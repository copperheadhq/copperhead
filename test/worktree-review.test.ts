import { runInit } from '../src/memory/scaffold.js';
import { describe, expect, it } from 'vitest';
import { chmod, mkdir, readFile, writeFile as rawWrite } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { tempFixtureRepo } from './helpers.js';
import { withWorktreeOwnership, writeFile, ownershipFor } from '../src/util/worktree-ownership.js';
import { commitAll, restore, snapshot } from '../src/util/git.js';
const git = async (repo: string, ...args: string[]) => (await execa('git', args, { cwd: repo })).stdout;

describe('second review regressions', () => {
  it('refuses a subdirectory root before any mutating action', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const original = await readFile(path.join(repo, '.gitignore'));
      let called = false;
      await expect(withWorktreeOwnership(path.join(repo, 'hardware'), async () => { called = true; })).rejects.toThrow(/working.tree root/);
      expect(called).toBe(false);
      expect(await readFile(path.join(repo, '.gitignore'))).toEqual(original);
      expect(await git(repo, 'status', '--porcelain')).toBe('');
    } finally { await cleanup(); }
  });
  it('reinitializes unchanged generated files without adopting their uncommitted bytes', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await withWorktreeOwnership(repo, async () => {
        expect((await runInit({ repoRoot: repo })).created).toEqual([]);
        expect(ownershipFor(repo)!.owned.size).toBe(0);
      });
    } finally { await cleanup(); }
  });
  it('keeps ignore maintenance out of a dirty .gitignore', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await rawWrite(path.join(repo, '.gitignore'), '.env\n.copperhead/runs/\n# user notes\n');
      await withWorktreeOwnership(repo, async () => {
        await writeFile(path.join(repo, 'owned.txt'), 'owned');
        const sha = await commitAll(repo, 'owned');
        expect(await git(repo, 'show', '--format=', '--name-only', sha!)).toBe('owned.txt');
        expect(await readFile(path.join(repo, '.gitignore'), 'utf8')).toContain('# user notes');
      });
    } finally { await cleanup(); }
  });
  it('drops ownership of rolled-back paths before a later commit', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await withWorktreeOwnership(repo, async () => {
        const snap = await snapshot(repo);
        await writeFile(path.join(repo, 'owned.txt'), 'first');
        await restore(repo, snap);
        const { ownershipFor } = await import('../src/util/worktree-ownership.js');
        expect(ownershipFor(repo)!.owned.has('owned.txt')).toBe(false);
        await writeFile(path.join(repo, 'next.txt'), 'second');
        const sha = await commitAll(repo, 'second');
        expect(await git(repo, 'show', '--format=', '--name-only', sha!)).toBe('next.txt');
      });
    } finally { await cleanup(); }
  });
  it('accepts a committed gitlink and an untracked nested repository', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const head = await git(repo, 'rev-parse', 'HEAD');
      await git(repo, 'update-index', '--add', '--cacheinfo', '160000', head, 'vendor/library');
      await git(repo, 'commit', '-qm', 'gitlink');
      await mkdir(path.join(repo, 'vendor/library'), { recursive: true });
      await mkdir(path.join(repo, 'nested'));
      await git(path.join(repo, 'nested'), 'init', '-q');
      await rawWrite(path.join(repo, 'nested', 'file'), 'nested');
      await expect(withWorktreeOwnership(repo, async () => 'entered')).resolves.toBe('entered');
    } finally { await cleanup(); }
  });
  it('refuses a non-owned schematic different from the verified commit tree', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await withWorktreeOwnership(repo, async () => {
        const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
        await rawWrite(sch, (await readFile(sch, 'utf8')) + '\n');
        await writeFile(path.join(repo, 'owned.txt'), 'board edit');
        await expect(commitAll(repo, 'verified')).rejects.toThrow(/verification input/);
        expect(await git(repo, 'log', '-1', '--format=%s')).toBe('fixture');
      });
    } finally { await cleanup(); }
  });
  it('returns no commit for a zero-diff run', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await withWorktreeOwnership(repo, async () => {
        const head = await git(repo, 'rev-parse', 'HEAD');
        expect(await commitAll(repo, 'nothing')).toBeNull();
        expect(await git(repo, 'rev-parse', 'HEAD')).toBe(head);
      });
    } finally { await cleanup(); }
  });
  it('keeps KiCad lock and cache files out of rollback', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await withWorktreeOwnership(repo, async () => {
        const snap = await snapshot(repo);
        await writeFile(path.join(repo, 'owned.txt'), 'run');
        await rawWrite(path.join(repo, '~board.kicad_pro.lck'), 'lock');
        await rawWrite(path.join(repo, 'fp-info-cache'), 'cache');
        await restore(repo, snap);
        expect(await readFile(path.join(repo, '~board.kicad_pro.lck'), 'utf8')).toBe('lock');
        expect(await git(repo, 'status', '--porcelain')).toBe('');
      });
    } finally { await cleanup(); }
  });
  it('preserves executable index modes with core.fileMode=false', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await rawWrite(path.join(repo, 'build.sh'), '#!/bin/sh\n');
      await git(repo, 'add', 'build.sh');
      await git(repo, 'update-index', '--chmod=+x', 'build.sh');
      await git(repo, 'commit', '-qm', 'executable');
      await git(repo, 'config', 'core.fileMode', 'false');
      await chmod(path.join(repo, 'build.sh'), 0o644);
      await withWorktreeOwnership(repo, async () => {
        await writeFile(path.join(repo, 'build.sh'), '#!/bin/sh\necho ready\n');
        await commitAll(repo, 'script');
        expect(await git(repo, 'ls-files', '-s', 'build.sh')).toMatch(/^100755 /);
      });
    } finally { await cleanup(); }
  });
});
