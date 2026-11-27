/**
 * The constraint registry a board is verified against: ECAD-derived entries
 * (re-derived every time) merged over the intent file when one exists, with
 * the file's unknown keys and any ECAD contradiction reported for HOLD.
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { PcbDesign } from '../ir/types.js';
import type { Constraint } from '../../memory/constraints.js';
import { parseIntent, intentToRegistry } from './language.js';
import { ecadConstraints, mergeEcad } from './ecad.js';
import { widthConstraint } from './physics.js';
import { loadProfile } from '../verify/profiles/index.js';

export interface LoadedConstraints {
  registry: Record<string, Constraint>;
  intentPath: string | null;
  holds: string[];
}

/** Candidate intent files: an explicit path, else `<board dir>/intent.yaml`, else `<docs>/LAYOUT.intent.yaml`. */
export function intentCandidates(boardPath: string, opts: { intentPath?: string | null; docsDir?: string; repoRoot?: string } = {}): string[] {
  const out: string[] = [];
  if (opts.intentPath) out.push(path.isAbsolute(opts.intentPath) ? opts.intentPath : path.join(opts.repoRoot ?? process.cwd(), opts.intentPath));
  out.push(path.join(path.dirname(boardPath), 'intent.yaml'));
  if (opts.docsDir) out.push(path.join(opts.docsDir, 'LAYOUT.intent.yaml'));
  return out;
}

export async function loadConstraints(design: PcbDesign, boardPath: string, opts: { intentPath?: string | null; docsDir?: string; repoRoot?: string } = {}): Promise<LoadedConstraints> {
  const holds: string[] = [];
  let registry: Record<string, Constraint> = {};
  let intentPath: string | null = null;
  for (const p of intentCandidates(boardPath, opts)) {
    if (!existsSync(p)) continue;
    const parsed = parseIntent(await readFile(p, 'utf8'), path.basename(p));
    registry = intentToRegistry(parsed);
    intentPath = p;
    for (const u of parsed.unknown) holds.push(`${path.basename(p)}: unknown key ${u}`);
    for (const e of parsed.errors) holds.push(`${path.basename(p)}: ${e}`);
    break;
  }
  // current requirements become width constraints through the physics compiler (hard only when copper weight is known)
  const profile = loadProfile(design.board.fabricationProfile);
  const copper = profile.copperWeightOz;
  for (const [k, c] of Object.entries(registry)) {
    if (!k.startsWith('layout.electrical-layout.current.')) continue;
    const net = String(c.parameters?.net ?? ''), amps = Number(c.parameters?.amps ?? 0);
    if (!net || !amps) continue;
    const w = widthConstraint({ net, amps, ...(copper ? { copperOzFt2: copper, riseC: Number(c.parameters?.rise_c ?? 10), layer: 'external' as const } : {}) }, `physics:${k}`);
    if (!registry[w.key]) registry[w.key] = w.constraint;
  }
  const merged = mergeEcad(registry, ecadConstraints(design));
  for (const c of merged.contradictions) holds.push(`${c.key}: the board's own rules contradict the ${c.theirs} entry`);
  return { registry: merged.registry, intentPath, holds };
}
