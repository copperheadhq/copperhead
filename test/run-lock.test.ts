import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { runAgentLoop } from '../src/agent/loop.js';
import { runCreate } from '../src/commands/create.js';
import { RunLockError, withRunLock } from '../src/util/run-lock.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function tempRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-run-lock-'));
  await execa('git', ['init', '-q'], { cwd: repo });
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

describe('cross-process run lock', () => {
  it('refuses concurrent do and create runs with the active process details', async () => {
    const { repo, cleanup } = await tempRepo();
    const readyFile = path.join(repo, 'lock-holder-ready');
    const releaseFile = path.join(repo, 'lock-holder-release');
    const script = [
      "const { writeFile, access } = await import('node:fs/promises');",
      "const { setTimeout: delay } = await import('node:timers/promises');",
      `const { withRunLock } = await import(${JSON.stringify(path.join(REPO_ROOT, 'src/util/run-lock.ts'))});`,
      "await withRunLock(process.env.COPPERHEAD_LOCK_TEST_REPO, 'copperhead do', async () => {",
      `  await writeFile(${JSON.stringify(readyFile)}, String(process.pid));`,
      '  for (;;) {',
      `    try { await access(${JSON.stringify(releaseFile)}); break; } catch { await delay(10); }`,
      '  }',
      '});',
    ].join('\n');
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, COPPERHEAD_LOCK_TEST_REPO: repo },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const exited = once(child, 'exit').then(([code, signal]) => {
      if (code !== 0) throw new Error(`lock-holder exited with ${String(code ?? signal)}: ${stderr}`);
      return code;
    });
    void exited.catch(() => {});

    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`lock-holder exited with ${String(child.exitCode ?? child.signalCode)}: ${stderr}`);
        }
        try {
          await access(readyFile);
          break;
        } catch {
          await delay(10);
        }
      }
      await expect(access(readyFile)).resolves.toBeUndefined();
      const activePid = Number(await readFile(readyFile, 'utf8'));
      expect(activePid).toBe(child.pid);

      const loopError = await runAgentLoop({
        repoRoot: repo,
        request: 'this must not start',
        model: 'gpt-5',
        log: () => {},
      }).then(() => null, (error: Error) => error);
      expect(loopError).toBeInstanceOf(RunLockError);
      expect(loopError!.message).toContain(`PID ${activePid}`);
      expect(loopError!.message).toMatch(/in progress/);

      const createError = await runCreate({
        repoRoot: repo,
        briefPath: path.join(repo, 'missing-brief.md'),
        model: 'gpt-5',
        log: () => {},
      }).then(() => null, (error: Error) => error);
      expect(createError).toBeInstanceOf(RunLockError);
      expect(createError!.message).toContain(`PID ${activePid}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await writeFile(releaseFile, 'release');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
        await exited.catch(() => {});
        clearTimeout(killTimer);
      }
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
