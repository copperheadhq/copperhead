import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

/** External deadline: terminate the whole isolated process group on POSIX. */
export async function supervise(command, args, { cwd, env = process.env, timeoutMs, stdio = 'inherit' }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('A positive finite deadline is required');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio, detached: process.platform !== 'win32' });
    let timedOut = false;
    let force;
    const stop = (signal) => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      force = setTimeout(() => stop('SIGKILL'), 2000);
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); clearTimeout(force); reject(error); });
    child.once('close', (code, signal) => {
      if (timedOut) stop('SIGKILL'); // do not leave a descendant behind after its parent exits
      clearTimeout(timer); clearTimeout(force);
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), timedOut, signal });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const scratch = await mkdtemp(path.join(tmpdir(), 'copperhead-replay-job-'));
  console.log(`Replay job evidence root: ${scratch}`);
  const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    COPPERHEAD_TEST_RECORDED_CREATE: '1', CI: '1', NO_COLOR: '1' };
  for (const name of Object.keys(env)) {
    if (name.endsWith('_API_KEY') || ['COPPERHEAD_TEST_CODEX', 'COPPERHEAD_TEST_CURSOR', 'COPPERHEAD_TEST_CLAUDE_CODE'].includes(name)) delete env[name];
  }
  const result = await supervise(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'),
    'run', '--no-cache', '--reporter=verbose', 'test/create-recorded-e2e.test.ts'], {
    cwd: root, env, timeoutMs: 600_000,
  });
  console.log(`Recorded replay job: ${JSON.stringify(result)}`);
  process.exitCode = result.exitCode;
}
