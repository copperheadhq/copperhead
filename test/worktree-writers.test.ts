import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { tempFixtureRepo } from './helpers.js';
import { appendFile, mkdir, unlink, writeFile, publishDirectory, ownershipFor, relativeOwnedPath, supportsGitHookRun, withWorktreeOwnership } from '../src/util/worktree-ownership.js';
import { commitAll, snapshot, restore, preserveFailedRun, applyFailedRun } from '../src/util/git.js';
const git = async (repo: string, ...args: string[]) => (await execa('git', args, { cwd: repo })).stdout;

describe('ownership writer boundaries', () => {
  it('rejects other drives and UNC shares using Windows path semantics', () => {
    expect(relativeOwnedPath('D:\\repo', 'C:\\Temp\\message', path.win32)).toBeUndefined();
    expect(relativeOwnedPath('\\\\server\\share\\repo', 'C:\\Temp\\message', path.win32)).toBeUndefined();
    expect(relativeOwnedPath('D:\\repo', 'D:\\repo\\docs\\BOM.md', path.win32)).toBe('docs/BOM.md');
  });
  it('guards the minimum Git version needed to run hooks', () => {
    expect(supportsGitHookRun('git version 2.35.9')).toBe(false);
    expect(supportsGitHookRun('git version 2.36.0.windows.1')).toBe(true);
    expect(supportsGitHookRun('git version 3.0.0')).toBe(true);
    expect(supportsGitHookRun('unrecognized')).toBe(false);
  });
  it('captures original bytes lazily and restores append, delete and created directories', async () => {
    const f = await tempFixtureRepo();
    try {
      await fs.writeFile(path.join(f.repo, 'keep.txt'), 'original\n');
      await git(f.repo, 'add', 'keep.txt'); await git(f.repo, 'commit', '-qm', 'baseline');
      await withWorktreeOwnership(f.repo, async () => {
        const snap = await snapshot(f.repo);
        expect(snap.ownership!.files.get('keep.txt')!.bytes).toBeUndefined();
        await appendFile(path.join(f.repo, 'keep.txt'), 'more\n', { flag: 'a' });
        expect(snap.ownership!.files.get('keep.txt')!.bytes!.toString()).toBe('original\n');
        expect(await fs.readFile(path.join(f.repo, 'keep.txt'), 'utf8')).toBe('original\nmore\n');
        await unlink(path.join(f.repo, 'keep.txt'));
        await mkdir(path.join(f.repo, 'new', 'nested'), { recursive: true });
        await writeFile(path.join(f.repo, 'new', 'nested', 'file'), 'new');
        await restore(f.repo, snap);
        expect(await fs.readFile(path.join(f.repo, 'keep.txt'), 'utf8')).toBe('original\n');
        await expect(fs.access(path.join(f.repo, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(ownershipFor(f.repo)!.owned.size).toBe(0);
      });
    } finally { await f.cleanup(); }
  });
  it('publishes generated files, refuses generated symlinks, and preserves ignored audit output', async () => {
    const f = await tempFixtureRepo(); const source = await fs.mkdtemp(path.join(tmpdir(), 'copperhead-output-'));
    try {
      await fs.mkdir(path.join(source, 'nested')); await fs.writeFile(path.join(source, 'nested', 'file'), 'generated');
      await withWorktreeOwnership(f.repo, async () => {
        const snap = await snapshot(f.repo);
        await publishDirectory(source, path.join(f.repo, 'outputs'));
        expect(await fs.readFile(path.join(f.repo, 'outputs', 'nested', 'file'), 'utf8')).toBe('generated');
        await fs.symlink(path.join(source, 'nested'), path.join(source, 'link'), 'junction');
        await expect(publishDirectory(source, path.join(f.repo, 'outputs'))).rejects.toThrow(/generated symlink/);
        await mkdir(path.join(f.repo, '.copperhead', 'runs'), { recursive: true });
        await appendFile(path.join(f.repo, '.copperhead', 'runs', 'audit.log'), 'audit');
        await mkdir(path.join(f.repo, '.history'), { recursive: true });
        await writeFile(path.join(f.repo, '.history', 'cache'), 'ignored');
        expect(ownershipFor(f.repo)!.owned.has('.history/cache')).toBe(false);
        expect(ownershipFor(f.repo)!.owned.has('.copperhead/runs/audit.log')).toBe(false);
        await restore(f.repo, snap);
        expect(await fs.readFile(path.join(f.repo, '.copperhead', 'runs', 'audit.log'), 'utf8')).toBe('audit');
      });
    } finally { await fs.rm(source, { recursive: true, force: true }); await f.cleanup(); }
  });
  it('leaves writes outside the project outside its commit, including message scratch files', async () => {
    const f = await tempFixtureRepo(); const outside = await fs.mkdtemp(path.join(tmpdir(), 'copperhead-outside-'));
    try {
      await withWorktreeOwnership(f.repo, async () => {
        await writeFile(path.join(outside, 'message'), 'outside');
        await writeFile(path.join(f.repo, 'owned.txt'), 'inside');
        const sha = await commitAll(f.repo, 'inside');
        expect(await git(f.repo, 'show', '--format=', '--name-only', sha!)).toBe('owned.txt');
        expect([...ownershipFor(f.repo)!.owned]).toEqual(['owned.txt']);
      });
    } finally { await fs.rm(outside, { recursive: true, force: true }); await f.cleanup(); }
  });
  it('preserves and reapplies a tracked deletion without touching the real index', async () => {
    const f = await tempFixtureRepo();
    try {
      await fs.writeFile(path.join(f.repo, 'drop.txt'), 'baseline');
      await git(f.repo, 'add', 'drop.txt'); await git(f.repo, 'commit', '-qm', 'baseline');
      await withWorktreeOwnership(f.repo, async () => {
        const snap = await snapshot(f.repo);
        await unlink(path.join(f.repo, 'drop.txt'));
        expect(await preserveFailedRun(f.repo, 'delete')).toBeTruthy();
        await restore(f.repo, snap);
        expect(await applyFailedRun(f.repo, 'delete')).toMatchObject({ ok: true, files: ['drop.txt'] });
        await commitAll(f.repo, 'delete');
        expect(await git(f.repo, 'ls-files', 'drop.txt')).toBe('');
      });
    } finally { await f.cleanup(); }
  });
  it('keeps a preserved draft when the destination has pre-existing changes', async () => {
    const f = await tempFixtureRepo();
    try {
      await withWorktreeOwnership(f.repo, async () => {
        const snap = await snapshot(f.repo);
        await writeFile(path.join(f.repo, 'draft.md'), 'draft');
        expect(await preserveFailedRun(f.repo, 'draft')).toBeTruthy();
        await restore(f.repo, snap);
      });
      await fs.writeFile(path.join(f.repo, 'draft.md'), 'human');
      await withWorktreeOwnership(f.repo, async () => {
        expect(await applyFailedRun(f.repo, 'draft')).toMatchObject({ ok: false, error: expect.stringContaining('pre-existing changes') });
        expect(await fs.readFile(path.join(f.repo, 'draft.md'), 'utf8')).toBe('human');
        expect(await git(f.repo, 'stash', 'list')).toContain('copperhead failed run draft');
      });
    } finally { await f.cleanup(); }
  });
  it('refuses a non-regular draft entry without needing filesystem symlinks', async () => {
    const f = await tempFixtureRepo();
    try {
      const head = await git(f.repo, 'rev-parse', 'HEAD');
      const blob = (await execa('git', ['hash-object', '-w', '--stdin'], { cwd: f.repo, input: 'target' })).stdout;
      const tree = (await execa('git', ['mktree'], { cwd: f.repo, input: `120000 blob ${blob}\tlink\n` })).stdout;
      const baseTree = await git(f.repo, 'rev-parse', 'HEAD^{tree}');
      const indexCommit = await git(f.repo, 'commit-tree', baseTree, '-p', head, '-m', 'index');
      const draft = await git(f.repo, 'commit-tree', tree, '-p', head, '-p', indexCommit, '-m', 'nonregular');
      await git(f.repo, 'stash', 'store', '-m', 'copperhead failed run nonregular', draft);
      await withWorktreeOwnership(f.repo, async () => {
        expect(await applyFailedRun(f.repo, 'nonregular')).toMatchObject({ ok: false, error: expect.stringContaining('not a regular file') });
        await expect(fs.access(path.join(f.repo, 'link'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await git(f.repo, 'stash', 'list')).toContain('copperhead failed run nonregular');
      });
    } finally { await f.cleanup(); }
  });
  it.skipIf(process.platform === 'win32')('refuses writing through a tracked symlink', async () => {
    const f = await tempFixtureRepo();
    try {
      await fs.writeFile(path.join(f.repo, 'target'), 'original');
      await fs.symlink('target', path.join(f.repo, 'link'));
      await git(f.repo, 'add', 'target', 'link'); await git(f.repo, 'commit', '-qm', 'symlink');
      await withWorktreeOwnership(f.repo, async () => {
        await expect(writeFile(path.join(f.repo, 'link'), 'bad')).rejects.toThrow(/is a symlink/);
        expect(await fs.readFile(path.join(f.repo, 'target'), 'utf8')).toBe('original');
      });
    } finally { await f.cleanup(); }
  });
});
