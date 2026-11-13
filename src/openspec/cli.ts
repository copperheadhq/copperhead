import { mkdir, ownershipFor, assertOwnedTree, writeFile, unlink } from '../util/worktree-ownership.js';
import { cp, mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
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
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
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
    await cp(repo, scratch, { recursive: true, filter: (source) => {
      const rel = path.relative(repo, source).split(path.sep).join('/');
      return !rel.split('/').some((part) => ['.git', 'node_modules', '.history', 'dist'].includes(part))
        && !rel.startsWith('.copperhead/runs') && !rel.startsWith('.copperhead/cache') && !rel.startsWith('.copperhead/llm-cache');
    } });
    const before = await treeFiles(scratch);
    const result = await invokeOpenSpec(scratch, args);
    if (!result.ok) return result;
    const after = await treeFiles(scratch);
    await assertOwnedTree(repo);
    for (const [rel, bytes] of after) {
      if (before.get(rel)?.equals(bytes)) continue;
      const file = path.join(repo, rel);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }
    for (const rel of before.keys()) if (!after.has(rel)) await unlink(path.join(repo, rel));
    return result;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
