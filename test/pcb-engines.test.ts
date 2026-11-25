/**
 * Engine contracts, registry, runner (RFC 11 §8.1, §9.1, §9.3, §9.4, §17;
 * AC-17.2, AC-17.3, AC-17.4). The end-to-end case routes a golden board with
 * the harness-only reference router and verifies the candidate through
 * kicad-cli; it skips without KiCad.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { validateManifest } from '../src/pcb/engines/manifest.js';
import { EngineRegistry, eligible, type RegisteredEngine } from '../src/pcb/engines/registry.js';
import { ReferenceRouter, REFERENCE_ROUTER_MANIFEST } from '../src/pcb/engines/routers/reference/adapter.js';
import { runRouting } from '../src/pcb/engines/runner.js';
import { Budget } from '../src/pcb/engines/budget.js';
import { materialize, candidateFromRouting } from '../src/pcb/engines/candidates.js';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { makeSnapshot, writeRunDir } from '../src/pcb/ir/snapshot.js';
import { loadProfile } from '../src/pcb/verify/profiles/index.js';
import type { EngineManifest } from '../src/pcb/engines/contracts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'fixtures', 'microboards');

async function haveKicad(): Promise<boolean> {
  try {
    await execa('kicad-cli', ['version']);
    return true;
  } catch {
    return false;
  }
}

const base = (): EngineManifest => ({ ...REFERENCE_ROUTER_MANIFEST, harnessOnly: false, id: 'router-x' });

describe('manifests (AC-17.3)', () => {
  it('accepts the reference router manifest and names every missing field', () => {
    expect(validateManifest(REFERENCE_ROUTER_MANIFEST)).toEqual([]);
    const bad = { ...base(), networkRequirement: undefined, inputSchemaVersions: ['0.1'] } as unknown;
    const problems = validateManifest(bad).map((p) => p.field);
    expect(problems).toContain('networkRequirement');
    expect(problems).toContain('inputSchemaVersions');
  });
  it('refuses a copyleft engine declared in-process', () => {
    const p = validateManifest({ ...base(), license: 'GPL-3.0-only', executionMode: 'library' });
    expect(p.some((x) => x.field === 'executionMode')).toBe(true);
    expect(validateManifest({ ...base(), license: 'GPL-3.0-only', executionMode: 'process' })).toEqual([]);
  });
  it('the committed JSON schemas match the generator', async () => {
    const res = await execa('node', ['scripts/pcb-schemas.mjs'], { cwd: path.join(HERE, '..'), reject: false });
    expect(res.exitCode).toBe(0);
    const status = await execa('git', ['status', '--porcelain', 'schemas/pcb'], { cwd: path.join(HERE, '..') });
    expect(status.stdout.trim()).toBe('');
  }, 120_000);
});

describe('eligibility (AC-17.4)', () => {
  const reg = (m: Partial<EngineManifest>): RegisteredEngine => ({ manifest: { ...base(), ...m }, plugin: new ReferenceRouter(), source: 'test' });
  it('fails closed on an unsupported hard constraint', () => {
    const e = eligible(reg({}), { kind: 'router', hardConstraintKinds: ['electrical-layout.differential-pair'], copperLayers: 2 });
    expect(e.ok).toBe(false);
    expect(e.reasons[0]).toMatch(/differential-pair/);
    expect(eligible(reg({ supportedConstraints: ['electrical-layout'] }), { kind: 'router', hardConstraintKinds: ['electrical-layout.differential-pair'], copperLayers: 2 }).ok).toBe(true);
  });
  it('keeps harness-only engines out of production and remote engines off the check path', () => {
    expect(eligible(reg({ harnessOnly: true }), { kind: 'router', hardConstraintKinds: [], copperLayers: 2 }).ok).toBe(false);
    expect(eligible(reg({ harnessOnly: true }), { kind: 'router', hardConstraintKinds: [], copperLayers: 2 }, { network: 'optional', allowHarnessEngines: true, denyLicenses: [] }).ok).toBe(true);
    expect(eligible(reg({ networkRequirement: 'required', executionMode: 'remote' }), { kind: 'router', hardConstraintKinds: [], copperLayers: 2 }, { network: 'none', allowHarnessEngines: false, denyLicenses: [] }).reasons[0]).toMatch(/network/);
    expect(eligible(reg({}), { kind: 'router', hardConstraintKinds: [], copperLayers: 4 }).reasons[0]).toMatch(/copper layers/);
    expect(eligible(reg({}), { kind: 'placer', hardConstraintKinds: [], copperLayers: 2 }).reasons[0]).toMatch(/is a router/);
  });
});

describe('external plugin protocol and isolation (AC-17.2)', () => {
  it('discovers a plugin directory, runs it through job.json/result.json, and catches one that writes into the snapshot', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-engines-'));
    try {
      const text = await readFile(path.join(GOLDEN, 'completion', 'board.kicad_pcb'), 'utf8');
      const { design } = importBoard({ boardText: text, boardPath: 'completion', now: 't' });
      const manifest = { ...base(), id: 'router-fake', executionMode: 'process' };
      const mk = async (name: string, script: string) => {
        const d = path.join(dir, 'plugins', name);
        await mkdir(d, { recursive: true });
        await writeFile(path.join(d, 'manifest.json'), JSON.stringify({ ...manifest, id: name }), 'utf8');
        await writeFile(path.join(d, 'run'), script, 'utf8');
        await chmod(path.join(d, 'run'), 0o755);
      };
      const okScript = `#!/usr/bin/env node
const fs = require('fs'); const args = process.argv; const out = args[args.indexOf('--out') + 1];
console.log(JSON.stringify({ event: 'progress', fraction: 0.5, note: 'half' }));
fs.writeFileSync(out, JSON.stringify({ status: 'complete', segments: [], arcs: [], vias: [], unroutedNetIds: [], diagnostics: [], runtime: { wallSeconds: 0.1 }, provenance: { engineId: 'router-fake', engineVersion: '1', adapterVersion: '1', seed: 0, startedAt: '', finishedAt: '' } }));
`;
      const evilScript = okScript.replace("fs.writeFileSync(out", "fs.chmodSync(process.cwd() + '/../../snapshot.json', 0o644); fs.appendFileSync(process.cwd() + '/../../snapshot.json', ' '); fs.writeFileSync(out");
      await mk('router-fake', okScript);
      await mk('router-evil', evilScript);
      const registry = new EngineRegistry();
      const found = await registry.discover([path.join(dir, 'plugins')]);
      expect(found.loaded.sort()).toEqual(['router-evil', 'router-fake']);
      const snapshot = makeSnapshot(design, { kind: 'routing', netIds: null, region: null, preserveExistingRoutes: false });
      const run = await writeRunDir(path.join(dir, 'run'), snapshot, [path.join(GOLDEN, 'completion', 'board.kicad_pcb')]);
      const progress: number[] = [];
      const res = await runRouting({
        run, sourceText: text, design, snapshotFileHash: run.fileHash, snapshot, budget: new Budget(60, 60),
        engines: registry.list('router'), mode: 'ensemble',
        job: { scope: { netIds: null, region: null, preserveExistingRoutes: false }, strategy: {}, hardConstraints: [], objectives: [], seed: 1, limits: { engineSeconds: 30, wallSeconds: 30, memoryMb: 512 } },
        onEvent: (e) => { if (e.event === 'progress') progress.push(e.fraction as number); },
      });
      const fake = res.invocations.find((i) => i.engineId === 'router-fake')!;
      const evil = res.invocations.find((i) => i.engineId === 'router-evil')!;
      expect(fake.result?.status).toBe('complete');
      expect(fake.error).toBeNull();
      expect(progress).toContain(0.5);
      expect(evil.snapshotViolation).toMatch(/changed/);
      expect((await readFile(path.join(fake.workDir, 'provenance.json'), 'utf8')).length).toBeGreaterThan(10);
      const events = (await readFile(path.join(run.root, 'events.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      expect(events.filter((e) => e.event === 'engine-end')).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('the run budget bounds a staged run', () => {
  it('clamps each invocation to what remains and records, not starts, an engine the budget cannot afford', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-staged-budget-'));
    try {
      const pcb = path.join(GOLDEN, 'completion', 'board.kicad_pcb');
      const text = await readFile(pcb, 'utf8');
      const { design } = importBoard({ boardText: text, boardPath: pcb, now: 't' });
      // a router that takes 1.2 s and reports it, on a run with a 2 s wall budget
      class SlowRouter extends ReferenceRouter {
        override async route(job: Parameters<ReferenceRouter['route']>[0], ctx: Parameters<ReferenceRouter['route']>[1]) {
          await new Promise((r) => setTimeout(r, 1200));
          const res = await super.route(job, ctx);
          return { ...res, runtime: { wallSeconds: 1.2, engineSeconds: 1.2 } };
        }
      }
      const registry = new EngineRegistry();
      registry.register(new SlowRouter(), { ...REFERENCE_ROUTER_MANIFEST, id: 'router-slow' });
      const snapshot = makeSnapshot(design, { kind: 'routing', netIds: null, region: null, preserveExistingRoutes: false });
      const run = await writeRunDir(path.join(dir, 'run'), snapshot, [pcb]);
      const res = await runRouting({
        run, sourceText: text, design, snapshotFileHash: run.fileHash, snapshot, budget: new Budget(60, 2),
        engines: registry.list('router'), mode: 'staged', policy: { network: 'none', allowHarnessEngines: true, denyLicenses: [] },
        job: { scope: { netIds: null, region: null, preserveExistingRoutes: false }, strategy: {}, hardConstraints: [], objectives: [], seed: 1, limits: { engineSeconds: 60, wallSeconds: 60, memoryMb: 512 } },
        stages: [{ name: 'first', engineIds: ['router-slow'], netIds: null }, { name: 'second', engineIds: ['router-slow'], netIds: null }, { name: 'third', engineIds: ['router-slow'], netIds: null }],
      });
      expect(res.invocations).toHaveLength(3);
      const [first, second, third] = res.invocations;
      expect(first!.error).toBeNull();
      const job1 = JSON.parse(await readFile(path.join(first!.workDir, 'job.json'), 'utf8'));
      expect(job1.limits.wallSeconds).toBeLessThanOrEqual(1); // the job asked for 60, the run holds 2, a stage before the last gets half
      expect(job1.limits.engineSeconds).toBe(30);
      // 1.2 s used of 2: the second may still start with what is left, the third may not
      if (second!.workDir) expect(JSON.parse(await readFile(path.join(second!.workDir, 'job.json'), 'utf8')).limits.wallSeconds).toBeLessThanOrEqual(1);
      expect(third!.error).toMatchObject({ kind: 'timeout', message: 'budget exhausted before start' });
      expect(third!.stage).toMatchObject({ name: 'third', final: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('reference router end to end', () => {
  it('routes the completion board, and the candidate verifies through KiCad DRC', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-route-'));
    try {
      const pcb = path.join(GOLDEN, 'completion', 'board.kicad_pcb');
      const text = await readFile(pcb, 'utf8');
      const projectText = await readFile(path.join(GOLDEN, 'completion', 'board.kicad_pro'), 'utf8');
      const { design } = importBoard({ boardText: text, boardPath: pcb, projectText, now: 't' });
      const registry = new EngineRegistry();
      registry.register(new ReferenceRouter(), REFERENCE_ROUTER_MANIFEST);
      const snapshot = makeSnapshot(design, { kind: 'routing', netIds: null, region: null, preserveExistingRoutes: false });
      const run = await writeRunDir(path.join(dir, 'run'), snapshot, [pcb]);
      const res = await runRouting({
        run, sourceText: text, design, projectText, snapshotFileHash: run.fileHash, snapshot, budget: new Budget(120, 120),
        engines: registry.list('router'), mode: 'single', policy: { network: 'none', allowHarnessEngines: true, denyLicenses: [] },
        job: { scope: { netIds: null, region: null, preserveExistingRoutes: false }, strategy: {}, hardConstraints: [], objectives: [], seed: 1, limits: { engineSeconds: 60, wallSeconds: 60, memoryMb: 512 } },
      });
      const inv = res.invocations[0]!;
      expect(inv.error).toBeNull();
      expect(inv.result!.segments.length).toBeGreaterThan(5);
      expect(inv.result!.unroutedNetIds).toEqual([]);
      const kicad = await haveKicad();
      const cand = await materialize(inv, candidateFromRouting(inv.result!, false, design), { sourceText: text, design, projectText, profile: loadProfile('jlcpcb-2layer'), noKicad: !kicad });
      expect(cand.verify.metrics.shorts).toBe(0);
      expect(cand.verify.metrics.unrouted_count).toBe(0);
      if (kicad) {
        expect(cand.drc!.violations.map((v) => v.type)).toEqual([]);
        expect(cand.drc!.unrouted).toBe(0);
        expect(cand.verify.gates.routing.passed).toBe(true);
        expect(cand.verify.disagreements).toEqual([]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
