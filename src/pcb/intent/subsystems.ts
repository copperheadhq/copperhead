/**
 * Subsystem partitions (add-reuse-placer, RFC 14 §6.5): the sets of parts a
 * designer places together, from every source that applies to the board.
 * Each partition is a variant the placer tries; none is chosen here.
 *
 * - intent: SUBSYSTEMS.md headings and schematic intent groups (deriveBlocks)
 * - sheet: one subsystem per hierarchical sheet, kept whole (measured on the
 *   KiCad demos: cohesion 0.55, purity 0.78)
 * - anchor: every part joins its nearest anchor IC over the part graph
 *   (cohesion 0.55, purity 0.74)
 * - louvain: modularity clustering of the same graph (cohesion 0.51, purity 0.58)
 *
 * Partitions other than intent are also produced under three clean-up
 * settings, and identical partitions are merged. Deterministic throughout.
 */
import type { PcbDesign, ComponentInstance } from '../ir/types.js';
import type { Constraint } from '../../memory/constraints.js';
import { deriveBlocks, isConnector, slugify, type DeriveInput } from './blocks.js';

export type PartitionSource = 'intent' | 'sheet' | 'anchor' | 'louvain' | 'model';
export type CleanupSetting = 'none' | 'support' | 'all';

export interface Subsystem {
  id: string;
  /** Component ids. */
  members: string[];
  /** Component id of the anchor IC, when there is one. */
  anchor: string | null;
  source: PartitionSource;
}

export interface Partition {
  /** Stable key: the sources and clean-up that produced it. */
  key: string;
  sources: PartitionSource[];
  cleanup: CleanupSetting;
  subsystems: Subsystem[];
  /** Parts with no nets or only ground: placed by mechanical rules, in no subsystem (clean-up `all`). */
  mechanical: string[];
  /** Parts connecting exactly two subsystems (clean-up `all`), kept in the one holding more of their connections. */
  boundary: { id: string; between: [string, string] }[];
}

export interface PartitionOptions {
  subsystemsMd?: string | null;
  schematicIntent?: DeriveInput['schematicIntent'];
  /** Sources to generate; default all that apply. */
  sources?: PartitionSource[];
  cleanups?: CleanupSetting[];
}

export const GROUND_NET = /(^|[/_\-.])([ADP]?GND|GND[ADP]?|VSS[A-Z]?|EARTH|CHASSIS|0V)($|[/_\-.])/i;
export const POWER_NET = /(^|\/)([+-]?\d+(\.\d+)?V\d*|\+[A-Z0-9_.]+|V(CC|DD|EE|BAT|IN|BUS|SYS|REF|DC)[A-Z0-9_]*|P?VDD[A-Z0-9_]*|PVCC[A-Z0-9_]*|[A-Z0-9_]*_(\d+V\d*|VCC|VDD))$/i;

/** An anchor IC: eight or more pads, not a connector. */
export function isAnchorIc(c: ComponentInstance): boolean {
  return c.pads.length >= 8 && !isConnector(c);
}

export interface PartGraph {
  ids: string[];
  index: Map<string, number>;
  /** Adjacency with weights: parts sharing a net of k parts get 1/(k-1), power nets 0.25 of that; ground and rails dropped. */
  adj: Map<number, number>[];
  netsOf: Map<string, Set<string>>;
}

export function partGraph(design: PcbDesign): PartGraph {
  const ids = design.components.map((c) => c.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const adj: Map<number, number>[] = ids.map(() => new Map());
  const compOfPad = new Map<string, string>();
  for (const c of design.components) for (const p of c.pads) compOfPad.set(p.id, c.id);
  const netsOf = new Map<string, Set<string>>();
  const railSize = Math.max(12, 0.2 * design.components.length);
  for (const n of design.nets) {
    const members = [...new Set(n.padIds.map((p) => compOfPad.get(p)).filter((x): x is string => !!x))];
    for (const m of members) (netsOf.get(m) ?? netsOf.set(m, new Set()).get(m)!).add(n.id);
    if (members.length < 2 || members.length > railSize || GROUND_NET.test(n.name)) continue;
    const w = (POWER_NET.test(n.name) ? 0.25 : 1) / (members.length - 1);
    for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) {
      const i = index.get(members[a]!)!, j = index.get(members[b]!)!;
      adj[i]!.set(j, (adj[i]!.get(j) ?? 0) + w);
      adj[j]!.set(i, (adj[j]!.get(i) ?? 0) + w);
    }
  }
  return { ids, index, adj, netsOf };
}

