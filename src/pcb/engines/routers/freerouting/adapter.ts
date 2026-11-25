/**
 * router-freerouting (ADR 0008, implementation spec §6.6): the bulk router,
 * GPL-3.0, run out of process on a user-installed jar and JRE, never bundled.
 * Every failure is named with its fix; a missing router degrades the run, it
 * never masquerades as a routed board.
 */
import { execa } from 'execa';
import { copperStack } from '../../../ir/layers.js';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { EngineManifest, RoutingJob, RoutingResult, RouterPlugin, RunContext } from '../../contracts.js';
import { ENGINE_SCHEMA_VERSION } from '../../contracts.js';
import { EngineError } from '../../../ir/status.js';
import { toolsDirs } from '../../tools.js';
import { emitDsn } from './dsn.js';
import { parseSes } from './ses.js';

export const FREEROUTING_MANIFEST: EngineManifest = {
  id: 'router-freerouting',
  kind: 'router',
  version: '2.4.1',
  adapterVersion: '1',
  license: 'GPL-3.0-only',
  inputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  outputSchemaVersions: [ENGINE_SCHEMA_VERSION],
  determinism: 'nondeterministic',
  executionMode: 'process',
  networkRequirement: 'none',
  harnessOnly: false,
  requires: { java: '>=25' },
  capabilities: { maxLayers: 32, differentialPairs: false, lengthMatching: false, pushAndShove: true, partialRouting: true, preserveExistingRoutes: true, arbitraryAngles: true, blindBuriedVias: false, copperZones: false },
  supportedConstraints: ['routing.width', 'routing.clearance', 'routing.via'],
};

export interface FreeroutingPaths {
  jar: string;
  java: string;
}

/** Jar: COPPERHEAD_FREEROUTING_JAR > config > vendor/tools (target repo, then the copperhead package) > the KiCad plugin install. */
export async function resolveJar(configJar: string | null | undefined, env = process.env, repoRoot = process.cwd()): Promise<string> {
  const explicit = env.COPPERHEAD_FREEROUTING_JAR?.trim() || configJar?.trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new EngineError('no-binary', `Freerouting jar not found at "${explicit}"`, 'fix COPPERHEAD_FREEROUTING_JAR or pcb.freeroutingJar');
    return explicit;
  }
  const candidates: string[] = [];
  const pluginRoots = [
    path.join(os.homedir(), '.local', 'share', 'kicad'),
    path.join(os.homedir(), 'Library', 'Preferences', 'kicad'),
    path.join(env.APPDATA ?? '', 'kicad'),
  ];
  for (const root of [...toolsDirs(repoRoot), ...pluginRoots]) {
    if (!root || !existsSync(root)) continue;
    for (const f of await walkJars(root, 4)) candidates.push(f);
  }
  candidates.sort((a, b) => versionOf(b) - versionOf(a));
  if (!candidates[0]) throw new EngineError('no-binary', 'no Freerouting jar found', 'run scripts/tools.sh freerouting, install the KiCad Freerouting plugin, or set COPPERHEAD_FREEROUTING_JAR');
  return candidates[0];
}

async function walkJars(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkJars(p, depth - 1)));
    else if (/^freerouting-[\d.]+\.jar$/.test(e.name)) out.push(p);
  }
  return out;
}

function versionOf(jar: string): number {
  const m = /freerouting-(\d+)\.(\d+)\.(\d+)\.jar$/.exec(jar);
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0;
}

/** Java: COPPERHEAD_JAVA > vendor/tools/jre25 > JAVA_HOME > PATH. */
export function resolveJava(env = process.env, repoRoot = process.cwd()): string {
  if (env.COPPERHEAD_JAVA?.trim()) return env.COPPERHEAD_JAVA.trim();
  for (const dir of toolsDirs(repoRoot)) {
    const java = path.join(dir, 'jre25', 'bin', 'java');
    if (existsSync(java)) return java;
  }
  if (env.JAVA_HOME && existsSync(path.join(env.JAVA_HOME, 'bin', 'java'))) return path.join(env.JAVA_HOME, 'bin', 'java');
  return 'java';
}

export class FreeroutingRouter implements RouterPlugin {
  constructor(private readonly opts: { jar?: string | null; java?: string; passes?: number; repoRoot?: string } = {}) {}

  async manifest(): Promise<EngineManifest> {
    return FREEROUTING_MANIFEST;
  }

  async estimate(job: RoutingJob): Promise<{ engineSeconds: number; wallSeconds: number }> {
    const n = job.snapshot.design.nets.length;
    return { engineSeconds: 5 + n * 2, wallSeconds: 10 + n * 3 };
  }

