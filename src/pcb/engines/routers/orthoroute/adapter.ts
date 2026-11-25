/**
 * router-orthoroute: bbenchoff/OrthoRoute (MIT) in its headless mode, `python main.py headless <board>.ORP -o <out>.ORS`.
 * The ORP is written from the IR (no KiCad GUI, no IPC), the ORS read back. OrthoRoute routes laterally on
 * inner layers only (its outer layers carry pad escapes: `unified_pathfinder.py`, "Lateral routing layers: inner
 * layers only"), so the manifest declares a four-layer minimum and the registry never offers it a two-layer
 * board. CPU-only by default; `strategy.gpu: true` asks for CUDA. ADR 0010.
 */
import { execa } from 'execa';
import { copperStack } from '../../../ir/layers.js';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EngineManifest, RoutingJob, RoutingResult, RouterPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import { EngineError } from '../../../ir/status.js';
import { toolsDirs } from '../../tools.js';
import { buildOrp, encodeOrp, netsTouched, parseOrs } from './orp.js';

export const ORTHOROUTE_MANIFEST: EngineManifest = {
  id: 'router-orthoroute',
  kind: 'router',
  version: '1.0.0',
  adapterVersion: '1',
  license: 'MIT',
  inputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  outputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  determinism: 'seeded',
  executionMode: 'process',
  networkRequirement: 'none',
  harnessOnly: false,
  requires: { binaries: ['orthoroute'], python: '>=3.10' },
  capabilities: { minLayers: 4, maxLayers: 32, differentialPairs: false, lengthMatching: false, pushAndShove: false, partialRouting: true, preserveExistingRoutes: false, arbitraryAngles: false, blindBuriedVias: false, copperZones: false },
  supportedConstraints: ['routing.width', 'routing.clearance', 'routing.via'],
};

export interface OrthoroutePaths {
  /** The OrthoRoute checkout (holds `main.py`). */
  dir: string;
  /** The interpreter with numpy and scipy (CuPy for the GPU). */
  python: string;
}

/** `COPPERHEAD_ORTHOROUTE` (checkout) and `COPPERHEAD_ORTHOROUTE_PYTHON` override; else `vendor/tools/orthoroute` with `or-venv`. */
export function resolveOrthoroute(env = process.env, repoRoot = process.cwd()): OrthoroutePaths {
  const dirs = env.COPPERHEAD_ORTHOROUTE?.trim() ? [env.COPPERHEAD_ORTHOROUTE.trim()] : toolsDirs(repoRoot).map((d) => path.join(d, 'orthoroute'));
  const dir = dirs.find((d) => existsSync(path.join(d, 'main.py')));
  if (!dir) throw new EngineError('no-binary', 'OrthoRoute checkout not found', 'git clone https://github.com/bbenchoff/OrthoRoute vendor/tools/orthoroute, or set COPPERHEAD_ORTHOROUTE');
  const python = env.COPPERHEAD_ORTHOROUTE_PYTHON?.trim() || toolsDirs(repoRoot).map((d) => path.join(d, 'or-venv', 'bin', 'python')).find((p) => existsSync(p)) || 'python3';
  return { dir, python };
}

export class OrthorouteRouter implements RouterPlugin {
  constructor(private readonly opts: { repoRoot?: string; paths?: OrthoroutePaths } = {}) {}

  async manifest(): Promise<EngineManifest> {
    return ORTHOROUTE_MANIFEST;
  }

  async estimate(job: RoutingJob): Promise<{ engineSeconds: number; wallSeconds: number }> {
    const n = job.snapshot.design.nets.length;
    return { engineSeconds: 5 + n, wallSeconds: 10 + n * 2 };
  }