/** Each part joins the anchor IC nearest over the graph (edge length 1/weight); unreached parts get -1. */
export function nearestAnchor(graph: PartGraph, anchors: number[], allowed?: Set<number>): number[] {
  const ok = (i: number) => !allowed || allowed.has(i);
  const label = graph.ids.map(() => -1);
  const dist = graph.ids.map(() => Number.POSITIVE_INFINITY);
  const queue: [number, number, number][] = [];
  for (const a of anchors) if (ok(a)) {
    dist[a] = 0;
    label[a] = a;
    queue.push([0, a, a]);
  }
  while (queue.length) {
    queue.sort((x, y) => x[0] - y[0] || x[2] - y[2] || x[1] - y[1]);
    const [d, i, src] = queue.shift()!;
    if (d > dist[i]!) continue;
    for (const [j, w] of graph.adj[i]!) {
      if (!ok(j) || w <= 0) continue;
      const nd = d + 1 / w;
      if (nd < dist[j]! - 1e-12) {
        dist[j] = nd;
        label[j] = src;
        queue.push([nd, j, src]);
      }
    }
  }
  return label;
}

/** Louvain modularity clustering (Blondel et al. 2008), deterministic node order. */
export function louvain(adj0: Map<number, number>[]): number[] {
  let graph = adj0;
  let membership = adj0.map((_, i) => i);
  for (let level = 0; level < 20; level++) {
    const n = graph.length;
    const k = graph.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
    const m2 = k.reduce((a, b) => a + b, 0);
    if (m2 === 0) break;
    const c = graph.map((_, i) => i);
    const tot = [...k];
    let moved = false;
    for (let pass = 0, improved = true; improved && pass < 50; pass++) {
      improved = false;
      for (let i = 0; i < n; i++) {
        const ci = c[i]!;
        const neigh = new Map<number, number>();
        for (const [j, w] of graph[i]!) if (j !== i) neigh.set(c[j]!, (neigh.get(c[j]!) ?? 0) + w);
        tot[ci] = tot[ci]! - k[i]!;
        let best = ci;
        let bestGain = (neigh.get(ci) ?? 0) - (tot[ci]! * k[i]!) / m2;
        for (const [cc, w] of neigh) {
          const gain = w - (tot[cc]! * k[i]!) / m2;
          if (gain > bestGain + 1e-12) {
            best = cc;
            bestGain = gain;
          }
        }
        tot[best] = tot[best]! + k[i]!;
        if (best !== ci) {
          c[i] = best;
          improved = true;
          moved = true;
        }
      }
    }
    if (!moved) break;
    const ids = new Map<number, number>();
    for (const x of c) if (!ids.has(x)) ids.set(x, ids.size);
    const next: Map<number, number>[] = [...ids.keys()].map(() => new Map());
    for (let i = 0; i < n; i++) for (const [j, w] of graph[i]!) {
      const a = ids.get(c[i]!)!, b = ids.get(c[j]!)!;
      next[a]!.set(b, (next[a]!.get(b) ?? 0) + w);
    }
    membership = membership.map((node) => ids.get(c[node]!)!);
    graph = next;
  }
  return membership;
}

