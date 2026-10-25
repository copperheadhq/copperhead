/**
 * Reading a real KiCad netlist export, and turning it into a drafting IR.
 *
 * The engine's input is `schematic.intent.json`: parts, and nets named by the
 * pins they join. A real design carries the same information, but the sheet
 * states most of it geometrically (two pins are on one net because a wire runs
 * between them, not because anyone labelled it). Extracting that from the
 * `.kicad_sch` directly means re-deriving connectivity, and the repo already
 * has a better source: `kicad-cli sch export netlist` makes KiCad itself
 * flatten the hierarchy, resolve the buses, and name every net, including the
 * ones the designer never named (`Net-(D15-1)`).
 *
 * So this module reads that export rather than the schematic. The format is an
 * s-expression, so the repo's own read-only parser handles it and no new
 * parser enters the tree.
 *
 * Product code: the ingestion path (`src/kicad/design-graph.ts`) and the
 * corpus tooling share this extractor so they cannot drift apart. The test
 * helper at `test/support/netlist.ts` re-exports from here.
 */
import { children, child, isList, parseSexp, type SexpNode } from './sexp.js';
import type { SchematicIntent } from './draft/ir.js';

const atom = (n: SexpNode[] | undefined, i: number): string | undefined => {
  const v = n?.[i];
  return typeof v === 'string' ? v : undefined;
};

export interface NetlistPart {
  ref: string;
  value: string;
  footprint: string;
  /** `lib:part` from libsource. The lib half is empty when KiCad recorded none. */
  libId: string;
  /** Sheet path the part sits on, e.g. `/power`. `/` for a flat design. */
  sheet: string;
  /** Stable per-object identity from `comp > tstamps` (empty when absent). */
  tstamps: string;
  /** Arbitrary `comp > fields > field` entries (MPN, Manufacturer, LCSC, custom). */
  fields: Record<string, string>;
  /** Datasheet URL from fields or libpart (empty when `~` or absent). */
  datasheet: string;
  /** Human description from libsource or libpart (empty when absent). */
  description: string;
  /** Sheet file from properties when the export carries it (empty when absent). */
  sheetFile: string;
  /** Multi-unit package structure from `comp > units` (empty for single-unit). */
  units: { name: string; pins: string[] }[];
}

export interface NetlistNode {
  ref: string;
  pin: string;
  /** Pin electrical type from the export (`power_in`, `passive`, empty when absent). */
  pintype: string;
  /** Pin function from the export (empty when absent). */
  pinfunction: string;
}

export interface NetlistNet {
  name: string;
  /** Netclass from `net > class` (`Default` when absent). */
  netclass: string;
  nodes: NetlistNode[];
}

export interface Netlist {
  parts: NetlistPart[];
  nets: NetlistNet[];
}

const NET_ESCAPES: Record<string, string> = {
  slash: '/', dblquote: '"', quote: "'", lt: '<', gt: '>', backslash: '\\', bar: '|',
  comma: ',', colon: ':', brace: '{', space: ' ', tab: '\t', dollar: '$', return: '\n',
};

/** KiCad escapes reserved characters in exported net names as `{slash}`, `{dblquote}`, and so on. */
export function unescapeNetName(name: string): string {
  return name.replace(/\{([a-z]+)\}/g, (m, k: string) => NET_ESCAPES[k] ?? m);
}

function cleanDatasheet(v: string | undefined): string {
  if (!v) return '';
  const t = v.trim();
  if (!t || t === '~') return '';
  return t;
}

function readFields(comp: SexpNode[]): Record<string, string> {
  const out: Record<string, string> = {};
  const fields = child(comp, 'fields');
  if (!fields) return out;
  for (const f of children(fields, 'field')) {
    const name = atom(child(f, 'name'), 1) ?? atom(f, 1);
    const value = atom(f, 2) ?? atom(child(f, 'value'), 1) ?? '';
    if (name) out[name] = value;
  }
  return out;
}

function readUnits(comp: SexpNode[]): { name: string; pins: string[] }[] {
  const unitsNode = child(comp, 'units');
  if (!unitsNode) return [];
  const out: { name: string; pins: string[] }[] = [];
  for (const u of children(unitsNode, 'unit')) {
    const name = atom(child(u, 'name'), 1) ?? atom(u, 1) ?? '';
    const pins: string[] = [];
    const pinsNode = child(u, 'pins');
    if (pinsNode) {
      for (const p of children(pinsNode, 'pin')) {
        const num = atom(child(p, 'num'), 1) ?? atom(p, 1) ?? '';
        if (num) pins.push(num);
      }
    }
    if (name) out.push({ name, pins });
  }
  return out;
}

