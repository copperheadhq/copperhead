/**
 * The closed loop (RFC 11 §12; Phase 5 tasks 7.1, 7.2, 7.4): place, route,
 * verify, repair within a budget, record. Harness engines, so it skips
 * without kicad-cli; the planner runs its deterministic policy.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { layoutBoard } from '../src/pcb/agent/orchestrate.js';
import { deterministicPlan, planRepair } from '../src/pcb/agent/repair/planner.js';
import { CATALOG, estimate } from '../src/pcb/agent/repair/catalog.js';
import { loadConfig } from '../src/config.js';
import { readEvidence } from '../src/pcb/evidence.js';
import { runCheck } from '../src/commands/check.js';
import type { Diagnostic } from '../src/pcb/verify/diagnostic.js';
import type { Provider, Msg, Turn } from '../src/agent/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GOLDEN = path.join(ROOT, 'test', 'fixtures', 'microboards');

async function haveKicad(): Promise<boolean> {
  try {
    await execa('kicad-cli', ['version']);
    return true;
  } catch {
    return false;
  }
}

const diag = (code: string, refs: string[] = [], severity: Diagnostic['severity'] = 'error'): Diagnostic => ({ code, category: 'connectivity', severity, entityIds: [], entityReferences: refs, message: code, suggestedActions: [], sourceChecker: { id: 't', version: '1' } });

async function repoWith(caseName: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-layout-'));
  await mkdir(path.join(dir, 'hardware'), { recursive: true });
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await mkdir(path.join(dir, '.copperhead'), { recursive: true });
  await cp(path.join(GOLDEN, caseName, 'board.kicad_pcb'), path.join(dir, 'hardware', 'board.kicad_pcb'));
  await cp(path.join(GOLDEN, caseName, 'board.kicad_pro'), path.join(dir, 'hardware', 'board.kicad_pro'));
  if (existsSync(path.join(GOLDEN, caseName, 'intent.yaml'))) await cp(path.join(GOLDEN, caseName, 'intent.yaml'), path.join(dir, 'hardware', 'intent.yaml'));
  await writeFile(path.join(dir, 'docs', 'LAYOUT.md'), '# Layout\n\n## Draft quality\n\ngrid\n', 'utf8');
  await writeFile(path.join(dir, '.copperhead', 'config.json'), JSON.stringify({ board: 'hardware/board.kicad_pcb', docs: 'docs/', maxRepairCycles: 2, pcb: { routers: ['router-reference'], placers: ['placer-reference'], allowHarnessEngines: true, budgetSeconds: 240 } }), 'utf8');
  return dir;
}

describe('repair catalog and planner', () => {
  it('every catalog entry has a cost; routing reruns cost the last routing run, placement adds a placement', () => {
    const last = { routingSeconds: 20, placementSeconds: 4 };
    for (const e of CATALOG) {
      const c = estimate({ type: e.type, reason: '', parameters: {} }, last);
      if (e.reruns === 'none') expect(c.engineSeconds).toBe(0);
      if (e.reruns === 'routing') expect(c.engineSeconds).toBe(20);
      if (e.reruns === 'routing-owed') expect(c.engineSeconds).toBe(10);
      if (e.reruns === 'placement') expect(c.engineSeconds).toBe(24);
    }
  });
  it('the deterministic policy: shorts rip up, owed connections continue, tune, then switch engine, hard intent with nothing left holds', () => {
    const base = { ranking: null, budgetRemaining: { engineSeconds: 600, wallSeconds: 600 }, last: { routingSeconds: 10, placementSeconds: 2 }, history: [], routers: ['router-a', 'router-b'] };
    expect(deterministicPlan({ ...base, diagnostics: [diag('conn.short', ['GND', 'VCC'])] }).action).toMatchObject({ type: 'rip-up-nets', parameters: { nets: ['GND', 'VCC'] } });
    const owed = [diag('conn.unrouted', ['SIG1'], 'info')];
    const zero = deterministicPlan({ ...base, diagnostics: owed }).action!;
    expect(zero).toMatchObject({ type: 'continue-routing', parameters: { nets: ['SIG1'] } });
    const first = deterministicPlan({ ...base, diagnostics: owed, history: [zero] }).action!;
    expect(first.type).toBe('tune-router');
    const second = deterministicPlan({ ...base, diagnostics: owed, history: [zero, first] }).action!;
    expect(second).toMatchObject({ type: 'select-router', parameters: { routerId: 'router-a' } });
    const third = deterministicPlan({ ...base, diagnostics: owed, history: [zero, first, second] }).action!;
    expect(third).toMatchObject({ type: 'select-router', parameters: { routerId: 'router-b' } });
    const fourth = deterministicPlan({ ...base, diagnostics: owed, history: [zero, first, second, third] }).action!;
    expect(fourth.type).toBe('change-net-priority');
    const none = deterministicPlan({ ...base, diagnostics: owed, history: [zero, first, second, third, fourth] });
    expect(none.action).toBeNull();
    // a first pass that spent its whole share: continuing costs half of it and fits where a full rerun does not
    expect(deterministicPlan({ ...base, diagnostics: owed, last: { routingSeconds: 300, placementSeconds: 2 }, budgetRemaining: { engineSeconds: 295, wallSeconds: 295 } }).action!.type).toBe('continue-routing');
    expect(deterministicPlan({ ...base, diagnostics: owed, last: { routingSeconds: 300, placementSeconds: 2 }, budgetRemaining: { engineSeconds: 295, wallSeconds: 295 }, history: [zero] }).action).toBeNull();
    const hold = deterministicPlan({ ...base, diagnostics: [diag('intent.functional.separation', ['U1', 'U2'])] });
    expect(hold.action!.type).toBe('request-user-action');
    // nothing fits a tiny budget
    expect(deterministicPlan({ ...base, diagnostics: owed, budgetRemaining: { engineSeconds: 1, wallSeconds: 1 } }).action).toBeNull();
  });
  it('a model answer is validated against the catalog, the routers, the budget, and the history; otherwise the policy stands', async () => {
    const fake = (text: string): Provider => ({ async chat(_m: Msg[]): Promise<Turn> { return { text, toolCalls: [], usage: { tokensIn: 0, tokensOut: 0 } } as unknown as Turn; }, async close() {} }) as unknown as Provider;
    const base = { diagnostics: [diag('conn.unrouted', ['SIG1'], 'info')], ranking: null, budgetRemaining: { engineSeconds: 600, wallSeconds: 600 }, last: { routingSeconds: 10, placementSeconds: 2 }, history: [], routers: ['router-a'] };
    const ok = await planRepair({ ...base, provider: fake('{"type":"select-router","reason":"try a","parameters":{"routerId":"router-a"}}') });
    expect(ok).toMatchObject({ fromModel: true, action: { type: 'select-router', parameters: { routerId: 'router-a' } } });
    const bad = await planRepair({ ...base, provider: fake('{"type":"select-router","parameters":{"routerId":"router-zzz"}}') });
    expect(bad.fromModel).toBe(false);
    expect(bad.reason).toMatch(/unknown router/);
    const relax = await planRepair({ ...base, provider: fake('{"type":"relax-constraint","parameters":{}}') });
    expect(relax.fromModel).toBe(false);
    expect(relax.reason).toMatch(/not in the catalog/);
    const prose = await planRepair({ ...base, provider: fake('I would try more passes.') });
    expect(prose.fromModel).toBe(false);
  });
});

describe('layoutBoard', () => {
  it('places and routes the completion board in one cycle, applies it, and records evidence that check accepts', async () => {
    if (!(await haveKicad())) return;
    const dir = await repoWith('completion');
    try {
      const config = await loadConfig(dir);
      const res = await layoutBoard({ repoRoot: dir, config, boardPath: path.join(dir, 'hardware', 'board.kicad_pcb'), runDir: path.join(dir, '.copperhead', 'runs', 'l1', 'layout'), apply: true, probeRouter: 'router-reference', policy: { network: 'none', allowHarnessEngines: true, denyLicenses: [] } });
      expect(res.outcome.status, res.outcome.detail.join('\n')).toBe('PASS');
      expect(res.cycles).toHaveLength(1);
      expect(res.applied).toBe(true);
      expect(res.verdict!.ok).toBe(true);
      const md = await readFile(path.join(dir, 'docs', 'LAYOUT.md'), 'utf8');
      expect(md).toContain('## Draft quality');
      expect(readEvidence(md)!.runDir).toBe('.copperhead/runs/l1/layout');
      expect((await readFile(path.join(dir, 'hardware', 'board.kicad_pcb'), 'utf8')).match(/\(segment/g)!.length).toBeGreaterThan(5);
      expect(existsSync(path.join(res.runDir, 'cycle-0', 'placement', 'outcome.json'))).toBe(true);
      expect(existsSync(path.join(res.runDir, 'cycle-0', 'routing', 'outcome.json'))).toBe(true);
      const check = await runCheck(dir, () => {});
      expect(check.layout).toMatchObject({ ok: true, status: 'PASS' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);

  it('congestion: the loop runs repair cycles under the policy and ends PARTIAL with the cycles recorded, board unchanged without --apply', async () => {
    if (!(await haveKicad())) return;
    const dir = await repoWith('congestion');
    try {
      const config = await loadConfig(dir);
      const before = await readFile(path.join(dir, 'hardware', 'board.kicad_pcb'), 'utf8');
      const res = await layoutBoard({ repoRoot: dir, config, boardPath: path.join(dir, 'hardware', 'board.kicad_pcb'), runDir: path.join(dir, '.copperhead', 'runs', 'l2', 'layout'), place: false, apply: false, maxRepairCycles: 2, budgetSeconds: 240, policy: { network: 'none', allowHarnessEngines: true, denyLicenses: [] } });
      expect(['PARTIAL', 'PASS']).toContain(res.outcome.status);
      expect(res.cycles.length).toBeGreaterThanOrEqual(1);
      if (res.outcome.status === 'PARTIAL') {
        expect(res.cycles.length).toBeGreaterThanOrEqual(2);
        expect(res.cycles[1]!.action).not.toBeNull();
        // owed connections are info-severity: the cycle record counts them on the selected candidate, not on the outcome that drops them (B4)
        expect(res.cycles[0]!.owed).toBeGreaterThan(0);
      }
      expect(await readFile(path.join(dir, 'hardware', 'board.kicad_pcb'), 'utf8')).toBe(before);
      expect(existsSync(path.join(res.runDir, 'evidence.json'))).toBe(true);
      expect(existsSync(path.join(res.runDir, 'outcome.json'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);

  it('copperhead pcb layout --apply runs the loop from the CLI', async () => {
    if (!(await haveKicad())) return;
    const dir = await repoWith('completion');
    try {
      const out = await execa('npx', ['tsx', path.join(ROOT, 'src', 'cli.ts'), '--json', '--repo', dir, 'pcb', 'layout', '--allow-harness-engines', '--apply', '--run-dir', '.copperhead/runs/l3/layout', '--budget-seconds', '240'], { cwd: ROOT, reject: false });
      expect(out.exitCode, out.stderr).toBe(0);
      const j = JSON.parse(out.stdout);
      expect(j.status).toBe('PASS');
      expect(j.applied).toBe(true);
      expect(j.cycles).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
