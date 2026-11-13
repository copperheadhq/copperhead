import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/** Separate process with an IPC handshake: no sleeps or readiness races. */
export async function holdRunLock(repo: string) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const specifier = pathToFileURL(path.join(root, 'src/util/run-lock.ts')).href;
  const script = [
    `const { withRunLock } = await import(${JSON.stringify(specifier)});`,
    "const { readFile } = await import('node:fs/promises');",
    "const path = await import('node:path');",
    "const release = new Promise((resolve) => process.once('message', resolve));",
    "await withRunLock(process.env.COPPERHEAD_LOCK_TEST_REPO, 'copperhead do', async () => {",
    "  const raw = await readFile(path.join(process.env.COPPERHEAD_LOCK_TEST_REPO, '.git', 'copperhead-run.lock'), 'utf8');",
    '  process.send(JSON.parse(raw));',
    '  await release;',
    '});',
    'process.disconnect();',
  ].join('\n');
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: root, env: { ...process.env, COPPERHEAD_LOCK_TEST_REPO: repo },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (text: string) => { stderr += text; });
  const exited = once(child, 'exit');
  try {
    const [owner] = await Promise.race([
      once(child, 'message'),
      exited.then(([code, signal]) => { throw new Error(`lock holder exited: ${code ?? signal}: ${stderr}`); }),
    ]);
    return {
      pid: child.pid,
      owner: owner as { pid: number; startedAt: string },
      release: async () => {
        const timer = setTimeout(() => child.kill(), 5000);
        try {
          if (child.connected) child.send('release');
          const [code, signal] = await exited;
          if (code !== 0) throw new Error(`lock holder exited: ${code ?? signal}: ${stderr}`);
        } finally {
          clearTimeout(timer);
        }
      },
    };
  } catch (error) {
    child.kill();
    await exited.catch(() => {});
    throw error;
  }
}