/** Parse a `kicad-cli sch export netlist` payload. */
export function parseNetlist(text: string): Netlist {
  const root = parseSexp(text)[0];
  if (!root || !isList(root)) throw new Error('unparseable netlist export');
  const comps = child(root, 'components');
  const libparts = child(root, 'libparts');
  const libByPart = new Map<string, SexpNode[]>();
  if (libparts) {
    for (const lp of children(libparts, 'libpart')) {
      const lib = atom(child(lp, 'lib'), 1) ?? '';
      const part = atom(child(lp, 'part'), 1) ?? '';
      if (part) libByPart.set(`${lib}:${part}`, lp);
      if (part && !libByPart.has(part)) libByPart.set(part, lp);
    }
  }
  const nets = child(root, 'nets');
  const parts: NetlistPart[] = [];
  for (const c of comps ? children(comps, 'comp') : []) {
    const ls = child(c, 'libsource') ?? [];
    const sp = child(c, 'sheetpath') ?? [];
    const lib = atom(child(ls, 'lib'), 1) ?? '';
    const part = atom(child(ls, 'part'), 1) ?? '';
    const libId = `${lib}:${part}`;
    const fields = readFields(c);
    const lp = libByPart.get(libId) ?? libByPart.get(part);
    let libDatasheet = '';
    let libDescription = '';
    if (lp) {
      const lpFields = readFields(lp);
      libDatasheet = cleanDatasheet(lpFields['Datasheet']);
      libDescription = lpFields['Description'] ?? '';
      if (!libDescription) libDescription = atom(child(lp, 'description'), 1) ?? '';
    }
    const libSourceDesc = atom(child(ls, 'description'), 1) ?? '';
    // KiCad writes the sheet as plain `(property (name "Sheetfile") (value ...))` children of `comp`.
    let sheetFile = '';
    for (const p of children(c, 'property')) {
      const n = (atom(child(p, 'name'), 1) ?? '').toLowerCase();
      if (n === 'sheetfile' || (n === 'sheetname' && !sheetFile)) sheetFile = atom(child(p, 'value'), 1) ?? '';
    }
    parts.push({
      ref: atom(child(c, 'ref'), 1) ?? '',
      value: atom(child(c, 'value'), 1) ?? '',
      footprint: atom(child(c, 'footprint'), 1) ?? '',
      libId,
      sheet: atom(child(sp, 'names'), 1) ?? '/',
      tstamps: atom(child(c, 'tstamps'), 1) ?? '',
      fields,
      datasheet: cleanDatasheet(fields['Datasheet']) || libDatasheet,
      description: libSourceDesc || libDescription,
      sheetFile,
      units: readUnits(c),
    });
  }
  return {
    parts,
    nets: (nets ? children(nets, 'net') : []).map((n) => ({
      name: unescapeNetName(atom(child(n, 'name'), 1) ?? ''),
      netclass: atom(child(n, 'class'), 1) ?? 'Default',
      nodes: children(n, 'node').map((nd) => ({
        ref: atom(child(nd, 'ref'), 1) ?? '',
        pin: atom(child(nd, 'pin'), 1) ?? '',
        pintype: atom(child(nd, 'pintype'), 1) ?? '',
        pinfunction: atom(child(nd, 'pinfunction'), 1) ?? '',
      })),
    })),
  };
}

/**
 * Netlist to IR.
 *
 * Two lossy steps, both deliberate. The group comes from the sheet path, which
 * is the closest thing a flattened design has to the subsystem structure the
 * engine groups by. And a net with one node is dropped: it is a pin connected
 * to nothing, which the IR cannot express (a net needs two endpoints) and which
 * a real export still lists.
 */
export function netlistToIntent(nl: Netlist): SchematicIntent {
  const groupOf = (sheet: string): string => {
    const seg = sheet.split('/').filter(Boolean);
    return seg.length ? seg[seg.length - 1]! : 'Main';
  };
  return {
    version: 1,
    parts: nl.parts.map((p) => ({
      ref: p.ref,
      libId: p.libId,
      value: p.value,
      footprint: p.footprint || undefined,
      group: groupOf(p.sheet),
    })),
    nets: nl.nets
      .filter((n) => n.nodes.length >= 2)
      .map((n) => ({ name: n.name, pins: n.nodes.map((nd) => `${nd.ref}.${nd.pin}`) })),
  };
}

/**
 * The connectivity of a netlist as a set of pin groups, ignoring net names.
 *
 * Names are not the contract: the engine may legitimately carry a net through
 * under the name it was given, but what must survive drafting is *which pins
 * end up joined to which*. Comparing partitions rather than names also keeps
 * the check honest across KiCad's auto-naming, which numbers unnamed nets by
 * the first pin it meets and would otherwise churn on placement changes.
 */
export function netPartition(nl: Netlist): Set<string> {
  return new Set(
    nl.nets
      .filter((n) => n.nodes.length >= 2)
      .map((n) =>
        n.nodes
          .map((nd) => `${nd.ref}.${nd.pin}`)
          .sort()
          .join('|'),
      ),
  );
}

/** Coarse bucket for a validation finding, so a sweep can report shape not prose. */
export type RefusalKind = 'multi-unit' | 'symbol-unresolved' | 'missing-pin' | 'merged-net' | 'short-net' | 'other';

export function classifyRefusal(detail: string): RefusalKind {
  if (/multi-unit|in more than one unit|outside its default-style units/.test(detail)) return 'multi-unit';
  if (/come into (WIRE|LABEL) contact|share a label point|merge/i.test(detail)) return 'merged-net';
  if (/has no pin/.test(detail)) return 'missing-pin';
  if (/is not installed and not vendored|does not exist in the library|is wrong about the library/.test(detail)) {
    return 'symbol-unresolved';
  }
  if (/at least two/.test(detail)) return 'short-net';
  return 'other';
}
