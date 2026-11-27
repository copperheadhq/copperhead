import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { readlink } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { runAgentLoop } from '../src/agent/loop.js';
import { runCreate } from '../src/commands/create.js';
import { runInit } from '../src/memory/scaffold.js';
import { RunLockError, withRunLock } from '../src/util/run-lock.js';

import { holdRunLock } from './run-lock-holder.js';

async function tempRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-run-lock-'));
  await execa('git', ['init', '-q'], { cwd: repo });
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

describe('cross-process run lock', () => {
  it('refuses concurrent do and create runs with the active process details', async () => {
    const { repo, cleanup } = await tempRepo();
    const holder = await holdRunLock(repo);
    try {
      const activePid = holder.owner.pid;
      expect(activePid).toBe(holder.pid);
      const loopError = await runAgentLoop({
        repoRoot: repo,
        request: 'this must not start',
        model: 'gpt-5',
        log: () => {},
      }).then(() => null, (error: Error) => error);
      expect(loopError).toBeInstanceOf(RunLockError);
      expect(loopError!.message).toContain(`PID ${activePid}`);
      expect(loopError!.message).toMatch(/in progress/);
      const owner = JSON.parse(await readFile(path.join(repo, '.git', 'copperhead-run.lock'), 'utf8'));
      expect(loopError!.message).toContain(owner.startedAt);
      await expect(runInit({ repoRoot: repo })).rejects.toBeInstanceOf(RunLockError);
      await expect(access(path.join(repo, '.copperhead'))).rejects.toMatchObject({ code: 'ENOENT' });

      const createError = await runCreate({
        repoRoot: repo,
        briefPath: path.join(repo, 'missing-brief.md'),
        model: 'gpt-5',
        log: () => {},
      }).then(() => null, (error: Error) => error);
      expect(createError).toBeInstanceOf(RunLockError);
      expect(createError!.message).toContain(`PID ${activePid}`);
    } finally {
      await holder.release();
      await cleanup();
    }
  }, 20_000);

  it('reclaims a lock whose owner process has exited', async () => {
    const { repo, cleanup } = await tempRepo();
    try {
      const deadOwner = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      const deadPid = deadOwner.pid;
      expect(deadPid).toBeDefined();
      await once(deadOwner, 'exit');

      const { stdout } = await execa('git', ['rev-parse', '--absolute-git-dir'], { cwd: repo });
      const lockPath = path.join(stdout.trim(), 'copperhead-run.lock');
      await writeFile(lockPath, JSON.stringify({
        hostname: hostname(),
        pidNamespace: process.platform === 'linux' ? await readlink('/proc/self/ns/pid') : null,
        processStart: null,
        pid: deadPid,
        startedAt: '2026-01-01T00:00:00.000Z',
        request: 'copperhead do',
        token: 'dead-owner-token',
      }), { flag: 'wx' });

      let entered = false;
      await withRunLock(repo, 'copperhead create', async () => { entered = true; });
      expect(entered).toBe(true);
      await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await cleanup();
    }
  });

  it('recovers when both the run and its cleanup owner have exited', async () => {
    const { repo, cleanup } = await tempRepo();
    try {
      let metadata: Record<string, unknown> = {};
      const lockPath = path.join(repo, '.git', 'copperhead-run.lock');
      await withRunLock(repo, 'capture owner', async () => {
        metadata = JSON.parse(await readFile(lockPath, 'utf8'));
      });
      const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
      await once(child, 'exit');
      const dead = { ...metadata, pid: child.pid, token: 'dead-owner' };
      await writeFile(lockPath, JSON.stringify(dead));
      await writeFile(`${lockPath}.reap`, JSON.stringify({ ...dead, token: 'dead-cleaner' }));
      await expect(withRunLock(repo, 'recovered run', async () => 'ran')).resolves.toBe('ran');
      await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(`${lockPath}.reap`)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await cleanup();
    }
  });

  it('allows nested calls in the same run to reuse their lock', async () => {
    const { repo, cleanup } = await tempRepo();
    try {
      const nested = await withRunLock(repo, 'copperhead create', () =>
        withRunLock(repo, 'copperhead create stage', async () => 'stage ran'),
      );
      expect(nested).toBe('stage ran');
    } finally {
      await cleanup();
    }
  });
});