const isRoot = (s: string) => s === '/' || /^(root|racine)$/i.test(s.replace(/\//g, ''));

function groupBy(ids: string[], label: (id: string) => string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id of ids) (out.get(label(id)) ?? out.set(label(id), []).get(label(id))!).push(id);
  return out;
}

function anchorOf(design: PcbDesign, members: string[], graph: PartGraph): string | null {
  const comps = members.map((id) => design.components.find((c) => c.id === id)!).filter(Boolean);
  const ics = comps.filter(isAnchorIc);
  const pool = ics.length ? ics : [];
  if (!pool.length) return null;
  const score = (c: ComponentInstance) => {
    const i = graph.index.get(c.id)!;
    return members.reduce((a, m) => a + (graph.adj[i]!.get(graph.index.get(m)!) ?? 0), 0);
  };
  return [...pool].sort((a, b) => score(b) - score(a) || b.pads.length - a.pads.length || a.reference.localeCompare(b.reference))[0]!.id;
}

function makeSubsystems(design: PcbDesign, groups: Map<string, string[]>, source: PartitionSource, graph: PartGraph): Subsystem[] {
  const used = new Set<string>();
  return [...groups.entries()].map(([name, members]) => {
    let id = slugify(name);
    for (let n = 2; used.has(id); n++) id = `${slugify(name)}-${n}`;
    used.add(id);
    // a board may carry two footprints with one uuid; the same part must not appear twice
    const unique = [...new Set(members)].sort();
    return { id, members: unique, anchor: anchorOf(design, unique, graph), source };
  });
}

function raw(design: PcbDesign, source: PartitionSource, graph: PartGraph, opts: PartitionOptions): Subsystem[] | null {
  const ids = design.components.map((c) => c.id);
  const byId = new Map(design.components.map((c) => [c.id, c]));
  if (source === 'intent') {
    const blocks = deriveBlocks({ design, subsystemsMd: opts.subsystemsMd ?? null, schematicIntent: opts.schematicIntent ?? null });
    if (!blocks.some((b) => b.id !== 'unassigned')) return null;
    return blocks.map((b) => ({ id: b.id, members: [...b.members].sort(), anchor: b.anchor, source: 'intent' as const }));
  }
  if (source === 'sheet') {
    const sizes = groupBy(ids, (id) => byId.get(id)!.sheet?.name ?? '/');
    if ([...sizes.values()].filter((v) => v.length >= 3).length < 2) return null;
    const named = new Map([...sizes.entries()].map(([k, v]) => [isRoot(k) ? 'root' : k.replace(/^\/|\/$/g, '') || 'root', v]));
    return makeSubsystems(design, named, 'sheet', graph);
  }
  if (source === 'anchor') {
    const anchors = design.components.map((c, i) => (isAnchorIc(c) ? i : -1)).filter((i) => i >= 0);
    if (!anchors.length) return null;
    const label = nearestAnchor(graph, anchors);
    const groups = groupBy(ids, (id) => {
      const l = label[graph.index.get(id)!]!;
      return l >= 0 ? design.components[l]!.reference : 'unassigned';
    });
    return makeSubsystems(design, groups, 'anchor', graph);
  }
  if (source === 'louvain') {
    const m = louvain(graph.adj);
    const groups = groupBy(ids, (id) => `cluster-${m[graph.index.get(id)!]}`);
    // name clusters after their anchor IC where one exists, for readable reports
    const renamed = new Map<string, string[]>();
    for (const [k, members] of groups) {
      const a = anchorOf(design, members, graph);
      renamed.set(a ? `louvain-${byId.get(a)!.reference}` : k, members);
    }
    return makeSubsystems(design, renamed, 'louvain', graph);
  }
  return null;
}

/** Apply a clean-up setting to a raw partition (intent partitions are returned unchanged). */
export function cleanup(design: PcbDesign, subsystems: Subsystem[], setting: CleanupSetting, graph: PartGraph): Pick<Partition, 'subsystems' | 'mechanical' | 'boundary'> {
  if (setting === 'none') return { subsystems, mechanical: [], boundary: [] };
  const byId = new Map(design.components.map((c) => [c.id, c]));
  const netName = new Map(design.nets.map((n) => [n.id, n.name]));
  const owner = new Map<string, string>();
  for (const s of subsystems) for (const m of s.members) owner.set(m, s.id);
  const compOfPad = new Map<string, string>();
  for (const c of design.components) for (const p of c.pads) compOfPad.set(p.id, c.id);
  const partsOnNet = new Map<string, string[]>();
  for (const n of design.nets) partsOnNet.set(n.id, [...new Set(n.padIds.map((p) => compOfPad.get(p)).filter((x): x is string => !!x))]);
  const signalNets = (c: ComponentInstance) => [...new Set(c.pads.map((p) => p.netId).filter((n): n is string => !!n && !GROUND_NET.test(netName.get(n) ?? '')))];
  const move = (id: string, to: string) => owner.set(id, to);
  for (const c of design.components) {
    const nets = signalNets(c);
    const twoPin = c.pads.filter((p) => p.netId).length === 2;
    if (twoPin && nets.length) {
      const ics = new Set(nets.flatMap((n) => (partsOnNet.get(n) ?? []).filter((p) => p !== c.id && isAnchorIc(byId.get(p)!))));
      if (ics.size === 1) {
        const ic = [...ics][0]!;
        const to = owner.get(ic);
        if (to) move(c.id, to);
      }
    }
  }
  const mechanical: string[] = [];
  const boundary: Partition['boundary'] = [];
  if (setting === 'all') {
    for (const c of design.components) {
      const nets = signalNets(c);
      if (!nets.length) {
        mechanical.push(c.id);
        owner.delete(c.id);
        continue;
      }
      const reach = new Map<string, number>();
      for (const n of nets) for (const p of partsOnNet.get(n) ?? []) {
        if (p === c.id) continue;
        const s = owner.get(p);
        if (s) reach.set(s, (reach.get(s) ?? 0) + 1);
      }
      if (isConnector(c)) {
        if (reach.size >= 3) owner.set(c.id, `connector-${slugify(c.reference)}`);
        else if (reach.size) move(c.id, [...reach.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0]);
        continue;
      }
      const others = [...reach.entries()].filter(([s]) => s !== owner.get(c.id));
      if (reach.size === 2 && others.length >= 1) {
        const sorted = [...reach.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        move(c.id, sorted[0]![0]);
        boundary.push({ id: c.id, between: [sorted[0]![0], sorted[1]![0]] });
      }
    }
  }
  const groups = new Map<string, string[]>();
  for (const [id, s] of owner) (groups.get(s) ?? groups.set(s, []).get(s)!).push(id);
  const source = subsystems[0]?.source ?? 'anchor';
  const out: Subsystem[] = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([id, members]) => ({ id, members: members.sort(), anchor: anchorOf(design, members, graph), source }));
  return { subsystems: out, mechanical: mechanical.sort(), boundary };
}

function membershipKey(p: Pick<Partition, 'subsystems' | 'mechanical'>): string {
  const sets = p.subsystems.map((s) => [...s.members].sort().join(',')).sort();
  return `${sets.join('|')}#${[...p.mechanical].sort().join(',')}`;
}

/** Every partition variant for the board, merged when identical. */
export function partitions(design: PcbDesign, opts: PartitionOptions = {}): Partition[] {
  const graph = partGraph(design);
  const sources = opts.sources ?? ['intent', 'sheet', 'anchor', 'louvain'];
  const cleanups = opts.cleanups ?? ['none', 'support', 'all'];
  const out: Partition[] = [];
  const seen = new Map<string, Partition>();
  for (const source of sources) {
    const base = raw(design, source, graph, opts);
    if (!base) continue;
    for (const setting of source === 'intent' ? (['none'] as CleanupSetting[]) : cleanups) {
      const cleaned = source === 'intent' ? { subsystems: base, mechanical: [], boundary: [] } : cleanup(design, base, setting, graph);
      const k = membershipKey(cleaned);
      const existing = seen.get(k);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        continue;
      }
      const p: Partition = { key: `${source}:${setting}`, sources: [source], cleanup: setting, ...cleaned };
      seen.set(k, p);
      out.push(p);
    }
  }
  return out;
}

/** Registry entries for one partition: `layout.functional.group.<slug>` per subsystem with members, anchor, and source. */
export function partitionToConstraints(design: PcbDesign, partition: Partition): Record<string, Constraint> {
  const ref = (id: string) => design.components.find((c) => c.id === id)?.reference ?? id;
  const out: Record<string, Constraint> = {};
  for (const s of partition.subsystems) {
    if (s.members.length < 2) continue;
    out[`layout.functional.group.${s.id}`] = {
      source: `subsystems:${partition.key}`,
      affects: ['board'],
      class: 'functional',
      severity: 'soft',
      scope: { refs: s.members.map(ref) },
      parameters: { anchor: s.anchor ? ref(s.anchor) : '', members: s.members.map(ref), region: '', partition: partition.key },
      priority: 40,
      confidence: 1,
      approvedBy: 'subsystems',
    };
  }
  return out;
}
