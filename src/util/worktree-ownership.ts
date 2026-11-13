import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { appendFile as rawAppendFile, writeFile as rawWriteFile, readFile, lstat, readlink, unlink as rawUnlink, mkdir as rawMkdir, rmdir, readdir, realpath, symlink as rawSymlink } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { PreflightError } from './preflight.js';

interface FileState { hash: string; mode: number }
export interface OwnershipState {
  repo: string;
  head: string;
  headRef: string;
  index: string;
  expected: Map<string, FileState>;
  owned: Set<string>;
  createdDirectories: Set<string>;
  dirtyAtStart: Set<string>;
  checkpoints: Set<OwnershipCheckpoint>;
  modes: Map<string, number>;
}
const runs = new AsyncLocalStorage<OwnershipState>();
export class ExternalChangeError extends Error {
  constructor(detail: string) {
    super(`external changes detected (${detail}); refusing to overwrite, commit, or roll back this working tree. Work has been left on disk for manual inspection.`);
    this.name = 'ExternalChangeError';
  }
}
async function git(repo: string, args: string[]): Promise<string> {
  return (await execa('git', args, { cwd: repo, stripFinalNewline: false })).stdout;
}
function excluded(rel: string): boolean {
  return rel === '.git' || rel.startsWith('.git/') || rel === '.copperhead/runs' || rel.startsWith('.copperhead/runs/');
}
async function state(file: string, mode?: number): Promise<FileState | undefined> {
  try {
    const st = await lstat(file);
    if (st.isDirectory()) return undefined; // gitlinks and nested repositories are independent trees
    const data = st.isSymbolicLink() ? await readlink(file) : await readFile(file);
    return { hash: createHash('sha256').update(data).digest('hex'), mode: st.isSymbolicLink() ? 0o120000 : (mode === 0o100644 || mode === 0o100755 ? mode : (st.mode & 0o111 ? 0o100755 : 0o100644)) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
function equal(a: FileState | undefined, b: FileState | undefined): boolean {
  return a?.hash === b?.hash && (process.platform === 'win32' || a?.mode === b?.mode);
}
async function files(repo: string, modes = new Map<string, number>()): Promise<Map<string, FileState>> {
  const names = (await git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0');
  const result = new Map<string, FileState>();
  for (const rel of new Set(names)) {
    if (!rel || excluded(rel)) continue;
    const value = await state(path.join(repo, rel), modes.get(rel));
    if (value) result.set(rel, value);
  }
  return result;
}
export function ownershipFor(repo: string): OwnershipState | undefined {
  const run = runs.getStore();
  return run?.repo === path.resolve(repo) ? run : undefined;
}
export async function withWorktreeOwnership<T>(repo: string, action: () => Promise<T>): Promise<T> {
  if (ownershipFor(repo)) return action();
  // Leave invalid/unborn repositories to the normal preflight diagnostics.
  let head: string;
  try { head = (await git(repo, ['rev-parse', '--verify', 'HEAD'])).trim(); }
  catch { return action(); }
  await assertWorktreeRoot(repo);
  const version = (await git(repo, ['--version'])).trim();
  if (!supportsGitHookRun(version)) throw new PreflightError(
    'Git 2.36 or newer is required for mutating runs',
    'scoped commits must execute the configured Git hooks', ['upgrade Git and retry'],
  );
  await ensureOwnershipExcludes(repo, ['.history/', '*.kicad_prl', '~*.lck', '*.lck', 'fp-info-cache', '*-backups/', '_autosave-*']);
  const modes = new Map<string, number>();
  const fileMode = await execa('git', ['config', '--bool', 'core.fileMode'], { cwd: repo, reject: false });
  if (fileMode.stdout.trim() === 'false') {
    for (const row of (await git(repo, ['ls-tree', '-r', '-z', head])).split('\0')) {
      const tab = row.indexOf('\t');
      if (tab !== -1) modes.set(row.slice(tab + 1), Number.parseInt(row.slice(0, 6), 8));
    }
  }
  const run: OwnershipState = {
    repo: path.resolve(repo), head, headRef: (await git(repo, ['rev-parse', '--symbolic-full-name', 'HEAD'])).trim(), index: await git(repo, ['ls-files', '--stage', '-z']),
    expected: await files(repo, modes), owned: new Set(), createdDirectories: new Set(), checkpoints: new Set(), modes,
    dirtyAtStart: new Set([
      ...(await git(repo, ['diff', '--name-only', '-z', 'HEAD'])).split('\0'),
      ...(await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0'),
    ].filter(Boolean)),
  };
  return runs.run(run, action);
}
export async function assertOwnedTree(repo: string, allFiles = true): Promise<void> {
  const run = ownershipFor(repo);
  if (!run) return;
  if ((await git(repo, ['rev-parse', '--symbolic-full-name', 'HEAD'])).trim() !== run.headRef) throw new ExternalChangeError('checked-out branch changed');
  if ((await git(repo, ['rev-parse', 'HEAD'])).trim() !== run.head) throw new ExternalChangeError('HEAD moved');
  if (await git(repo, ['ls-files', '--stage', '-z']) !== run.index) throw new ExternalChangeError('Git index changed');
  if (allFiles) {
    const current = await files(repo, run.modes);
    for (const rel of new Set([...current.keys(), ...run.expected.keys()])) {
      if (!equal(current.get(rel), run.expected.get(rel))) throw new ExternalChangeError(rel);
    }
  } else {
    for (const rel of run.owned) {
      if (!equal(await state(path.join(repo, rel), run.modes.get(rel)), run.expected.get(rel))) throw new ExternalChangeError(rel);
    }
  }
}
async function beforeWrite(file: Parameters<typeof rawWriteFile>[0]): Promise<{ run: OwnershipState; rel: string } | undefined> {
  const run = runs.getStore();
  if (!run || typeof file !== 'string') return;
  const rel = relativeOwnedPath(run.repo, file);
  if (!rel || excluded(rel)) return;
  // Ignored cache/audit outputs do not participate in Git rollback or commits.
  const ignored = await execa('git', ['check-ignore', '-q', '--', rel], { cwd: run.repo, reject: false });
  if (ignored.exitCode === 0 && !run.expected.has(rel)) return;
  await assertOwnedTree(run.repo, false);
  if (!equal(await state(file, run.modes.get(rel)), run.expected.get(rel))) throw new ExternalChangeError(rel);
  if (run.dirtyAtStart.has(rel) && !run.owned.has(rel)) throw new ExternalChangeError(`${rel} has pre-existing changes; commit them first or resume them through create`);
  let bytes: Buffer | undefined;
  for (const checkpoint of run.checkpoints) {
    const original = checkpoint.files.get(rel);
    if (!original || original.bytes) continue;
    if (!equal(original.state, run.expected.get(rel))) throw new ExternalChangeError(rel);
    bytes ??= original.state.mode === 0o120000 ? Buffer.from(await readlink(file)) : await readFile(file);
    if (createHash('sha256').update(bytes).digest('hex') !== original.state.hash) throw new ExternalChangeError(rel);
    original.bytes = bytes;
  }
  return { run, rel };
}
export const writeFile: typeof rawWriteFile = async (file, data, options) => {
  const owner = await beforeWrite(file);
  if (owner && (await lstat(String(file)).catch(() => null))?.isSymbolicLink()) throw new ExternalChangeError(owner.rel + ' is a symlink');
  const createOptions = owner && !owner.run.expected.has(owner.rel)
    ? { ...(typeof options === 'string' ? { encoding: options } : options), flag: 'wx' }
    : options;
  await rawWriteFile(file, data, createOptions);
  if (owner) {
    // Compare the intended payload, not a new read that might adopt an external save.
    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (typeof data !== 'string' && !Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
      throw new Error('ownership-tracked writes require a string or byte buffer');
    }
    const bytes = typeof data === 'string' ? Buffer.from(data, encoding ?? 'utf8') : data;
    const current = await state(String(file), owner.run.modes.get(owner.rel));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (!current || current.hash !== hash) throw new ExternalChangeError(owner.rel);
    owner.run.expected.set(owner.rel, { ...current, hash });
    owner.run.owned.add(owner.rel);
  }
};
export const appendFile: typeof rawAppendFile = async (file, data, options) => {
  const owner = await beforeWrite(file);
  if (!owner) return rawAppendFile(file, data, options);
  const existing = await readFile(String(file)).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return Buffer.alloc(0);
    throw err;
  });
  const encoding = typeof options === 'string' ? options : options?.encoding;
  if (typeof data !== 'string' && !Buffer.isBuffer(data) && !(data instanceof Uint8Array)) throw new Error('ownership-tracked appends require text or bytes');
  const bytes = typeof data === 'string' ? Buffer.from(data, encoding ?? 'utf8') : Buffer.from(data);
  await writeFile(file, Buffer.concat([existing, bytes]), { ...(typeof options === 'string' ? { encoding: options } : options), flag: 'w' });
};

/** Delete only a file whose current bytes still belong to this run. */
export async function unlink(file: string): Promise<void> {
  const owner = await beforeWrite(file);
  await rawUnlink(file);
  if (owner) {
    owner.run.expected.delete(owner.rel);
    owner.run.owned.add(owner.rel);
  }
}

/** Publish subprocess outputs through the same byte ownership checks as tools. */
export async function publishDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await publishDirectory(from, to);
    } else if (entry.isFile()) {
      await writeFile(to, await readFile(from));
    } else {
      throw new Error(`refusing generated symlink or special file: ${from}`);
    }
  }
}

