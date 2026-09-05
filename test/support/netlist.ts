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
 * Test-tree only: nothing here is part of the shipped CLI. It exists so the
 * engine can be pointed at real designs (see draft-real-corpus.test.ts).
 */
import { children, child, isList, parseSexp, type SexpNode } from '../../src/kicad/sexp.js';
import type { SchematicIntent } from '../../src/kicad/draft/ir.js';

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
}

export interface NetlistNet {
  name: string;
  nodes: { ref: string; pin: string }[];
}

export interface Netlist {
  parts: NetlistPart[];
  nets: NetlistNet[];
}

/** Parse a `kicad-cli sch export netlist` payload. */
export function parseNetlist(text: string): Netlist {
  const root = parseSexp(text)[0];
  if (!root || !isList(root)) throw new Error('unparseable netlist export');
  const comps = child(root, 'components');
  const nets = child(root, 'nets');
  const parts: NetlistPart[] = [];
  for (const c of comps ? children(comps, 'comp') : []) {
    const ls = child(c, 'libsource') ?? [];
    const sp = child(c, 'sheetpath') ?? [];
    parts.push({
      ref: atom(child(c, 'ref'), 1) ?? '',
      value: atom(child(c, 'value'), 1) ?? '',
      footprint: atom(child(c, 'footprint'), 1) ?? '',
      libId: `${atom(child(ls, 'lib'), 1) ?? ''}:${atom(child(ls, 'part'), 1) ?? ''}`,
      sheet: atom(child(sp, 'names'), 1) ?? '/',
    });
  }
  return {
    parts,
    nets: (nets ? children(nets, 'net') : []).map((n) => ({
      name: atom(child(n, 'name'), 1) ?? '',
      nodes: children(n, 'node').map((nd) => ({
        ref: atom(child(nd, 'ref'), 1) ?? '',
        pin: atom(child(nd, 'pin'), 1) ?? '',
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
