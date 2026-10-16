import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { listSymbols, pinNets, type SchematicSymbol, type PinNet } from './sexp.js';
import { parseNetlist, type Netlist } from './netlist.js';

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

export type PartClass = 'ic' | 'passive' | 'connector' | 'power' | 'mechanical';

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
const LCSC_KEYS = ['lcsc', 'lcscpart', 'lcscpartnumber', 'lcsc_part'];

function pickField(fields: Record<string, string>, keys: string[]): string {
  const norm = new Map<string, string>();
  for (const [k, v] of Object.entries(fields)) norm.set(k.toLowerCase().replace(/[^a-z0-9]/g, ''), v);
  for (const k of keys) {
    const v = norm.get(k);
    if (v !== undefined && v !== '') return v;
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
export function classifyPart(sym: SchematicSymbol, pinCount: number): { class: PartClass; evidence: string } {
  const lib = sym.libId;
  const libCat = lib.includes(':') ? lib.slice(0, lib.indexOf(':')) : '';
  const fpItem = sym.footprint.includes(':')
    ? sym.footprint.slice(sym.footprint.lastIndexOf(':') + 1)
    : sym.footprint;
  const refPrefix = sym.ref.replace(/[0-9]+.*$/, '');
  if (/^power$/i.test(libCat) || /^power/i.test(lib)) return { class: 'power', evidence: `lib:${lib}` };
  if (/connector/i.test(libCat) || /connector/i.test(lib)) return { class: 'connector', evidence: `lib:${lib}` };
  if (/mechanical|mountinghole/i.test(libCat) || /mechanical|mountinghole/i.test(lib)) {
    return { class: 'mechanical', evidence: `lib:${lib}` };
  }
  if (/^[RCL]_/.test(fpItem.trim()) && pinCount <= 2) {
    return { class: 'passive', evidence: `footprint:${sym.footprint},pins:${pinCount}` };
  }
  if (/^(R|C|L)$/i.test(refPrefix) && pinCount <= 2) return { class: 'passive', evidence: `ref:${sym.ref},pins:${pinCount}` };
  if (/^(J|P|CONN|MH)$/i.test(refPrefix) || /^(J|P)_/.test(sym.ref)) {
    return { class: 'connector', evidence: `ref:${sym.ref},lib:${lib}` };
  }
  if (/^(MH|MOUNT|FID|LOGO)$/i.test(refPrefix)) return { class: 'mechanical', evidence: `ref:${sym.ref}` };
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

/** Build the normalized graph from s-expression symbols plus the netlist export when available. */
export function buildGraph(
  symbols: SchematicSymbol[],
  pins: PinNet[],
  netlist: Netlist | null,
  sources: { path: string; sha256: string }[],
  kicadCli: string | null,
  partialReason: string | null,
): DesignGraph {
  const pinsByRef = new Map<string, PinNet[]>();
  for (const p of pins) {
    const arr = pinsByRef.get(p.ref) ?? [];
    arr.push(p);
    pinsByRef.set(p.ref, arr);
  }
  const netByRefPin = new Map<string, { netclass: string; pintype: string; pinfunction: string }>();
  const nets: GraphNet[] = [];
  if (netlist) {
    for (const n of netlist.nets) {
      nets.push({
        name: n.name,
        netclass: n.netclass,
        nodes: n.nodes.map((nd) => ({ ref: nd.ref, pin: nd.pin, pintype: nd.pintype, pinfunction: nd.pinfunction })),
      });
      for (const nd of n.nodes) netByRefPin.set(`${nd.ref}:${nd.pin}`, { netclass: n.netclass, pintype: nd.pintype, pinfunction: nd.pinfunction });
    }
  } else {
    const grouped = new Map<string, GraphNetNode[]>();
    for (const p of pins) {
      if (!p.net) continue;
      const arr = grouped.get(p.net) ?? [];
      arr.push({ ref: p.ref, pin: p.pinNumber, pintype: '', pinfunction: '' });
      grouped.set(p.net, arr);
    }
    for (const [name, nodes] of grouped) nets.push({ name, netclass: 'Default', nodes });
  }
  const nlByRef = new Map<string, Netlist['parts'][number]>();
  if (netlist) for (const p of netlist.parts) nlByRef.set(p.ref, p);

  const parts: GraphPart[] = symbols.map((s) => {
    const refPins = pinsByRef.get(s.ref) ?? [];
    const { class: cls, evidence } = classifyPart(s, refPins.length);
    const nl = nlByRef.get(s.ref);
    const fields = { ...s.fields, ...(nl ? nl.fields : {}) };
    const mpn = pickField(fields, MPN_KEYS);
    const graphPins: GraphPin[] = refPins.map((p) => {
      const extra = netByRefPin.get(`${p.ref}:${p.pinNumber}`);
      return { num: p.pinNumber, name: p.pinName, type: extra?.pintype ?? '', net: p.net };
    });
    return {
      ref: s.ref,
      uuid: s.uuid || nl?.tstamps || '',
      value: s.value,
      libId: s.libId,
      footprint: s.footprint,
      class: cls,
      classEvidence: evidence,
      sheet: s.sheet,
      sheetFile: nl?.sheetFile ?? '',
      dnp: s.dnp,
      excludeFromBom: !s.inBom,
      fields,
      mpn,
      manufacturer: pickField(fields, MANUFACTURER_KEYS),
      lcsc: pickField(fields, LCSC_KEYS),
      datasheet: s.datasheet || (nl ? nl.datasheet : ''),
      description: nl?.description ?? '',
      units: nl?.units ?? [],
      pins: graphPins,
    };
  });
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

/** Extract the graph for a schematic file, preferring the `kicad-cli` netlist and falling back to the s-expression parse. */
export async function extractDesignGraph(repoRoot: string, schematicRel: string): Promise<DesignGraph> {
  const schPath = path.join(repoRoot, schematicRel);
  const schText = await readFile(schPath, 'utf8');
  const sources = [{ path: schematicRel, sha256: sha256(schText) }];
  const [symbols, pins, nl] = await Promise.all([
    listSymbols(schPath),
    pinNets(schPath),
    tryNetlist(schPath),
  ]);
  return buildGraph(symbols, pins, nl.netlist, sources, nl.kicadCli, nl.reason);
}

export function graphPath(repoRoot: string): string {
  return path.join(repoRoot, '.copperhead', 'design-graph.json');
}

/** Write the graph to `.copperhead/design-graph.json` (derived artifact, see header note). */
export async function writeDesignGraph(repoRoot: string, graph: DesignGraph): Promise<string> {
  const p = graphPath(repoRoot);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(graph, null, 2) + '\n', 'utf8');
  return p;
}

/** Read the graph when fresh, or null when missing, version-mismatched, or stale (source hashes moved). */
export async function readFreshGraph(repoRoot: string, schematicRel: string): Promise<DesignGraph | null> {
  let raw: string;
  try {
    raw = await readFile(graphPath(repoRoot), 'utf8');
  } catch {
    return null;
  }
  let graph: DesignGraph;
  try {
    graph = JSON.parse(raw) as DesignGraph;
  } catch {
    return null;
  }
  if (graph.version !== DESIGN_GRAPH_VERSION) return null;
  try {
    const schText = await readFile(path.join(repoRoot, schematicRel), 'utf8');
    const current = sha256(schText);
    const recorded = graph.generated.sources.find((s) => s.path === schematicRel)?.sha256;
    if (recorded !== current) return null;
  } catch {
    return null;
  }
  return graph;
}
