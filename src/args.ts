import { PRESET_TECHNIQUES, listPasses } from '@jsrift/core';
import type { Language, PresetName, TechniqueId } from '@jsrift/core';

export const TECHNIQUE_IDS = Object.keys(PRESET_TECHNIQUES.balanced) as TechniqueId[];
export const PRESET_NAMES = Object.keys(PRESET_TECHNIQUES) as PresetName[];
export const LANGUAGES: readonly Language[] = ['auto', 'js', 'jsx', 'ts', 'tsx'];

export interface CliOptions {
  /** `null` means stdin. */
  input: string | null;
  /** `null` means stdout. */
  output: string | null;
  preset: PresetName;
  enable: TechniqueId[];
  disable: TechniqueId[];
  disablePasses: string[];
  language: Language;
  sourceMap: boolean | 'inline';
  comments: boolean;
  indent: number;
  quotes: 'single' | 'double' | 'preserve';
  format: boolean;
  banner: boolean;
  /** `null` leaves the engine default in place rather than overriding it with `undefined`. */
  maxIterations: number | null;
  timeBudgetMs: number | null;
  verify: boolean;
  allowExecution: boolean;
  json: boolean;
  stats: boolean;
  listPasses: boolean;
  listTechniques: boolean;
  analyze: boolean;
  quiet: boolean;
  /** `null` means "decide from the stream and the environment". */
  color: boolean | null;
  help: boolean;
  version: boolean;
}

export interface ParseSuccess {
  ok: true;
  options: CliOptions;
}

