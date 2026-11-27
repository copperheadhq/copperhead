/**
 * placer-heuristic: the engineer's basic placement rules, and the layout
 * intent a model may write for them. Everything here is offline — the placer
 * takes no model and no network, and the planner falls back to the rules when
 * no provider is configured.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { makeSnapshot, DEFAULT_LIMITS } from '../src/pcb/ir/snapshot.js';
import { applyPlacements } from '../src/pcb/ir/transform.js';
import { verifyDesign } from '../src/pcb/verify/index.js';
import { loadProfile } from '../src/pcb/verify/profiles/index.js';
import { bbox, distance } from '../src/pcb/ir/geometry.js';
import { HeuristicPlacer, HEURISTIC_PLACER_MANIFEST } from '../src/pcb/engines/placers/heuristic/adapter.js';
import { defaultPlacerRegistry } from '../src/pcb/engines/place.js';
import { classifyCritical } from '../src/pcb/intent/critical.js';
import { partitions } from '../src/pcb/intent/subsystems.js';
import { defaultPlan, validatePlan } from '../src/pcb/engines/reuse/plan.js';
import { planPrompt, planFromModel, planPlacement } from '../src/pcb/agent/place/planner.js';
import { poseOutline } from '../src/pcb/engines/reuse/transfer.js';
import type { PcbDesign, PlacedComponent } from '../src/pcb/ir/types.js';
import type { PlacementJob, RunContext } from '../src/pcb/engines/contracts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARDS = path.join(HERE, 'fixtures', 'microboards');

async function boardOf(name: string): Promise<PcbDesign> {
  const boardPath = path.join(BOARDS, name, 'board.kicad_pcb');
  return importBoard({ boardText: await readFile(boardPath, 'utf8'), boardPath, now: 't' }).design;
}

function jobFor(design: PcbDesign, constraints: unknown[] = []): { job: PlacementJob; ctx: RunContext } {
  const movableComponentIds = design.components.filter((c) => !c.attributes.locked).map((c) => c.id);
  const snapshot = makeSnapshot(design, { kind: 'placement', movableComponentIds }, { seed: 0, limits: DEFAULT_LIMITS });
  return {
    job: { runId: 'test', snapshot, movableComponentIds, constraints, objectives: [], seed: 0, limits: snapshot.limits },
    ctx: { workDir: '/tmp', boardPath: 'board.kicad_pcb', log: () => {} },
  };
}

const at = (design: PcbDesign, placements: PlacedComponent[], ref: string) => {
  const c = design.components.find((x) => x.reference === ref)!;
  return placements.find((p) => p.id === c.id)!;
};

describe('placer-heuristic', () => {
  it('is registered, deterministic and needs nothing but the board', async () => {
    const entry = defaultPlacerRegistry(HERE).get('placer-heuristic');
    expect(entry?.manifest.determinism).toBe('deterministic');
    expect(entry?.manifest.networkRequirement).toBe('none');
    expect(entry?.manifest.harnessOnly).toBe(false);
    expect(HEURISTIC_PLACER_MANIFEST.requires).toEqual({});
  });

  it('places every part legally, and the same way twice', async () => {
    const design = await boardOf('completion');
    const { job, ctx } = jobFor(design);
    const res = await new HeuristicPlacer().place(job, ctx);
    expect(res.status).toBe('complete');
    expect(res.unplacedComponentIds).toEqual([]);
    expect(res.placements).toHaveLength(job.movableComponentIds.length);
    const verified = verifyDesign({ design: applyPlacements(design, res.placements), profile: loadProfile(design.board.fabricationProfile) });
    expect(verified.gates.placement.passed).toBe(true);
    const again = await new HeuristicPlacer().place(job, ctx);
    expect(again.placements).toEqual(res.placements);
  });

  it('puts the connector against a board edge with its pads facing inboard, and the main IC in the middle', async () => {
    const design = await boardOf('completion');
    const { job, ctx } = jobFor(design);
    const res = await new HeuristicPlacer().place(job, ctx);
    const board = bbox(design.board.outline);
    const centre = { x: (board.minX + board.maxX) / 2, y: (board.minY + board.maxY) / 2 };
    const gapToEdge = (ref: string) => {
      const c = design.components.find((x) => x.reference === ref)!;
      const p = at(design, res.placements, ref);
      const e = bbox(poseOutline(c, p.at, p.rotation));
      return Math.min(e.minX - board.minX, e.minY - board.minY, board.maxX - e.maxX, board.maxY - e.maxY);
    };
    const fromCentre = (ref: string) => {
      const p = at(design, res.placements, ref);
      return Math.hypot(p.at.x - centre.x, p.at.y - centre.y);
    };
    // rule 1: the pin header is on an edge — nearer to one than any other part
    for (const other of ['U1', 'C1', 'R1', 'R2', 'Y1']) expect(gapToEdge('J1')).toBeLessThan(gapToEdge(other));
    // and it faces out: its pads sit inboard of its own body centre
    const j1 = design.components.find((c) => c.reference === 'J1')!;
    const placedJ1 = at(design, res.placements, 'J1');
    const e = bbox(poseOutline(j1, placedJ1.at, placedJ1.rotation));
    const nearest = [
      { d: e.minX - board.minX, out: { x: -1, y: 0 } },
      { d: board.maxX - e.maxX, out: { x: 1, y: 0 } },
      { d: e.minY - board.minY, out: { x: 0, y: -1 } },
      { d: board.maxY - e.maxY, out: { x: 0, y: 1 } },
    ].sort((a, b) => a.d - b.d)[0]!;
    const moved = applyPlacements(design, res.placements).components.find((c) => c.reference === 'J1')!;
    const padCentre = { x: moved.pads.reduce((a, p) => a + p.at.x, 0) / moved.pads.length, y: moved.pads.reduce((a, p) => a + p.at.y, 0) / moved.pads.length };
    const bodyCentre = { x: (e.minX + e.maxX) / 2, y: (e.minY + e.maxY) / 2 };
    expect((padCentre.x - bodyCentre.x) * nearest.out.x + (padCentre.y - bodyCentre.y) * nearest.out.y).toBeLessThanOrEqual(0);
    // rule 3: the main IC is the part nearest the board centre
    for (const other of ['C1', 'R1', 'R2', 'Y1', 'J1']) expect(fromCentre('U1')).toBeLessThan(fromCentre(other));
  });

  it('rings a subsystem\'s passives around its IC: the decoupling caps end up beside it', async () => {
    const design = await boardOf('decoupling-qfn');
    const { job, ctx } = jobFor(design);
    const res = await new HeuristicPlacer().place(job, ctx);
    expect(res.status).toBe('complete');
    const posed = applyPlacements(design, res.placements);
    const u1 = posed.components.find((c) => c.reference === 'U1')!;
    for (const ref of ['C1', 'C2']) {
      const cap = posed.components.find((c) => c.reference === ref)!;
      const gap = distance(cap.footprint.courtyard!, u1.footprint.courtyard!);
      expect(gap).toBeLessThan(2_000_000); // within 2 mm of the IC it decouples
    }
  });

  it('follows the intent when it names the edge a connector faces', async () => {
    const design = await boardOf('completion');
    const movableRefs = design.components.filter((c) => !c.attributes.locked).map((c) => c.reference);
    const plan = defaultPlan({ design, movableRefs, partition: partitions(design)[0]!, classification: classifyCritical(design) });
    const intent = { ...plan, fixed: [...plan.fixed, { ref: 'J1', edge: 'north' as const, why: 'the cable comes in from the top' }] };
    expect(validatePlan(intent, design, movableRefs).errors).toEqual([]);
    const { job, ctx } = jobFor(design, [{ kind: 'layout.plan', value: intent }]);
    const res = await new HeuristicPlacer().place(job, ctx);
    const board = bbox(design.board.outline);
    const j1 = design.components.find((c) => c.reference === 'J1')!;
    const p = at(design, res.placements, 'J1');
    const e = bbox(poseOutline(j1, p.at, p.rotation));
    // north is the smaller y in KiCad's frame: the part is nearer that edge than any other
    expect(e.minY - board.minY).toBeLessThan(Math.min(board.maxY - e.maxY, e.minX - board.minX, board.maxX - e.maxX));
  });

  it('refuses an intent that names a part the board does not have', async () => {
    const design = await boardOf('completion');
    const plan = defaultPlan({ design, movableRefs: design.components.map((c) => c.reference), partition: partitions(design)[0]!, classification: classifyCritical(design) });
    const broken = { ...plan, subsystems: [...plan.subsystems, { id: 'ghost', members: ['U99'], anchor: null, region: null }] };
    const { job, ctx } = jobFor(design, [{ kind: 'layout.plan', value: broken }]);
    const res = await new HeuristicPlacer().place(job, ctx);
    expect(res.status).toBe('failed');
    expect(res.placements).toEqual([]);
  });
});

describe('layout intent with no reference board', () => {
  it('asks the model for the rules a board is placed by, and for no coordinates', async () => {
    const design = await boardOf('completion');
    const movableRefs = design.components.map((c) => c.reference);
    const { system, user, input } = planPrompt({ design, movableRefs, partitions: partitions(design), classification: classifyCritical(design) });
    expect(system).toMatch(/never give coordinates/);
    expect(system).toMatch(/edge facing off the board/);
    expect(system).toMatch(/main IC sits in the middle/);
    expect(user).toMatch(/positions are not yours to give/);
    // no reference board: nothing about adapting one, and no delta table
    expect(input).not.toHaveProperty('delta');
    expect(input).not.toHaveProperty('reference');
  });

  it('takes the connector edges a model gives and drops the coordinates it should not have given', async () => {
    const design = await boardOf('completion');
    const movableRefs = design.components.map((c) => c.reference);
    const fallback = defaultPlan({ design, movableRefs, partition: partitions(design)[0]!, classification: classifyCritical(design) });
    const merged = planFromModel({ fixed: [{ ref: 'J1', edge: 'south', x_mm: 5, y_mm: 5, why: 'the cable' }, { ref: 'U1', edge: 'nowhere' }] }, fallback);
    const j1 = merged.fixed.find((f) => f.ref === 'J1')!;
    expect(j1.edge).toBe('south');
    expect(j1.x_mm).toBeUndefined();
    expect(merged.fixed.some((f) => f.ref === 'U1')).toBe(false);
  });

  it('plans with the rules when no model is configured, and the plan validates', async () => {
    const design = await boardOf('completion');
    const movableRefs = design.components.filter((c) => !c.attributes.locked).map((c) => c.reference);
    const outcome = await planPlacement({ design, movableRefs, partitions: partitions(design), classification: classifyCritical(design) });
    expect(outcome.fromModel).toBe(false);
    expect(outcome.plan.strategy).toBe('fresh');
    expect(validatePlan(outcome.plan, design, movableRefs).errors).toEqual([]);
  });
});
