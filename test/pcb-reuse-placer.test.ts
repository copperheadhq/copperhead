/**
 * The reuse placer's front end (add-reuse-placer, RFC 14 §7, §8.1): matching a
 * board against a reference, moving the reference's placement into its frame,
 * the delta between the two, subsystems, critical relationships, the checks
 * that measure them, and the plan the placer runs when no model wrote one.
 * Everything here is offline: no kicad-cli, no packer, no model.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { mmToNm, normMdeg } from '../src/pcb/ir/units.js';
import type { PcbDesign } from '../src/pcb/ir/types.js';
import { matchComponents, packageFamily, netSignature } from '../src/pcb/engines/reuse/match.js';
import { transferPlacement, fitTransform, applyTransform } from '../src/pcb/engines/reuse/transfer.js';
import { computeDelta, deltaTable } from '../src/pcb/engines/reuse/delta.js';
import { defaultPlan, validatePlan, PLAN_SCHEMA, type PlacementPlan } from '../src/pcb/engines/reuse/plan.js';
import { partitions, partGraph, louvain, isAnchorIc } from '../src/pcb/intent/subsystems.js';
import { classifyCritical, relationsToConstraints, phaseOf } from '../src/pcb/intent/critical.js';
import { checkPlacementIntent, shoelace, loopPoints } from '../src/pcb/verify/checkers/placement-intent.js';
import { parseIntent, intentToRegistry } from '../src/pcb/intent/language.js';
import { checkPreflight } from '../src/pcb/verify/checkers/preflight.js';
import { loadProfile } from '../src/pcb/verify/profiles/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'fixtures', 'microboards');

async function design(caseName: string): Promise<PcbDesign> {
  const p = path.join(GOLDEN, caseName, 'board.kicad_pcb');
  return importBoard({ boardText: await readFile(p, 'utf8'), boardPath: p, now: 't' }).design;
}

const clone = (d: PcbDesign): PcbDesign => structuredClone(d);
const ref = (d: PcbDesign, r: string) => d.components.find((c) => c.reference === r)!;

describe('matching a board against a reference', () => {
  it('matches a board to itself at the refdes-and-footprint tier and covers everything', async () => {
    const d = await design('completion');
    const r = matchComponents(d, clone(d));
    expect(r.coverage).toBe(1);
    expect(r.unmatchedTarget).toEqual([]);
    expect(r.matches.every((m) => m.targetRef === m.referenceRef)).toBe(true);
    expect(r.byTier[2]).toBe(d.components.length);
  });

  it('falls to the refdes tier when the footprint was swapped, and reports the swap in the delta', async () => {
    const reference = await design('completion');
    const target = clone(reference);
    ref(target, 'C1').footprint.libId = 'Capacitor_SMD:C_0402_1005Metric';
    const r = matchComponents(target, reference);
    expect(r.matches.find((m) => m.targetRef === 'C1')!.tier).toBe(3);
    const delta = computeDelta(target, reference, r);
    const changed = delta.changed.find((c) => c.ref === 'C1')!;
    expect(changed.from).toContain('C_0603');
    expect(changed.to).toContain('C_0402');
    expect(deltaTable(delta)).toContain('C1');
  });

  it('matches by schematic symbol path across a rename, and names parts with no counterpart', async () => {
    const reference = await design('completion');
    for (const c of reference.components) c.symbolPath = `/${c.reference}-uuid`;
    const target = clone(reference);
    const r1 = ref(target, 'R1');
    r1.reference = 'R7';
    r1.footprint.libId = 'Resistor_SMD:R_0402_1005Metric';
    const extra = structuredClone(ref(target, 'R2'));
    extra.id = 'extra-id';
    extra.reference = 'R9';
    delete extra.symbolPath;
    extra.pads = [];
    target.components.push(extra);
    const r = matchComponents(target, reference);
    const m = r.matches.find((x) => x.targetRef === 'R7')!;
    expect(m.tier).toBe(1);
    expect(m.referenceRef).toBe('R1');
    const delta = computeDelta(target, reference, r);
    expect(delta.added.map((p) => p.ref)).toEqual(['R9']);
    expect(delta.removed).toEqual([]);
  });

  it('knows package families and net signatures', async () => {
    const d = await design('ldo-caps');
    expect(packageFamily('Capacitor_SMD:C_0603_1608Metric')).toBe('C');
    expect(packageFamily('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm')).toBe('SOIC-8_3.9x4.9mm_P1.27mm');
    const names = new Map(d.nets.map((n) => [n.id, n.name]));
    expect(netSignature(ref(d, 'C1'), names).split('|')).toContain('GND');
  });
});

describe('transferring a reference placement', () => {
  it('recovers a rigid transform from two anchors and reproduces the reference geometry exactly', async () => {
    const reference = await design('completion');
    const target = clone(reference);
    const transform = { rotationMdeg: 90_000, dx: mmToNm(12), dy: mmToNm(-4) };
    for (const r of ['J1', 'U1']) {
      const t = ref(target, r), s = ref(reference, r);
      t.at = applyTransform(s.at, transform);
      t.rotation = normMdeg(s.rotation + transform.rotationMdeg);
    }
    const anchorIds = new Set(['J1', 'U1'].map((r) => ref(target, r).id));
    const matches = matchComponents(target, reference).matches;
    const res = transferPlacement(target, reference, matches, { anchorIds });
    expect(res.fittedOn).toBe('anchors');
    expect(res.transform.rotationMdeg).toBe(90_000);
    expect(res.residualNm).toBeLessThan(1000);
    const c1 = res.placements.find((p) => p.id === ref(target, 'C1').id)!;
    const want = applyTransform(ref(reference, 'C1').at, transform);
    expect(Math.abs(c1.at.x - want.x)).toBeLessThan(1000);
    expect(Math.abs(c1.at.y - want.y)).toBeLessThan(1000);
    expect(c1.rotation).toBe(normMdeg(ref(reference, 'C1').rotation + 90_000));
    // the reference's own relative geometry survives: every pairwise distance is preserved
    const du = Math.hypot(ref(reference, 'C1').at.x - ref(reference, 'U1').at.x, ref(reference, 'C1').at.y - ref(reference, 'U1').at.y);
    const u1 = ref(target, 'U1');
    expect(Math.hypot(c1.at.x - u1.at.x, c1.at.y - u1.at.y)).toBeCloseTo(du, -3);
  });

  it('centres the reference on the outline when the board fixes nothing, and never mirrors', async () => {
    const reference = await design('completion');
    const target = clone(reference);
    const matches = matchComponents(target, reference).matches;
    const res = transferPlacement(target, reference, matches, {});
    expect(res.fittedOn).toBe('outline');
    expect([0, 90_000, 180_000, 270_000]).toContain(res.transform.rotationMdeg);
    expect(res.placements).toHaveLength(target.components.length);
    expect(res.outsideOutline).toEqual([]);
    expect(res.overlapping).toEqual([]);
  });

  it('fits the rotation that best explains the pairs', () => {
    const pairs = [
      { from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
      { from: { x: 1000, y: 0 }, to: { x: 10, y: -990 } },
    ];
    expect(fitTransform(pairs).transform.rotationMdeg).toBe(90_000);
    expect(fitTransform(pairs).residualNm).toBeLessThan(2);
  });
});

describe('subsystems', () => {
  it('partitions a board by anchor and by clustering, and keeps every part in exactly one subsystem', async () => {
    const d = await design('completion');
    const parts = partitions(d);
    expect(parts.length).toBeGreaterThan(0);
    for (const p of parts) {
      const members = p.subsystems.flatMap((s) => s.members);
      expect(new Set(members).size).toBe(members.length);
      expect([...members, ...p.mechanical].length).toBeLessThanOrEqual(d.components.length);
    }
    expect(parts.some((p) => p.sources.includes('anchor'))).toBe(true);
    const anchored = parts.find((p) => p.sources.includes('anchor'))!;
    expect(anchored.subsystems.some((s) => s.anchor === ref(d, 'U1').id)).toBe(true);
  });

  it('drops ground from the part graph and weights power below signal', async () => {
    const d = await design('ldo-caps');
    const g = partGraph(d);
    const u1 = g.index.get(ref(d, 'U1').id)!;
    const c1 = g.index.get(ref(d, 'C1').id)!;
    expect(g.adj[u1]!.get(c1)).toBeGreaterThan(0);
    // ground is not an edge: a two-part board joined only by GND has no edges at all
    const onlyGnd = clone(d);
    for (const n of onlyGnd.nets) n.name = 'GND';
    expect(partGraph(onlyGnd).adj.every((m) => m.size === 0)).toBe(true);
  });

  it('louvain returns one label per node and is deterministic', async () => {
    const d = await design('completion');
    const g = partGraph(d);
    const a = louvain(g.adj), b = louvain(g.adj);
    expect(a).toHaveLength(d.components.length);
    expect(a).toEqual(b);
  });

  it('an anchor IC has at least eight pads and is not a connector', async () => {
    const d = await design('completion');
    expect(isAnchorIc(ref(d, 'U1'))).toBe(true);
    expect(isAnchorIc(ref(d, 'C1'))).toBe(false);
    expect(isAnchorIc(ref(d, 'J1'))).toBe(false);
  });
});

describe('critical relationships', () => {
  it('ties a decoupling capacitor to the supply pin it decouples', async () => {
    const d = await design('decoupling-qfn');
    const { relations, partClasses } = classifyCritical(d);
    const dec = relations.filter((r) => r.class === 'supply-decoupling');
    expect(dec.length).toBeGreaterThan(0);
    expect(dec.every((r) => r.refs.includes('U1'))).toBe(true);
    expect(partClasses.get('C1')!.has('supply-decoupling')).toBe(true);
    const registry = relationsToConstraints(relations);
    const c1 = registry['layout.relative.attached.C1']!;
    expect(c1.parameters!.target).toBe('U1');
    expect(c1.parameters!.max_distance_nm).toBe(2_000_000);
    expect(String(c1.source)).toContain('rule:decoupling');
  });

  it('groups a crystal with its load capacitors and keeps it away from the edge', async () => {
    const d = await design('crystal');
    const { relations } = classifyCritical(d);
    const xtal = relations.find((r) => r.class === 'crystal')!;
    expect(xtal.refs).toContain('Y1');
    expect(xtal.refs).toContain('C1');
    expect(xtal.refs).toContain('C2');
    expect(xtal.maxMm).toBe(3);
    const registry = relationsToConstraints(relations);
    expect(Object.keys(registry).some((k) => k.startsWith('layout.emc.edge-distance.Y1'))).toBe(true);
  });

  it('weights a decoupling net above a signal net and ground at zero', async () => {
    const d = await design('decoupling-qfn');
    const { netWeights } = classifyCritical(d);
    expect(netWeights.get('GND')).toBe(0);
    expect(netWeights.get('VDD')).toBeGreaterThanOrEqual(1);
  });

  it('places mechanical parts first and the rest in the engineer\'s order', async () => {
    const d = await design('completion');
    const c = classifyCritical(d);
    const anchors = new Set(['U1']);
    expect(phaseOf('J1', c, anchors)).toBe('mechanical');
    expect(phaseOf('U1', c, anchors)).toBe('anchors');
    expect(['support', 'remaining']).toContain(phaseOf('C1', c, anchors));
  });

  it('a user constraint is never overwritten by a rule', async () => {
    const d = await design('decoupling-qfn');
    const { relations } = classifyCritical(d);
    const existing = { 'layout.relative.attached.C1': { source: 'intent', affects: ['board'], class: 'relative' as const, severity: 'hard' as const, scope: { refs: ['C1', 'U1'] }, parameters: { max_distance_nm: 500_000 }, priority: 90, confidence: 1 } };
    const registry = relationsToConstraints(relations, existing);
    expect(registry['layout.relative.attached.C1']).toBeUndefined();
  });
});

describe('the placement intent checks', () => {
  it('measures a current loop and fails it against a declared area', async () => {
    const d = await design('ldo-caps');
    const parsed = parseIntent(`
placement:
  hot_loops:
    - kind: supply
      parts: [C1, U1, C2]
      max_area_mm2: 0.01
`, 'test');
    expect(parsed.errors).toEqual([]);
    expect(parsed.unknown).toEqual([]);
    const registry = intentToRegistry(parsed);
    const res = checkPlacementIntent(d, registry);
    expect(res.metrics.loop_count).toBe(1);
    expect(res.metrics.loop_area_mm2).toBeGreaterThan(0);
    const hit = res.diagnostics.find((x) => x.code === 'intent.emc.hot-loop')!;
    expect(hit.severity).toBe('error');
    expect(hit.entityReferences).toContain('U1');
    // the same loop with a generous budget passes and still reports the measurement
    const ok = checkPlacementIntent(d, intentToRegistry(parseIntent('placement:\n  hot_loops:\n    - {kind: supply, parts: [C1, U1, C2], max_area_mm2: 10000}\n', 'test')));
    expect(ok.diagnostics.filter((x) => x.code === 'intent.emc.hot-loop')).toEqual([]);
    expect(ok.metrics.loop_area_mm2).toBeCloseTo(res.metrics.loop_area_mm2!, 6);
  });

  it('measures isolation and reports the closest pair', async () => {
    const d = await design('crystal');
    const registry = intentToRegistry(parseIntent('placement:\n  isolation:\n    - {noisy: [U1], sensitive: [Y1], min_mm: 50}\n', 'test'));
    const res = checkPlacementIntent(d, registry);
    const hit = res.diagnostics.find((x) => x.code === 'intent.emc.isolation')!;
    expect(hit.entityReferences.sort()).toEqual(['U1', 'Y1']);
    expect(res.metrics.isolation_min_mm).toBeGreaterThan(0);
  });

  it('catches a part out of order along a chain, and reads a reversed chain as the same path', async () => {
    const d = await design('ldo-caps');
    // put C2 past U1 along the line: the physical order is C1, U1, C2
    const u1 = ref(d, 'U1');
    ref(d, 'C2').at = { x: u1.at.x + mmToNm(10), y: u1.at.y };
    ref(d, 'C1').at = { x: u1.at.x - mmToNm(10), y: u1.at.y };
    const declared = (order: string) => checkPlacementIntent(d, intentToRegistry(parseIntent(`placement:\n  chains:\n    - order: [${order}]\n`, 'test')));
    expect(declared('C1, C2, U1').metrics.chain_order_violations).toBeGreaterThan(0);
    expect(declared('C1, U1, C2').metrics.chain_order_violations).toBe(0);
    // the same chain read backwards is the same physical path, so it passes too
    expect(declared('C2, U1, C1').metrics.chain_order_violations).toBe(0);
  });

  it('computes a loop\'s area from the pads the loop runs through', () => {
    expect(shoelace([{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1000 }, { x: 0, y: 1000 }])).toBe(1e6);
    expect(shoelace([{ x: 0, y: 0 }, { x: 1000, y: 0 }])).toBe(0);
  });

  it('reads every placement key the language defines and rejects the rest', () => {
    const parsed = parseIntent(`
electrical:
  voltages:
    VBUS: 5
placement:
  rf: [{ref: U1, edge: north, clearance_mm: 3}]
  edge_distance: [{ref: Y1, min_mm: 5}]
  thermal: [{hot: [U1], protect: [C1], min_mm: 4}]
  channels: [{left: [C1], right: [C2], min_mm: 6}]
  exposed_pads: [U1]
  matched: [{pairs: [[C1, C2]], max_offset_mm: 0.5}]
  critical: [{class: bootstrap, refs: [C1, U1], pins: ['U1.2'], max_mm: 2}]
  nonsense: 1
`, 'test');
    expect(parsed.errors).toEqual([]);
    expect(parsed.unknown).toEqual(['placement.nonsense']);
    const keys = parsed.entries.map((e) => e.key);
    expect(keys).toContain('layout.rf.edge.U1');
    expect(keys).toContain('layout.emc.edge-distance.Y1');
    expect(keys).toContain('layout.thermal.distance.0');
    expect(keys).toContain('layout.emc.channel.0');
    expect(keys).toContain('layout.thermal.exposed-pad.U1');
    expect(keys).toContain('layout.electrical-layout.voltage.VBUS');
    expect(keys).toContain('layout.relative.attached.C1');
  });

  it('a loop through two parts uses the pads they share a net through', async () => {
    const d = await design('ldo-caps');
    const pts = loopPoints([ref(d, 'C1'), ref(d, 'U1')]);
    expect(pts.length).toBeGreaterThanOrEqual(2);
  });
});

describe('feasibility', () => {
  it('warns above the designer p90 and refuses above the maximum', async () => {
    const d = await design('completion');
    const profile = loadProfile(d.board.fabricationProfile);
    const ok = checkPreflight(d, profile, {});
    expect(ok.diagnostics.filter((x) => x.code === 'preflight.utilisation')).toEqual([]);
    expect(ok.metrics.utilisation_front).toBeGreaterThan(0);
    // the same parts on a quarter of the outline: no legal placement exists
    const tight = clone(d);
    const b = tight.board.outline.outer;
    const minX = Math.min(...b.map((p) => p.x)), minY = Math.min(...b.map((p) => p.y));
    const maxX = Math.max(...b.map((p) => p.x)), maxY = Math.max(...b.map((p) => p.y));
    const w = (maxX - minX) / 4, h = (maxY - minY) / 4;
    tight.board.outline = { outer: [{ x: minX, y: minY }, { x: minX + w, y: minY }, { x: minX + w, y: minY + h }, { x: minX, y: minY + h }], holes: [] };
    const refused = checkPreflight(tight, profile, {});
    const hit = refused.diagnostics.find((x) => x.code === 'preflight.utilisation')!;
    expect(hit.severity).toBe('error');
    expect(refused.metrics.utilisation_front).toBeGreaterThan(0.95);
  });
});

describe('the default plan', () => {
  it('names subsystems, regions, critical relationships, and phases that cover every movable part', async () => {
    const d = await design('completion');
    const movableRefs = d.components.filter((c) => !c.attributes.locked).map((c) => c.reference);
    const partition = partitions(d)[0]!;
    const classification = classifyCritical(d);
    const plan = defaultPlan({ design: d, movableRefs, partition, classification });
    expect(plan.schema).toBe(PLAN_SCHEMA);
    expect(plan.strategy).toBe('fresh');
    expect(validatePlan(plan, d, movableRefs)).toEqual({ errors: [], warnings: [] });
    const phased = plan.phases.flatMap((p) => p.parts);
    expect(new Set(phased)).toEqual(new Set(movableRefs));
    for (const s of plan.subsystems) expect(plan.regions.some((r) => r.id === s.region)).toBe(true);
  });

  it('follows the reference when there is one, and keeps its orientations', async () => {
    const reference = await design('completion');
    const d = clone(reference);
    for (const c of d.components) c.at = { x: c.at.x + mmToNm(3), y: c.at.y };
    const movableRefs = d.components.map((c) => c.reference);
    const matches = matchComponents(d, reference).matches;
    const transferred = transferPlacement(d, reference, matches, {}).placements;
    const plan = defaultPlan({ design: d, movableRefs, partition: partitions(d)[0]!, classification: classifyCritical(d), transferred, reference: { board: 'completion', coverage: 1 } });
    expect(plan.strategy).toBe('reuse');
    expect(plan.orientation.length).toBe(movableRefs.length);
    expect(plan.regions.every((r) => r.w > 0 && r.h > 0)).toBe(true);
    expect(validatePlan(plan, d, movableRefs).errors).toEqual([]);
  });

  it('refuses a plan that leaves a movable part out, names a part twice, or invents a part', async () => {
    const d = await design('completion');
    const movableRefs = d.components.map((c) => c.reference);
    const plan = defaultPlan({ design: d, movableRefs, partition: partitions(d)[0]!, classification: classifyCritical(d) });
    const short: PlacementPlan = structuredClone(plan);
    short.phases = short.phases.map((p) => ({ ...p, parts: p.parts.filter((r) => r !== 'C1') }));
    expect(validatePlan(short, d, movableRefs).errors.join(' ')).toContain('C1 is movable but in no phase');
    const twice: PlacementPlan = structuredClone(plan);
    twice.phases.push({ kind: 'remaining', parts: ['C1'] });
    expect(validatePlan(twice, d, movableRefs).errors.join(' ')).toMatch(/twice|two phases/);
    const invented: PlacementPlan = structuredClone(plan);
    invented.subsystems.push({ id: 'ghost', members: ['Q9'], anchor: null, region: null });
    expect(validatePlan(invented, d, movableRefs).errors.join(' ')).toContain('Q9 is not on the board');
  });
});
