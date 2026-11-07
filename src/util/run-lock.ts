import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readFile, realpath, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { execa } from 'execa';

interface LockMetadata {
  pid: number;
  startedAt: string;
  request: string;
  token: string;
}

interface LockLocation {
  key: string;
  file: string;
}

type LockInspection = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'valid'; metadata: LockMetadata };

const heldLocks = new AsyncLocalStorage<Set<string>>();

export class RunLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunLockError';
  }
}

/**
 * Run serialization shared by the CLI and MCP server. The lock lives in the
 * worktree's git directory, outside the files a run stages, commits, or rolls
 * back. The temp-dir fallback exists only so invalid repositories can reach
 * their normal preflight error without writing a lock into the project tree.
 */
async function lockLocation(repoRoot: string): Promise<LockLocation> {
  const root = path.resolve(repoRoot);
  const canonicalRoot = await realpath(root).catch(() => root);
  try {
    const { stdout } = await execa('git', ['rev-parse', '--absolute-git-dir'], { cwd: root });
    const gitDir = await realpath(stdout.trim());
    return { key: gitDir, file: path.join(gitDir, 'copperhead-run.lock') };
  } catch {
    const id = createHash('sha256').update(canonicalRoot).digest('hex');
    const dir = path.join(tmpdir(), 'copperhead-run-locks');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return { key: `fallback:${id}`, file: path.join(dir, `${id}.lock`) };
  }
}

function makeMetadata(request: string): LockMetadata {
  return { pid: process.pid, startedAt: new Date().toISOString(), request, token: randomUUID() };
}

async function inspect(file: string): Promise<LockInspection> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid' };
  }
  try {
    const value = JSON.parse(raw) as Partial<LockMetadata>;
    if (
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) < 1 ||
      typeof value.startedAt !== 'string' ||
      typeof value.request !== 'string' ||
      typeof value.token !== 'string'
    ) return { kind: 'invalid' };
    return { kind: 'valid', metadata: value as LockMetadata };
  } catch {
    return { kind: 'invalid' };
  }
}

async function inspectStable(file: string): Promise<LockInspection> {
  let current = await inspect(file);
  // O_EXCL creates the file before its owner writes the metadata. Give that
  // short creation window time to finish before treating an empty file as a
  // damaged lock that needs manual inspection.
  for (let attempt = 0; current.kind === 'invalid' && attempt < 4; attempt++) {
    await delay(10);
    current = await inspect(file);
  }
  return current;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function createExclusive(file: string, metadata: LockMetadata): Promise<void> {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(file).catch(() => {});
    throw error;
  }
}

async function releaseIfOwned(file: string, token: string): Promise<void> {
  const current = await inspect(file);
  if (current.kind === 'valid' && current.metadata.token === token) {
    await unlink(file).catch(() => {});
  }
}

function activeMessage(metadata: LockMetadata, file: string): RunLockError {
  return new RunLockError(
    `another ${metadata.request} run is in progress for this working tree (PID ${metadata.pid}, started ${metadata.startedAt}); wait for it to finish, then retry (lock: ${file})`,
  );
}

async function acquire(file: string, request: string): Promise<LockMetadata> {
  const metadata = makeMetadata(request);
  const reaperFile = `${file}.reap`;

  for (;;) {
    try {
      await createExclusive(file, metadata);
      return metadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const existing = await inspectStable(file);
    if (existing.kind === 'missing') continue;
    if (existing.kind === 'invalid') {
      throw new RunLockError(
        `a copperhead run lock exists but its owner details cannot be read (lock: ${file}); verify no copperhead run is active, then remove the stale lock to continue`,
      );
    }
    if (processIsAlive(existing.metadata.pid)) throw activeMessage(existing.metadata, file);

    // Only one process may reclaim a dead owner's lock at a time. Re-read it
    // while holding this small cleanup lock so a newly acquired live lock can
    // never be removed based on an earlier stale read.
    const reaper = makeMetadata('copperhead stale-lock cleanup');
    try {
      await createExclusive(reaperFile, reaper);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const cleanup = await inspectStable(reaperFile);
      const detail = cleanup.kind === 'valid'
        ? `PID ${cleanup.metadata.pid}, started ${cleanup.metadata.startedAt}`
        : 'unknown owner';
      throw new RunLockError(
        `stale run-lock cleanup is already active (${detail}); retry shortly, or inspect and remove ${reaperFile} if its owner has exited`,
      );
    }

    try {
      const current = await inspectStable(file);
      if (
        current.kind === 'valid' &&
        current.metadata.token === existing.metadata.token &&
        !processIsAlive(current.metadata.pid)
      ) {
        await unlink(file);
      }
    } finally {
      await releaseIfOwned(reaperFile, reaper.token);
    }
  }
}

/** Hold an exclusive per-working-tree lock for the complete mutating run. */
export async function withRunLock<T>(repoRoot: string, request: string, run: () => Promise<T>): Promise<T> {
  const location = await lockLocation(repoRoot);
  const inherited = heldLocks.getStore() ?? new Set<string>();
  if (inherited.has(location.key)) return run();

  const metadata = await acquire(location.file, request);
  try {
    return await heldLocks.run(new Set([...inherited, location.key]), run);
  } finally {
    await releaseIfOwned(location.file, metadata.token);
  }
}