export interface OwnershipCheckpoint {
  createdDirectories: Set<string>;
  head: string;
  files: Map<string, { bytes?: Buffer; state: FileState }>;
  owned: Set<string>;
}
export async function ownershipCheckpoint(repo: string): Promise<OwnershipCheckpoint | undefined> {
  const run = ownershipFor(repo);
  if (!run) return;
  await assertOwnedTree(repo);
  const checkpoint: OwnershipCheckpoint = {
    head: run.head, files: new Map([...run.expected].map(([rel, state]) => [rel, { state }])),
    createdDirectories: new Set(run.createdDirectories), owned: new Set(run.owned),
  };
  run.checkpoints.add(checkpoint);
  return checkpoint;
}
/** No reset or clean: change only owned paths and leave unrelated arrivals alone. */
export async function restoreOwnershipCheckpoint(repo: string, checkpoint: OwnershipCheckpoint): Promise<void> {
  const run = ownershipFor(repo)!;
  await assertOwnedTree(repo);
  if (run.head !== checkpoint.head) throw new ExternalChangeError('HEAD no longer matches rollback snapshot');
  for (const rel of [...run.owned]) {
    const original = checkpoint.files.get(rel);
    if (original) {
      if (!equal(run.expected.get(rel), original.state)) {
        if (!original.bytes) throw new Error(`missing original bytes for rollback: ${rel}`);
        await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
        if (original.state.mode === 0o120000) {
          const file = path.join(repo, rel);
          if (run.expected.has(rel)) await unlink(file);
          await beforeWrite(file);
          await rawSymlink(original.bytes.toString(), file);
          run.expected.set(rel, original.state);
        } else await writeFile(path.join(repo, rel), original.bytes, { mode: original.state.mode & 0o777 });
      }
    } else if (run.expected.has(rel)) {
      await unlink(path.join(repo, rel));
    }
  }
  run.owned = new Set(checkpoint.owned);
  run.checkpoints.delete(checkpoint);
  const directories = [...run.createdDirectories].filter((dir) => !checkpoint.createdDirectories.has(dir)).sort((a, b) => b.length - a.length);
  for (const dir of directories) {
    try { await rmdir(dir); run.createdDirectories.delete(dir); }
    catch (err) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
    }
  }
}

