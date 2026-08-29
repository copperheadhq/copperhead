/**
 * Subtle interactive-TTY chrome: muted hierarchy with a copper accent.
 * Plain / --json / piped output must stay free of SGR (AC-8.9), so helpers
 * no-op unless color has been explicitly enabled for this process.
 */

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

/** True after makeRenderer selects the interactive path. */
let colorEnabled = false;

export function setColorEnabled(on: boolean): void {
  colorEnabled = on;
}

export function isColorEnabled(): boolean {
  return colorEnabled;
}

function paint(code: string, s: string): string {
  if (!colorEnabled || s === '') return s;
  return `${ESC}${code}m${s}${RESET}`;
}

const TRUECOLOR = /truecolor|24bit/i.test(process.env.COLORTERM ?? '');

/** Secondary metadata — soft gray #999999 (truecolor), SGR 90 fallback. */
export const dim = (s: string): string => paint(TRUECOLOR ? '38;2;153;153;153' : '90', s);
/** Rules/separators — one step darker than dim: #888888. */
export const ruleDim = (s: string): string => paint(TRUECOLOR ? '38;2;136;136;136' : '90', s);
/** Primary content — bright white (typed input, key values). */
export const bright = (s: string): string => paint('97', s);

/** Exact brand copper #b87333 where truecolor is available; warm 256 fallback. */
const COPPER_SGR = TRUECOLOR ? '38;2;184;115;51' : '38;5;173';
/** Light copper tint (brand accent-high #eec9a5) — menu hover. */
export const copperLight = (s: string): string =>
  paint(TRUECOLOR ? '38;2;238;201;165' : '38;5;223', s);
/** Title emphasis — bold in the terminal's default foreground (theme-adaptive). */
export const bold = (s: string): string => paint('1', s);
/** Brand / active accent — exact copper #b87333 (truecolor), 256-color 173 fallback. */
export const copper = (s: string): string => paint(COPPER_SGR, s);
/** Success — PCB green. */
export const ok = (s: string): string => paint('32', s);
/** Busy / caution — amber. */
export const warn = (s: string): string => paint('33', s);
/** Failure. */
export const err = (s: string): string => paint('31', s);

/**
 * Style a create-pipeline stage line. Keeps the `stage <name>:` prefix so
 * existing log greps and operator muscle memory still work.
 */
export function stageLine(name: string, detail: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info'): string {
  const label = dim(`stage ${name}:`);
  const body =
    kind === 'ok' ? ok(detail) : kind === 'warn' ? warn(detail) : kind === 'err' ? err(detail) : detail;
  return `${label} ${body}`;
}

/**
 * Tool-result scrollback line: glyph from envelope `ok`, not a regex on prose.
 * The envelope `viewHint` styles the name: mutations (they changed the repo)
 * read copper, exports light copper, queries/diagnostics stay dim. Plain mode
 * is unaffected: every painter no-ops while color is off.
 */
export function toolLine(
  name: string,
  firstLine: string,
  succeeded = false,
  viewHint?: 'diagnostic' | 'mutation' | 'query' | 'export',
): string {
  const glyph = succeeded ? ok('✓') : copper('▸');
  const label = viewHint === 'mutation' ? copper(name) : viewHint === 'export' ? copperLight(name) : dim(name);
  return `  ${glyph} ${label}  ${firstLine}`;
}

/** Color the final outcome line from its exit-path token. */
export function styleOutcome(line: string): string {
  if (!colorEnabled) return line;
  const head = line.split(' · ')[0] ?? line;
  const rest = line.slice(head.length);
  if (head === 'done') return ok(head) + dim(rest);
  if (/refus|fail|error|exhaust|stall/i.test(head)) return err(head) + dim(rest);
  return copper(head) + dim(rest);
}

/** Dim secondary segments of the two-line CLI header (brand stays copper). */
export function styleHeaderLines(lines: string[]): string[] {
  if (!colorEnabled) return lines;
  return lines.map((line, i) => {
    if (i === 0) {
      // copperhead vX · rest…
      const m = line.match(/^(copperhead v\S+)(.*)$/);
      if (!m) return dim(line);
      return copper(m[1]!) + dim(m[2]!);
    }
    return dim(line);
  });
}
