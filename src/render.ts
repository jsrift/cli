import { PRESET_TECHNIQUES, STAGE_ORDER, listPasses } from 'jsrift';
import type {
  DeobfuscateMetadata,
  Detection,
  Diagnostic,
  PassReport,
  PresetName,
  Progress,
  TechniqueFlags,
  TechniqueId,
  analyze,
} from 'jsrift';

type AnalysisResult = ReturnType<typeof analyze>;
type PassInfo = ReturnType<typeof listPasses>[number];

const CSI = '[';
const RESET = `${CSI}0m`;
const CLEAR_LINE = `\r${CSI}K`;
const ANSI_PATTERN = /\[[0-9;]*m/g;
/** The same codes, captured so `split` keeps them between the text runs. */
const ANSI_SPLIT = /(\[[0-9;]*m)/;
const ANSI_CODE = /^\[[0-9;]*m$/;

export interface Style {
  enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  green(text: string): string;
  cyan(text: string): string;
  magenta(text: string): string;
}

interface ColorStream {
  isTTY?: boolean;
}

/**
 * Colour is opt-out, but only ever opt-in on a real terminal: piping into a file
 * or another program must produce clean text. `NO_COLOR` is honoured with any
 * non-empty value per the no-color.org convention.
 */
export function shouldUseColor(
  stream: ColorStream,
  explicit: boolean | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (explicit !== null) return explicit;
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false;
  if (env['FORCE_COLOR'] !== undefined) return env['FORCE_COLOR'] !== '0';
  if (env['TERM'] === 'dumb') return false;
  return stream.isTTY === true;
}

export function createStyle(enabled: boolean): Style {
  const wrap =
    (code: string) =>
    (text: string): string =>
      enabled ? `${CSI}${code}m${text}${RESET}` : text;
  return {
    enabled,
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    yellow: wrap('33'),
    green: wrap('32'),
    cyan: wrap('36'),
    magenta: wrap('35'),
  };
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const PROGRESS_INTERVAL_MS = 60;
const BAR_WIDTH = 20;

export interface ProgressRenderer {
  update(progress: Progress): void;
  /** Erase the progress line so the next write starts on a clean row. */
  clear(): void;
}

interface ProgressStream extends ColorStream {
  write(chunk: string): unknown;
  columns?: number;
}

export function createProgressRenderer(stream: ProgressStream, style: Style): ProgressRenderer {
  let frame = 0;
  let lastPaintedAt = 0;
  let dirty = false;

  const paint = (progress: Progress): void => {
    const width = Math.max(24, Math.min(stream.columns ?? 80, 120));
    const percent = Math.round(clamp01(progress.completed) * 100);
    const spinner = SPINNER[frame % SPINNER.length] ?? '-';
    frame += 1;

    const filled = Math.round((percent / 100) * BAR_WIDTH);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`;
    const label = progress.message ?? progress.stage;
    const line = `${style.cyan(spinner)} ${style.dim(bar)} ${String(percent).padStart(3)}%  ${label}`;

    stream.write(`${CLEAR_LINE}${truncate(line, width - 1, style.enabled)}`);
    dirty = true;
  };

  return {
    update(progress) {
      const at = Date.now();
      // The kernel reports far faster than a terminal can usefully redraw. The
      // final frame is exempt so the bar always ends full rather than at 87%.
      if (at - lastPaintedAt < PROGRESS_INTERVAL_MS && progress.completed < 1) return;
      lastPaintedAt = at;
      paint(progress);
    },
    clear() {
      if (!dirty) return;
      stream.write(CLEAR_LINE);
      dirty = false;
    },
  };
}

// ---------------------------------------------------------------------------
// The run report
// ---------------------------------------------------------------------------

const MAX_LISTED_PASSES = 18;
const MAX_LISTED_DETECTIONS = 12;
const MAX_LISTED_DIAGNOSTICS = 10;

export function renderReport(metadata: DeobfuscateMetadata, style: Style, width = 80): string {
  const lines: string[] = [
    `${style.bold('jsrift')} ${style.dim('·')} ${metadata.preset} preset ${style.dim('·')} ${metadata.language} ${metadata.sourceType} ${style.dim('·')} ${countOn(metadata.techniques)} techniques on`,
    '',
    style.bold('DETECTIONS'),
  ];

  if (metadata.detections.length === 0) {
    lines.push(`  ${style.dim('no known obfuscator signature found')}`);
  } else {
    for (const detection of metadata.detections.slice(0, MAX_LISTED_DETECTIONS)) {
      lines.push(`  ${renderDetection(detection, style, width)}`);
    }
    const hidden = metadata.detections.length - MAX_LISTED_DETECTIONS;
    if (hidden > 0) lines.push(`  ${style.dim(`... and ${hidden} more`)}`);
  }

  lines.push('', ...renderPassSection(metadata.passes, style));
  lines.push('', ...renderResultSection(metadata, style));

  if (metadata.diagnostics.length > 0) {
    lines.push('', style.bold('DIAGNOSTICS'));
    for (const diagnostic of metadata.diagnostics.slice(0, MAX_LISTED_DIAGNOSTICS)) {
      lines.push(`  ${renderDiagnostic(diagnostic, style, width)}`);
    }
    const hidden = metadata.diagnostics.length - MAX_LISTED_DIAGNOSTICS;
    if (hidden > 0) lines.push(`  ${style.dim(`... and ${hidden} more`)}`);
  }

  return lines.join('\n');
}

function renderDetection(detection: Detection, style: Style, width: number): string {
  const confidence = `${Math.round(detection.confidence * 100)}%`.padStart(4);
  const count = detection.count === undefined ? '' : style.dim(` ×${formatInt(detection.count)}`);
  const evidence = truncate(detection.evidence, Math.max(16, width - 40), false);
  return `${style.cyan(detection.kind.padEnd(24))} ${confidence}  ${style.dim(evidence)}${count}`;
}

function renderPassSection(passes: readonly PassReport[], style: Style): string[] {
  // The engine only reports a pass that changed something, bailed out, or cost
  // real time, so `passes.length` is the interesting subset - not the roster.
  const registered = listPasses().length;
  const totalMs = passes.reduce((sum, pass) => sum + pass.durationMs, 0);
  const lines = [
    `${style.bold('PASSES')} ${style.dim(`${passes.length} of ${registered} reported work · ${formatMs(totalMs)} in passes`)}`,
  ];

  const active = passes.filter((pass) => pass.changes > 0 || pass.bailout !== undefined);
  if (active.length === 0) {
    lines.push(
      `  ${style.dim('no pass changed the tree or bailed out; silent, sub-millisecond passes are not reported')}`,
    );
    return lines;
  }

  // Sorted by impact rather than execution order: the reader wants to know what
  // moved the needle first, and what it cost second.
  const ranked = [...active].sort(
    (a, b) => b.changes - a.changes || b.durationMs - a.durationMs || a.id.localeCompare(b.id),
  );
  const peak = ranked[0]?.changes ?? 0;
  const idWidth = Math.min(32, Math.max(...ranked.map((pass) => pass.id.length)));

  for (const pass of ranked.slice(0, MAX_LISTED_PASSES)) {
    const changes = formatInt(pass.changes).padStart(8);
    const duration = formatMs(pass.durationMs).padStart(8);
    const bar = peak > 0 ? style.dim(sparkbar(pass.changes / peak, 12)) : '';
    const bailout = pass.bailout === undefined ? '' : ` ${style.yellow(`bailout: ${pass.bailout}`)}`;
    lines.push(
      `  ${pass.id.padEnd(idWidth)} ${changes} ${style.dim('changes')} ${duration} ${bar}${bailout}`,
    );
  }
  const hidden = ranked.length - MAX_LISTED_PASSES;
  if (hidden > 0) lines.push(`  ${style.dim(`... and ${hidden} more`)}`);
  return lines;
}

function renderResultSection(metadata: DeobfuscateMetadata, style: Style): string[] {
  const stats = metadata.stats;
  const column = (value: string): string => value.padStart(11);

  const lines = [
    style.bold('RESULT'),
    `  bytes      ${column(formatInt(stats.inputBytes))} → ${column(formatInt(stats.outputBytes))}  ${signColor(delta(stats.inputBytes, stats.outputBytes), style)}`,
    `  lines      ${column(formatInt(stats.inputLines))} → ${column(formatInt(stats.outputLines))}  ${signColor(delta(stats.inputLines, stats.outputLines), style)}`,
    `  changes    ${column(formatInt(stats.totalChanges))} ${style.dim(`over ${stats.iterations} iteration${stats.iterations === 1 ? '' : 's'} · ${formatInt(stats.astNodes)} AST nodes`)}`,
    `  renames    ${column(formatInt(metadata.renames.length))} ${style.dim('identifiers')}`,
    `  strings    ${column(formatInt(metadata.strings.length))} ${style.dim('decoded')}`,
    `  time       ${column(formatMs(stats.totalMs))} ${style.dim(`parse ${formatMs(stats.parseMs)} · transform ${formatMs(stats.transformMs)} · generate ${formatMs(stats.generateMs)}`)}`,
    `  verified   ${column(renderVerification(metadata, style))}`,
  ];

  if (stats.truncated) {
    lines.push(
      `  ${style.yellow('truncated: the time budget, an abort signal or the iteration cap ended the run before the tree settled')}`,
    );
  }
  return lines;
}

function renderVerification(metadata: DeobfuscateMetadata, style: Style): string {
  switch (metadata.stats.verification) {
    case 'ok':
      return style.green('yes');
    case 'skipped':
      return style.dim('skipped (--no-verify)');
    case 'too-deep':
      return `${style.yellow('unknown')} ${style.dim('· the re-parse ran out of stack')}`;
    case 'invalid':
      return style.yellow('no');
  }
}

function renderDiagnostic(diagnostic: Diagnostic, style: Style, width: number): string {
  const paint =
    diagnostic.severity === 'error'
      ? style.red
      : diagnostic.severity === 'warning'
        ? style.yellow
        : style.dim;
  const where =
    diagnostic.loc === undefined
      ? ''
      : style.dim(`:${diagnostic.loc.line}:${diagnostic.loc.column}`);
  return `${paint(diagnostic.severity.padEnd(7))} ${style.cyan(diagnostic.source)}${where}  ${truncate(diagnostic.message, Math.max(20, width - 30), false)}`;
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

export function renderAnalysis(result: AnalysisResult, style: Style, width = 80): string {
  const lines = [
    `${style.bold('jsrift --analyze')} ${style.dim('·')} ${result.language} ${result.sourceType} ${style.dim('·')} ${formatInt(result.bytes)} bytes, ${formatInt(result.lines)} lines`,
    '',
    style.bold('DETECTIONS'),
  ];
  if (result.detections.length === 0) {
    lines.push(`  ${style.dim('no known obfuscator signature found')}`);
  } else {
    for (const detection of result.detections) {
      lines.push(`  ${renderDetection(detection, style, width)}`);
    }
  }
  return lines.join('\n');
}

export function renderPassList(passes: readonly PassInfo[], style: Style): string {
  const lines = [`${style.bold('PASSES')} ${style.dim(`${passes.length} total, in stage order`)}`];
  const idWidth = Math.min(34, Math.max(...passes.map((pass) => pass.id.length), 10));
  for (const stage of STAGE_ORDER) {
    const inStage = passes.filter((pass) => pass.stage === stage);
    if (inStage.length === 0) continue;
    lines.push('', `  ${style.magenta(stage)}`);
    for (const pass of inStage) {
      lines.push(
        `    ${style.cyan(pass.id.padEnd(idWidth))} ${style.dim(pass.technique.padEnd(22))} ${pass.title}`,
      );
    }
  }
  return lines.join('\n');
}

export function renderTechniqueList(style: Style): string {
  const presets = Object.keys(PRESET_TECHNIQUES) as PresetName[];
  const ids = Object.keys(PRESET_TECHNIQUES.balanced) as TechniqueId[];
  const idWidth = Math.max(...ids.map((id) => id.length));
  const columnWidth = 5;

  const lines = [
    `${style.bold('TECHNIQUES')} ${style.dim('what you toggle; each maps to one or more passes')}`,
    '',
    `  ${' '.repeat(idWidth)}  ${presets.map((preset) => style.dim(preset.slice(0, columnWidth - 1).padEnd(columnWidth))).join('')}`,
  ];
  for (const id of ids) {
    const marks = presets
      .map((preset) => {
        const on = PRESET_TECHNIQUES[preset][id];
        return on ? style.green('on'.padEnd(columnWidth)) : style.dim('·'.padEnd(columnWidth));
      })
      .join('');
    lines.push(`  ${style.cyan(id.padEnd(idWidth))}  ${marks}${TECHNIQUE_SUMMARY[id]}`);
  }
  return lines.join('\n');
}

const TECHNIQUE_SUMMARY: Record<TechniqueId, string> = {
  stringDecoding: 'decode string arrays, wrapper functions and encoded literals',
  variableRenaming: 'replace mangled identifiers with inferred, scope-safe names',
  controlFlowAnalysis: 'recover flattened while/switch state machines',
  deadCodeRemoval: 'delete unreachable branches, unused bindings and filler',
  functionUnwrapping: 'inline proxy functions and object alias maps',
  literalSimplification: 'fold constant expressions, !![] and void 0',
  propertyNormalization: 'rewrite obj["prop"] as obj.prop',
  antiTamperRemoval: 'strip debugger traps, self-defending and console guards',
  statementRecovery: 'restore statements from comma sequences and ternaries',
  moduleUnwrapping: 'split webpack/Next.js chunk maps into named modules',
  jsxRestoration: 'turn _jsx(...) runtime calls back into JSX',
};

// ---------------------------------------------------------------------------
// Formatting primitives
// ---------------------------------------------------------------------------

export function formatInt(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatMs(value: number): string {
  if (value < 1) return `${value.toFixed(2)}ms`;
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

function delta(before: number, after: number): string {
  if (before === 0) return ' - ';
  const percent = ((after - before) / before) * 100;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

function signColor(text: string, style: Style): string {
  if (text.startsWith('-')) return style.green(text);
  if (text.startsWith('+')) return style.yellow(text);
  return style.dim(text);
}

function sparkbar(ratio: number, width: number): string {
  return '█'.repeat(Math.max(1, Math.round(clamp01(ratio) * width)));
}

function countOn(flags: TechniqueFlags): string {
  const values = Object.values(flags);
  return `${values.filter(Boolean).length}/${values.length}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Truncate to a visible width. Styled text carries ANSI codes that occupy no
 * columns, so the cut is measured over the visible characters alone: every
 * code before it is kept, none is split, and a reset closes whatever is open.
 */
function truncate(text: string, width: number, styled: boolean): string {
  if (!styled) {
    return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}...`;
  }
  if (text.replace(ANSI_PATTERN, '').length <= width) return text;
  let budget = Math.max(0, width - 1);
  let cut = '';
  for (const part of text.split(ANSI_SPLIT)) {
    if (ANSI_CODE.test(part)) {
      cut += part;
      continue;
    }
    cut += part.slice(0, budget);
    budget -= Math.min(budget, part.length);
    if (budget === 0) break;
  }
  return `${cut}${RESET}...`;
}
