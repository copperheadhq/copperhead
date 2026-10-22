import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { listSymbols, listSheetFiles, pinNets, type SchematicSymbol, type PinNet } from './sexp.js';
import { parseNetlist, type Netlist } from './netlist.js';
import { ensureIgnored } from '../util/git.js';

/**
 * Normalized design graph (issue #248, step 1 for #247).
 *
 * Deterministic, LLM-free, network-free. The s-expression parser stays the
 * source of truth for geometry (which no export gives). The `kicad-cli`
 * netlist export is the source of truth for connectivity, part identity, and
 * BOM fields when it can be produced. The graph is a derived artifact: the
 * header carries the source hashes it was derived from so staleness is
 * detectable without re-parsing, and consumers must never treat it as a
 * second source of truth that can disagree with the KiCad files.
 */

export const DESIGN_GRAPH_VERSION = 1;

export type PartClass = 'ic' | 'passive' | 'discrete' | 'connector' | 'power' | 'mechanical';

export interface GraphPin {
  num: string;
  name: string;
  type: string;
  net: string | null;
}

export interface GraphPart {
  ref: string;
  uuid: string;
  value: string;
  libId: string;
  footprint: string;
  class: PartClass;
  /** Raw evidence the classification was derived from (auditable). */
  classEvidence: string;
  sheet: string;
  sheetFile: string;
  dnp: boolean;
  excludeFromBom: boolean;
  fields: Record<string, string>;
  mpn: string;
  manufacturer: string;
  lcsc: string;
  datasheet: string;
  description: string;
  units: { name: string; pins: string[] }[];
  pins: GraphPin[];
}

export interface GraphNetNode {
  ref: string;
  pin: string;
  pintype: string;
  pinfunction: string;
}

export interface GraphNet {
  name: string;
  netclass: string;
  nodes: GraphNetNode[];
}

