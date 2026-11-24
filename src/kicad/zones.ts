/**
 * Copper pour fills (#469, change refill-zone-fills).
 *
 * A board stores each zone's fill as computed data: `filled_polygon` blocks
 * (legacy `fill_segments`) inside the zone, valid only for the copper they
 * were filled against. Moving a pad or track into a pour leaves the old fill
 * overlapping it, and a zone written by hand has no fill at all. Only KiCad's
 * own filler computes fills correctly (thermal reliefs, island removal,
 * net-class and custom-rule clearances), and kicad-cli runs it only as part
 * of a DRC that saves the whole board in its own format.
 *
 * So the refresh fills a scratch copy beside copies of the project's rule
 * files, then splices only each zone's fill data back into the design file's
 * own text, by the same span-splicing the other writers use (SPEC §1.3), and
 * checks that KiCad reads the result back with exactly the fills it computed.
 * It returns text; callers decide whether to write it.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boardResaveSupported, refillAndSave, resaveBoard, runDrc, zoneRefillSupported } from './cli.js';
import type { CheckReport } from './report.js';
import { childSpans, type Span } from './spans.js';

export class ZoneFillError extends Error {
  override name = 'ZoneFillError';
}

export class ZoneRefillUnavailableError extends ZoneFillError {
  override name = 'ZoneRefillUnavailableError';
  constructor() {
    super(
      'this kicad-cli cannot refill zones (its `pcb drc` has no --refill-zones/--save-board; KiCad 9 or later has them), ' +
        'so pour fills were not refreshed',
    );
  }
}

/** Fill data inside a zone: the only children a refresh replaces. */
const FILL_TAGS = new Set(['filled_polygon', 'fill_segments']);
/** Children that make a zone a rule area (keepout), which KiCad never fills. */
const RULE_AREA_TAGS = new Set(['keepout', 'rule_area']);
/** Project files KiCad reads the board's rules from, found by the board's own name. */
const PROJECT_RULE_FILES = ['.kicad_pro', '.kicad_dru'];

export interface ZoneInfo {
  /** Match key: the zone's id, prefixed by its footprint's id for a footprint's own zone; null without an id. */
  key: string | null;
  span: Span;
  kids: Span[];
  /** The zone's `uuid`/`tstamp` child, when it has one. */
  idSpan?: Span;
  fills: Span[];
  /** The `(fill …)` child. */
  fill?: Span;
  /** The `(filled_areas_thickness …)` child. */
  thickness?: Span;
  /** KiCad fills it: any zone that is not a rule area. */
  fillable: boolean;
  /** For messages: `the GND zone on F.Cu (3c3c3c3c)`. */
  label: string;
}

/** Every zone on the board, top-level and inside footprints, in file order. */
export function listZones(text: string): ZoneInfo[] {
  const root = text.indexOf('(kicad_pcb');
  if (root < 0) throw new ZoneFillError('not a KiCad board: no (kicad_pcb …) list');
  const out: ZoneInfo[] = [];
  childSpans(text, root).forEach((top, i) => {
    if (top.tag === 'zone') out.push(zoneInfo(text, top, null));
    else if (top.tag === 'footprint') {
      const fpKids = childSpans(text, top.start);
      const fpId = idOf(text, fpKids.find((k) => k.tag === 'uuid' || k.tag === 'tstamp')) ?? `#${i}`;
      const ref = footprintRef(text.slice(top.start, top.end));
      for (const k of fpKids) if (k.tag === 'zone') out.push(zoneInfo(text, k, { id: fpId, ref }));
    }
  });
  return out;
}

/** Fillable zones that hold no fill: a pour that was drawn but never filled. */
export function unfilledZones(text: string): ZoneInfo[] {
  return listZones(text).filter((z) => z.fillable && !z.fills.length && !(z.fill && isFillYes(text, z.fill)));
}

