import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunLockError, withRunLock } from '../src/util/run-lock.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link) };
});

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const repo = await fs.mkdtemp(path.join(tmpdir(), 'copperhead-lock-recovery-'));
  await execa('git', ['init', '-q'], { cwd: repo });
  const file = path.join(repo, '.git', 'copperhead-run.lock');
  const owner = await withRunLock(repo, 'capture metadata', async () => JSON.parse(await fs.readFile(file, 'utf8')));
  return { repo, file, owner, cleanup: () => fs.rm(repo, { recursive: true, force: true }) };
}

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  await once(child, 'exit');
  expect(pid).toBeDefined();
  return pid;
}

const guardPath = (file: string, token: string) => `${file}.reap.${createHash('sha256').update(token).digest('hex')}`;

describe('crash recovery and ownership', () => {
  it('publishes complete metadata atomically, and can retry an interrupted write', async () => {
    const f = await fixture();
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const interrupted = new Error('simulated acquisition crash');
    try {
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await real.open(...args);
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
          await expect(fs.access(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
          throw interrupted;
        });
        return handle;
      });
      await expect(withRunLock(f.repo, 'interrupted', async () => 'unreachable')).rejects.toBe(interrupted);
      await expect(fs.access(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fs.readdir(path.dirname(f.file))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      vi.mocked(fs.link).mockImplementationOnce(async (temporary, target) => {
        expect(JSON.parse(await real.readFile(temporary, 'utf8'))).toMatchObject({ pid: process.pid, request: 'retry' });
        await expect(real.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
        await real.link(temporary, target);
      });
      await expect(withRunLock(f.repo, 'retry', async () => 'ran')).resolves.toBe('ran');
    } finally {
      await f.cleanup();
    }
  });

  it.each(['', '{partial', JSON.stringify({ pid: 1 })])('refuses a damaged or legacy lock without deleting it (%j)', async (raw) => {
    const f = await fixture();
    try {
      await fs.writeFile(f.file, raw);
      await expect(withRunLock(f.repo, 'blocked', async () => 'unreachable')).rejects.toThrow(/owner details cannot be read/);
      expect(await fs.readFile(f.file, 'utf8')).toBe(raw);
    } finally {
      await f.cleanup();
    }
  });

  it.each(['hostname', 'pidNamespace'])('does not reclaim an owner from a different %s', async (field) => {
    const f = await fixture();
    try {
      const owner = { ...f.owner, [field]: 'another-host-or-namespace', pid: await exitedPid() };
      const raw = JSON.stringify(owner);
      await fs.writeFile(f.file, raw);
      await expect(withRunLock(f.repo, 'blocked', async () => 'unreachable')).rejects.toThrow(/manually removing/);
      expect(await fs.readFile(f.file, 'utf8')).toBe(raw);
    } finally {
      await f.cleanup();
    }
  });

  it('recognizes a reused live PID when the platform provides start identity', async () => {
    const f = await fixture();
    try {
      expect(f.owner.pid).toBe(process.pid);
      await fs.writeFile(f.file, JSON.stringify({ ...f.owner, processStart: 'different-boot:0' }));
      if (f.owner.processStart !== null) {
        await expect(withRunLock(f.repo, 'new owner', async () => 'ran')).resolves.toBe('ran');
        await expect(fs.access(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        // No process identity API is used on other platforms: fail closed.
        await expect(withRunLock(f.repo, 'blocked', async () => 'unreachable')).rejects.toBeInstanceOf(RunLockError);
      }
    } finally {
      await f.cleanup();
    }
  });

  it('refuses a live cleanup owner and preserves both locks', async () => {
    const f = await fixture();
    try {
      await fs.writeFile(f.file, JSON.stringify({ ...f.owner, pid: await exitedPid(), token: 'dead' }));
      const reaper = `${f.file}.reap`;
      await fs.writeFile(reaper, JSON.stringify(f.owner));
      await expect(withRunLock(f.repo, 'blocked', async () => 'unreachable')).rejects.toThrow(`PID ${process.pid}`);
      expect(JSON.parse(await fs.readFile(reaper, 'utf8'))).toEqual(f.owner);
      expect(JSON.parse(await fs.readFile(f.file, 'utf8')).token).toBe('dead');
    } finally {
      await f.cleanup();
    }
  });

  it('recovers an abandoned generation guard without removing a new live owner', async () => {
    const f = await fixture();
    try {
      const dead = { ...f.owner, pid: await exitedPid(), token: 'abandoned-run' };
      const guard = guardPath(f.file, dead.token);
      await fs.writeFile(f.file, JSON.stringify(dead));
      await fs.writeFile(guard, JSON.stringify({ ...dead, token: 'abandoned-cleaner' }));
      // The two calls have independent async contexts. Hold the winning callback
      // until the other contender has answered, rather than relying on timing.
      let resolve!: () => void;
      const release = new Promise<void>((done) => { resolve = done; });
      const results: string[] = [];
      const contender = () => withRunLock(f.repo, 'contender', async () => {
        results.push('entered');
        await release;
      }).then(() => 'done', (error: Error) => {
        expect(error).toBeInstanceOf(RunLockError);
        return 'refused';
      });
      const a = contender();
      const b = contender();
      try {
        expect(await Promise.race([a, b])).toBe('refused');
        // A loser can refuse at the cleanup guard before the winner enters.
        // The surviving main lock, if already published, must never be removed.
        resolve();
        expect((await Promise.all([a, b])).sort()).toEqual(['done', 'refused']);
        expect(results).toEqual(['entered']);
        await expect(fs.access(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.access(guard)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        resolve();
        await Promise.allSettled([a, b]);
      }
    } finally {
      await f.cleanup();
    }
  });

  it('holds the lock through failure cleanup, then releases it', async () => {
    const f = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const failure = new Error('rollback complete');
    const running = withRunLock(f.repo, 'rollback', async () => {
      entered();
      await finish;
      throw failure;
    });
    const rejected = expect(running).rejects.toBe(failure);
    try {
      await ready;
      await expect(withRunLock(f.repo, 'competitor', async () => 'unreachable')).rejects.toBeInstanceOf(RunLockError);
      release();
      await rejected;
      await expect(withRunLock(f.repo, 'next run', async () => 'ran')).resolves.toBe('ran');
    } finally {
      release();
      await rejected;
      await f.cleanup();
    }
  });

  it('lets linked Git worktrees run independently', async () => {
    const f = await fixture();
    const other = `${f.repo}-linked`;
    try {
      await execa('git', ['-c', 'user.name=Lock test', '-c', 'user.email=lock@test.local',
        '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'baseline'], { cwd: f.repo });
      await execa('git', ['worktree', 'add', '--detach', other], { cwd: f.repo });
      await withRunLock(f.repo, 'first worktree', async () => {
        await expect(withRunLock(other, 'linked worktree', async () => 'ran')).resolves.toBe('ran');
        expect(JSON.parse(await fs.readFile(f.file, 'utf8')).request).toBe('first worktree');
      });
    } finally {
      await fs.rm(other, { recursive: true, force: true });
      await f.cleanup();
    }
  });

  it('uses a canonical temp lock for a non-Git repository and leaves the tree untouched', async () => {
    const repo = await fs.mkdtemp(path.join(tmpdir(), 'copperhead-lock-fallback-'));
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const running = withRunLock(repo, 'fallback holder', async () => { entered(); await finish; });
    try {
      await ready;
      await expect(withRunLock(path.join(repo, '.'), 'competitor', async () => 'unreachable')).rejects.toThrow(/fallback holder/);
      expect(await fs.readdir(repo)).toEqual([]);
    } finally {
      release();
      await running;
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});