export interface DesignGraph {
  version: number;
  generated: {
    kicadCli: string | null;
    partial: boolean;
    partialReason: string | null;
    sources: { path: string; sha256: string }[];
  };
  parts: GraphPart[];
  nets: GraphNet[];
  board: null;
  sync: { schematicOnly: string[]; boardOnly: string[]; netMismatches: string[] };
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

const MPN_KEYS = ['mpn', 'manufacturerpartnumber', 'mfrpartnumber', 'mfrpart', 'partnumber'];
const MANUFACTURER_KEYS = ['manufacturer', 'mfr', 'mfg'];
const LCSC_KEYS = ['lcsc', 'lcscpart', 'lcscpartnumber'];
const PLACEHOLDERS = new Set(['', '~', '-', 'n/a', 'na', 'tbd']);

function pickField(fields: Record<string, string>, keys: string[]): string {
  const norm = new Map<string, string>();
  for (const [k, v] of Object.entries(fields)) norm.set(k.toLowerCase().replace(/[^a-z0-9]/g, ''), v);
  for (const k of keys) {
    const v = norm.get(k);
    if (v !== undefined && !PLACEHOLDERS.has(v.trim().toLowerCase())) return v.trim();
  }
  return '';
}

/** MPN from schematic fields (empty when the project carries none, never invented). */
export function mpnOf(sym: SchematicSymbol): string {
  return pickField(sym.fields, MPN_KEYS);
}

export function manufacturerOf(sym: SchematicSymbol): string {
  return pickField(sym.fields, MANUFACTURER_KEYS);
}

export function lcscOf(sym: SchematicSymbol): string {
  return pickField(sym.fields, LCSC_KEYS);
}

/**
 * Chip classification, derived not prefixed.
 *
 * The old scaffold used `ref.startsWith('U')`, so connectors, regulators
 * addressed as `VR1`, MOSFETs, and crystals never made the pinout, while a
 * `U`-prefixed part was always a chip. This derives the class from the
 * library category, the footprint family, and the pin count, and keeps the
 * raw evidence so the classification is auditable.
 */
export function classifyPart(sym: Pick<SchematicSymbol, 'ref' | 'libId' | 'footprint'>, pinCount: number): { class: PartClass; evidence: string } {
  const lib = sym.libId;
  const libCat = lib.includes(':') ? lib.slice(0, lib.indexOf(':')) : '';
  const fpItem = sym.footprint.includes(':')
    ? sym.footprint.slice(sym.footprint.lastIndexOf(':') + 1)
    : sym.footprint;
  const refPrefix = sym.ref.replace(/[^A-Za-z].*$/, '');
  if (/^power$/i.test(libCat)) return { class: 'power', evidence: `lib:${lib}` };
  if (/connector/i.test(libCat) || /connector/i.test(lib)) return { class: 'connector', evidence: `lib:${lib}` };
  if (/mechanical|mountinghole/i.test(libCat) || /mechanical|mountinghole/i.test(lib)) {
    return { class: 'mechanical', evidence: `lib:${lib}` };
  }
  if (/^[RCL]_/.test(fpItem.trim()) && pinCount <= 2) {
    return { class: 'passive', evidence: `footprint:${sym.footprint},pins:${pinCount}` };
  }
  if (/^(R|C|L)$/i.test(refPrefix) && pinCount <= 2) return { class: 'passive', evidence: `ref:${sym.ref},pins:${pinCount}` };
  if (/^RN$/i.test(refPrefix)) return { class: 'passive', evidence: `ref:${sym.ref},pins:${pinCount}` };
  if (/^(J|P|CONN)$/i.test(refPrefix) || /^(J|P)_/.test(sym.ref)) {
    return { class: 'connector', evidence: `ref:${sym.ref},lib:${lib}` };
  }
  if (/^(MH|MOUNT|FID|LOGO)$/i.test(refPrefix)) return { class: 'mechanical', evidence: `ref:${sym.ref}` };
  // Small discretes (diodes, LEDs, transistors, crystals, fuses, switches, ...) are not chips:
  // their pins do not belong in the pinout.
  if (pinCount <= 3 && (/^(D|LED|Q|Y|X|SW|F|FB|JP|RV|TP|CP|TVS|ESD)$/i.test(refPrefix) || libCat === 'Device')) {
    return { class: 'discrete', evidence: `ref:${sym.ref},lib:${lib},pins:${pinCount}` };
  }
  return { class: 'ic', evidence: `lib:${lib},ref:${sym.ref},pins:${pinCount}` };
}

/** Parts worth a pinout row: ICs and connectors (plus multi-pin unknowns classed ic). Passives and mechanicals stay out. */
export function isPinoutWorthy(cls: PartClass): boolean {
  return cls === 'ic' || cls === 'connector';
}

export interface GraphSources {
  schPath: string;
  schText: string;
  repoRoot: string;
}

async function tryNetlist(schPath: string): Promise<{ netlist: Netlist | null; kicadCli: string | null; reason: string | null }> {
  try {
    const { exportNetlist, kicadCliVersion } = await import('./cli.js');
    const text = await exportNetlist(schPath);
    return { netlist: parseNetlist(text), kicadCli: await kicadCliVersion().catch(() => null), reason: null };
  } catch (err) {
    return { netlist: null, kicadCli: null, reason: String((err as Error).message).slice(0, 300) };
  }
}

/** Collapse multi-unit placements to one symbol per ref (first placement wins; DNP/BOM flags are per-ref). */
function uniqueByRef(symbols: SchematicSymbol[]): SchematicSymbol[] {
  const byRef = new Map<string, SchematicSymbol>();
  for (const s of symbols) if (!byRef.has(s.ref)) byRef.set(s.ref, s);
  return [...byRef.values()];
}

/**
 * Build the normalized graph. With a netlist, parts, pins and nets all come from
 * it (one part per netlist component, pin nets named exactly as in `nets[]`);
 * the s-expression symbols only add geometry-side data (DNP and BOM flags,
 * pin names) joined by uuid, then ref. Without one, symbols collapse to one
 * part per ref and the graph is partial.
 */
export function buildGraph(
  symbols: SchematicSymbol[],
  pins: PinNet[],
  netlist: Netlist | null,
  sources: { path: string; sha256: string }[],
  kicadCli: string | null,
  partialReason: string | null,
): DesignGraph {
  const sexpPins = new Map<string, PinNet>();
  for (const p of pins) {
    const k = `${p.ref}:${p.pinNumber}`;
    const prev = sexpPins.get(k);
    if (!prev || (prev.net === null && p.net !== null)) sexpPins.set(k, p);
  }
  const symByRef = new Map(uniqueByRef(symbols).map((s) => [s.ref, s]));
  const symByUuid = new Map(symbols.filter((s) => s.uuid).map((s) => [s.uuid, s]));

  const nets: GraphNet[] = [];
  const netlistPins = new Map<string, GraphPin[]>();
  const pinOf = (ref: string, num: string, fallbackName: string, type: string, net: string | null): GraphPin => ({
    num,
    name: sexpPins.get(`${ref}:${num}`)?.pinName || fallbackName,
    type,
    net,
  });
  if (netlist) {
    for (const n of netlist.nets) {
      nets.push({
        name: n.name,
        netclass: n.netclass,
        nodes: n.nodes.map((nd) => ({ ref: nd.ref, pin: nd.pin, pintype: nd.pintype, pinfunction: nd.pinfunction })),
      });
      for (const nd of n.nodes) {
        const arr = netlistPins.get(nd.ref) ?? [];
        arr.push(pinOf(nd.ref, nd.pin, nd.pinfunction, nd.pintype, n.name));
        netlistPins.set(nd.ref, arr);
      }
    }
  } else {
    const grouped = new Map<string, GraphNetNode[]>();
    for (const p of sexpPins.values()) {
      if (!p.net) continue;
      const arr = grouped.get(p.net) ?? [];
      arr.push({ ref: p.ref, pin: p.pinNumber, pintype: '', pinfunction: '' });
      grouped.set(p.net, arr);
    }
    for (const [name, nodes] of grouped) nets.push({ name, netclass: 'Default', nodes });
  }

  const byPin = (a: GraphPin, b: GraphPin): number => a.num.localeCompare(b.num, undefined, { numeric: true });
  const build = (
    ref: string,
    s: SchematicSymbol | undefined,
    nl: Netlist['parts'][number] | undefined,
    graphPins: GraphPin[],
  ): GraphPart => {
    const libId = s?.libId ?? nl?.libId ?? '';
    const footprint = s?.footprint ?? nl?.footprint ?? '';
    graphPins.sort(byPin);
    const { class: cls, evidence } = classifyPart({ ref, libId, footprint }, graphPins.length);
    const fields = { ...(s?.fields ?? {}), ...(nl?.fields ?? {}) };
    return {
      ref,
      uuid: s?.uuid || nl?.tstamps || '',
      value: s?.value ?? nl?.value ?? '',
      libId,
      footprint,
      class: cls,
      classEvidence: evidence,
      sheet: s?.sheet ?? nl?.sheet ?? '',
      sheetFile: nl?.sheetFile ?? '',
      dnp: s?.dnp ?? false,
      excludeFromBom: s ? !s.inBom : false,
      fields,
      mpn: pickField(fields, MPN_KEYS),
      manufacturer: pickField(fields, MANUFACTURER_KEYS),
      lcsc: pickField(fields, LCSC_KEYS),
      datasheet: s?.datasheet || nl?.datasheet || '',
      description: nl?.description ?? '',
      units: nl?.units ?? [],
      pins: graphPins,
    };
  };

  let parts: GraphPart[];
  if (netlist) {
    const seen = new Set<string>();
    parts = [];
    for (const nl of netlist.parts) {
      if (seen.has(nl.ref)) continue;
      seen.add(nl.ref);
      const s = (nl.tstamps && symByUuid.get(nl.tstamps)) || symByRef.get(nl.ref);
      parts.push(build(nl.ref, s, nl, netlistPins.get(nl.ref) ?? []));
    }
  } else {
    parts = [...symByRef.values()].map((s) =>
      build(
        s.ref,
        s,
        undefined,
        [...sexpPins.values()].filter((p) => p.ref === s.ref).map((p) => pinOf(p.ref, p.pinNumber, p.pinName, '', p.net)),
      ),
    );
  }
  parts.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  nets.sort((a, b) => a.name.localeCompare(b.name));

  return {
    version: DESIGN_GRAPH_VERSION,
    generated: { kicadCli, partial: netlist === null, partialReason, sources },
    parts,
    nets,
    board: null,
    sync: { schematicOnly: [], boardOnly: [], netMismatches: [] },
  };
}

/** A sha256 per sheet file of the hierarchy, repo-relative and sorted, so a sub-sheet edit moves the graph's sources. */
async function hashSheets(repoRoot: string, schematicRel: string): Promise<{ path: string; sha256: string }[]> {
  const files = await listSheetFiles(path.join(repoRoot, schematicRel));
  const out = await Promise.all(
    files.map(async (f) => ({ path: path.relative(repoRoot, f), sha256: sha256(await readFile(f, 'utf8')) })),
  );
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Extract the graph for a schematic file, preferring the `kicad-cli` netlist and falling back to the s-expression parse. */
export async function extractDesignGraph(repoRoot: string, schematicRel: string): Promise<DesignGraph> {
  const schPath = path.join(repoRoot, schematicRel);
  const [sources, symbols, pins, nl] = await Promise.all([
    hashSheets(repoRoot, schematicRel),
    listSymbols(schPath),
    pinNets(schPath),
    tryNetlist(schPath),
  ]);
  return buildGraph(symbols, pins, nl.netlist, sources, nl.kicadCli, nl.reason);
}

export function graphPath(repoRoot: string): string {
  return path.join(repoRoot, '.copperhead', 'design-graph.json');
}

/** Write the graph to `.copperhead/design-graph.json`. It is a derived cache, so it is gitignored. */
export async function writeDesignGraph(repoRoot: string, graph: DesignGraph): Promise<string> {
  const p = graphPath(repoRoot);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(graph, null, 2) + '\n', 'utf8');
  await ensureIgnored(repoRoot, ['.copperhead/design-graph.json']);
  return p;
}

/** Read the graph when fresh, or null when missing, version-mismatched, or stale (any sheet file's hash or the set of sheet files moved). */
export async function readFreshGraph(repoRoot: string, schematicRel: string): Promise<DesignGraph | null> {
  let graph: DesignGraph;
  try {
    graph = JSON.parse(await readFile(graphPath(repoRoot), 'utf8')) as DesignGraph;
  } catch {
    return null;
  }
  if (graph.version !== DESIGN_GRAPH_VERSION) return null;
  try {
    const current = await hashSheets(repoRoot, schematicRel);
    const recorded = [...graph.generated.sources].sort((a, b) => a.path.localeCompare(b.path));
    if (JSON.stringify(current) !== JSON.stringify(recorded)) return null;
  } catch {
    return null;
  }
  return graph;
}
