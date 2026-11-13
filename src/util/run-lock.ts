import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { open, link, mkdir, readFile, readlink, realpath, unlink } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

interface LockMetadata {
  pid: number;
  startedAt: string;
  request: string;
  token: string;
  hostname: string;
  pidNamespace: string | null;
  processStart: string | null;
}

interface LockLocation {
  key: string;
  file: string;
}

type LockInspection = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'valid'; metadata: LockMetadata };
type OwnerState = 'alive' | 'dead' | 'unknown';
interface CleanupLock { file: string; metadata: LockMetadata }

const heldLocks = new AsyncLocalStorage<Set<string>>();

export class RunLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunLockError';
  }
}

/** The Git directory is outside the files a run commits or rolls back. */
async function lockLocation(repoRoot: string): Promise<LockLocation> {
  const root = path.resolve(repoRoot);
  const canonicalRoot = await realpath(root).catch(() => root);
  try {
    const { stdout } = await execa('git', ['rev-parse', '--absolute-git-dir'], { cwd: root });
    const gitDir = await realpath(stdout.trim());
    return { key: gitDir, file: path.join(gitDir, 'copperhead-run.lock') };
  } catch {
    // Invalid repositories must reach preflight without startup writes in the tree.
    const id = createHash('sha256').update(canonicalRoot).digest('hex');
    const dir = path.join(tmpdir(), 'copperhead-run-locks');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return { key: `fallback:${id}`, file: path.join(dir, `${id}.lock`) };
  }
}

async function pidNamespace(): Promise<string | null> {
  return process.platform === 'linux' ? readlink('/proc/self/ns/pid').catch(() => null) : null;
}

async function processStart(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    const [boot, stat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    // comm can contain spaces and parentheses. Field 22 follows the closing ')'.
    const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return ticks && /^\d+$/.test(ticks) ? `${boot.trim()}:${ticks}` : null;
  } catch {
    return null;
  }
}

async function makeMetadata(request: string): Promise<LockMetadata> {
  return {
    pid: process.pid, startedAt: new Date().toISOString(), request, token: randomUUID(),
    hostname: hostname(), pidNamespace: await pidNamespace(), processStart: await processStart(process.pid),
  };
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
      !Number.isSafeInteger(value.pid) || (value.pid ?? 0) < 1 ||
      typeof value.startedAt !== 'string' || typeof value.request !== 'string' ||
      typeof value.token !== 'string' || typeof value.hostname !== 'string' ||
      !(value.pidNamespace === null || typeof value.pidNamespace === 'string') ||
      !(value.processStart === null || typeof value.processStart === 'string')
    ) return { kind: 'invalid' };
    return { kind: 'valid', metadata: value as LockMetadata };
  } catch {
    return { kind: 'invalid' };
  }
}

async function ownerState(owner: LockMetadata): Promise<OwnerState> {
  if (owner.hostname !== hostname() || owner.pidNamespace !== await pidNamespace()) return 'unknown';
  // An unavailable namespace must not make a live container owner look dead.
  if (process.platform === 'linux' && owner.pidNamespace === null) return 'unknown';
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
  if (owner.processStart !== null) {
    const actual = await processStart(owner.pid);
    if (actual === null) return 'unknown';
    if (actual !== owner.processStart) return 'dead';
  }
  return 'alive';
}

async function createExclusive(file: string, metadata: LockMetadata): Promise<void> {
  const temporary = `${file}.${metadata.token}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    // Hard-link publication is atomic and never overwrites an existing owner.
    await link(temporary, file);
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
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

function unknownOwner(metadata: LockMetadata, file: string): RunLockError {
  return new RunLockError(
    `cannot establish run-lock ownership on host ${metadata.hostname} or its PID namespace (PID ${metadata.pid}, started ${metadata.startedAt}, lock: ${file}); verify the owner has exited on that host before manually removing the lock`,
  );
}

/**
 * Scope cleanup guards to the stale main lock's token. A dead cleaner's guard
 * stays in place while recovery uses its own successor guard. Unlinking and
 * reusing one shared .reap path would let two recovering processes remove a
 * newly acquired live guard based on the same stale read.
 */
async function acquireCleanup(file: string, token: string): Promise<{ held: CleanupLock; abandoned: CleanupLock[] }> {
  const metadata = await makeMetadata('copperhead stale-lock cleanup');
  const abandoned: CleanupLock[] = [];
  let generation = token;
  for (;;) {
    const digest = createHash('sha256').update(generation).digest('hex');
    const guard = `${file}.reap.${digest}`;
    try {
      await createExclusive(guard, metadata);
      return { held: { file: guard, metadata }, abandoned };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const current = await inspect(guard);
    if (current.kind === 'missing') continue;
    if (current.kind === 'invalid') throw new RunLockError(`cleanup lock owner details cannot be read; inspect ${guard} before removing it`);
    const state = await ownerState(current.metadata);
    if (state === 'unknown') throw unknownOwner(current.metadata, guard);
    if (state === 'alive') throw activeMessage(current.metadata, guard);
    abandoned.push({ file: guard, metadata: current.metadata });
    generation = `${digest}:${current.metadata.token}`;
  }
}

async function acquire(file: string, request: string): Promise<LockMetadata> {
  const metadata = await makeMetadata(request);
  for (;;) {
    try {
      await createExclusive(file, metadata);
      return metadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const existing = await inspect(file);
    if (existing.kind === 'missing') continue;
    if (existing.kind === 'invalid') {
      throw new RunLockError(
        `a copperhead run lock exists but its owner details cannot be read (lock: ${file}); verify no copperhead run is active, then remove the stale lock to continue`,
      );
    }
    const state = await ownerState(existing.metadata);
    if (state === 'unknown') throw unknownOwner(existing.metadata, file);
    if (state === 'alive') throw activeMessage(existing.metadata, file);

    const { held, abandoned } = await acquireCleanup(file, existing.metadata.token);
    try {
      // Recover the .reap path left by the original implementation, under the
      // generation guard. Never remove a live or unverifiable cleanup owner.
      const legacyFile = `${file}.reap`;
      const legacy = await inspect(legacyFile);
      if (legacy.kind === 'invalid') throw new RunLockError(`cleanup lock owner details cannot be read; inspect ${legacyFile} before removing it`);
      if (legacy.kind === 'valid') {
        const legacyState = await ownerState(legacy.metadata);
        if (legacyState === 'unknown') throw unknownOwner(legacy.metadata, legacyFile);
        if (legacyState === 'alive') throw activeMessage(legacy.metadata, legacyFile);
        await releaseIfOwned(legacyFile, legacy.metadata.token);
      }
      const current = await inspect(file);
      if (current.kind === 'valid' && current.metadata.token === existing.metadata.token &&
          await ownerState(current.metadata) === 'dead') {
        await unlink(file);
      }
    } finally {
      // Ancestors must stay present until this main-lock generation is gone.
      const current = await inspect(file);
      if (current.kind === 'missing' || (current.kind === 'valid' && current.metadata.token !== existing.metadata.token)) {
        for (const guard of abandoned) await releaseIfOwned(guard.file, guard.metadata.token);
      }
      await releaseIfOwned(held.file, held.metadata.token);
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
