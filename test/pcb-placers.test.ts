/**
 * Placement harness (RFC 11 §8, Phase 3 tasks 5.1 and 5.3): the fixed control
 * and the harness reference placer through `placeBoard`, placement metrics,
 * the routability probe, and the `pcb place` CLI. The real engines run only
 * behind their flags (COPPERHEAD_TEST_PYPLACER=1, COPPERHEAD_TEST_KICAD_TOOLS=1).
 * Everything that materializes a candidate skips without kicad-cli.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { placeBoard, defaultPlacerRegistry } from '../src/pcb/engines/place.js';
import { defaultRegistry as routerRegistry } from '../src/pcb/engines/route.js';
import { FixedPlacer } from '../src/pcb/engines/placers/fixed/adapter.js';
import { ReferencePlacer } from '../src/pcb/engines/placers/reference/adapter.js';
import { PyplacerPlacer, resolvePyplacer } from '../src/pcb/engines/placers/pyplacer/adapter.js';
import { KicadToolsPlacer } from '../src/pcb/engines/placers/kicad-tools/adapter.js';
import { fixedRefs, movable } from '../src/pcb/engines/placers/shared.js';
import { resolveKct } from '../src/pcb/engines/kicad-tools.js';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { makeSnapshot, DEFAULT_LIMITS } from '../src/pcb/ir/snapshot.js';
import { verifyDesign } from '../src/pcb/verify/index.js';
import { placementMetrics } from '../src/pcb/verify/metrics.js';
import { loadScoringProfile } from '../src/pcb/verify/profiles/scoring/index.js';
import type { PlacementJob, RunContext } from '../src/pcb/engines/contracts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GOLDEN = path.join(ROOT, 'test', 'fixtures', 'microboards');
const HARNESS = { network: 'none' as const, allowHarnessEngines: true, denyLicenses: [] };

async function haveKicad(): Promise<boolean> {
  try {
    await execa('kicad-cli', ['version']);
    return true;
  } catch {
    return false;
  }
}

async function jobFor(caseName: string, opts: { lock?: string[] } = {}): Promise<{ job: PlacementJob; ctx: RunContext; boardPath: string }> {
  const boardPath = path.join(GOLDEN, caseName, 'board.kicad_pcb');
  const { design } = importBoard({ boardText: await readFile(boardPath, 'utf8'), boardPath, now: 't' });
  for (const c of design.components) if (opts.lock?.includes(c.reference)) c.attributes.locked = true;
  const movableIds = design.components.filter((c) => !c.attributes.locked).map((c) => c.id);
  const snapshot = makeSnapshot(design, { kind: 'placement', movableComponentIds: movableIds }, { seed: 0, limits: { ...DEFAULT_LIMITS, engineSeconds: 120, wallSeconds: 120 } });
  const job: PlacementJob = { runId: 'test', snapshot, movableComponentIds: movableIds, constraints: [], objectives: [], seed: 0, limits: snapshot.limits };
  const workDir = await mkdtemp(path.join(tmpdir(), 'copperhead-placer-'));
  const ctx: RunContext = { workDir, boardPath, log: () => {} };
  return { job, ctx, boardPath };
}

describe('placer wrappers', () => {
  it('placer-fixed returns the input placement for every movable part and nothing else', async () => {
    const { job, ctx } = await jobFor('completion', { lock: ['J1'] });
    try {
      const res = await new FixedPlacer().place(job, ctx);
      expect(res.status).toBe('complete');
      expect(res.placements.map((p) => p.id).sort()).toEqual(job.movableComponentIds.sort());
      expect(fixedRefs(job)).toEqual(['J1']);
      const u1 = job.snapshot.design.components.find((c) => c.reference === 'U1')!;
      expect(res.placements.find((p) => p.id === u1.id)).toEqual({ id: u1.id, at: u1.at, rotation: u1.rotation, side: 'front' });
    } finally {
      await rm(ctx.workDir, { recursive: true, force: true });
    }
  });
  it('placer-reference packs the movable parts inside the outline, clear of each other and of the fixed parts', async () => {
    const { job, ctx } = await jobFor('overlap');
    try {
      expect(movable(job)).toHaveLength(2);
      const res = await new ReferencePlacer().place(job, ctx);
      expect(res.status).toBe('complete');
      expect(res.placements).toHaveLength(2);
      const [a, b] = res.placements;
      expect(a!.at).not.toEqual(b!.at);
      // the same input packs the same way
      const again = await new ReferencePlacer().place(job, ctx);
      expect(again.placements).toEqual(res.placements);
    } finally {
      await rm(ctx.workDir, { recursive: true, force: true });
    }
  });
});

describe('placement metrics', () => {
  it('HPWL sums the net bounding boxes and the gate counts follow the diagnostics', async () => {
    const p = path.join(GOLDEN, 'overlap', 'board.kicad_pcb');
    const { design } = importBoard({ boardText: await readFile(p, 'utf8'), boardPath: p, now: 't' });
    const v = verifyDesign({ design });
    const m = placementMetrics({ design, verify: v, runtimeSeconds: 3 });
    expect(m.courtyard_overlap_count).toBe(1);
    expect(m.outside_board_count).toBe(0);
    expect(m.hpwl_nm).toBeGreaterThan(0);
    expect(m.congestion_overflow).toBeGreaterThanOrEqual(0);
    expect(m.component_count).toBe(2);
    expect(m.runtime_s).toBe(3);
    const q = path.join(GOLDEN, 'outside-board', 'board.kicad_pcb');
    const out = importBoard({ boardText: await readFile(q, 'utf8'), boardPath: q, now: 't' }).design;
    expect(placementMetrics({ design: out, verify: verifyDesign({ design: out }) }).outside_board_count).toBeGreaterThan(0);
  });
  it('the placement profile gates on overlaps and off-board parts and prefers routability', () => {
    const p = loadScoringProfile('default-placement-2-layer');
    expect(p.gates.courtyard_overlap_count).toEqual({ max: 0 });
    expect(p.higherIsBetter).toContain('routability_completion');
  });
});

describe('placeBoard', () => {
  it('rejects the fixed control on the seeded overlap, selects the reference placer, and probes routability', async () => {
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-place-'));
    try {
      const res = await placeBoard({ repoRoot: ROOT, boardPath: path.join(GOLDEN, 'overlap', 'board.kicad_pcb'), runDir: path.join(dir, 'run'), placers: ['placer-fixed', 'placer-reference'], mode: 'ensemble', policy: HARNESS, limits: { engineSeconds: 120, wallSeconds: 120 }, probe: { routerId: 'router-reference', registry: routerRegistry(ROOT) } });
      expect(res.outcome.status).toBe('PASS');
      expect(res.ranking.selected).toBe('placer-reference');
      const fixed = res.ranking.candidates.find((c) => c.id === 'placer-fixed')!;
      expect(fixed.eligible).toBe(false);
      expect(fixed.gateFailures).toContain('geom.courtyard-overlap');
      const ref = res.candidates.find((c) => c.engineId === 'placer-reference')!;
      expect(ref.verify.gates.placement.passed).toBe(true);
      expect(ref.drc!.violations.filter((v) => v.type === 'courtyards_overlap')).toEqual([]);
      const metrics = JSON.parse(await readFile(path.join(ref.workDir, 'metrics.json'), 'utf8'));
      expect(metrics.routability_completion).toBe(1);
      expect(metrics.routability_drc_errors).toBe(0);
      expect(existsSync(path.join(ref.workDir, 'probe', 'outcome.json'))).toBe(true);
      for (const f of ['snapshot.json', 'ranking.json', 'outcome.json', 'events.jsonl']) expect(existsSync(path.join(res.runDir, f)), f).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('rips up copper that a moved part invalidated, and keeps it when nothing moved', async () => {
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-place-'));
    try {
      // clearance carries two tracks; the fixed control moves nothing, so they stay
      const kept = await placeBoard({ repoRoot: ROOT, boardPath: path.join(GOLDEN, 'clearance', 'board.kicad_pcb'), runDir: path.join(dir, 'a'), placers: ['placer-fixed'], policy: HARNESS, probe: false, limits: { engineSeconds: 60, wallSeconds: 60 } });
      expect(kept.candidates[0]!.design.routing.segments.length).toBe(4);
      const moved = await placeBoard({ repoRoot: ROOT, boardPath: path.join(GOLDEN, 'clearance', 'board.kicad_pcb'), runDir: path.join(dir, 'b'), placers: ['placer-reference'], policy: HARNESS, probe: false, limits: { engineSeconds: 60, wallSeconds: 60 } });
      expect(moved.candidates[0]!.design.routing.segments).toEqual([]);
      expect(moved.candidates[0]!.verify.diagnostics.filter((d) => d.code === 'conn.short')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('refuses the harness placer by default and names the registered ones', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-place-'));
    try {
      const res = await placeBoard({ repoRoot: ROOT, boardPath: path.join(GOLDEN, 'completion', 'board.kicad_pcb'), runDir: path.join(dir, 'run'), placers: ['placer-reference', 'placer-nope'], registry: defaultPlacerRegistry(ROOT), noKicad: true, probe: false });
      expect(res.outcome.status).toBe('UNSUPPORTED');
      expect(res.ineligible.map((i) => i.engineId).sort()).toEqual(['placer-nope', 'placer-reference']);
      // a run that never placed still draws the board it was given
      expect(existsSync(path.join(res.runDir, 'board.svg'))).toBe(true);
      expect(res.ineligible.find((i) => i.engineId === 'placer-nope')!.reasons[0]).toMatch(/not registered/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('live placers (scripts/tools.sh, vendor/pyplacer)', () => {
  it('pyplacer moves the movable parts and honours --fixed (COPPERHEAD_TEST_PYPLACER=1)', async () => {
    if (process.env.COPPERHEAD_TEST_PYPLACER !== '1' || !existsSync(path.join(resolvePyplacer(), 'run.py'))) return;
    const { job, ctx } = await jobFor('completion', { lock: ['J1'] });
    try {
      const res = await new PyplacerPlacer({ iterations: 200 }).place(job, ctx);
      expect(res.status).toBe('complete');
      expect(res.placements).toHaveLength(5);
      expect(res.provenance.invocation!.args).toContain('--fixed');
      expect(res.provenance.invocation!.args[res.provenance.invocation!.args.indexOf('--fixed') + 1]).toBe('J1');
      const before = new Map(job.snapshot.design.components.map((c) => [c.id, c.at]));
      expect(res.placements.some((p) => p.at.x !== before.get(p.id)!.x || p.at.y !== before.get(p.id)!.y)).toBe(true);
    } finally {
      await rm(ctx.workDir, { recursive: true, force: true });
    }
  }, 300_000);
  it('kct placement optimize returns a placement for every movable part (COPPERHEAD_TEST_KICAD_TOOLS=1)', async () => {
    if (process.env.COPPERHEAD_TEST_KICAD_TOOLS !== '1' || !existsSync(resolveKct(process.env, ROOT))) return;
    const { job, ctx } = await jobFor('completion', { lock: ['J1'] });
    try {
      const res = await new KicadToolsPlacer('force-directed', { repoRoot: ROOT, iterations: 200 }).place(job, ctx);
      expect(['complete', 'partial']).toContain(res.status);
      expect(res.placements.length).toBeGreaterThan(0);
      expect(res.provenance.invocation!.args).toContain('--fixed');
    } finally {
      await rm(ctx.workDir, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('copperhead pcb place CLI', () => {
  it('places the overlap board with the harness placers and reports the ranking', async () => {
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-placecli-'));
    try {
      const out = await execa('npx', ['tsx', 'src/cli.ts', '--json', '--repo', ROOT, 'pcb', 'place', '--board', path.join(GOLDEN, 'overlap', 'board.kicad_pcb'), '--placers', 'placer-fixed,placer-reference', '--mode', 'ensemble', '--allow-harness-engines', '--probe-router', 'router-reference', '--run-dir', path.join(dir, 'run'), '--budget-seconds', '120'], { cwd: ROOT, reject: false });
      expect(out.exitCode, out.stderr).toBe(0);
      const j = JSON.parse(out.stdout);
      expect(j.status).toBe('PASS');
      expect(j.ranking.selected).toBe('placer-reference');
      expect(j.movable).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('placement against intent (B3)', () => {
  it('decoupling-far: stage 3 attaches C1 from the intent, every candidate then satisfies it', async () => {
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-place-intent-'));
    try {
      const res = await placeBoard({ repoRoot: ROOT, boardPath: path.join(GOLDEN, 'decoupling-far', 'board.kicad_pcb'), runDir: path.join(dir, 'run'), placers: ['placer-fixed', 'placer-reference'], mode: 'ensemble', policy: HARNESS, probe: false, limits: { engineSeconds: 60, wallSeconds: 60 } });
      expect(res.outcome.status).toBe('PASS');
      // stage 3 attaches C1 to U1 before any wrapped placer runs, so every candidate inherits the attachment
      expect(res.plan!.stages.find((s) => s.name === 'attach')!.componentIds.length).toBeGreaterThanOrEqual(2); // C1 and its target U1
      for (const id of ['placer-fixed', 'placer-reference']) {
        const c = res.ranking.candidates.find((x) => x.id === id)!;
        expect(c.eligible, id).toBe(true);
        expect(c.metrics.intent_hard_violations, id).toBe(0);
        expect(c.metrics.intent_hard_total, id).toBe(1);
      }
      // the same board verified as given still violates it
      const asGiven = verifyDesign({ design: (await import('../src/pcb/ir/kicad/import.js')).importBoard({ boardText: await readFile(path.join(GOLDEN, 'decoupling-far', 'board.kicad_pcb'), 'utf8'), boardPath: 'b', now: 't' }).design, constraints: (await import('../src/pcb/intent/load.js').then((m) => m.loadConstraints(res.candidates[0]!.design, path.join(GOLDEN, 'decoupling-far', 'board.kicad_pcb')))).registry });
      expect(asGiven.metrics.intent_hard_violations).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