  async route(job: RoutingJob, ctx: RunContext): Promise<RoutingResult> {
    const t0 = Date.now();
    const repoRoot = this.opts.repoRoot ?? process.cwd();
    const jar = await resolveJar(this.opts.jar, process.env, repoRoot);
    const java = this.opts.java ?? resolveJava(process.env, repoRoot);
    const design = job.snapshot.design;
    const dsnPath = path.join(ctx.workDir, 'board.dsn');
    const sesPath = path.join(ctx.workDir, 'board.ses');
    const dsn = emitDsn(design, {
      boardName: path.basename(design.source.files.board, '.kicad_pcb'),
      netIds: job.scope.netIds ? new Set(job.scope.netIds) : null,
      preserveExistingRoutes: job.scope.preserveExistingRoutes,
      edgeClearanceNm: design.board.rules.copperEdgeClearanceNm,
      ...(typeof job.strategy.trackWidthNm === 'number' ? { trackWidthNm: job.strategy.trackWidthNm } : {}),
      ...(typeof job.strategy.clearanceNm === 'number' ? { clearanceNm: job.strategy.clearanceNm } : {}),
      ...(job.strategy.layers && typeof job.strategy.layers === 'object' ? { layers: job.strategy.layers } : {}),
    });
    await writeFile(dsnPath, dsn, 'utf8');
    const passes = Number(job.strategy.passes ?? this.opts.passes ?? 20);
    const args = ['-jar', jar, '-de', dsnPath, '-do', sesPath, '-mp', String(passes)];
    ctx.log(`${java} ${args.join(' ')}`);
    const res = await execa(java, args, { cwd: ctx.workDir, reject: false, timeout: job.limits.wallSeconds * 1000, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', JAVA_TOOL_OPTIONS: '-Djava.awt.headless=true' }, extendEnv: false, ...(ctx.signal ? { cancelSignal: ctx.signal } : {}) });
    await writeFile(path.join(ctx.workDir, 'freerouting.log'), `${res.stdout ?? ''}\n${res.stderr ?? ''}`, 'utf8');
    const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    if (res.timedOut) throw new EngineError('timeout', `Freerouting exceeded ${job.limits.wallSeconds}s`, 'raise the budget or lower passes');
    if (res.failed && /ENOENT/.test(String((res as { code?: string }).code ?? ''))) throw new EngineError('no-runtime', `java not found at "${java}"`, 'install a JRE 25 (scripts/tools.sh jre) or set COPPERHEAD_JAVA');
    if (/UnsupportedClassVersionError/.test(combined)) {
      const m = /class file version (\d+)/.exec(combined);
      throw new EngineError('runtime-too-old', `the JRE at "${java}" is too old for ${path.basename(jar)} (class file ${m?.[1] ?? '?'}: 69 needs Java 25, 65 needs Java 21)`, 'point COPPERHEAD_JAVA at a newer JRE or run scripts/tools.sh jre');
    }
    if (res.exitCode !== 0 && !existsSync(sesPath)) throw new EngineError('process-failed', `Freerouting exited ${res.exitCode}: ${combined.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`, 'see freerouting.log in the run directory');
    if (!existsSync(sesPath)) throw new EngineError('no-output', 'Freerouting exited clean but wrote no session file', 'see freerouting.log in the run directory');
    const ses = await readFile(sesPath, 'utf8');
    const copperLayers = copperStack(design);
    const parsed = parseSes(ses, { copperLayers, netIdByName: new Map(design.nets.map((n) => [n.name, n.id])), rules: design.board.rules, namespace: `${design.designId}/${job.runId}`, minWidthNm: typeof job.strategy.trackWidthNm === 'number' ? job.strategy.trackWidthNm : design.board.rules.trackWidthNm });
    const routable = design.nets.filter((n) => n.padIds.length >= 2 && (!job.scope.netIds || job.scope.netIds.includes(n.id)));
    if (!parsed.segments.length && routable.length) throw new EngineError('empty-result', 'the session carries no wires for a board with nets to route', 'see freerouting.log; the DSN may have been rejected');
    const unroutedMatch = /(\d+) unrouted/i.exec(combined.split('\n').reverse().find((l) => /unrouted/i.test(l)) ?? '');
    const wall = (Date.now() - t0) / 1000;
    const routedNames = new Set(parsed.nets);
    const unrouted = routable.filter((n) => !routedNames.has(n.name)).map((n) => n.id);
    return {
      status: unrouted.length || (unroutedMatch && Number(unroutedMatch[1]) > 0) ? 'partial' : 'complete',
      segments: parsed.segments,
      arcs: [],
      vias: parsed.vias,
      unroutedNetIds: unrouted,
      diagnostics: parsed.widened.count
        ? [{ code: 'quality.engine_neckdown_widened', category: 'quality', severity: 'info', entityIds: [], entityReferences: parsed.widened.nets, message: `${parsed.widened.count} wire(s) Freerouting necked down below the class width were widened to it before verification`, suggestedActions: [], sourceChecker: { id: FREEROUTING_MANIFEST.id, version: '1' } }]
        : [],
      runtime: { wallSeconds: wall, engineSeconds: wall },
      provenance: { engineId: FREEROUTING_MANIFEST.id, engineVersion: versionOf(jar) ? path.basename(jar).replace(/^freerouting-|\.jar$/g, '') : 'unknown', adapterVersion: '1', invocation: { binary: java, args, envKeys: ['PATH', 'HOME', 'JAVA_TOOL_OPTIONS'] }, seed: job.seed, exitCode: res.exitCode ?? -1, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString() },
    };
  }
}
