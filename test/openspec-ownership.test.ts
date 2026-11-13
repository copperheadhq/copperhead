import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { tempFixtureRepo } from './helpers.js';
import { withWorktreeOwnership } from '../src/util/worktree-ownership.js';
import { openspecArchive, openspecInit } from '../src/openspec/cli.js';
import { commitAll, restore, snapshot } from '../src/util/git.js';

const cli = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('execa', async (original) => {
  const actual = await original<typeof import('execa')>();
  return { ...actual, execa: (command: string, args: string[], options: { cwd: string }) =>
    command === 'openspec' ? cli.run(args, options.cwd) : actual.execa(command, args, options) };
});
afterEach(() => vi.resetAllMocks());
const git = async (repo: string, ...args: string[]) => (await execa('git', args, { cwd: repo })).stdout;

async function change(repo: string) {
  const dir = path.join(repo, 'openspec', 'changes', 'demo', 'specs', 'safety');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'spec.md'), '# preserved spec\n');
  await fs.writeFile(path.join(repo, 'openspec', 'changes', 'demo', 'tasks.md'), '- [x] done\n');
  await git(repo, 'add', 'openspec');
  await git(repo, 'commit', '-qm', 'proposal');
}

describe('isolated OpenSpec outputs', () => {
  it('archives the change, removes empty directories, and can roll the move back', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await change(repo);
      // An unrelated project symlink is not copied or traversed by OpenSpec.
      await fs.symlink(path.join(repo, 'hardware'), path.join(repo, 'unrelated-link'), 'junction');
      cli.run.mockImplementation(async (_args: string[], cwd: string) => {
        await expect(fs.access(path.join(cwd, 'hardware'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(fs.access(path.join(cwd, 'unrelated-link'))).rejects.toMatchObject({ code: 'ENOENT' });
        await fs.mkdir(path.join(cwd, 'openspec', 'changes', 'archive'), { recursive: true });
        await fs.rename(path.join(cwd, 'openspec', 'changes', 'demo'), path.join(cwd, 'openspec', 'changes', 'archive', 'demo'));
        return { stdout: 'archived', stderr: '' };
      });
      await withWorktreeOwnership(repo, async () => {
        const snap = await snapshot(repo);
        expect((await openspecArchive(repo, 'demo')).ok).toBe(true);
        await expect(fs.access(path.join(repo, 'openspec', 'changes', 'demo'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await fs.readFile(path.join(repo, 'openspec', 'changes', 'archive', 'demo', 'tasks.md'), 'utf8')).toBe('- [x] done\n');
        await restore(repo, snap);
        expect(await fs.readFile(path.join(repo, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8')).toBe('- [x] done\n');
        await expect(fs.access(path.join(repo, 'openspec', 'changes', 'archive', 'demo'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await openspecArchive(repo, 'demo')).ok).toBe(true);
        expect(await commitAll(repo, 'archive')).toBeTruthy();
      });
    } finally { await cleanup(); }
  });
  it('publishes only initialized OpenSpec files', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      cli.run.mockImplementation(async (_args: string[], cwd: string) => {
        await fs.mkdir(path.join(cwd, 'openspec'));
        await fs.writeFile(path.join(cwd, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
        await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'not a project output');
        return { stdout: 'initialized', stderr: '' };
      });
      await withWorktreeOwnership(repo, async () => {
        expect((await openspecInit(repo)).ok).toBe(true);
        expect(await fs.readFile(path.join(repo, 'openspec', 'config.yaml'), 'utf8')).toBe('schema: spec-driven\n');
        await expect(fs.access(path.join(repo, 'AGENTS.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      });
    } finally { await cleanup(); }
  });
  it('refuses publication after an external save and leaves the change active', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await change(repo);
      cli.run.mockImplementation(async () => {
        await fs.writeFile(path.join(repo, 'human.txt'), 'external');
        return { stdout: 'done', stderr: '' };
      });
      await withWorktreeOwnership(repo, async () => {
        await expect(openspecArchive(repo, 'demo')).rejects.toThrow(/external changes detected/);
        expect(await fs.readFile(path.join(repo, 'human.txt'), 'utf8')).toBe('external');
        expect(await fs.readFile(path.join(repo, 'openspec', 'changes', 'demo', 'tasks.md'), 'utf8')).toContain('done');
      });
    } finally { await cleanup(); }
  });
  it('reports a missing OpenSpec CLI without publishing files', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      cli.run.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      await withWorktreeOwnership(repo, async () => {
        expect(await openspecInit(repo)).toMatchObject({ ok: false, output: expect.stringContaining('not found') });
        await expect(fs.access(path.join(repo, 'openspec'))).rejects.toMatchObject({ code: 'ENOENT' });
      });
    } finally { await cleanup(); }
  });
});