export interface ParseFailure {
  ok: false;
  message: string;
  /** A second line offering the closest valid spelling, when one exists. */
  hint?: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

const FLAGS_WITH_VALUES = [
  '--output',
  '--preset',
  '--enable',
  '--disable',
  '--disable-pass',
  '--language',
  '--indent',
  '--quotes',
  '--max-iterations',
  '--time-budget',
] as const;

const FLAGS_WITHOUT_VALUES = [
  '--source-map',
  '--no-comments',
  '--no-format',
  '--no-verify',
  '--no-color',
  '--color',
  '--banner',
  '--allow-execution',
  '--json',
  '--stats',
  '--list-passes',
  '--list-techniques',
  '--analyze',
  '--quiet',
  '--help',
  '--version',
] as const;

const KNOWN_FLAGS: readonly string[] = [...FLAGS_WITH_VALUES, ...FLAGS_WITHOUT_VALUES];

function defaults(): CliOptions {
  return {
    input: null,
    output: null,
    preset: 'balanced',
    enable: [],
    disable: [],
    disablePasses: [],
    language: 'auto',
    sourceMap: false,
    comments: true,
    indent: 2,
    quotes: 'preserve',
    format: true,
    banner: false,
    maxIterations: null,
    timeBudgetMs: null,
    verify: true,
    allowExecution: false,
    json: false,
    stats: false,
    listPasses: false,
    listTechniques: false,
    analyze: false,
    quiet: false,
    color: null,
    help: false,
    version: false,
  };
}

export function parseArgs(argv: readonly string[]): ParseResult {
  const options = defaults();
  const positionals: string[] = [];
  let index = 0;
  let literal = false;

  const fail = (message: string, hint?: string): ParseFailure =>
    hint === undefined ? { ok: false, message } : { ok: false, message, hint };

  while (index < argv.length) {
    const raw = argv[index];
    index += 1;
    if (raw === undefined) break;

    if (literal || raw === '-' || !raw.startsWith('-') || raw === '') {
      positionals.push(raw);
      continue;
    }
    if (raw === '--') {
      literal = true;
      continue;
    }

    const equals = raw.indexOf('=');
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const attached = equals === -1 ? undefined : raw.slice(equals + 1);

    /** Consume this flag's value from `--flag=value` or the following argv entry. */
    const take = (): string | null => {
      if (attached !== undefined) return attached;
      const next = argv[index];
      if (next === undefined) return null;
      index += 1;
      return next;
    };
    const rejectValue = (): ParseFailure | null =>
      attached === undefined ? null : fail(`Option ${flag} does not take a value.`);

    switch (flag) {
      case '-h':
      case '--help': {
        options.help = true;
        break;
      }
      case '-v':
      case '--version': {
        options.version = true;
        break;
      }
      case '-o':
      case '--output': {
        const value = take();
        if (value === null) return fail(`Option ${flag} requires a file path.`);
        options.output = value;
        break;
      }
      case '--preset': {
        const value = take();
        if (value === null) return fail('Option --preset requires a value.');
        if (!isPreset(value)) {
          return fail(
            `Unknown preset ${JSON.stringify(value)}. Valid presets: ${PRESET_NAMES.join(', ')}.`,
            suggestion(value, PRESET_NAMES),
          );
        }
        options.preset = value;
        break;
      }
      case '--enable':
      case '--disable': {
        const value = take();
        if (value === null) return fail(`Option ${flag} requires a technique list.`);
        const parsed = parseTechniqueList(value, flag);
        if (!parsed.ok) return parsed;
        const target = flag === '--enable' ? options.enable : options.disable;
        target.push(...parsed.items);
        break;
      }
      case '--disable-pass': {
        const value = take();
        if (value === null) return fail('Option --disable-pass requires a pass id list.');
        const parsed = parsePassList(value);
        if (!parsed.ok) return parsed;
        options.disablePasses.push(...parsed.items);
        break;
      }
      case '--language': {
        const value = take();
        if (value === null) return fail('Option --language requires a value.');
        if (!isLanguage(value)) {
          return fail(
            `Unknown language ${JSON.stringify(value)}. Valid languages: ${LANGUAGES.join(', ')}.`,
            suggestion(value, LANGUAGES),
          );
        }
        options.language = value;
        break;
      }
      case '--source-map': {
        if (attached !== undefined) {
          if (attached !== 'inline') {
            return fail(
              `Option --source-map takes no value or the value "inline", got ${JSON.stringify(attached)}.`,
            );
          }
          options.sourceMap = 'inline';
        } else if (argv[index] === 'inline') {
          index += 1;
          options.sourceMap = 'inline';
        } else {
          options.sourceMap = true;
        }
        break;
      }
      case '--indent': {
        const value = take();
        if (value === null) return fail('Option --indent requires a number.');
        const parsed = parseInteger(value, '--indent', 0, 16);
        if (typeof parsed !== 'number') return parsed;
        options.indent = parsed;
        break;
      }
      case '--quotes': {
        const value = take();
        if (value === null) return fail('Option --quotes requires a value.');
        if (value !== 'single' && value !== 'double' && value !== 'preserve') {
          return fail(
            `Unknown quote style ${JSON.stringify(value)}. Valid styles: single, double, preserve.`,
            suggestion(value, ['single', 'double', 'preserve']),
          );
        }
        options.quotes = value;
        break;
      }
      case '--max-iterations': {
        const value = take();
        if (value === null) return fail('Option --max-iterations requires a number.');
        const parsed = parseInteger(value, '--max-iterations', 1, 1000);
        if (typeof parsed !== 'number') return parsed;
        options.maxIterations = parsed;
        break;
      }
      case '--time-budget': {
        const value = take();
        if (value === null) return fail('Option --time-budget requires a number of milliseconds.');
        const parsed = parseInteger(value, '--time-budget', 1, Number.MAX_SAFE_INTEGER);
        if (typeof parsed !== 'number') return parsed;
        options.timeBudgetMs = parsed;
        break;
      }
      default: {
        const invalid = rejectValue();
        if (invalid) return invalid;
        const applied = applyBooleanFlag(options, flag);
        if (!applied) {
          return fail(
            `Unknown option ${flag}.`,
            suggestion(flag, KNOWN_FLAGS) ?? 'Run `jsrift --help` for the full option list.',
          );
        }
        break;
      }
    }
  }

  if (positionals.length > 1) {
    return fail(
      `Expected at most one input file, got ${positionals.length}: ${positionals.join(', ')}.`,
      'Use -o <file> to choose the output path; jsrift reads exactly one input.',
    );
  }

  const first = positionals[0];
  options.input = first === undefined || first === '-' ? null : first;

  const conflict = options.enable.find((id) => options.disable.includes(id));
  if (conflict) {
    return fail(
      `Technique ${conflict} is passed to both --enable and --disable.`,
      'Pick one; a technique cannot be turned on and off in the same run.',
    );
  }

  if (options.sourceMap === true && options.output === null) {
    return fail(
      'A standalone source map needs a file to sit next to.',
      'Pass -o <file> to write <file>.map, or use --source-map inline.',
    );
  }

  return { ok: true, options };
}

function applyBooleanFlag(options: CliOptions, flag: string): boolean {
  switch (flag) {
    case '--no-comments':
      options.comments = false;
      return true;
    case '--no-format':
      options.format = false;
      return true;
    case '--no-verify':
      options.verify = false;
      return true;
    case '--no-color':
      options.color = false;
      return true;
    case '--color':
      options.color = true;
      return true;
    case '--banner':
      options.banner = true;
      return true;
    case '--allow-execution':
      options.allowExecution = true;
      return true;
    case '--json':
      options.json = true;
      return true;
    case '--stats':
      options.stats = true;
      return true;
    case '--list-passes':
      options.listPasses = true;
      return true;
    case '--list-techniques':
      options.listTechniques = true;
      return true;
    case '--analyze':
      options.analyze = true;
      return true;
    case '-q':
    case '--quiet':
      options.quiet = true;
      return true;
    default:
      return false;
  }
}

interface ListSuccess<T> {
  ok: true;
  items: T[];
}

function parseTechniqueList(value: string, flag: string): ListSuccess<TechniqueId> | ParseFailure {
  const items: TechniqueId[] = [];
  for (const entry of splitList(value)) {
    if (!isTechnique(entry)) {
      const hint = suggestion(entry, TECHNIQUE_IDS);
      return {
        ok: false,
        message: `Unknown technique ${JSON.stringify(entry)} in ${flag}.\nValid techniques: ${TECHNIQUE_IDS.join(', ')}.`,
        ...(hint === undefined ? {} : { hint }),
      };
    }
    if (!items.includes(entry)) items.push(entry);
  }
  if (items.length === 0) return { ok: false, message: `Option ${flag} was given an empty list.` };
  return { ok: true, items };
}

function parsePassList(value: string): ListSuccess<string> | ParseFailure {
  const known = listPasses().map((pass) => pass.id);
  const items: string[] = [];
  for (const entry of splitList(value)) {
    if (!known.includes(entry)) {
      const hint = suggestion(entry, known);
      return {
        ok: false,
        message: `Unknown pass id ${JSON.stringify(entry)} in --disable-pass.\nRun \`jsrift --list-passes\` to see all ${known.length} pass ids.`,
        ...(hint === undefined ? {} : { hint }),
      };
    }
    if (!items.includes(entry)) items.push(entry);
  }
  if (items.length === 0) return { ok: false, message: 'Option --disable-pass was given an empty list.' };
  return { ok: true, items };
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseInteger(
  value: string,
  flag: string,
  min: number,
  max: number,
): number | ParseFailure {
  if (!/^\d+$/.test(value)) {
    return { ok: false, message: `Option ${flag} expects a whole number, got ${JSON.stringify(value)}.` };
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    return { ok: false, message: `Option ${flag} expects a number between ${min} and ${max}, got ${parsed}.` };
  }
  return parsed;
}

function isPreset(value: string): value is PresetName {
  return (PRESET_NAMES as readonly string[]).includes(value);
}

function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

function isTechnique(value: string): value is TechniqueId {
  return (TECHNIQUE_IDS as readonly string[]).includes(value);
}

/**
 * Closest candidate by edit distance, or nothing when the nearest match is too
 * far away to be a plausible typo - a wrong guess is worse than no guess.
 */
export function suggestion(input: string, candidates: readonly string[]): string | undefined {
  const normalized = input.replace(/^-+/, '').toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(normalized, candidate.replace(/^-+/, '').toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  if (best === undefined) return undefined;
  const budget = Math.max(2, Math.floor(normalized.length / 3));
  return bestDistance <= budget ? `Did you mean ${best}?` : undefined;
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_unused, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + cost;
      current[j] = Math.min(deletion, insertion, substitution);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] ?? 0;
}

export const HELP_TEXT = `jsrift - deobfuscate JavaScript, TypeScript and JSX

USAGE
  jsrift <input> [-o <file>] [options]
  jsrift - < obfuscated.js > clean.js
  cat bundle.js | jsrift --stats > clean.js

  <input> is a file path. "-" or no argument reads stdin. The deobfuscated code
  goes to stdout unless -o is given, so redirection works.

INPUT AND OUTPUT
  -o, --output <file>       write the code to <file> instead of stdout
      --json                print the metadata object as JSON on stdout
                            (the code then only lands anywhere if -o is given)
      --stats               print a human-readable report on stderr
      --analyze             fingerprint the input and exit; transform nothing
      --list-passes         list every pass id, grouped by stage
      --list-techniques     list every technique and the presets that enable it

WHAT TO RUN
      --preset <name>       ${PRESET_NAMES.join(' | ')}   (default: balanced)
      --enable  <list>      force techniques on,  comma separated
      --disable <list>      force techniques off, comma separated (wins over --enable)
      --disable-pass <list> skip individual passes by id, comma separated
      --language <name>     ${LANGUAGES.join(' | ')}   (default: auto)
      --allow-execution     opt in to the sandbox evaluation tier for decoders
                            that the native and interpreter tiers cannot handle

OUTPUT SHAPE
      --no-format           skip pretty-printing
      --indent <n>          indentation width, 0-16 (default: 2)
      --quotes <style>      single | double | preserve (default: preserve)
      --no-comments         drop comments from the output
      --source-map [inline] write <out>.map, or "inline" to append a data URI
      --banner              prepend a summary comment to the code

BUDGETS
      --max-iterations <n>  fixpoint iteration cap
      --time-budget <ms>    abort with best-effort output after this long
      --no-verify           skip re-parsing the output to prove it is valid

REPORTING
  -q, --quiet               no progress indicator, no non-essential stderr
      --no-color            disable ANSI colour (also honours NO_COLOR)
  -h, --help                show this help
  -v, --version             show the version

TECHNIQUES
  ${TECHNIQUE_IDS.join(', ')}

EXIT CODES
  0  success
  1  usage error
  2  the input could not be parsed
  3  the output failed re-parse verification
  70 internal error
`;
