/**
 * Engine registry and eligibility (RFC 11 §9.4, implementation spec §6.4).
 * Discovery order: built-in library plugins, then engines/<name>/manifest.json
 * in the copperhead install, then .copperhead/engines/<name>/manifest.json in
 * the repo, then COPPERHEAD_PCB_ENGINES (colon-separated). Later entries with
 * the same id override earlier ones. Eligibility fails closed: an engine that
 * cannot honour every hard constraint, the layer count, the license policy,
 * or the network policy is never invoked with a degraded job.
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import type { EngineManifest, EnginePlugin, RouterCapabilities, PlacerCapabilities } from './contracts.js';
import { validateManifest, COPYLEFT } from './manifest.js';
import { ExternalPlugin } from './process.js';

export interface RegisteredEngine {
  manifest: EngineManifest;
  plugin: EnginePlugin;
  /** Where it came from, for the evidence bundle. */
  source: 'builtin' | string;
}

export interface EnginePolicy {
  /** Which network requirements are acceptable: 'none' on the check path, 'optional' in create/do, 'required' only when opted in. */
  network: 'none' | 'optional' | 'required';
  allowHarnessEngines: boolean;
  /** SPDX prefixes that may not run at all (default: none). */
  denyLicenses: string[];
}

export const DEFAULT_POLICY: EnginePolicy = { network: 'optional', allowHarnessEngines: false, denyLicenses: [] };
export const CHECK_PATH_POLICY: EnginePolicy = { network: 'none', allowHarnessEngines: false, denyLicenses: [] };

export interface JobShape {
  kind: 'placer' | 'router';
  /** Constraint classes (or class.parameter) that are hard in this job. */
  hardConstraintKinds: string[];
  copperLayers: number;
  needs?: Partial<RouterCapabilities & PlacerCapabilities>;
}

export interface Eligibility {
  ok: boolean;
  reasons: string[];
}

/** Manifest-level eligibility; binary presence is probed separately by `available()`. */
export function eligible(engine: RegisteredEngine, job: JobShape, policy: EnginePolicy = DEFAULT_POLICY): Eligibility {
  const m = engine.manifest;
  const reasons: string[] = [];
  if (m.kind !== job.kind) reasons.push(`is a ${m.kind}, job needs a ${job.kind}`);
  if (m.harnessOnly && !policy.allowHarnessEngines) reasons.push('harness-only reference engine (pass allowHarnessEngines to use it)');
  const netRank = { none: 0, optional: 1, required: 2 };
  if (netRank[m.networkRequirement] > netRank[policy.network]) reasons.push(`needs network "${m.networkRequirement}", policy allows "${policy.network}"`);
  if (policy.denyLicenses.some((p) => m.license.startsWith(p))) reasons.push(`license ${m.license} is denied by policy`);
  if (COPYLEFT.test(m.license) && m.executionMode === 'library') reasons.push(`${m.license} engine declared in-process`);
  for (const c of job.hardConstraintKinds) {
    const cls = c.split('.')[0]!;
    if (!m.supportedConstraints.includes(c) && !m.supportedConstraints.includes(cls) && !m.supportedConstraints.includes('*')) reasons.push(`does not support hard constraint ${c}`);
  }
  const caps = m.capabilities as Partial<RouterCapabilities & PlacerCapabilities>;
  if (job.kind === 'router' && caps.maxLayers !== undefined && job.copperLayers > caps.maxLayers) reasons.push(`supports ${caps.maxLayers} copper layers, board has ${job.copperLayers}`);
  if (job.kind === 'router' && caps.minLayers !== undefined && job.copperLayers < caps.minLayers) reasons.push(`needs at least ${caps.minLayers} copper layers, board has ${job.copperLayers}`);
  for (const [k, v] of Object.entries(job.needs ?? {})) {
    if (v === true && (caps as Record<string, unknown>)[k] !== true) reasons.push(`lacks capability ${k}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** Are the engine's declared binaries and runtimes present on this machine? */
export async function available(engine: RegisteredEngine, env = process.env): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const b of engine.manifest.requires.binaries ?? []) {
    const override = env[`COPPERHEAD_${b.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
    if (override && existsSync(override)) continue;
    try {
      await execa(b, ['--version'], { reject: false, timeout: 10_000 });
    } catch {
      missing.push(b);
    }
  }
  for (const e of engine.manifest.requires.env ?? []) if (!env[e]) missing.push(`env ${e}`);
  return { ok: missing.length === 0, missing };
}

export class EngineRegistry {
  private engines = new Map<string, RegisteredEngine>();

  register(plugin: EnginePlugin, manifest: EngineManifest, source: RegisteredEngine['source'] = 'builtin'): void {
    const problems = validateManifest(manifest);
    if (problems.length) throw new Error(`engine ${manifest.id ?? '?'} rejected: ${problems.map((p) => `${p.field}: ${p.problem}`).join('; ')}`);
    this.engines.set(manifest.id, { manifest, plugin, source });
  }

  get(id: string): RegisteredEngine | undefined {
    return this.engines.get(id);
  }

  list(kind?: EngineManifest['kind']): RegisteredEngine[] {
    return [...this.engines.values()].filter((e) => !kind || e.manifest.kind === kind);
  }

  /** Discover out-of-process plugins: directories holding manifest.json and an executable `run`. */
  async discover(dirs: string[]): Promise<{ loaded: string[]; rejected: { dir: string; problems: string }[] }> {
    const loaded: string[] = [];
    const rejected: { dir: string; problems: string }[] = [];
    for (const root of dirs) {
      let entries: string[] = [];
      try {
        entries = await readdir(root);
      } catch {
        continue;
      }
      for (const e of entries) {
        const dir = path.join(root, e);
        const mf = path.join(dir, 'manifest.json');
        if (!existsSync(mf)) continue;
        let manifest: unknown;
        try {
          manifest = JSON.parse(await readFile(mf, 'utf8'));
        } catch (err) {
          rejected.push({ dir, problems: `manifest.json unreadable: ${(err as Error).message}` });
          continue;
        }
        const problems = validateManifest(manifest);
        if (problems.length) {
          rejected.push({ dir, problems: problems.map((p) => `${p.field}: ${p.problem}`).join('; ') });
          continue;
        }
        const m = manifest as EngineManifest;
        this.engines.set(m.id, { manifest: m, plugin: new ExternalPlugin(dir, m), source: dir });
        loaded.push(m.id);
      }
    }
    return { loaded, rejected };
  }
}

/** The directories the registry scans, in override order. */
export function discoveryDirs(repoRoot: string, installRoot: string, env = process.env): string[] {
  const dirs = [path.join(installRoot, 'engines'), path.join(repoRoot, '.copperhead', 'engines')];
  for (const d of (env.COPPERHEAD_PCB_ENGINES ?? '').split(':').filter(Boolean)) dirs.push(d);
  return dirs;
}
