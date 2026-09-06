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
  /** KiCad `(mirror x|y)`: y flips the symbol left-for-right (a transistor whose base must face right). */
  mirror?: 'x' | 'y';
  /** Reference/Value text anchors (absolute). Hidden properties reuse the origin. */
  refAt: { x: number; y: number };
  valueAt: { x: number; y: number };
  /** Power-port symbols hide their reference text. */
  hideRef?: boolean;
  hideValue?: boolean;
  /** Pin numbers, for the per-pin uuid entries KiCad requires. For a
   * multi-unit instance these are that UNIT's pins only. */
  pinNumbers: string[];
  /** KiCad unit number for one placed unit of a multi-unit symbol. Several
   * entries may share a `ref`, one per unit; omitted means unit 1. */
  unit?: number;
}

/** Flag outline of a global label: KiCad's shape vocabulary, chosen from the
 * electrical type of the pin the label serves (`shape` is cosmetic in ERC). */
export type LabelShape = 'input' | 'output' | 'bidirectional' | 'passive';

export interface EmitLabel {
  name: string;
  x: number;
  y: number;
  /** KiCad's own rotation: text extends right (0), up (90), left (180) or
   * down (270) from the anchor, in schematic Y-down coordinates. */
  rot: number;
  /** A `global` label draws as a bordered flag whose tip sits on the wire
   * end; a `local` one is bare text standing on its wire. Nets that leave a
   * wired run through a stub carry global flags everywhere (a local and a
   * global label of one name do not connect in KiCad); a net wired whole
   * keeps a plain local name on the run. Unstated means local. */
  kind?: 'local' | 'global';
  /** Flag shape of a global label; unstated means passive (a plain box). */
  shape?: LabelShape;
}

/** Font height, mm, of a group caption; bold so a subsystem title reads at
 * arm's length on an A1/A2 sheet. */
export const CAPTION_SIZE = 3.5;
/** Font height, mm, of every net label. */
export const LABEL_SIZE = 1.27;
/** Stroke thickness, mm, of label text and the flag outline drawn with it;
 * KiCad's default is size/8 ≈ 0.16, too faint against a coloured wire. */
export const LABEL_THICKNESS = 0.2;
/** Wire stroke width, mm; 0 would mean KiCad's default of 0.1524. */
export const WIRE_WIDTH = 0.254;

export interface PlacementModel {
  projectName: string;
  paper: string;
  title: { title: string; date: string; rev: string };
  /** Verbatim `(symbol "Name" …)` source blocks keyed by target lib_id (design D3). */
  libSymbols: { libId: string; sourceText: string }[];
  symbols: EmitSymbol[];
  wires: { x1: number; y1: number; x2: number; y2: number; net: string; index: number }[];
  junctions: { x: number; y: number }[];
  labels: EmitLabel[];
  noConnects: { x: number; y: number }[];
  rectangles: { x1: number; y1: number; x2: number; y2: number; stroke: 'solid' | 'dash'; name: string }[];
  captions: { text: string; x: number; y: number; name: string }[];
  /** Wire and label colour per net, RGB 0..255; nets absent here draw in the theme default. */
  netColors?: Record<string, [number, number, number]>;
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

  const colorOf = (net: string): string => {
    const c = model.netColors?.[net];
    return c ? ` (color ${c[0]} ${c[1]} ${c[2]} 1)` : '';
  };
  const wires = [...model.wires].sort((a, b) => a.net.localeCompare(b.net) || a.index - b.index);
  for (const w of wires) {
    L.push('\t(wire');
    L.push(`\t\t(pts (xy ${knum(w.x1)} ${knum(w.y1)}) (xy ${knum(w.x2)} ${knum(w.y2)}))`);
    L.push(`\t\t(stroke (width ${knum(WIRE_WIDTH)}) (type default)${colorOf(w.net)})`);
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
    L.push(`\t\t(effects (font (size ${knum(CAPTION_SIZE)} ${knum(CAPTION_SIZE)}) bold) (justify left top))`);
    L.push(`\t\t(uuid ${q(id(`caption/${c.name}`))})`);
    L.push('\t)');
  }

