/**
 * The reuse run (add-reuse-placer, RFC 14 §8.5–§8.8): moving parts in memory,
 * the variant matrix, screening, the placer that replays a screened variant,
 * which nets are worth routing before a placement is accepted, and the
 * revision rules. Offline: no kicad-cli, no router, no model.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { applyPlacements, moveComponent } from '../src/pcb/ir/transform.js';
import { mmToNm } from '../src/pcb/ir/units.js';
import { PrecomputedPlacer, precomputedManifest } from '../src/pcb/engines/placers/precomputed/adapter.js';
import { enumerateVariants } from '../src/pcb/engines/reuse/variants.js';
import { criticalNetNames } from '../src/pcb/engines/reuse/critical-route.js';
import { proposeRevisions, facingCost } from '../src/pcb/engines/reuse/revise.js';
import { classifyCritical } from '../src/pcb/intent/critical.js';
import { makeSnapshot, DEFAULT_LIMITS } from '../src/pcb/ir/snapshot.js';
import { reuseRun } from '../src/pcb/engines/reuse/run.js';
import { verifyDesign } from '../src/pcb/verify/index.js';
import type { PcbDesign } from '../src/pcb/ir/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GOLDEN = path.join(ROOT, 'test', 'fixtures', 'microboards');

async function design(name: string): Promise<PcbDesign> {
  const p = path.join(GOLDEN, name, 'board.kicad_pcb');
  return importBoard({ boardText: await readFile(p, 'utf8'), boardPath: p, now: 't' }).design;
}
const ref = (d: PcbDesign, r: string) => d.components.find((c) => c.reference === r)!;

describe('moving parts in memory', () => {
  it('moves a part\'s pads, courtyard and body with it, and leaves the rest of the design alone', async () => {
    const d = await design('completion');
    const c = ref(d, 'C1');
    const pad = c.pads[0]!;
    const moved = moveComponent(c, { id: c.id, at: { x: c.at.x + mmToNm(4), y: c.at.y - mmToNm(2) }, rotation: c.rotation, side: c.attributes.side });
    expect(moved.pads[0]!.at.x - pad.at.x).toBe(mmToNm(4));
    expect(moved.pads[0]!.at.y - pad.at.y).toBe(-mmToNm(2));
    expect(moved.pads[0]!.netId).toBe(pad.netId);
    if (c.footprint.courtyard) expect(moved.footprint.courtyard!.outer[0]!.x - c.footprint.courtyard.outer[0]!.x).toBe(mmToNm(4));
    // a quarter turn takes the pads around the origin, keeping their distance from it
    const turned = moveComponent(c, { id: c.id, at: { ...c.at }, rotation: (c.rotation + 90_000) % 360_000, side: c.attributes.side });
    const before = Math.hypot(pad.at.x - c.at.x, pad.at.y - c.at.y);
    const after = Math.hypot(turned.pads[0]!.at.x - c.at.x, turned.pads[0]!.at.y - c.at.y);
    expect(after).toBeCloseTo(before, -3);
    const applied = applyPlacements(d, [{ id: c.id, at: { x: c.at.x + mmToNm(4), y: c.at.y }, rotation: c.rotation, side: c.attributes.side }]);
    expect(applied.components.filter((x) => x.id !== c.id).every((x, i) => x === d.components.filter((y) => y.id !== c.id)[i])).toBe(true);
    expect(applied.nets).toBe(d.nets);
  });
});

describe('the variant matrix', () => {
  it('offers the three options with a reference and only packing without one, and is deterministic', () => {
    const withRef = enumerateVariants({ partitions: ['anchor:none', 'louvain:all'], hasReference: true, clearanceNm: 200_000 });
    expect(new Set(withRef.map((v) => v.option))).toEqual(new Set(['A', 'B', 'C']));
    expect(withRef.map((v) => v.id)).toEqual(enumerateVariants({ partitions: ['anchor:none', 'louvain:all'], hasReference: true, clearanceNm: 200_000 }).map((v) => v.id));
    expect(new Set(withRef.map((v) => v.id)).size).toBe(withRef.length);
    const without = enumerateVariants({ partitions: ['anchor:none'], hasReference: false, clearanceNm: 200_000 });
    expect(without.every((v) => v.option === 'C')).toBe(true);
    const quick = enumerateVariants({ partitions: ['anchor:none'], hasReference: true, clearanceNm: 200_000, budget: 'quick' });
    expect(quick.length).toBeLessThan(withRef.length);
    // option A keeps the reference; option C ignores it
    expect(withRef.find((v) => v.id === 'a0')!.planFirst).toBe(true);
    expect(withRef.find((v) => v.id === 'c0')!.attraction).toBe(0);
    // ids become engine ids, which the registry requires to be kebab-case
    expect(withRef.every((v) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v.id))).toBe(true);
  });
});

describe('replaying a screened variant', () => {
  it('returns exactly the placements it was given, and names what it could not place', async () => {
    const d = await design('completion');
    const movable = d.components.filter((c) => !c.attributes.locked).map((c) => c.id);
    const snapshot = makeSnapshot(d, { kind: 'placement', movableComponentIds: movable }, { seed: 0, limits: DEFAULT_LIMITS });
    const job = { runId: 't', snapshot, movableComponentIds: movable, constraints: [], objectives: [], seed: 0, limits: snapshot.limits };
    const one = movable.slice(0, 2).map((id) => ({ id, at: { x: mmToNm(10), y: mmToNm(10) }, rotation: 0, side: 'front' as const }));
    const res = await new PrecomputedPlacer('placer-reuse-x', one).place(job, { workDir: '/tmp', boardPath: '', log: () => {} });
    expect(res.placements).toHaveLength(2);
    expect(res.status).toBe('partial');
    expect(res.unplacedComponentIds.sort()).toEqual(movable.slice(2).sort());
    expect((await new PrecomputedPlacer('placer-reuse-x', one).manifest()).id).toBe('placer-reuse-x');
    expect(precomputedManifest('placer-reuse-y').capabilities).toMatchObject({ layoutReuse: true });
  });
});

describe('which nets are routed before a placement is accepted', () => {
  it('takes the nets a critical relationship weighted, and never ground', async () => {
    const d = await design('decoupling-qfn');
    const classification = classifyCritical(d);
    const nets = criticalNetNames(d, classification);
    expect(nets).not.toContain('GND');
    expect(nets.length).toBeGreaterThan(0);
    expect(nets.every((n) => d.nets.some((x) => x.name === n))).toBe(true);
    // a net the board declares a routing rule for is critical whatever the rules think
    const withIntent = criticalNetNames(d, classification, { 'layout.routing.width.SIG': { source: 'intent', affects: ['board'], class: 'routing', severity: 'hard', scope: { nets: ['GND'] }, parameters: {}, priority: 50, confidence: 1 } });
    expect(withIntent).toContain('GND');
  });
});

describe('revision rules', () => {
  it('turns a part to face the one it must reach, and measures the improvement', async () => {
    const d = await design('crystal');
    const y1 = ref(d, 'Y1'), u1 = ref(d, 'U1');
    // put the crystal beside the IC, turned away from it
    const turned = applyPlacements(d, [{ id: y1.id, at: { x: u1.at.x + mmToNm(6), y: u1.at.y }, rotation: 180_000, side: y1.attributes.side }]);
    const before = facingCost(ref(turned, 'Y1'), ref(turned, 'U1'));
    const revisions = proposeRevisions({ design: turned, movableIds: new Set(turned.components.map((c) => c.id)), failures: [{ ref: 'Y1', toward: 'U1', why: 'XI does not route' }] });
    const rotate = revisions.find((r) => r.kind === 'rotate-facing');
    expect(rotate).toBeDefined();
    expect(rotate!.refs).toEqual(['Y1']);
    expect(rotate!.afterNm).toBeLessThan(rotate!.beforeNm);
    const after = facingCost(ref(applyPlacements(turned, rotate!.placements), 'Y1'), ref(turned, 'U1'));
    expect(after).toBeLessThan(before);
    expect(rotate!.placements[0]!.at).toEqual(ref(turned, 'Y1').at);
  });

  it('never proposes a move that does not shorten the pair, and moves only movable parts', async () => {
    const d = await design('crystal');
    const movableIds = new Set(d.components.filter((c) => c.reference !== 'U1').map((c) => c.id));
    const failures = [
      { ref: 'C1', toward: 'Y1', why: 'test' },
      { ref: 'C2', toward: 'U1', why: 'test' },
      { ref: 'U1', toward: 'Y1', why: 'U1 is not movable here' },
    ];
    const revisions = proposeRevisions({ design: d, movableIds, failures });
    for (const r of revisions) {
      if (r.kind !== 'release-between') expect(r.afterNm).toBeLessThan(r.beforeNm);
      for (const p of r.placements) expect(movableIds.has(p.id)).toBe(true);
    }
    expect(revisions.some((r) => r.refs.includes('U1') && r.kind === 'rotate-facing')).toBe(false);
  });
});

describe('the reuse run', () => {
  it('screens every variant, keeps the legal ones, and writes the run\'s artifacts', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-reuse-run-'));
    try {
      await mkdir(path.join(dir, 'hardware'), { recursive: true });
      const boardPath = path.join(dir, 'hardware', 'board.kicad_pcb');
      const referencePath = path.join(dir, 'hardware', 'reference.kicad_pcb');
      const text = await readFile(path.join(GOLDEN, 'completion', 'board.kicad_pcb'), 'utf8');
      await writeFile(boardPath, text, 'utf8');
      await writeFile(referencePath, text, 'utf8');
      const run = await reuseRun({
        repoRoot: dir,
        boardPath,
        referencePath,
        runDir: path.join(dir, 'run'),
        keep: 3,
        budget: 'quick',
        probe: false,
        noKicad: true,
        log: () => {},
      });
      expect(run.match.coverage).toBe(1);
      expect(run.planSource).toBe('rules');
      expect(run.screened.length).toBeGreaterThan(1);
      expect(run.screened.some((v) => v.metrics.legal)).toBe(true);
      expect(run.screened.filter((v) => v.kept).length).toBeLessThanOrEqual(3);
      // the board is its own reference, so copying it is legal and reproduces it exactly
      const copy = run.screened.find((v) => v.id === 'copy')!;
      expect(copy.metrics.legal).toBe(true);
      expect(copy.metrics.unplaced).toBe(0);
      const screening = JSON.parse(await readFile(path.join(dir, 'run', 'screening.json'), 'utf8'));
      expect(screening.variants.length).toBe(run.screened.length);
      expect(JSON.parse(await readFile(path.join(dir, 'run', 'placement-plan.json'), 'utf8')).schema).toBe('copperhead-placement-plan/1');
      expect(await readFile(path.join(dir, 'run', 'delta.md'), 'utf8')).toContain('Matched 100 %');
      // every kept variant became a candidate that verifies
      expect(run.place).not.toBeNull();
      for (const c of run.place!.candidates) expect(verifyDesign({ design: c.design }).gates.preflight.passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
