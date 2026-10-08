#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import process from 'node:process';
import { analyze, deobfuscate, listPasses, PRESET_TECHNIQUES } from 'jsrift';
import type {
  DeobfuscateOptions,
  PerformanceOptions,
  Progress,
  TechniqueId,
  TechniqueOverride,
  TechniqueOverrides,
} from 'jsrift';
import { HELP_TEXT, parseArgs, type CliOptions } from './args.js';
import {
  createProgressRenderer,
  createStyle,
  renderAnalysis,
  renderPassList,
  renderReport,
  renderTechniqueList,
  shouldUseColor,
  type ProgressRenderer,
  type Style,
} from './render.js';

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_PARSE = 2;
const EXIT_UNVERIFIED = 3;
const EXIT_INTERNAL = 70;

/**
 * The renderer of the run in flight, reachable from the catch at the bottom:
 * the engine paints the first frame before it parses, and a parse failure
 * would otherwise land on the same row as the bar.
 */
const progress: { current: ProgressRenderer | null } = { current: null };

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArgs(argv);
  const errorStyle = createStyle(shouldUseColor(process.stderr, colorFlagOf(argv)));

  if (!parsed.ok) {
    process.stderr.write(`${errorStyle.red('error')} ${parsed.message}\n`);
    if (parsed.hint) process.stderr.write(`${errorStyle.dim(parsed.hint)}\n`);
    return EXIT_USAGE;
  }

  const options = parsed.options;
  const outStyle = createStyle(shouldUseColor(process.stdout, options.color));
  const logStyle = createStyle(shouldUseColor(process.stderr, options.color));

  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return EXIT_OK;
  }
  if (options.version) {
    process.stdout.write(`${readVersion()}\n`);
    return EXIT_OK;
  }
  if (options.listPasses) {
    const passes = listPasses();
    process.stdout.write(
      options.json ? `${JSON.stringify(passes, null, 2)}\n` : `${renderPassList(passes, outStyle)}\n`,
    );
    return EXIT_OK;
  }
  if (options.listTechniques) {
    process.stdout.write(
      options.json
        ? `${JSON.stringify(PRESET_TECHNIQUES, null, 2)}\n`
        : `${renderTechniqueList(outStyle)}\n`,
    );
    return EXIT_OK;
  }

  const source = await readInput(options, logStyle);
  if (typeof source !== 'string') return source;

  if (options.analyze) {
    const result = analyze(source, {
      language: options.language,
      ...(options.input === null ? {} : { filename: options.input }),
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${renderAnalysis(result, outStyle, widthOf(process.stdout))}\n`,
    );
    return EXIT_OK;
  }

  const renderer = showProgress(options) ? createProgressRenderer(process.stderr, logStyle) : null;
  progress.current = renderer;
  const result = await deobfuscate(
    source,
    buildEngineOptions(options, renderer ? (update) => renderer.update(update) : undefined),
  );
  renderer?.clear();

  writeCode(options, result.code, result.map, logStyle);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result.metadata, null, 2)}\n`);
  }
  if (options.stats) {
    process.stderr.write(`${renderReport(result.metadata, logStyle, widthOf(process.stderr))}\n`);
  }

  if (options.verify && !result.metadata.stats.verified) {
    if (!options.quiet) {
      // The engine names no pass: it does not re-run with passes disabled,
      // and the cause can sit upstream of every pass (input that only parsed
      // with error recovery, a pinned sourceType the output cannot satisfy).
      // The diagnostics carry what is known; `--disable-pass` is the reader's
      // own narrowing, offered only once the input is known to be clean.
      process.stderr.write(
        result.metadata.stats.verification === 'too-deep'
          ? `${logStyle.red('error')} the generated output could not be verified: the re-parse ran out of stack.\n` +
              `${logStyle.dim('That is a limit of this process rather than a defect in the output; the code was still written.')}\n`
          : `${logStyle.red('error')} the generated output did not re-parse as valid source.\n` +
              `${logStyle.dim('The code was still written so it can be inspected. The diagnostics (--stats or --json) say whether the input itself parsed cleanly; when it did, --disable-pass <id> narrows the cause to a pass by hand.')}\n`,
      );
    }
    return EXIT_UNVERIFIED;
  }
  return EXIT_OK;
}

/**
 * Colour for the argument-error path has to be decided before the arguments are
 * understood, so `--no-color` is looked for directly in argv.
 */
function colorFlagOf(argv: readonly string[]): boolean | null {
  if (argv.includes('--no-color')) return false;
  if (argv.includes('--color')) return true;
  return null;
}

function showProgress(options: CliOptions): boolean {
  return process.stderr.isTTY === true && !options.quiet;
}

function widthOf(stream: { columns?: number }): number {
  return Math.max(40, Math.min(stream.columns ?? 80, 140));
}

