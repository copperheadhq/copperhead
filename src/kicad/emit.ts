import { createHash } from 'node:crypto';

/**
 * Deterministic KiCad schematic emitter (design D3/D4). A string-template
 * module, NOT a serializing parser: the read-only parser in sexp.ts stays
 * read-only, and this module builds canonical text directly from a placement
 * model. Identical models yield byte-identical files: every UUID derives from
 * a stable semantic path (UUIDv5), elements are emitted in a canonical sort
 * order, and numbers use KiCad's trailing-zero-trimmed formatting.
 */

/** Pinned format target: matches the scaffold (bootstrap.ts) and kicad-cli 8/9. */
export const EMIT_VERSION = '20231120';
export const EMIT_GENERATOR = 'copperhead-draft';
export const EMIT_GENERATOR_VERSION = '8.0';

/** Fixed namespace for copperhead-derived UUIDs (an arbitrary but constant v4). */
const COPPERHEAD_NAMESPACE = 'a1b2c3d4-0000-4000-8000-c0bbe4ead001';

/** RFC-4122 UUIDv5 (SHA-1, name-based). Same inputs, same UUID, any machine. */
export function uuidv5(name: string, namespace: string = COPPERHEAD_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** KiCad number formatting: up to 4 decimals, trailing zeros (and dot) trimmed. */
export const knum = (n: number): string => {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export interface EmitSymbol {
  ref: string;
  libId: string;
  value: string;
  footprint: string;
  at: { x: number; y: number; rot: number };
  /** Reference/Value text anchors (absolute). Hidden properties reuse the origin. */
  refAt: { x: number; y: number };
  valueAt: { x: number; y: number };
  /** Power-port symbols hide their reference text. */
  hideRef?: boolean;
  hideValue?: boolean;
  /** Pin numbers, for the per-pin uuid entries KiCad requires. */
  pinNumbers: string[];
}

export interface PlacementModel {
  projectName: string;
  paper: string;
  title: { title: string; date: string; rev: string };
  /** Verbatim `(symbol "Name" …)` source blocks keyed by target lib_id (design D3). */
  libSymbols: { libId: string; sourceText: string }[];
  symbols: EmitSymbol[];
  wires: { x1: number; y1: number; x2: number; y2: number; net: string; index: number }[];
  junctions: { x: number; y: number }[];
  labels: { name: string; x: number; y: number; rot: number }[];
  noConnects: { x: number; y: number }[];
  rectangles: { x1: number; y1: number; x2: number; y2: number; stroke: 'solid' | 'dash'; name: string }[];
  captions: { text: string; x: number; y: number; name: string }[];
}

/**
 * Rename a verbatim library `(symbol "Name" …)` block to its embedded lib_id.
 * Identifier atoms only; every other body byte stays exactly as vendored.
 *
 * The unit children (`Name_<unit>_<style>`) are renamed with the parent:
 * KiCad's schematic loader requires the child prefix to match the parent
 * name, so a derived symbol emitted under its own lib_id with the base's
 * children (`Regulator_Linear:AMS1117-3.3` wrapping `AP1117-15_0_1`) fails
 * to load outright. Children carry the BARE name, no library nickname,
 * matching how non-derived blocks already emit.
 */
export function renameSymbolBlock(sourceText: string, libId: string): string {
  const oldName = /^\s*\(symbol\s+"([^"]+)"/.exec(sourceText)?.[1];
  const bare = libId.includes(':') ? libId.slice(libId.indexOf(':') + 1) : libId;
  const escaped = libId.replace(/\$/g, '$$$$');
  let out = sourceText.replace(/^(\s*\(symbol\s+")[^"]+(")/, `$1${escaped}$2`);
  if (oldName && oldName !== bare) {
    const oldEsc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(`\\(symbol "${oldEsc}_(\\d+_\\d+)"`, 'g'),
      `(symbol "${bare.replace(/\$/g, '$$$$')}_$1"`,
    );
  }
  return out;
}

/** Re-indent a vendored block so lib_symbols nests consistently. Structural
 * whitespace only; token bytes are untouched. */
function indentBlock(block: string, indent: string): string {
  const lines = block.split('\n');
  const first = lines.find((l) => l.trim());
  const strip = first ? first.match(/^\s*/)![0].length : 0;
  return lines
    .map((l) => (l.trim() ? indent + (l.slice(0, strip).trim() === '' ? l.slice(strip) : l.trimStart()) : ''))
    .join('\n');
}

export function emitSchematic(model: PlacementModel): string {
  const ns = uuidv5(`project/${model.projectName}`);
  const id = (path: string): string => uuidv5(path, ns);
  const rootUuid = id('sheet/root');
  const L: string[] = [];
  L.push('(kicad_sch');
  L.push(`\t(version ${EMIT_VERSION})`);
  L.push(`\t(generator ${q(EMIT_GENERATOR)})`);
  L.push(`\t(generator_version ${q(EMIT_GENERATOR_VERSION)})`);
  L.push(`\t(uuid ${q(rootUuid)})`);
  L.push(`\t(paper ${q(model.paper)})`);
  L.push('\t(title_block');
  L.push(`\t\t(title ${q(model.title.title)})`);
  L.push(`\t\t(date ${q(model.title.date)})`);
  L.push(`\t\t(rev ${q(model.title.rev)})`);
  L.push('\t)');

  const libs = [...model.libSymbols].sort((a, b) => a.libId.localeCompare(b.libId));
  if (libs.length) {
    L.push('\t(lib_symbols');
    for (const lib of libs) L.push(indentBlock(renameSymbolBlock(lib.sourceText, lib.libId), '\t\t'));
    L.push('\t)');
  } else {
    L.push('\t(lib_symbols)');
  }

  const juncs = [...model.junctions].sort((a, b) => a.x - b.x || a.y - b.y);
  for (const j of juncs) {
    L.push(`\t(junction (at ${knum(j.x)} ${knum(j.y)})`);
    L.push('\t\t(diameter 0)');
    L.push('\t\t(color 0 0 0 0)');
    L.push(`\t\t(uuid ${q(id(`junction/${knum(j.x)},${knum(j.y)}`))})`);
    L.push('\t)');
  }

  const ncs = [...model.noConnects].sort((a, b) => a.x - b.x || a.y - b.y);
  for (const n of ncs) {
    L.push(`\t(no_connect (at ${knum(n.x)} ${knum(n.y)}) (uuid ${q(id(`no_connect/${knum(n.x)},${knum(n.y)}`))}))`);
  }

  const wires = [...model.wires].sort((a, b) => a.net.localeCompare(b.net) || a.index - b.index);
  for (const w of wires) {
    L.push('\t(wire');
    L.push(`\t\t(pts (xy ${knum(w.x1)} ${knum(w.y1)}) (xy ${knum(w.x2)} ${knum(w.y2)}))`);
    L.push('\t\t(stroke (width 0) (type default))');
    L.push(`\t\t(uuid ${q(id(`wire/${w.net}/${w.index}`))})`);
    L.push('\t)');
  }

  const rects = [...model.rectangles].sort((a, b) => a.name.localeCompare(b.name));
  for (const r of rects) {
    L.push(`\t(rectangle (start ${knum(r.x1)} ${knum(r.y1)}) (end ${knum(r.x2)} ${knum(r.y2)})`);
    L.push(`\t\t(stroke (width 0.152) (type ${r.stroke}))`);
    L.push('\t\t(fill (type none))');
    L.push(`\t\t(uuid ${q(id(`rect/${r.name}`))})`);
    L.push('\t)');
  }

  const caps = [...model.captions].sort((a, b) => a.name.localeCompare(b.name));
  for (const c of caps) {
    L.push(`\t(text ${q(c.text)} (at ${knum(c.x)} ${knum(c.y)} 0)`);
    L.push('\t\t(effects (font (size 2 2)) (justify left top))');
    L.push(`\t\t(uuid ${q(id(`caption/${c.name}`))})`);
    L.push('\t)');
  }

  const labels = [...model.labels].sort((a, b) => a.name.localeCompare(b.name) || a.x - b.x || a.y - b.y);
  for (const lb of labels) {
    const justify = lb.rot === 180 || lb.rot === 270 ? 'right bottom' : 'left bottom';
    const drawRot = lb.rot === 180 ? 0 : lb.rot === 270 ? 90 : lb.rot;
    L.push(`\t(label ${q(lb.name)} (at ${knum(lb.x)} ${knum(lb.y)} ${knum(drawRot)})`);
    L.push(`\t\t(effects (font (size 1.27 1.27)) (justify ${justify}))`);
    L.push(`\t\t(uuid ${q(id(`label/${lb.name}/${knum(lb.x)},${knum(lb.y)}`))})`);
    L.push('\t)');
  }

  const syms = [...model.symbols].sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  for (const s of syms) {
    const sid = id(`symbol/${s.ref}`);
    const hideRef = s.hideRef ? ' hide' : '';
    const hideValue = s.hideValue ? ' hide' : '';
    L.push('\t(symbol');
    L.push(`\t\t(lib_id ${q(s.libId)})`);
    L.push(`\t\t(at ${knum(s.at.x)} ${knum(s.at.y)} ${knum(s.at.rot)})`);
    L.push('\t\t(unit 1)');
    L.push('\t\t(exclude_from_sim no)');
    L.push('\t\t(in_bom yes)');
    L.push('\t\t(on_board yes)');
    L.push('\t\t(dnp no)');
    L.push(`\t\t(uuid ${q(sid)})`);
    L.push(`\t\t(property "Reference" ${q(s.ref)} (at ${knum(s.refAt.x)} ${knum(s.refAt.y)} 0)`);
    L.push(`\t\t\t(effects (font (size 1.27 1.27))${hideRef})`);
    L.push('\t\t)');
    L.push(`\t\t(property "Value" ${q(s.value)} (at ${knum(s.valueAt.x)} ${knum(s.valueAt.y)} 0)`);
    L.push(`\t\t\t(effects (font (size 1.27 1.27))${hideValue})`);
    L.push('\t\t)');
    L.push(`\t\t(property "Footprint" ${q(s.footprint)} (at ${knum(s.at.x)} ${knum(s.at.y)} 0)`);
    L.push('\t\t\t(effects (font (size 1.27 1.27)) hide)');
    L.push('\t\t)');
    L.push(`\t\t(property "Datasheet" "~" (at ${knum(s.at.x)} ${knum(s.at.y)} 0)`);
    L.push('\t\t\t(effects (font (size 1.27 1.27)) hide)');
    L.push('\t\t)');
    for (const pin of s.pinNumbers) {
      L.push(`\t\t(pin ${q(pin)} (uuid ${q(id(`symbol/${s.ref}/pin/${pin}`))}))`);
    }
    L.push('\t\t(instances');
    L.push(`\t\t\t(project ${q(model.projectName)}`);
    L.push(`\t\t\t\t(path ${q('/' + rootUuid)} (reference ${q(s.ref)}) (unit 1))`);
    L.push('\t\t\t)');
    L.push('\t\t)');
    L.push('\t)');
  }

  L.push('\t(sheet_instances');
  L.push('\t\t(path "/" (page "1"))');
  L.push('\t)');
  L.push(')');
  return L.join('\n') + '\n';
}