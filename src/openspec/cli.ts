import { mkdir, ownershipFor, assertOwnedTree, writeFile, unlink } from '../util/worktree-ownership.js';
import { cp, mkdtemp, rm, readdir, readFile, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isNotFoundError } from '../util/preflight.js';

/**
 * OpenSpec is driven as a subprocess, same pattern as kicad-cli (SPEC §2.6).
 * Never user-triggered; copperhead owns the propose → validate → archive flow.
 */

export interface OpenSpecResult {
  ok: boolean;
  output: string;
}

async function openspec(repo: string, args: string[]): Promise<OpenSpecResult> {
  if (ownershipFor(repo) && args[0] !== 'validate') return isolatedOpenSpec(repo, args);
  return invokeOpenSpec(repo, args);
}

async function invokeOpenSpec(repo: string, args: string[]): Promise<OpenSpecResult> {
  try {
    const { stdout, stderr } = await execa('openspec', args, { cwd: repo });
    return { ok: true, output: [stdout, stderr].filter(Boolean).join('\n') };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: string; message: string; exitCode?: number };
    if (isNotFoundError(e)) {
      return { ok: false, output: 'openspec CLI not found on PATH (npm i -g @fission-ai/openspec)' };
    }
    return { ok: false, output: [e.stdout, e.stderr].filter(Boolean).join('\n') || e.message };
  }
}

export function hasOpenSpec(repo: string): boolean {
  return existsSync(path.join(repo, 'openspec'));
}

export async function openspecInit(repo: string): Promise<OpenSpecResult> {
  if (hasOpenSpec(repo)) return { ok: true, output: 'openspec/ already present' };
  return openspec(repo, ['init', '--no-interactive']);
}

export function openspecValidate(repo: string, changeId?: string): Promise<OpenSpecResult> {
  return openspec(repo, changeId ? ['validate', changeId] : ['validate']);
}

export function openspecArchive(repo: string, changeId: string): Promise<OpenSpecResult> {
  return openspec(repo, ['archive', changeId, '--yes']);
}

async function treeFiles(root: string, prefix = ''): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return []; throw err;
  });
  for (const entry of entries) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of await treeFiles(root, rel)) files.set(name, bytes);
    } else if (entry.isFile()) files.set(rel, await readFile(path.join(root, rel)));
    else throw new Error(`OpenSpec staging refuses symlink or special file: ${rel}`);
  }
  return files;
}

/** Never let an external CLI overwrite live project files before ownership checks. */
async function isolatedOpenSpec(repo: string, args: string[]): Promise<OpenSpecResult> {
  await assertOwnedTree(repo);
  const scratch = await mkdtemp(path.join(tmpdir(), 'copperhead-openspec-'));
  try {
    if (existsSync(path.join(repo, 'openspec'))) await cp(path.join(repo, 'openspec'), path.join(scratch, 'openspec'), { recursive: true });
    const before = await treeFiles(scratch, 'openspec');
    const result = await invokeOpenSpec(scratch, args);
    if (!result.ok) return result;
    const after = await treeFiles(scratch, 'openspec');
    await assertOwnedTree(repo);
    for (const [rel, bytes] of after) {
      if (before.get(rel)?.equals(bytes)) continue;
      const file = path.join(repo, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }
    const removed = [...before.keys()].filter((rel) => !after.has(rel));
    for (const rel of removed) await unlink(path.join(repo, rel));
    for (const rel of removed) {
      let dir = path.dirname(path.join(repo, rel));
      while (dir !== path.resolve(repo)) {
        try { await rmdir(dir); }
        catch (err) {
          if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((err as NodeJS.ErrnoException).code ?? '')) break;
          throw err;
        }
        dir = path.dirname(dir);
      }
    }
    return result;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
