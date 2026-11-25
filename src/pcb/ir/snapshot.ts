/**
 * Immutable board snapshots (RFC 11 §6.2, implementation spec §3.4 and §3.5).
 * A snapshot is written once into a run directory, made read-only, and its
 * hash is re-verified after every engine exits: an engine that writes into
 * its input produces INVALID_OUTPUT, never a silently corrupted source.
 */
import { mkdir, writeFile, readFile, chmod, cp } from 'node:fs/promises';
import path from 'node:path';
import type { Polygon } from './geometry.js';
import type { PcbDesign } from './types.js';
import { canonicalJson, hashDesign, sha256 } from './canonical.js';

export const SNAPSHOT_SCHEMA_VERSION = '1.0' as const;

export type SnapshotScope =
  | { kind: 'placement'; movableComponentIds: string[] }
  | { kind: 'routing'; netIds: string[] | null; region: Polygon | null; preserveExistingRoutes: boolean }
  | { kind: 'verify' };

export interface ResourceLimits {
  engineSeconds: number;
  wallSeconds: number;
  memoryMb: number;
}

export interface BoardSnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  hash: string;
  design: PcbDesign;
  scope: SnapshotScope;
  /** Layout constraints in scope; the registry entries themselves (typed in agent/constraints, opaque here). */
  hardConstraints: unknown[];
  objectives: { metric: string; weight: number }[];
  seed: number;
  limits: ResourceLimits;
  referenceMap: Record<string, string>;
  preserved: { componentIds: string[]; netIds: string[] };
}

export const DEFAULT_LIMITS: ResourceLimits = { engineSeconds: 600, wallSeconds: 900, memoryMb: 4096 };

export function makeSnapshot(
  design: PcbDesign,
  scope: SnapshotScope,
  opts: Partial<Pick<BoardSnapshot, 'hardConstraints' | 'objectives' | 'seed' | 'limits' | 'preserved'>> = {},
): BoardSnapshot {
  const referenceMap: Record<string, string> = {};
  for (const c of design.components) referenceMap[c.reference] = c.id;
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    hash: hashDesign(design),
    design,
    scope,
    hardConstraints: opts.hardConstraints ?? [],
    objectives: opts.objectives ?? [],
    seed: opts.seed ?? 0,
    limits: opts.limits ?? DEFAULT_LIMITS,
    referenceMap,
    preserved: opts.preserved ?? { componentIds: design.placement.lockedComponentIds, netIds: [] },
  };
}

/** Layout of a layout run directory (`.copperhead/runs/<ts>/layout/`). */
export interface RunDir {
  root: string;
  snapshotPath: string;
  sourceDir: string;
  candidatesDir: string;
}

/**
 * Create the run directory, copy the source files read-only, and write the
 * snapshot once. Returns the paths and the on-disk snapshot hash.
 */
export async function writeRunDir(root: string, snapshot: BoardSnapshot, sourceFiles: string[]): Promise<RunDir & { fileHash: string }> {
  const sourceDir = path.join(root, 'source');
  const candidatesDir = path.join(root, 'candidates');
  await mkdir(sourceDir, { recursive: true });
  await mkdir(candidatesDir, { recursive: true });
  for (const f of sourceFiles) {
    const dst = path.join(sourceDir, path.basename(f));
    await cp(f, dst);
    await chmod(dst, 0o444);
  }
  const snapshotPath = path.join(root, 'snapshot.json');
  const text = canonicalJson(snapshot);
  await writeFile(snapshotPath, text, 'utf8');
  await chmod(snapshotPath, 0o444);
  return { root, snapshotPath, sourceDir, candidatesDir, fileHash: sha256(text) };
}

/** Re-read the snapshot file and confirm neither it nor its design changed. */
export async function verifySnapshotIntact(run: RunDir, expected: { fileHash: string; designHash: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
  let text: string;
  try {
    text = await readFile(run.snapshotPath, 'utf8');
  } catch (e) {
    return { ok: false, reason: `snapshot.json unreadable: ${(e as Error).message}` };
  }
  if (sha256(text) !== expected.fileHash) return { ok: false, reason: 'snapshot.json bytes changed during the engine run' };
  const parsed = JSON.parse(text) as BoardSnapshot;
  if (hashDesign(parsed.design) !== expected.designHash) return { ok: false, reason: 'snapshot design hash changed during the engine run' };
  return { ok: true };
}