/** Remember only directories actually created by this run, for non-recursive cleanup. */
export const mkdir: typeof rawMkdir = (async (file, options) => {
  const run = runs.getStore();
  const missing: string[] = [];
  if (run && typeof file === 'string') {
    let dir = path.resolve(file);
    while (dir.startsWith(run.repo + path.sep) && !excluded(path.relative(run.repo, dir).split(path.sep).join('/'))) {
      try { await lstat(dir); break; }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        missing.push(dir);
        dir = path.dirname(dir);
      }
    }
  }
  const result = await rawMkdir(file, options);
  if (run) {
    const recursive = typeof options === 'object' && options?.recursive;
    const firstCreated = typeof result === 'string' ? path.resolve(result) : null;
    for (const dir of missing) {
      if (!recursive || (firstCreated && (dir === firstCreated || dir.startsWith(firstCreated + path.sep)))) {
        run.createdDirectories.add(dir);
      }
    }
  }
  return result;
}) as typeof rawMkdir;


/** A subdirectory root cannot safely share top-level index paths. Fail before writes. */
export async function assertWorktreeRoot(repo: string): Promise<void> {
  const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
  if (path.relative(await realpath(top), await realpath(repo)) !== '') throw new PreflightError(
    'repo must be the Git working-tree root',
    'scoped index paths must be relative to the working-tree root', [`rerun with --repo ${top}`],
  );
}
export function supportsGitHookRun(version: string): boolean {
  const match = version.match(/git version (\d+)\.(\d+)/);
  return !!match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 36));
}
export function relativeOwnedPath(root: string, file: string, paths: Pick<typeof path, 'relative' | 'resolve' | 'isAbsolute' | 'sep'> = path): string | undefined {
  const rel = paths.relative(root, paths.resolve(file));
  if (!rel || paths.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + paths.sep)) return;
  return rel.split(paths.sep).join('/');
}
export async function ensureOwnershipExcludes(repo: string, patterns: string[]): Promise<void> {
  const file = path.resolve(repo, (await git(repo, ['rev-parse', '--git-path', 'info/exclude'])).trim());
  await rawMkdir(path.dirname(file), { recursive: true });
  const prior = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return ''; throw err;
  });
  const missing = patterns.filter((pattern) => !prior.split(/\r?\n/).includes(pattern));
  if (missing.length) await rawAppendFile(file, `${prior.endsWith('\n') || !prior ? '' : '\n'}${missing.join('\n')}\n`);
}
/** Explicit adoption for resumed create inputs or hash/force-authorized init outputs. */
export async function adoptOwnedPaths(repo: string, paths: string[]): Promise<void> {
  const run = ownershipFor(repo);
  if (!run) return;
  await assertOwnedTree(repo);
  for (const rel of paths) if (run.dirtyAtStart.has(rel) && run.expected.has(rel)) run.owned.add(rel);
}