  const labels = [...model.labels].sort((a, b) => a.name.localeCompare(b.name) || a.x - b.x || a.y - b.y);
  for (const lb of labels) {
    const uuid = q(id(`label/${lb.name}/${knum(lb.x)},${knum(lb.y)}`));
    if (lb.kind === 'global') {
      // eeschema's own encoding of a flag: the stored angle is the true one
      // and the justification names the side of the anchor the text is on
      // (left = extends right/up, right = extends left/down)
      const rot = ((lb.rot % 360) + 360) % 360;
      const justify = rot === 180 || rot === 270 ? 'right' : 'left';
      L.push(`\t(global_label ${q(lb.name)} (shape ${lb.shape ?? 'passive'}) (at ${knum(lb.x)} ${knum(lb.y)} ${knum(rot)}) (fields_autoplaced yes)`);
      L.push(`\t\t(effects (font (size ${knum(LABEL_SIZE)} ${knum(LABEL_SIZE)}) (thickness ${knum(LABEL_THICKNESS)})${colorOf(lb.name)}) (justify ${justify}))`);
      L.push(`\t\t(uuid ${uuid})`);
      L.push(`\t\t(property "Intersheetrefs" "\${INTERSHEET_REFS}" (at ${knum(lb.x)} ${knum(lb.y)} 0)`);
      L.push(`\t\t\t(effects (font (size ${knum(LABEL_SIZE)} ${knum(LABEL_SIZE)})) hide)`);
      L.push('\t\t)');
      L.push('\t)');
      continue;
    }
    // a local label never draws upside down: 180/270 are drawn as 0/90 with
    // the justification mirrored, which is how eeschema itself stores them
    const justify = lb.rot === 180 || lb.rot === 270 ? 'right bottom' : 'left bottom';
    const drawRot = lb.rot === 180 ? 0 : lb.rot === 270 ? 90 : lb.rot;
    L.push(`\t(label ${q(lb.name)} (at ${knum(lb.x)} ${knum(lb.y)} ${knum(drawRot)})`);
    L.push(`\t\t(effects (font (size ${knum(LABEL_SIZE)} ${knum(LABEL_SIZE)}) (thickness ${knum(LABEL_THICKNESS)})${colorOf(lb.name)}) (justify ${justify}))`);
    L.push(`\t\t(uuid ${uuid})`);
    L.push('\t)');
  }

  const syms = [...model.symbols].sort(
    (a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }) || (a.unit ?? 1) - (b.unit ?? 1),
  );
  for (const s of syms) {
    const unit = s.unit ?? 1;
    // unit 1 keeps the historical uuid path so single-unit boards stay
    // byte-identical; further units get their own stable path
    const sid = id(unit === 1 ? `symbol/${s.ref}` : `symbol/${s.ref}/unit/${unit}`);
    const hideRef = s.hideRef ? ' hide' : '';
    const hideValue = s.hideValue ? ' hide' : '';
    L.push('\t(symbol');
    L.push(`\t\t(lib_id ${q(s.libId)})`);
    L.push(`\t\t(at ${knum(s.at.x)} ${knum(s.at.y)} ${knum(s.at.rot)})`);
    if (s.mirror) L.push(`\t\t(mirror ${s.mirror})`);
    L.push(`\t\t(unit ${unit})`);
    L.push('\t\t(exclude_from_sim no)');
    L.push('\t\t(in_bom yes)');
    L.push('\t\t(on_board yes)');
    L.push('\t\t(dnp no)');
    L.push(`\t\t(uuid ${q(sid)})`);
    // KiCad adds the symbol's rotation to a property's angle when it draws
    // the text, so a part turned 90 or 270 stores 90 to keep its reference
    // and value reading horizontally (every rotated resistor in KiCad's own
    // demos does). Storing 0 stood the bootstrap caps' values on end.
    const fieldRot = s.at.rot % 180 === 90 ? 90 : 0;
    L.push(`\t\t(property "Reference" ${q(s.ref)} (at ${knum(s.refAt.x)} ${knum(s.refAt.y)} ${fieldRot})`);
    L.push(`\t\t\t(effects (font (size 1.27 1.27))${hideRef})`);
    L.push('\t\t)');
    L.push(`\t\t(property "Value" ${q(s.value)} (at ${knum(s.valueAt.x)} ${knum(s.valueAt.y)} ${fieldRot})`);
    L.push(`\t\t\t(effects (font (size 1.27 1.27))${hideValue})`);
    L.push('\t\t)');
    L.push(`\t\t(property "Footprint" ${q(s.footprint)} (at ${knum(s.at.x)} ${knum(s.at.y)} 0)`);
    L.push('\t\t\t(effects (font (size 1.27 1.27)) hide)');
    L.push('\t\t)');
    L.push(`\t\t(property "Datasheet" "~" (at ${knum(s.at.x)} ${knum(s.at.y)} 0)`);
    L.push('\t\t\t(effects (font (size 1.27 1.27)) hide)');
    L.push('\t\t)');
    for (const pin of s.pinNumbers) {
      // units ≥ 2 scope their pin uuids: a common (unit-0) pin appears on
      // every placed unit, and identical paths would mint duplicate uuids
      const pinPath = unit === 1 ? `symbol/${s.ref}/pin/${pin}` : `symbol/${s.ref}/unit/${unit}/pin/${pin}`;
      L.push(`\t\t(pin ${q(pin)} (uuid ${q(id(pinPath))}))`);
    }
    L.push('\t\t(instances');
    L.push(`\t\t\t(project ${q(model.projectName)}`);
    L.push(`\t\t\t\t(path ${q('/' + rootUuid)} (reference ${q(s.ref)}) (unit ${unit}))`);
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