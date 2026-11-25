/**
 * Scoring and orchestration (RFC 11 §11, §12.5; AC-17.7): an ineligible
 * candidate never outranks an eligible one, the Pareto frontier is kept, and
 * `routeBoard` writes a complete run directory and ends in one status. The
 * end-to-end and CLI cases use the harness-only reference router and skip
 * without kicad-cli.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { rank } from '../src/pcb/verify/scoring.js';
import { DEFAULT_LOW_SPEED_2_LAYER } from '../src/pcb/verify/profiles/scoring/index.js';
import { routingMetrics, owedBaseline } from '../src/pcb/verify/metrics.js';
import { routeBoard, defaultRegistry } from '../src/pcb/engines/route.js';
import { ReferenceRouter, REFERENCE_ROUTER_MANIFEST } from '../src/pcb/engines/routers/reference/adapter.js';
import { defaultStagedPlan, isPowerNet } from '../src/pcb/engines/plan.js';
import { emitDsn } from '../src/pcb/engines/routers/freerouting/dsn.js';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { verifyDesign } from '../src/pcb/verify/index.js';
import { mmToNm } from '../src/pcb/ir/units.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GOLDEN = path.join(ROOT, 'test', 'fixtures', 'microboards');
const mm = mmToNm;

async function haveKicad(): Promise<boolean> {
  try {
    await execa('kicad-cli', ['version']);
    return true;
  } catch {
    return false;
  }
}

describe('ranking (AC-17.7)', () => {
  const base = { total_wirelength_nm: mm(100), via_count: 4, drc_error_count: 0, drc_critical_count: 0, shorts: 0, runtime_s: 5, pour_largest_share: 1, bottom_signal_length_nm: 0 };
  it('an invalid candidate never beats a valid one, whatever its wirelength', () => {
    const r = rank([
      { id: 'short-but-shorted', metrics: { ...base, completion_rate: 1, total_wirelength_nm: mm(10), shorts: 1 }, gatesPassed: false, gateFailures: ['conn.short'] },
      { id: 'long-but-clean', metrics: { ...base, completion_rate: 1, total_wirelength_nm: mm(300) }, gatesPassed: true, gateFailures: [] },
    ], DEFAULT_LOW_SPEED_2_LAYER);
    expect(r.selected).toBe('long-but-clean');
    expect(r.candidates[1]!.id).toBe('short-but-shorted');
    expect(r.candidates[1]!.eligible).toBe(false);
    expect(r.candidates[1]!.reason).toMatch(/conn\.short/);
  });
  it('profile gates and lexicographic completion come before the weighted score', () => {
    const r = rank([
      { id: 'critical-drc', metrics: { ...base, completion_rate: 1, drc_critical_count: 1 }, gatesPassed: true, gateFailures: [] },
      { id: 'partial', metrics: { ...base, completion_rate: 0.8, total_wirelength_nm: mm(50) }, gatesPassed: true, gateFailures: [] },
      { id: 'complete', metrics: { ...base, completion_rate: 1, total_wirelength_nm: mm(200), via_count: 9 }, gatesPassed: true, gateFailures: [] },
    ], DEFAULT_LOW_SPEED_2_LAYER);
    expect(r.candidates.map((c) => c.id)).toEqual(['complete', 'partial', 'critical-drc']);
    expect(r.candidates[2]!.profileGateFailures[0]).toMatch(/drc_critical_count/);
  });
  it('keeps the Pareto frontier and the raw metrics', () => {
    const r = rank([
      { id: 'a', metrics: { ...base, completion_rate: 1, total_wirelength_nm: mm(100), via_count: 2 }, gatesPassed: true, gateFailures: [] },
      { id: 'b', metrics: { ...base, completion_rate: 1, total_wirelength_nm: mm(80), via_count: 6 }, gatesPassed: true, gateFailures: [] },
      { id: 'c', metrics: { ...base, completion_rate: 1, total_wirelength_nm: mm(120), via_count: 8 }, gatesPassed: true, gateFailures: [] },
    ], DEFAULT_LOW_SPEED_2_LAYER);
    const by = Object.fromEntries(r.candidates.map((c) => [c.id, c]));
    expect(by.a!.pareto && by.b!.pareto).toBe(true);
    expect(by.c!.pareto).toBe(false);
    expect(by.c!.metrics.total_wirelength_nm).toBe(mm(120));
    expect(r.selected).toBeTruthy();
  });
});

describe('metrics', () => {
  it('counts bends, acute angles, vias, wirelength, and the PCBWorld set', async () => {
    const pcb = path.join(GOLDEN, 'clearance', 'board.kicad_pcb');
    const { design } = importBoard({ boardText: await readFile(pcb, 'utf8'), boardPath: pcb, now: 't' });
    const v = verifyDesign({ design });
    const m = routingMetrics({ design, verify: v, baseline: design, runtimeSeconds: 2 });
    expect(m.total_wirelength_nm).toBeGreaterThan(mm(20));
    expect(m.bend_count).toBe(1); // net 2 runs straight through its joint; net 3 turns toward the pad
    expect(m.acute_angle_count).toBe(0);
    expect(m.via_count).toBe(0);
    expect(m['pcbworld.time_s']).toBe(2);
    expect(m['pcbworld.routability']).toBeLessThan(1);
    expect(owedBaseline(design)).toBe(4);
  });
});

describe('routeBoard', () => {
  it('routes the completion board with the reference router and writes a complete run directory', async () => {
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-routeboard-'));
    try {
      const res = await routeBoard({ repoRoot: ROOT, boardPath: path.join(GOLDEN, 'completion', 'board.kicad_pcb'), runDir: path.join(dir, 'run'), routers: ['router-reference'], mode: 'single', policy: { network: 'none', allowHarnessEngines: true, denyLicenses: [] }, limits: { engineSeconds: 120, wallSeconds: 120 } });
      expect(res.outcome.status).toBe('PASS');
      expect(res.ranking.selected).toBe('router-reference');
      expect(res.candidates[0]!.verify.gates.routing.passed).toBe(true);
      expect(res.candidates[0]!.drc!.violations).toEqual([]);
      for (const f of ['snapshot.json', 'ranking.json', 'outcome.json', 'events.jsonl', 'board.svg']) expect(existsSync(path.join(res.runDir, f)), f).toBe(true);
      const cand = (await readdir(path.join(res.runDir, 'candidates')))[0]!;
      for (const f of ['job.json', 'result.json', 'provenance.json', 'candidate.kicad_pcb', 'candidate.json', 'diagnostics.json', 'metrics.json']) expect(existsSync(path.join(res.runDir, 'candidates', cand, f)), f).toBe(true);
      const metrics = JSON.parse(await readFile(path.join(res.runDir, 'candidates', cand, 'metrics.json'), 'utf8'));
      expect(metrics['pcbworld.clean_pass']).toBe(1);
      expect(metrics.completion_rate).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('a refused board is drawn with the gate failure marked', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-routeboard-'));
    try {
      const res = await routeBoard({ repoRoot: ROOT, boardPath: path.join(GOLDEN, 'overlap', 'board.kicad_pcb'), runDir: path.join(dir, 'run'), routers: ['router-reference'], policy: { network: 'none', allowHarnessEngines: true, denyLicenses: [] }, noKicad: true });
      expect(res.outcome.status).toBe('REFUSE');
      expect(res.candidates).toEqual([]);
      const svg = await readFile(path.join(res.runDir, 'board.svg'), 'utf8');
      expect(svg).toContain('<svg');
      // findings are drawn as markers (legend off): the overlapping part gets a red box and a numbered badge
      expect(svg).toContain('stroke="#ff2d2d"');
      expect(svg).toContain('fill="#ff2d2d"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses the harness engine by default and says so', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-routeboard-'));
    try {
      const reg = defaultRegistry(ROOT);
      const res = await routeBoard({ repoRoot: ROOT, boardPath: path.join(GOLDEN, 'completion', 'board.kicad_pcb'), runDir: path.join(dir, 'run'), routers: ['router-reference'], registry: reg, noKicad: true });
      expect(res.outcome.status).toBe('UNSUPPORTED');
      expect(res.ineligible[0]!.reasons[0]).toMatch(/harness-only/);
      // a run that never routed still draws the board it was given
      expect(existsSync(path.join(res.runDir, 'board.svg'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('copperhead pcb CLI', () => {
  it('import, verify, route, score run offline on a golden board', async () => {
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-pcbcli-'));
    try {
      const board = path.join(GOLDEN, 'completion', 'board.kicad_pcb');
      const cli = ['tsx', 'src/cli.ts', '--json', '--repo', ROOT];
      const imp = await execa('npx', [...cli, 'pcb', 'import', '--board', board], { cwd: ROOT, reject: false });
      expect(imp.exitCode, imp.stderr).toBe(0);
      expect(JSON.parse(imp.stdout).components).toBe(6);
      const ver = await execa('npx', [...cli, 'pcb', 'verify', board], { cwd: ROOT, reject: false });
      expect(ver.exitCode, ver.stderr).toBe(0);
      expect(JSON.parse(ver.stdout).status).toBe('PARTIAL');
      const runDir = path.join(dir, 'run');
      const route = await execa('npx', [...cli, 'pcb', 'route', '--board', board, '--routers', 'router-reference', '--allow-harness-engines', '--run-dir', runDir, '--budget-seconds', '120'], { cwd: ROOT, reject: false });
      expect(route.exitCode, route.stderr).toBe(0);
      expect(JSON.parse(route.stdout).status).toBe('PASS');
      const score = await execa('npx', [...cli, 'pcb', 'score', runDir], { cwd: ROOT, reject: false });
      expect(score.exitCode, score.stderr).toBe(0);
      expect(JSON.parse(score.stdout).selected).toBe('router-reference');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
});

describe('staged routing plan (§9.5)', () => {
  it('routes power first at the class width, then critical, then the bulk by race', async () => {
    const pcb = path.join(GOLDEN, 'completion', 'board.kicad_pcb');
    const { design } = importBoard({ boardText: await readFile(pcb, 'utf8'), boardPath: pcb, now: 't' });
    const gnd = design.nets.find((n) => n.name === 'GND')!;
    const other = design.nets.find((n) => n.name !== 'GND' && n.padIds.length >= 2)!;
    design.board.rules.netClasses['Power'] = { trackWidthNm: mm(0.5) };
    gnd.netClass = 'Power';
    const plan = defaultStagedPlan(design, { engineIds: ['router-freerouting', 'router-kicad-tools-astar'], criticalNetNames: [other.name], layerPreferences: [{ layerId: 'B.Cu', mode: 'vertical' }] });
    expect(plan.stages.map((s) => s.name)).toEqual(['power', 'critical', 'bulk']); // no clearance given: no generous pass
    const power = design.nets.filter((n) => n.padIds.length >= 2 && isPowerNet(n, design)).map((n) => n.id);
    expect(power).toContain(gnd.id);
    expect(plan.stages[0]!.netIds).toEqual(power);
    expect(plan.stages[0]!.strategy.trackWidthNm).toBe(mm(0.5));
    expect(plan.stages[0]!.race).toBe(false);
    expect(plan.stages[1]!.netIds).toEqual([other.id]);
    expect(plan.stages[2]!.netIds).toBeNull();
    expect(plan.stages[2]!.race).toBe(true);
    expect(plan.stages[2]!.engineIds).toHaveLength(2);
    expect(plan.stages[2]!.strategy.layers).toEqual({ 'B.Cu': { active: true, preferredDirection: 'vertical' } });
    expect(plan.classification.bulk).not.toContain(gnd.id);
  });
  it('recognises power by class, by name, and by pour', async () => {
    const pcb = path.join(GOLDEN, 'completion', 'board.kicad_pcb');
    const { design } = importBoard({ boardText: await readFile(pcb, 'utf8'), boardPath: pcb, now: 't' });
    const mk = (name: string, netClass = 'Default') => ({ id: name, code: 9, name, padIds: ['a', 'b'], netClass });
    for (const n of ['GND', 'AGND', 'VCC', 'VDD_3V3', '+3V3', '3V3', '+5V', '12V', 'VBUS', 'VIN', '-12V']) expect(isPowerNet(mk(n), design), n).toBe(true);
    for (const n of ['SDA', 'Net-(U1-Pad3)', 'LED_K', 'D+', 'CLK']) expect(isPowerNet(mk(n), design), n).toBe(false);
    expect(isPowerNet(mk('X', 'pwr_rail'), design)).toBe(true);
    const zone = { id: 'z', netId: 'X', layers: ['B.Cu'], outline: { outer: [], holes: [] }, priority: 0, clearanceNm: 0, thermal: null, isKeepout: false, fills: [] };
    const zoned = { ...design, routing: { ...design.routing, zones: [zone] } } as unknown as typeof design;
    expect(isPowerNet(mk('X'), zoned)).toBe(true);
  });
  it('layer preferences and the stage width land in the DSN as Freerouting settings', async () => {
    const pcb = path.join(GOLDEN, 'completion', 'board.kicad_pcb');
    const { design } = importBoard({ boardText: await readFile(pcb, 'utf8'), boardPath: pcb, now: 't' });
    const dsn = emitDsn(design, { boardName: 'b', edgeClearanceNm: mm(0.3), trackWidthNm: mm(0.5), layers: { 'F.Cu': { active: true, preferredDirection: 'horizontal' }, 'B.Cu': { active: false } } });
    expect(dsn).toMatch(/\(autoroute_settings/);
    expect(dsn).toMatch(/\(layer_rule F\.Cu\s+\(active on\)\s+\(preferred_direction horizontal\)/);
    expect(dsn).toMatch(/\(layer_rule B\.Cu\s+\(active off\)/);
    expect(dsn).toMatch(/\(class kicad_default[^]*?\(width 500\)/);
    expect(emitDsn(design, { boardName: 'b', edgeClearanceNm: 0 })).not.toMatch(/autoroute_settings/);
  });
  it('a staged run the budget cuts short is judged on the last stage that routed, not thrown away (B4)', async () => {
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-staged-cut-'));
    try {
      // a router that takes 1.2 s per stage, on a 2 s wall budget: the power stage runs, the bulk stages cannot start
      class SlowRouter extends ReferenceRouter {
        override async route(job: Parameters<ReferenceRouter['route']>[0], ctx: Parameters<ReferenceRouter['route']>[1]) {
          await new Promise((r) => setTimeout(r, 1200));
          const res = await super.route(job, ctx);
          return { ...res, runtime: { wallSeconds: 1.2, engineSeconds: 1.2 } };
        }
      }
      const reg = defaultRegistry(ROOT);
      reg.register(new SlowRouter(), { ...REFERENCE_ROUTER_MANIFEST, id: 'router-slow' });
      const res = await routeBoard({ repoRoot: ROOT, boardPath: path.join(GOLDEN, 'completion', 'board.kicad_pcb'), runDir: path.join(dir, 'run'), routers: ['router-slow'], mode: 'staged', registry: reg, policy: { network: 'none', allowHarnessEngines: true, denyLicenses: [] }, limits: { engineSeconds: 60, wallSeconds: 2 } });
      expect(res.invocations.map((i) => i.stage!.name)).toEqual(['power', 'bulk-generous', 'bulk']);
      expect(res.invocations[0]!.error).toBeNull();
      expect(res.invocations[2]!.error).toMatchObject({ kind: 'timeout' });
      // the power copper is the candidate: a partial board the loop can repair, not a TIMEOUT with nothing
      expect(res.candidates).toHaveLength(1);
      expect(res.candidates[0]!.engineId).toBe('router-slow');
      expect(res.outcome.status).toBe('PARTIAL');
      expect(res.candidates[0]!.verify.metrics.completion_rate).toBeGreaterThan(0);
      expect(res.candidates[0]!.verify.metrics.completion_rate).toBeLessThan(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
  it('a staged run carries the power copper into the bulk stage and yields one candidate per final branch', async () => {
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-staged-'));
    try {
      const res = await routeBoard({ repoRoot: ROOT, boardPath: path.join(GOLDEN, 'completion', 'board.kicad_pcb'), runDir: path.join(dir, 'run'), routers: ['router-reference'], mode: 'staged', policy: { network: 'none', allowHarnessEngines: true, denyLicenses: [] }, limits: { engineSeconds: 240, wallSeconds: 240 } });
      // the bulk routes generous first (1.5x the rule) and re-routes what is owed at the rule
      expect(res.plan!.stages.map((s) => s.name)).toEqual(['power', 'bulk-generous', 'bulk']);
      expect(res.plan!.stages[1]!.strategy.clearanceNm).toBe(Math.round(res.candidates[0]!.design.board.rules.clearanceNm * 1.5));
      expect(res.invocations.map((i) => i.stage!.name)).toEqual(['power', 'bulk-generous', 'bulk']);
      expect(res.candidates).toHaveLength(1);
      expect(res.outcome.status).toBe('PASS');
      expect(res.candidates[0]!.verify.metrics.completion_rate).toBe(1);
      const power = res.invocations[0]!.result!;
      expect(power.segments.length).toBeGreaterThan(0);
      const final = res.invocations[res.invocations.length - 1]!;
      expect(final.stage!.final).toBe(true);
      expect(final.stage!.carried!.segments.length).toBeGreaterThanOrEqual(power.segments.length);
      expect(res.candidates[0]!.verify.metrics.completion_rate).toBe(1);
      // no piece of copper twice: an engine that echoes preserved wires must not double the composite
      const segs = res.candidates[0]!.design.routing.segments;
      const keys = new Set(segs.map((s) => `${s.netId}|${s.layer}|${[`${s.a.x},${s.a.y}`, `${s.b.x},${s.b.y}`].sort().join('|')}|${s.width}`));
      expect(keys.size).toBe(segs.length);
      expect(existsSync(path.join(res.runDir, 'plan.json'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