async function readInput(options: CliOptions, style: Style): Promise<string | number> {
  if (options.input !== null) {
    try {
      return stripBom(readFileSync(options.input, 'utf8'));
    } catch (error) {
      process.stderr.write(
        `${style.red('error')} cannot read ${options.input}: ${messageOf(error)}\n`,
      );
      return EXIT_USAGE;
    }
  }

  if (process.stdin.isTTY) {
    process.stderr.write(
      `${style.red('error')} no input.\n${style.dim('Pass a file path, or pipe source in: cat bundle.js | jsrift')}\n`,
    );
    return EXIT_USAGE;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return stripBom(Buffer.concat(chunks).toString('utf8'));
}

function writeCode(
  options: CliOptions,
  code: string,
  map: unknown,
  style: Style,
): void {
  const target = options.output;

  if (target === null) {
    // With --json the metadata owns stdout, so the code has nowhere to go; say
    // so rather than silently dropping it.
    if (options.json && !options.quiet) {
      process.stderr.write(
        `${style.dim('note: --json printed metadata to stdout; pass -o <file> to keep the code too.')}\n`,
      );
      return;
    }
    if (!options.json) process.stdout.write(withTrailingNewline(code));
    return;
  }

  let body = withTrailingNewline(code);
  if (options.sourceMap === true && map) {
    const mapPath = `${target}.map`;
    writeFileSync(mapPath, `${JSON.stringify(map)}\n`, 'utf8');
    body = `${body}//# sourceMappingURL=${basename(mapPath)}\n`;
  }
  writeFileSync(target, body, 'utf8');
}

/**
 * Text files end with a newline. Without one, `jsrift in.js > out.js` produces
 * a file that every diff tool flags and that concatenates badly, and an appended
 * `//# sourceMappingURL=` comment would land on the last line of code.
 */
function withTrailingNewline(code: string): string {
  if (code.length === 0 || code.endsWith('\n')) return code;
  return `${code}\n`;
}

function buildEngineOptions(
  options: CliOptions,
  onProgress: ((progress: Progress) => void) | undefined,
): DeobfuscateOptions {
  const performance: PerformanceOptions = { verifyOutput: options.verify };
  if (options.maxIterations !== null) performance.maxIterations = options.maxIterations;
  if (options.timeBudgetMs !== null) performance.timeBudgetMs = options.timeBudgetMs;

  const engineOptions: DeobfuscateOptions = {
    preset: options.preset,
    techniques: buildTechniqueOverrides(options),
    language: options.language,
    output: {
      format: options.format,
      indent: options.indent,
      comments: options.comments,
      sourceMaps: options.sourceMap,
      banner: options.banner,
      quotes: options.quotes,
    },
    performance,
    sandbox: { allowExecution: options.allowExecution },
    disablePasses: options.disablePasses,
  };
  if (options.input !== null) engineOptions.filename = options.input;
  if (onProgress) engineOptions.onProgress = onProgress;
  return engineOptions;
}

function buildTechniqueOverrides(options: CliOptions): TechniqueOverrides {
  const overrides: TechniqueOverrides = {};
  for (const id of options.enable) setOverride(overrides, id, true);
  for (const id of options.disable) setOverride(overrides, id, false);

  if (options.allowExecution) {
    // The sandbox tier is absent from every preset by design, so opting in means
    // rewriting the tier list rather than flipping a flag - and that must not
    // accidentally re-enable a technique the user turned off.
    const enabled = options.disable.includes('stringDecoding')
      ? false
      : options.enable.includes('stringDecoding') || PRESET_TECHNIQUES[options.preset].stringDecoding;
    overrides.stringDecoding = { enabled, tiers: ['native', 'interpreter', 'sandbox'] };
  }
  return overrides;
}

/**
 * A write through a union-keyed index needs a value acceptable to every member
 * of the union; `boolean` is, but TypeScript cannot prove it for a generic key.
 */
function setOverride(target: TechniqueOverrides, id: TechniqueId, value: boolean): void {
  (target as Record<TechniqueId, TechniqueOverride>)[id] = value;
}

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return `jsrift ${pkg.version ?? '0.0.0'} (node ${process.versions.node})`;
  } catch {
    return `jsrift (node ${process.versions.node})`;
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A parse failure is the user's input being wrong, not the engine misbehaving.
 * An ambiguous dialect is one too: the input reads two ways and the message
 * says which `--language` pins it.
 */
function isParseFailure(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error &&
      (error.name === 'ParseFailedError' ||
        error.name === 'AmbiguousDialectError' ||
        error.name === 'SyntaxError'))
  );
}

// `jsrift in.js | head` closes stdout early; that is normal usage, not a crash.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(EXIT_OK);
});

try {
  // Assigning exitCode rather than calling process.exit lets Node flush a large
  // pipe write to stdout before the process goes away.
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  progress.current?.clear();
  const style = createStyle(shouldUseColor(process.stderr, colorFlagOf(process.argv)));
  if (isParseFailure(error)) {
    process.stderr.write(`${style.red('parse error')} ${messageOf(error)}\n`);
    process.exitCode = EXIT_PARSE;
  } else {
    process.stderr.write(`${style.red('internal error')} ${messageOf(error)}\n`);
    if (error instanceof Error && error.stack) {
      process.stderr.write(`${style.dim(error.stack)}\n`);
    }
    process.exitCode = EXIT_INTERNAL;
  }
}
