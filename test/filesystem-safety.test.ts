import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { toolEditFile, toolReadFile, toolSearch, toolWriteFile } from '../src/agent/filetools.js';
import { SandboxError } from '../src/util/paths.js';
import { changedFiles, commitAll, preserveFailedRun, restore, snapshot } from '../src/util/git.js';
import { tempFixtureRepo } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fileFixture(): Promise<{ repo: string; outside: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), 'copperhead-file-safety-'));
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const repo = path.join(parent, 'repo');
  const outside = path.join(parent, 'outside');
  await mkdir(repo);
  await mkdir(outside);
  return { repo, outside };
}

describe('file tools do not follow symbolic links below the repo root', () => {
  it('write_file never overwrites a concurrent new-file writer', async () => {
    const { repo } = await fileFixture();
    const results = await Promise.allSettled([
      toolWriteFile(repo, 'new.md', 'first writer'),
      toolWriteFile(repo, 'new.md', 'second writer'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(['first writer', 'second writer']).toContain(await readFile(path.join(repo, 'new.md'), 'utf8'));
  });

  it('blocks reads, edits, and new files through an external directory link', async () => {
    const { repo, outside } = await fileFixture();
    await writeFile(path.join(outside, 'private.txt'), 'private original');
    await symlink(outside, path.join(repo, 'linked'), 'dir');

    await expect(toolReadFile(repo, 'linked/private.txt')).rejects.toThrow(SandboxError);
    await expect(toolEditFile(repo, 'linked/private.txt', 'original', 'changed')).rejects.toThrow(SandboxError);
    await expect(toolWriteFile(repo, 'linked/new/note.md', 'new')).rejects.toThrow(SandboxError);
    expect(await readFile(path.join(outside, 'private.txt'), 'utf8')).toBe('private original');
    await expect(readFile(path.join(outside, 'new/note.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks a dangling file link before write_file creates its outside target', async () => {
    const { repo, outside } = await fileFixture();
    const target = path.join(outside, 'new.md');
    await symlink(target, path.join(repo, 'alias.md'));

    await expect(toolWriteFile(repo, 'alias.md', 'new')).rejects.toThrow(SandboxError);
    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('blocks in-repo file aliases that hide a KiCad extension from edit gates', async () => {
    const { repo } = await fileFixture();
    await writeFile(path.join(repo, 'board.kicad_pcb'), '(kicad_pcb original)');
    await symlink('board.kicad_pcb', path.join(repo, 'alias.md'));

    await expect(toolEditFile(repo, 'alias.md', 'original', 'changed')).rejects.toThrow(SandboxError);
    expect(await readFile(path.join(repo, 'board.kicad_pcb'), 'utf8')).toBe('(kicad_pcb original)');
  });

  it('supports a repo root reached through a symlink', async () => {
    const { repo, outside } = await fileFixture();
    const rootAlias = path.join(outside, 'repo-alias');
    await symlink(repo, rootAlias, 'dir');
    await toolWriteFile(rootAlias, 'docs/note.md', 'inside');
    expect(await toolReadFile(rootAlias, 'docs/note.md')).toBe('inside');
  });

  it('search skips external, cyclic, and dangling symlinks', async () => {
    const { repo, outside } = await fileFixture();
    await writeFile(path.join(repo, 'inside.md'), 'needle inside');
    await writeFile(path.join(outside, 'private.md'), 'needle private');
    await symlink(outside, path.join(repo, 'external'), 'dir');
    await symlink(repo, path.join(repo, 'loop'), 'dir');
    await symlink('missing', path.join(repo, 'dangling'));

    expect(await toolSearch(repo, 'needle')).toEqual([
      { file: 'inside.md', line: 1, text: 'needle inside' },
    ]);
  });
});

describe('dirty snapshots preserve the complete user state', () => {
  it('stages and restores cwd-relative paths when the project is inside a larger Git repo', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);
    const nested = path.join(repo, 'nested-board');
    await mkdir(nested);
    await writeFile(path.join(repo, 'notes.md'), 'outer baseline');
    await writeFile(path.join(nested, 'notes.md'), 'nested baseline');
    await writeFile(path.join(nested, '.gitignore'), '.env\n');
    await execa('git', ['add', '-A'], { cwd: repo });
    await execa('git', ['commit', '-qm', 'nested project'], { cwd: repo });
    await writeFile(path.join(nested, '.gitignore'), '.env\nprivate.local\n');
    await writeFile(path.join(nested, 'private.local'), 'private user data');
    await writeFile(path.join(nested, 'notes.md'), 'user staged version');
    await execa('git', ['add', '--', 'notes.md'], { cwd: nested });
    await writeFile(path.join(nested, 'notes.md'), 'user unstaged version');
    const snap = await snapshot(nested);
    await writeFile(path.join(nested, '.gitignore'), '.env\n');
    await writeFile(path.join(nested, 'notes.md'), 'agent version');
    await execa('git', ['add', '-f', '--', 'private.local'], { cwd: nested });

    const commit = await commitAll(nested, 'nested work', snap);

    expect((await execa('git', ['show', `${commit}:nested-board/notes.md`], { cwd: repo })).stdout).toBe('agent version');
    expect((await execa('git', ['show', `${commit}:notes.md`], { cwd: repo })).stdout).toBe('outer baseline');
    expect((await execa('git', ['show', `${commit}:nested-board/private.local`], { cwd: repo, reject: false })).exitCode).not.toBe(0);
    await restore(nested, snap);
    expect(await readFile(path.join(nested, 'notes.md'), 'utf8')).toBe('user unstaged version');
    expect((await execa('git', ['show', ':nested-board/notes.md'], { cwd: repo })).stdout).toBe('user staged version');
    expect(await readFile(path.join(nested, 'private.local'), 'utf8')).toBe('private user data');
    expect(await readFile(path.join(repo, 'notes.md'), 'utf8')).toBe('outer baseline');
  });

  it('refuses an external .gitignore symlink before staging any private files', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);
    const { outside } = await fileFixture();
    const outsideIgnore = path.join(outside, 'ignore');
    await writeFile(outsideIgnore, 'outside contents\n');
    await rm(path.join(repo, '.gitignore'));
    await symlink(outsideIgnore, path.join(repo, '.gitignore'));
    await writeFile(path.join(repo, '.env'), 'private synthetic contents');
    await mkdir(path.join(repo, 'nested'));
    await writeFile(path.join(repo, 'nested/.env'), 'nested private contents');
    await writeFile(path.join(repo, 'notes.md'), 'project work');

    await expect(commitAll(repo, 'project work')).rejects.toThrow(SandboxError);

    expect(await readFile(outsideIgnore, 'utf8')).toBe('outside contents\n');
    expect((await execa('git', ['diff', '--cached', '--name-only'], { cwd: repo })).stdout).toBe('');
  });

  it.each([false, true])('does not commit originally ignored private data, already staged: %s', async (staged) => {
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);
    await writeFile(path.join(repo, '.gitignore'), '.env\n.copperhead/runs/\nprivate-token.local\n');
    await writeFile(path.join(repo, 'private-token.local'), 'synthetic-private-value');
    const snap = await snapshot(repo);
    await writeFile(path.join(repo, '.gitignore'), '.copperhead/runs/\n');
    await writeFile(path.join(repo, 'public.md'), 'intended project work');
    if (staged) await execa('git', ['add', '-f', '--', 'private-token.local'], { cwd: repo });

    const commit = await commitAll(repo, 'public project work', snap);

    const privateData = await execa('git', ['show', `${commit}:private-token.local`], { cwd: repo, reject: false });
    expect(privateData.exitCode).not.toBe(0);
    expect((await execa('git', ['show', `${commit}:public.md`], { cwd: repo })).stdout).toBe('intended project work');
    expect(await readFile(path.join(repo, 'private-token.local'), 'utf8')).toBe('synthetic-private-value');
  });

  it.each([false, true])('does not stash originally ignored private data, already staged: %s', async (staged) => {
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);
    const privateFiles = ['.env', 'private-token.local'];
    await writeFile(path.join(repo, '.gitignore'), '.env\n.copperhead/runs/\nprivate-token.local\n');
    for (const file of privateFiles) await writeFile(path.join(repo, file), `synthetic-private-value:${file}`);
    const snap = await snapshot(repo);
    await writeFile(path.join(repo, '.gitignore'), '.copperhead/runs/\n');
    if (staged) await execa('git', ['add', '-f', '--', ...privateFiles], { cwd: repo });
    const preserved = await preserveFailedRun(repo, 'private-data-regression', snap);
    expect(preserved).not.toBeNull();
    for (const file of privateFiles) {
      const captured = await execa('git', ['show', `${preserved}:${file}`], { cwd: repo, reject: false });
      expect(captured.exitCode).not.toBe(0);
    }
    await restore(repo, snap);
    for (const file of privateFiles) {
      expect(await readFile(path.join(repo, file), 'utf8')).toBe(`synthetic-private-value:${file}`);
    }
  });

  it.each([true, false])('preserves ignored files when the original .gitignore is tracked: %s', async (tracked) => {
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);
    const ignorePath = tracked ? '.gitignore' : 'private/.gitignore';
    await mkdir(path.join(repo, 'private'));
    const before = tracked ? await readFile(path.join(repo, ignorePath), 'utf8') : '';
    await writeFile(path.join(repo, ignorePath), `${before}*.local\n`);
    const privateFile = path.join(repo, 'private', 'user [1] ?.local');
    await writeFile(privateFile, 'user private data');
    const snap = await snapshot(repo);
    await writeFile(path.join(repo, ignorePath), before);
    await writeFile(path.join(repo, 'agent-only.md'), 'failed agent work');
    await execa('git', ['add', '-A'], { cwd: repo });

    await restore(repo, snap);

    expect(await readFile(privateFile, 'utf8')).toBe('user private data');
    expect(await readFile(path.join(repo, ignorePath), 'utf8')).toBe(`${before}*.local\n`);
    await expect(readFile(path.join(repo, 'agent-only.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores both staged and unstaged versions of a tracked file', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);
    const file = 'hardware/open-key.kicad_sch';
    const abs = path.join(repo, file);
    const original = await readFile(abs, 'utf8');
    await writeFile(abs, original.replace('KEY_DAH', 'KEY_STAGED'));
    await execa('git', ['add', '--', file], { cwd: repo });
    await writeFile(abs, original.replace('KEY_DAH', 'KEY_UNSTAGED'));
    const staged = (await execa('git', ['diff', '--cached'], { cwd: repo })).stdout;
    const unstaged = (await execa('git', ['diff'], { cwd: repo })).stdout;
    const snap = await snapshot(repo);
    await writeFile(abs, 'failed agent edit');

    await restore(repo, snap);

    expect((await execa('git', ['diff', '--cached'], { cwd: repo })).stdout).toBe(staged);
    expect((await execa('git', ['diff'], { cwd: repo })).stdout).toBe(unstaged);
  });

  it('restores untracked paths with leading whitespace and dangling symlinks', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);
    await writeFile(path.join(repo, ' notes.md'), 'user notes');
    await symlink('missing-target', path.join(repo, 'dangling'));
    const snap = await snapshot(repo);
    await writeFile(path.join(repo, ' notes.md'), 'agent overwrite');

    await restore(repo, snap);

    expect(await readFile(path.join(repo, ' notes.md'), 'utf8')).toBe('user notes');
    expect(await readlink(path.join(repo, 'dangling'))).toBe('missing-target');
  });

  it('reports filenames literally instead of Git-quoted or newline-split paths', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);
    const snap = await snapshot(repo);
    const filenames = [' notes.md', 'schematic\nnotes.md', 'café.md'];
    for (const filename of filenames) await writeFile(path.join(repo, filename), filename);
    await execa('git', ['add', '--', 'café.md'], { cwd: repo });

    expect((await changedFiles(repo, snap.head)).sort()).toEqual(filenames.sort());
  });
});
