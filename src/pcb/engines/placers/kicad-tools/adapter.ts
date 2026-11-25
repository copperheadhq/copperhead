/**
 * placer-kicad-tools-physics / -evolutionary: `kct placement optimize` (MIT)
 * out of process on the snapshot board, in the net-code dialect its parser
 * reads (ADR 0002, ADR 0008).
 */
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EngineManifest, PlacementJob, PlacementResult, PlacerPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import { EngineError } from '../../../ir/status.js';
import { importBoard } from '../../../ir/kicad/import.js';
import { resolveKct, boardForKct } from '../../kicad-tools.js';
import { fixedRefs, placementsFrom, resultShape } from '../shared.js';

export type KctPlacementStrategy = 'force-directed' | 'evolutionary';

function manifestFor(strategy: KctPlacementStrategy): EngineManifest {
  return {
    id: strategy === 'force-directed' ? 'placer-kicad-tools-physics' : 'placer-kicad-tools-evolutionary',
    kind: 'placer',
    version: '0.20.0',
    adapterVersion: '1',
    license: 'MIT',
    inputSchemaVersions: [ENGINE_SCHEMA_VERSION],
    outputSchemaVersions: [ENGINE_SCHEMA_VERSION],
    determinism: strategy === 'force-directed' ? 'deterministic' : 'nondeterministic',
    executionMode: 'process',
    networkRequirement: 'none',
    harnessOnly: false,
    requires: { binaries: ['kct'] },
    capabilities: { bottomSide: false, rotation: false, arbitraryOutline: false, relativeConstraints: ['keepout'], fixedComponents: true, congestionAwareness: strategy === 'force-directed', layoutReuse: false },
    supportedConstraints: [],
  };
}

export const KCT_PHYSICS_MANIFEST = manifestFor('force-directed');
export const KCT_EVOLUTIONARY_MANIFEST = manifestFor('evolutionary');

export class KicadToolsPlacer implements PlacerPlugin {
  private readonly manifestValue: EngineManifest;
  constructor(private readonly strategy: KctPlacementStrategy, private readonly opts: { kct?: string; repoRoot?: string; iterations?: number; generations?: number } = {}) {
    this.manifestValue = manifestFor(strategy);
  }
  async manifest(): Promise<EngineManifest> {
    return this.manifestValue;
  }
  async place(job: PlacementJob, ctx: RunContext): Promise<PlacementResult> {
    const t0 = Date.now();
    const kct = this.opts.kct ?? resolveKct(process.env, this.opts.repoRoot ?? process.cwd());
    const design = job.snapshot.design;
    const inPath = path.join(ctx.workDir, 'board-netcodes.kicad_pcb');
    await writeFile(inPath, boardForKct(await readFile(ctx.boardPath, 'utf8'), design), 'utf8');
    const outPath = path.join(ctx.workDir, 'placed.kicad_pcb');
    const fixed = fixedRefs(job);
    const args = ['placement', 'optimize', inPath, '-o', outPath, '--strategy', this.strategy, '--format', 'json', ...(fixed.length ? ['--fixed', fixed.join(',')] : []), ...(this.opts.iterations ? ['--iterations', String(this.opts.iterations)] : []), ...(this.opts.generations ? ['--generations', String(this.opts.generations)] : [])];
    ctx.log(`${kct} ${args.join(' ')}`);
    const res = await execa(kct, args, { cwd: ctx.workDir, reject: false, timeout: job.limits.wallSeconds * 1000, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, extendEnv: false, ...(ctx.signal ? { cancelSignal: ctx.signal } : {}) });
    await writeFile(path.join(ctx.workDir, 'kct.log'), `${res.stdout ?? ''}\n${res.stderr ?? ''}`, 'utf8');
    const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    if (res.timedOut) throw new EngineError('timeout', `kct placement optimize exceeded ${job.limits.wallSeconds}s`, 'raise the budget or lower iterations');
    if (res.failed && /ENOENT/.test(String((res as { code?: string }).code ?? ''))) throw new EngineError('no-binary', `kct not found at "${kct}"`, 'run scripts/tools.sh kicad-tools or pip install kicad-tools==0.20.0');
    if (res.exitCode !== 0) throw new EngineError('process-failed', `kct placement optimize exited ${res.exitCode}: ${combined.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`, 'see kct.log in the run directory');
    if (!existsSync(outPath)) throw new EngineError('no-output', 'kct exited clean but wrote no board', 'see kct.log in the run directory');
    const output = importBoard({ boardText: await readFile(outPath, 'utf8'), boardPath: outPath, now: design.source.importedAt }).design;
    const { placements, unplaced } = placementsFrom(job, output);
    const wall = (Date.now() - t0) / 1000;
    return resultShape(unplaced.length ? (placements.length ? 'partial' : 'failed') : 'complete', placements, unplaced, wall, { engineId: this.manifestValue.id, engineVersion: this.manifestValue.version, adapterVersion: '1', invocation: { binary: kct, args, envKeys: ['PATH', 'HOME'] }, seed: job.seed, exitCode: res.exitCode ?? -1, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString() });
  }
}