function zoneInfo(text: string, span: Span, footprint: { id: string; ref: string | null } | null): ZoneInfo {
  const kids = childSpans(text, span.start);
  const idSpan = kids.find((k) => k.tag === 'uuid' || k.tag === 'tstamp');
  const id = idOf(text, idSpan);
  const net = netName(text, kids);
  const layer = kids
    .filter((k) => k.tag === 'layer' || k.tag === 'layers')
    .map((k) => [...text.slice(k.start, k.end).matchAll(/"([^"]*)"|(?<=\s)([^\s()"]+)/g)].map((m) => m[1] ?? m[2]).join(', '))
    .join(', ');
  const owner = footprint ? `${footprint.ref ?? 'a footprint'}'s ` : 'the ';
  const label = `${owner}${net ? `${net} ` : ''}zone on ${layer || 'an unknown layer'} (${id ? id.slice(0, 8) : 'no uuid'})`;
  return {
    key: id ? (footprint ? `${footprint.id}/${id}` : id) : null,
    span,
    kids,
    ...(idSpan ? { idSpan } : {}),
    fills: kids.filter((k) => FILL_TAGS.has(k.tag)),
    ...withSpan('fill', kids.find((k) => k.tag === 'fill')),
    ...withSpan('thickness', kids.find((k) => k.tag === 'filled_areas_thickness')),
    fillable: !kids.some((k) => RULE_AREA_TAGS.has(k.tag)),
    label,
  };
}

function withSpan<K extends string>(key: K, span: Span | undefined): Partial<Record<K, Span>> {
  return span ? ({ [key]: span } as Record<K, Span>) : {};
}

function idOf(text: string, span: Span | undefined): string | null {
  if (!span) return null;
  return /^\(\s*(?:uuid|tstamp)\s+"?([^\s")]+)"?\s*\)$/.exec(text.slice(span.start, span.end))?.[1] ?? null;
}

/** KiCad 8 writes `(net 1) (net_name "GND")`, KiCad 10 `(net "GND")`. */
function netName(text: string, kids: Span[]): string | null {
  for (const tag of ['net_name', 'net']) {
    const k = kids.find((s) => s.tag === tag);
    const name = k && /"([^"]*)"/.exec(text.slice(k.start, k.end))?.[1];
    if (name) return name;
  }
  return null;
}

