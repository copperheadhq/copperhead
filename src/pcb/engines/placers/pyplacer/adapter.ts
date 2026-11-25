/**
 * placer-pyplacer: ajokela/pyplacer (BSD-3-Clause, vendored under
 * vendor/pyplacer with a `--fixed` patch) run out of process on the snapshot
 * board. Simulated annealing over wirelength; seeded; no rotation moves, no
 * bottom side (ADR 0008).
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EngineManifest, PlacementJob, PlacementResult, PlacerPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import { EngineError } from '../../../ir/status.js';
import { importBoard } from '../../../ir/kicad/import.js';
import { packageRoot } from '../../tools.js';
import { boardForKct } from '../../kicad-tools.js';
import { fixedRefs, placementsFrom, resultShape } from '../shared.js';

export const PYPLACER_MANIFEST: EngineManifest = {
  id: 'placer-pyplacer',
  kind: 'placer',
  version: '34baa02',
  adapterVersion: '1',
  license: 'BSD-3-Clause',
  inputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  outputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  determinism: 'seeded',
  executionMode: 'process',
  networkRequirement: 'none',
  harnessOnly: false,
  requires: { binaries: ['python3'] },
  capabilities: { bottomSide: false, rotation: false, arbitraryOutline: false, relativeConstraints: [], fixedComponents: true, congestionAwareness: true, layoutReuse: false },
  supportedConstraints: [],
};

/** The vendored copy first (its --fixed patch is required), then COPPERHEAD_PYPLACER_DIR. */
export function resolvePyplacer(env = process.env): string {
  const explicit = env.COPPERHEAD_PYPLACER_DIR?.trim();
  if (explicit) return explicit;
  return path.join(packageRoot(), 'vendor', 'pyplacer');
}

export function resolvePython(env = process.env): string {
  return env.COPPERHEAD_PYTHON?.trim() || 'python3';
}

export class PyplacerPlacer implements PlacerPlugin {
  constructor(private readonly opts: { python?: string; dir?: string; iterations?: number; cooling?: number } = {}) {}
  async manifest(): Promise<EngineManifest> {
    return PYPLACER_MANIFEST;
  }
  async place(job: PlacementJob, ctx: RunContext): Promise<PlacementResult> {
    const t0 = Date.now();
    const dir = this.opts.dir ?? resolvePyplacer();
    const run = path.join(dir, 'run.py');
    if (!existsSync(run)) throw new EngineError('no-binary', `pyplacer not found at "${dir}"`, 'the vendored copy lives under vendor/pyplacer; or set COPPERHEAD_PYPLACER_DIR');
    const python = this.opts.python ?? resolvePython();
    // pyplacer's parser reads pad nets as `(net N "name")`: hand it the code dialect when the board carries only names
    const inPath = path.join(ctx.workDir, 'board-netcodes.kicad_pcb');
    await writeFile(inPath, boardForKct(await readFile(ctx.boardPath, 'utf8'), job.snapshot.design), 'utf8');
    const outPath = path.join(ctx.workDir, 'placed.kicad_pcb');
    const iterations = Number(this.opts.iterations ?? 2000);
    const cooling = Number(this.opts.cooling ?? 0.95);
    const args = [run, inPath, outPath, '--seed', String(job.seed), '--iterations', String(iterations), '--cooling', String(cooling), '--fixed', fixedRefs(job).join(','), '--quiet'];
    ctx.log(`${python} ${args.join(' ')}`);
    const res = await execa(python, args, { cwd: dir, reject: false, timeout: job.limits.wallSeconds * 1000, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PYTHONDONTWRITEBYTECODE: '1' }, extendEnv: false, ...(ctx.signal ? { cancelSignal: ctx.signal } : {}) });
    await writeFile(path.join(ctx.workDir, 'pyplacer.log'), `${res.stdout ?? ''}\n${res.stderr ?? ''}`, 'utf8');
    const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    if (res.timedOut) throw new EngineError('timeout', `pyplacer exceeded ${job.limits.wallSeconds}s`, 'raise the budget or lower iterations');
    if (res.failed && /ENOENT/.test(String((res as { code?: string }).code ?? ''))) throw new EngineError('no-runtime', `python not found at "${python}"`, 'install Python 3.10+ with numpy or set COPPERHEAD_PYTHON');
    if (/No module named 'numpy'/.test(combined)) throw new EngineError('no-runtime', `the python at "${python}" has no numpy`, 'pip install numpy, or point COPPERHEAD_PYTHON at an interpreter that has it');
    if (res.exitCode !== 0) throw new EngineError('process-failed', `pyplacer exited ${res.exitCode}: ${combined.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`, 'see pyplacer.log in the run directory');
    if (!existsSync(outPath)) throw new EngineError('no-output', 'pyplacer exited clean but wrote no board', 'see pyplacer.log in the run directory');
    const output = importBoard({ boardText: await readFile(outPath, 'utf8'), boardPath: outPath, now: job.snapshot.design.source.importedAt }).design;
    const { placements, unplaced } = placementsFrom(job, output);
    const wall = (Date.now() - t0) / 1000;
    const r = resultShape(unplaced.length ? (placements.length ? 'partial' : 'failed') : 'complete', placements, unplaced, wall, { engineId: PYPLACER_MANIFEST.id, engineVersion: PYPLACER_MANIFEST.version, adapterVersion: '1', invocation: { binary: python, args, envKeys: ['PATH', 'HOME', 'PYTHONDONTWRITEBYTECODE'] }, seed: job.seed, exitCode: res.exitCode ?? -1, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString() });
    return r;
  }
}
