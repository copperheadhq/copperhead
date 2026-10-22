import { constants, existsSync } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { resolveInRepo } from '../util/paths.js';

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value;
}

function slug(value: unknown, field: string): string {
  const result = text(value, field);
  if (!SLUG.test(result)) throw new Error(`${field} must be a single kebab-case name`);
  return result;
}

/** Reject links at any existing component, including a destination file. */
async function checkTarget(repo: string, relative: string): Promise<void> {
  const parts = relative.split(path.sep);
  for (let i = 1; i <= parts.length; i++) {
    const target = resolveInRepo(repo, parts.slice(0, i).join(path.sep));
    const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`proposal path contains a symlink: ${relative}`);
    if (i < parts.length && !stat.isDirectory()) throw new Error(`proposal parent is not a directory: ${relative}`);
    if (i === parts.length && (!stat.isFile() || stat.nlink > 1)) {
      throw new Error(`proposal destination must be a regular, unshared file: ${relative}`);
    }
  }
}

/** The locked proposal tool may write only these fixed planning documents. */
export async function writeChangeProposal(
  repo: string,
  args: Record<string, unknown>,
  interactive: boolean,
): Promise<string> {
  const id = slug(args.id, 'id');
  const why = text(args.why, 'why');
  const changes = text(args.what_changes, 'what_changes');
  const tasks = text(args.tasks, 'tasks');
  const supplied = args.spec_deltas;
  if (supplied !== undefined && !Array.isArray(supplied)) throw new Error('spec_deltas must be an array');
  const deltas = supplied ?? [];
  if (existsSync(path.join(repo, 'openspec/config.yaml')) && deltas.length === 0) {
    throw new Error('spec_deltas must contain at least one capability with its requirement and scenario markdown');
  }
  const dir = path.join('openspec', 'changes', id);
  const auto = interactive ? '' : '\n> Marker: AUTO (autonomous mode; auto-approved, reviewable after the fact)\n';
  const files = new Map<string, string>([
    [path.join(dir, 'proposal.md'), `# Proposal: ${id}\n${auto}\n## Why\n\n${why}\n\n## What Changes\n\n${changes}\n`],
    [path.join(dir, 'tasks.md'), `# Tasks\n\n${tasks}\n`],
  ]);
  const capabilities = new Set<string>();
  for (const item of deltas) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('each spec_deltas item must be an object');
    const capability = slug(item.capability, 'capability');
    const content = text(item.content, 'content');
    if (capabilities.has(capability)) throw new Error(`duplicate capability: ${capability}`);
    capabilities.add(capability);
    files.set(path.join(dir, 'specs', capability, 'spec.md'), content);
  }
  // Validate all arguments and destinations before changing any planning file.
  for (const relative of files.keys()) await checkTarget(repo, relative);
  for (const [relative, content] of files) {
    const target = resolveInRepo(repo, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await checkTarget(repo, relative);
    const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink > 1) throw new Error(`proposal destination must be a regular, unshared file: ${relative}`);
      await file.truncate(0);
      await file.writeFile(content, 'utf8');
    } finally {
      await file.close();
    }
  }
  return id;
}