function footprintRef(fpText: string): string | null {
  return (
    /\(property\s+"Reference"\s+"([^"]*)"/.exec(fpText)?.[1] ?? /\(fp_text\s+reference\s+"?([^\s")]+)/.exec(fpText)?.[1] ?? null
  );
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

function isFillYes(text: string, fill: Span): boolean {
  return /^\(fill\s+yes\b/.test(text.slice(fill.start, fill.end));
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Apply non-overlapping edits back to front, so earlier offsets stay valid. */
function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  let floor = Infinity;
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (e.end > floor) throw new ZoneFillError('internal: overlapping zone edits');
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    floor = e.start;
  }
  return out;
}

/** Start of the whitespace run that ends at `pos`. */
function wsStart(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && /\s/.test(text[i - 1]!)) i--;
  return i;
}

/** The indentation of the zone's children, read from the last child on its own line. */
function childIndent(text: string, z: ZoneInfo): string {
  for (let k = z.kids.length - 1; k >= 0; k--) {
    const ws = text.slice(wsStart(text, z.kids[k]!.start), z.kids[k]!.start);
    const nl = ws.lastIndexOf('\n');
    if (nl >= 0) return ws.slice(nl + 1);
  }
  // a zone written on one line: one level deeper than the zone itself
  const ws = text.slice(wsStart(text, z.span.start), z.span.start);
  const own = ws.slice(ws.lastIndexOf('\n') + 1);
  return own + indentUnit(own);
}

/** KiCad 7 and older indent with two spaces, KiCad 8 and later with tabs; hand-written boards with either. */
function indentUnit(indent: string): string {
  return indent.includes('\t') ? '\t' : '  ';
}

/**
 * Re-indent a block copied from the refilled file (whose children sit at
 * `from`) to the original's style (children at `to`), with its line endings.
 * The first line starts at the span itself and carries no indentation.
 */
function reindent(block: string, from: string, to: string, eol: string): string {
  const fu = indentUnit(from);
  const tu = indentUnit(to);
  return block
    .split(/\r?\n/)
    .map((line, i) => {
      if (i === 0) return line;
      const lead = /^[ \t]*/.exec(line)![0];
      const rel = lead.startsWith(from) ? lead.slice(from.length) : '';
      const depth = fu === '\t' ? (rel.match(/\t/g)?.length ?? 0) : Math.floor(rel.length / fu.length);
      return to + tu.repeat(depth) + line.slice(lead.length);
    })
    .join(eol);
}

/** The board's format version (`(version 20240108)`), 0 when absent. */
export function boardVersion(text: string): number {
  return Number(/\(version\s+(\d+)\)/.exec(text.slice(0, 4096))?.[1] ?? 0);
}

/** A uuid derived from `seed`, so the same zone gets the same id on every refresh. */
function stableUuid(seed: string): string {
  const h = createHash('sha1').update(seed).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Give every zone a unique id. KiCad assigns a random uuid to a zone that has
 * none (or repeats one) when it loads the board, which would leave the
 * refilled copy's zone unmatchable; a hand-written pour often has none. The id
 * is derived from the zone's own text and position, so a second refresh gives
 * the same one. Uses the file's own id token (`tstamp` in KiCad 6/7 files).
 * Returns the text unchanged when every zone already has a unique id.
 */
export function assignZoneIds(text: string): string {
  const zones = listZones(text);
  const token = /\(uuid\s/.test(text) || !/\(tstamp\s/.test(text) ? 'uuid' : 'tstamp';
  const seen = new Set<string>();
  const edits: Edit[] = [];
  zones.forEach((z, i) => {
    if (z.key && !seen.has(z.key)) {
      seen.add(z.key);
      return;
    }
    // whitespace-free, so the same zone gets the same id with CRLF or LF, tabs or spaces
    const id = stableUuid(`${i}\n${squash(text.slice(z.span.start, z.span.end))}`);
    if (z.idSpan) {
      const old = text.slice(z.idSpan.start, z.idSpan.end);
      const tag = /^\(\s*(uuid|tstamp)/.exec(old)![1];
      edits.push({ ...z.idSpan, text: old.includes('"') ? `(${tag} "${id}")` : `(${tag} ${id})` });
    } else {
      const anchor = [...z.kids].reverse().find((k) => ['net', 'net_name', 'layer', 'layers'].includes(k.tag));
      const at = anchor ? anchor.end : z.span.start + '(zone'.length;
      edits.push({ start: at, end: at, text: token === 'uuid' ? ` (uuid "${id}")` : ` (tstamp ${id})` });
    }
    seen.add(z.key ? z.key.replace(/[^/]+$/, id) : id);
  });
  return edits.length ? applyEdits(text, edits) : text;
}

export interface ZoneSplice {
  text: string;
  /** Labels of the zones whose fill data or flags changed. */
  changed: string[];
}

/**
 * Put the refilled copy's fill data into the original text. Per zone, matched
 * by key: replace its `filled_polygon`/`fill_segments` children with the
 * refilled ones (re-indented to the original's style and line endings), mark
 * it `(fill yes`, and give it `(filled_areas_thickness no)` where the
 * original's format would otherwise read the new fill as a legacy, thicker
 * one: when the refilled zone carries the token, or the original file is an
 * older format than the refilled copy (KiCad 10 stopped writing the token; a
 * pre-10 zone without it is read as legacy and inflated). Nothing else changes.
 */
export function spliceZoneFills(original: string, refilled: string): ZoneSplice {
  const fresh = new Map<string, ZoneInfo>();
  for (const z of listZones(refilled)) if (z.key) fresh.set(z.key, z);
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const olderFormat = boardVersion(original) < boardVersion(refilled);
  const edits: Edit[] = [];
  const changed: string[] = [];

  for (const z of listZones(original)) {
    if (!z.key) throw new ZoneFillError(`${z.label} has no uuid; zones need ids before a refill can be matched (assignZoneIds)`);
    const r = fresh.get(z.key);
    if (!r) {
      throw new ZoneFillError(
        `KiCad dropped ${z.label} when it loaded the board, so it has no fill to take; ` +
          'its outline is likely one KiCad cannot use (fewer than three points, or self-intersecting): fix or remove that zone',
      );
    }
    if (!z.fillable) continue;
    const before = edits.length;
    const indent = childIndent(original, z);
    const header: string[] = [];

    const oldFill = z.fills.map((f) => original.slice(f.start, f.end)).join(' ');
    const newFill = r.fills.map((f) => refilled.slice(f.start, f.end)).join(' ');
    if (squash(oldFill) !== squash(newFill)) {
      const from = childIndent(refilled, r);
      const body = r.fills.map((f) => eol + indent + reindent(refilled.slice(f.start, f.end), from, indent, eol)).join('');
      if (z.fills.length) {
        z.fills.forEach((f, i) => edits.push({ start: wsStart(original, f.start), end: f.end, text: i === 0 ? body : '' }));
      } else {
        const last = z.kids[z.kids.length - 1];
        if (!last) throw new ZoneFillError(`${z.label} has no children to place a fill after`);
        edits.push({ start: last.end, end: last.end, text: body });
      }
    }

    if (r.fill && isFillYes(refilled, r.fill)) {
      if (z.fill) {
        const head = /^\(fill(?:\s+(?:yes|no)\b)?/.exec(original.slice(z.fill.start, z.fill.end))![0];
        if (!head.endsWith('yes')) edits.push({ start: z.fill.start, end: z.fill.start + head.length, text: '(fill yes' });
      } else {
        header.push('(fill yes)');
      }
    }

    const wantThickness = r.thickness ? /\bno\b/.test(refilled.slice(r.thickness.start, r.thickness.end)) : olderFormat;
    if (wantThickness) {
      if (z.thickness) {
        if (!/\bno\b/.test(original.slice(z.thickness.start, z.thickness.end))) {
          edits.push({ start: z.thickness.start, end: z.thickness.end, text: '(filled_areas_thickness no)' });
        }
      } else {
        const minThickness = z.kids.find((k) => k.tag === 'min_thickness');
        if (minThickness) edits.push({ start: minThickness.end, end: minThickness.end, text: ' (filled_areas_thickness no)' });
        else header.push('(filled_areas_thickness no)');
      }
    }

    if (header.length) {
      // before the fill settings, or the outline: where KiCad keeps zone settings
      const anchor = (!z.fill ? undefined : z.fill) ?? z.kids.find((k) => k.tag === 'polygon') ?? z.kids[0];
      if (!anchor) throw new ZoneFillError(`${z.label} has no children to place its fill settings beside`);
      const at = wsStart(original, anchor.start);
      edits.push({ start: at, end: at, text: header.map((h) => eol + indent + h).join('') });
    }
    if (edits.length > before) changed.push(z.label);
  }
  return { text: applyEdits(original, edits), changed };
}

/**
 * Pours whose fill differs between `refilled` (the copy KiCad filled and
 * saved) and `readBack` (the spliced board after KiCad loaded and saved it
 * without refilling), named by their labels in `refilled`. Both texts come
 * from the same kicad-cli's writer, so a pour KiCad reads exactly as it
 * computed it compares equal, whitespace aside. Empty when every pour matches.
 */
export function fillMismatches(refilled: string, readBack: string): string[] {
  const fills = (text: string): Map<string, { label: string; fill: string }> =>
    new Map(
      listZones(text)
        .filter((z) => z.fillable && z.key)
        .map((z) => [
          z.key!,
          {
            label: z.label,
            fill: `${z.fill && isFillYes(text, z.fill) ? 'yes' : 'no'} ${squash(z.fills.map((f) => text.slice(f.start, f.end)).join(' '))}`,
          },
        ]),
    );
  const got = fills(readBack);
  return [...fills(refilled)].filter(([key, want]) => got.get(key)?.fill !== want.fill).map(([, want]) => want.label);
}

/**
 * Violation types (and unconnected items) where the spliced board reports
 * more findings than KiCad's DRC of the refilled copy. Empty when the splice
 * reproduces KiCad's result. The fallback check where kicad-cli cannot resave.
 */
export function spliceRegressions(spliced: CheckReport, refilled: CheckReport): string[] {
  const count = (r: CheckReport): Map<string, number> => {
    const m = new Map<string, number>();
    for (const v of [...r.violations, ...(r.intrinsic ?? [])]) m.set(v.type, (m.get(v.type) ?? 0) + 1);
    return m;
  };
  const a = count(spliced);
  const b = count(refilled);
  const worse = [...a].filter(([type, n]) => n > (b.get(type) ?? 0)).map(([type, n]) => `${type} (${n} vs ${b.get(type) ?? 0})`);
  if ((spliced.unrouted ?? 0) > (refilled.unrouted ?? 0)) {
    worse.push(`unconnected items (${spliced.unrouted} vs ${refilled.unrouted ?? 0})`);
  }
  return worse;
}

/** The copy KiCad refilled and saved, and its DRC. */
export interface RefilledCopy {
  text: string;
  report: CheckReport;
}

const SPLICE_MISMATCH = "the spliced pour fills do not match KiCad's own refill";

/**
 * Check the splice against KiCad's own refill (design D5). The spliced text
 * is written over the scratch copy, and kicad-cli loads and saves it without
 * refilling (`pcb upgrade --force`); every pour must come back with exactly
 * the fill KiCad computed. That catches a mis-spliced zone, a fill KiCad
 * would read as a legacy one and inflate, and a future format change, and it
 * names the pour. Where kicad-cli cannot resave, it falls back to comparing
 * the spliced board's DRC with the refilled copy's, per violation type, which
 * catches only differences that DRC can see.
 */
export async function verifySplice(scratchPath: string, spliced: string, refilled: RefilledCopy): Promise<void> {
  await writeFile(scratchPath, spliced, 'utf8');
  if (await boardResaveSupported()) {
    try {
      await resaveBoard(scratchPath);
    } catch (err) {
      throw new ZoneFillError(
        `${SPLICE_MISMATCH}: KiCad cannot load the spliced board (${(err as Error).message}); the board was left as it was`,
      );
    }
    const differ = fillMismatches(refilled.text, await readFile(scratchPath, 'utf8'));
    if (differ.length) {
      throw new ZoneFillError(
        `${SPLICE_MISMATCH}: KiCad reads back a different fill for ${differ.join(', ')}; the board was left as it was`,
      );
    }
    return;
  }
  const worse = spliceRegressions(await runDrc(scratchPath), refilled.report);
  if (worse.length) {
    throw new ZoneFillError(
      `${SPLICE_MISMATCH}: the spliced board has more DRC findings (${worse.join(', ')}); the board was left as it was`,
    );
  }
}

/**
 * Run `fn` on a scratch copy of the board text, written under the board's own
 * file name beside copies of the project's rule files, so KiCad applies the
 * project's net classes and custom rules. The directory is removed after.
 */
async function inScratchProject<T>(boardPath: string, text: string, fn: (scratch: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-zones-'));
  try {
    const stem = path.basename(boardPath).replace(/\.kicad_pcb$/i, '');
    for (const ext of PROJECT_RULE_FILES) {
      const src = path.join(path.dirname(boardPath), stem + ext);
      if (existsSync(src)) await copyFile(src, path.join(dir, stem + ext));
    }
    const scratch = path.join(dir, `${stem}.kicad_pcb`);
    await writeFile(scratch, text, 'utf8');
    return await fn(scratch);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface ZoneFillRefresh {
  /** The board text with every zone's fill as KiCad computes it now; the input when nothing changed. */
  text: string;
  changed: boolean;
  /** Labels of the zones whose fill data or flags changed. */
  zones: string[];
  /** Zones that had no id (or a repeated one) and were given one. */
  idsAssigned: boolean;
  /**
   * KiCad's DRC of the refilled scratch copy: geometry and connectivity as
   * filled, under the project's rules. Library findings can differ from an
   * in-place run (the copy has no library tables beside it). Null when the
   * board has no fillable zone and kicad-cli was not run.
   */
  report: CheckReport | null;
}

/**
 * Refresh every zone fill on the board at `boardPath` (or on `text`, the
 * board's content when the caller already holds it), as KiCad would fill it
 * now with the project's rules. Never writes `boardPath`. Throws
 * ZoneRefillUnavailableError when kicad-cli cannot refill, and ZoneFillError
 * when a zone cannot be matched or KiCad reads the spliced fills differently.
 */
export async function refreshZoneFills(boardPath: string, text?: string): Promise<ZoneFillRefresh> {
  const original = text ?? (await readFile(boardPath, 'utf8'));
  if (!listZones(original).some((z) => z.fillable)) {
    return { text: original, changed: false, zones: [], idsAssigned: false, report: null };
  }
  if (!(await zoneRefillSupported())) throw new ZoneRefillUnavailableError();
  const withIds = assignZoneIds(original);
  return inScratchProject(boardPath, withIds, async (scratch) => {
    const report = await refillAndSave(scratch);
    const refilled = await readFile(scratch, 'utf8');
    const splice = spliceZoneFills(withIds, refilled);
    // a splice that changed nothing returns the board's own fills, already as KiCad computes them
    if (splice.text !== withIds) await verifySplice(scratch, splice.text, { text: refilled, report });
    return {
      text: splice.text,
      changed: splice.text !== original,
      zones: splice.changed,
      idsAssigned: withIds !== original,
      report,
    };
  });
}