  async route(job: RoutingJob, ctx: RunContext): Promise<RoutingResult> {
    const t0 = Date.now();
    const { dir, python } = this.opts.paths ?? resolveOrthoroute(process.env, this.opts.repoRoot ?? process.cwd());
    const design = job.snapshot.design;
    const orpPath = path.join(ctx.workDir, 'board.ORP');
    const orsPath = path.join(ctx.workDir, 'board.ORS');
    const orp = buildOrp(design, {
      boardName: path.basename(design.source.files.board, '.kicad_pcb'),
      netIds: job.scope.netIds ? new Set(job.scope.netIds) : null,
      ...(typeof job.strategy.clearanceNm === 'number' ? { clearanceNm: job.strategy.clearanceNm } : {}),
      ...(typeof job.strategy.trackWidthNm === 'number' ? { trackWidthNm: job.strategy.trackWidthNm } : {}),
      ...(typeof job.strategy.gridPitchMm === 'number' ? { gridPitchMm: job.strategy.gridPitchMm } : {}),
    });
    await writeFile(orpPath, encodeOrp(orp));
    await rm(orsPath, { force: true }); // a stale solution must not read as this run's
    const iterations = Number(job.strategy.iterations ?? 200);
    const args = [path.join(dir, 'main.py'), 'headless', orpPath, '-o', orsPath, '--max-iterations', String(iterations), job.strategy.gpu === true ? '--use-gpu' : '--cpu-only'];
    ctx.log(`${python} ${args.join(' ')}`);
    const res = await execa(python, args, { cwd: dir, reject: false, timeout: job.limits.wallSeconds * 1000, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PYTHONUNBUFFERED: '1' }, extendEnv: false, ...(ctx.signal ? { cancelSignal: ctx.signal } : {}) });
    await writeFile(path.join(ctx.workDir, 'orthoroute.log'), `${res.stdout ?? ''}\n${res.stderr ?? ''}`, 'utf8');
    if (res.timedOut) throw new EngineError('timeout', `OrthoRoute exceeded ${job.limits.wallSeconds}s`, 'raise the budget or lower iterations');
    if (res.failed && /ENOENT/.test(String((res as { code?: string }).code ?? ''))) throw new EngineError('no-runtime', `python not found at "${python}"`, 'create vendor/tools/or-venv with numpy and scipy, or set COPPERHEAD_ORTHOROUTE_PYTHON');
    if (res.exitCode !== 0 && !existsSync(orsPath)) throw new EngineError('process-failed', `OrthoRoute exited ${res.exitCode}: ${`${res.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`, 'see orthoroute.log in the run directory');
    if (!existsSync(orsPath)) throw new EngineError('no-output', 'OrthoRoute exited clean but wrote no solution file', 'see orthoroute.log in the run directory');
    const copperLayers = copperStack(design);
    const parsed = parseOrs(await readFile(orsPath), { copperLayers, netIdByName: new Map(design.nets.map((n) => [n.name, n.id])), rules: design.board.rules, namespace: `${design.designId}/${job.runId}` });
    const routable = design.nets.filter((n) => n.padIds.length >= 2 && (!job.scope.netIds || job.scope.netIds.includes(n.id)));
    // the engine emits pad-escape stubs on nets it never finished, so a net counts only when its copper reaches two of its pads
    const routed = netsTouched(design, parsed);
    const unrouted = routable.filter((n) => !routed.has(n.id)).map((n) => n.id);
    const nothing = routable.length > 0 && routed.size === 0;
    const wall = (Date.now() - t0) / 1000;
    return {
      status: nothing ? 'failed' : unrouted.length ? 'partial' : 'complete',
      segments: parsed.segments,
      arcs: [],
      vias: parsed.vias,
      unroutedNetIds: unrouted,
      diagnostics: nothing
        ? [{ code: 'quality.engine_no_copper', category: 'quality', severity: 'info', entityIds: [], entityReferences: [], message: copperLayers.length < 4 ? `OrthoRoute routed none of ${routable.length} net(s) in ${parsed.iterations ?? '?'} iteration(s): it routes on inner layers only, and this board has ${copperLayers.length}` : `OrthoRoute routed none of ${routable.length} net(s) in ${parsed.iterations ?? '?'} iteration(s) on ${copperLayers.length} layers; see orthoroute.log`, suggestedActions: [], sourceChecker: { id: ORTHOROUTE_MANIFEST.id, version: '1' } }]
        : [],
      runtime: { wallSeconds: wall, engineSeconds: wall },
      provenance: { engineId: ORTHOROUTE_MANIFEST.id, engineVersion: ORTHOROUTE_MANIFEST.version, adapterVersion: '1', invocation: { binary: python, args, envKeys: ['PATH', 'HOME', 'PYTHONUNBUFFERED'] }, seed: job.seed, exitCode: res.exitCode ?? -1, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString() },
    };
  }
}
