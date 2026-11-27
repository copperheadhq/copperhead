/**
 * copperhead-tools over its JSON protocol (v1): `run <tool>` with a request on stdin and a result on
 * stdout. copperhead never imports that package; this subprocess boundary is the only coupling.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

export interface ToolsResult {
  status: 'ok' | 'findings' | 'not-run' | 'error';
  tool: { id: string; version: string };
  package?: { name: string; version: string };
  summary?: Record<string, unknown>;
  data?: Record<string, unknown>;
  findings?: unknown[];
  error?: { code: string; message: string };
}

export class ToolsError extends Error {}

export interface ToolsClient {
  /** How the tools were found, for the record. */
  readonly command: string[];
  /** An aborted `signal` stops the tool's process (SIGTERM) and rejects with "cancelled". */
  run(tool: string, inputs: Record<string, unknown>, opts?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal }): Promise<ToolsResult>;
}

/** `--tools`, then COPPERHEAD_TOOLS (a cli.js or an executable), then `copperhead-tools` on PATH. */
export async function resolveTools(
  flag?: string,
  env = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<ToolsClient> {
  const given = flag ?? env.COPPERHEAD_TOOLS;
  let command: string[];
  if (given) {
    const abs = path.resolve(given);
    try {
      await access(abs);
    } catch {
      throw new ToolsError(`copperhead-tools not found at ${abs} (from ${flag ? '--tools' : 'COPPERHEAD_TOOLS'})`);
    }
    command = abs.endsWith('.js') ? [process.execPath, abs] : [abs];
  } else {
    const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const exts = platform === 'win32' ? ['.com', '.exe'] : [''];
    let found = false;
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, `copperhead-tools${ext}`);
        try {
          await access(candidate, constants.X_OK);
          found = true;
          break;
        } catch {
          // try next
        }
      }
      if (found) break;
    }
    if (!found) {
      throw new ToolsError('copperhead-tools not found on PATH (set --tools or COPPERHEAD_TOOLS)');
    }
    command = ['copperhead-tools'];
  }
  return {
    command,
    run(tool, inputs, opts = {}) {
      return new Promise((resolve, reject) => {
        if (opts.signal?.aborted) {
          reject(new ToolsError(`copperhead-tools ${tool}: cancelled`));
          return;
        }
        const child = spawn(command[0]!, [...command.slice(1), 'run', tool], {
          cwd: opts.cwd ?? process.cwd(),
          env: { ...process.env, ...(opts.env ?? {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // A cancelled review must not leave a sweep running: stop the child and settle now.
        const onAbort = () => {
          child.kill('SIGTERM');
          reject(new ToolsError(`copperhead-tools ${tool}: cancelled`));
        };
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        let out = '';
        let err = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        // A child that died before reading its request must not crash the review with EPIPE.
        child.stdin.on('error', () => undefined);
        child.on('error', (e) => reject(new ToolsError(`cannot start copperhead-tools (${command.join(' ')}): ${e.message}`)));
        child.on('close', (code) => {
          opts.signal?.removeEventListener('abort', onAbort);
          let result: ToolsResult;
          try {
            result = JSON.parse(out) as ToolsResult;
          } catch {
            reject(new ToolsError(`copperhead-tools ${tool} exited ${code} without a result: ${err.trim().split('\n').slice(-3).join(' ')}`));
            return;
          }
          if (result.status === 'not-run' || result.status === 'error' || (code !== 0 && code !== 1)) {
            reject(new ToolsError(`copperhead-tools ${tool}: ${result.error?.message ?? `exit ${code}`}`));
            return;
          }
          resolve(result);
        });
        child.stdin.end(JSON.stringify({ protocol: 1, inputs, options: { failOn: 'never' } }));
      });
    },
  };
}
