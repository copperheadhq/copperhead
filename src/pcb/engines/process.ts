/**
 * Out-of-process plugin protocol (ADR 0005, implementation spec §6.3): a
 * plugin directory holds manifest.json and an executable `run`; the runner
 * writes job.json into the invocation directory, spawns
 * `run --job job.json --out result.json` with a scrubbed environment, reads
 * NDJSON progress from stdout, and validates result.json on return. Built-in
 * TypeScript adapters do not use this; third-party wrappers do.
 */
import { execa } from 'execa';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EngineManifest, PlacementJob, PlacementResult, RoutingJob, RoutingResult, RunContext } from './contracts.js';
import { EngineError } from '../ir/status.js';

/** Environment an engine process receives: never a credential (RFC 11 §17). */
export function scrubbedEnv(manifest: EngineManifest, env = process.env): Record<string, string> {
  const keep = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'JAVA_HOME', 'PYTHONPATH', 'VIRTUAL_ENV', ...(manifest.requires.env ?? [])]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/(_KEY|_TOKEN|_SECRET|PASSWORD)$/i.test(k)) continue;
    if (keep.has(k) || k.startsWith('KICAD')) out[k] = v;
  }
  return out;
}

export class ExternalPlugin {
  constructor(
    private readonly dir: string,
    private readonly manifestData: EngineManifest,
  ) {}

  async manifest(): Promise<EngineManifest> {
    return this.manifestData;
  }

  private async invoke<TJob, TResult>(job: TJob, ctx: RunContext, limits: { wallSeconds: number }): Promise<TResult> {
    const jobPath = path.join(ctx.workDir, 'job.json');
    const outPath = path.join(ctx.workDir, 'result.json');
    await writeFile(jobPath, JSON.stringify(job), 'utf8');
    const bin = path.join(this.dir, 'run');
    const res = await execa(bin, ['--job', jobPath, '--out', outPath], {
      cwd: ctx.workDir,
      env: scrubbedEnv(this.manifestData),
      extendEnv: false,
      reject: false,
      timeout: limits.wallSeconds * 1000,
      ...(ctx.signal ? { cancelSignal: ctx.signal } : {}),
    });
    for (const line of (res.stdout ?? '').split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const ev = JSON.parse(line) as { event?: string; fraction?: number; note?: string };
        if (ev.event === 'progress' && typeof ev.fraction === 'number') ctx.progress?.(ev.fraction, ev.note);
      } catch {
        // not an event line
      }
    }
    if (res.timedOut) throw new EngineError('timeout', `${this.manifestData.id} exceeded ${limits.wallSeconds}s`, 'raise limits.wallSeconds or pick a faster engine');
    if (res.failed && /ENOENT/.test(String((res as { code?: string }).code ?? ''))) throw new EngineError('no-binary', `${bin} is not executable`, `install the ${this.manifestData.id} plugin`);
    if (res.exitCode !== 0) throw new EngineError('process-failed', `${this.manifestData.id} exited ${res.exitCode}: ${(res.stderr ?? '').slice(0, 400)}`, 'see stderr.log in the run directory');
    let text: string;
    try {
      text = await readFile(outPath, 'utf8');
    } catch {
      throw new EngineError('no-output', `${this.manifestData.id} wrote no result.json`, 'the plugin must write --out');
    }
    try {
      return JSON.parse(text) as TResult;
    } catch (e) {
      throw new EngineError('malformed-output', `${this.manifestData.id} result.json is not JSON: ${(e as Error).message}`, 'fix the plugin');
    }
  }

  place(job: PlacementJob, ctx: RunContext): Promise<PlacementResult> {
    return this.invoke<PlacementJob, PlacementResult>(job, ctx, job.limits);
  }

  route(job: RoutingJob, ctx: RunContext): Promise<RoutingResult> {
    return this.invoke<RoutingJob, RoutingResult>(job, ctx, job.limits);
  }
}
