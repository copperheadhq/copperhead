import { runAgentLoop } from '../src/agent/loop.js';
import { describe, it, expect } from 'vitest';
import { writeFile as externalWrite, readFile, unlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { tempFixtureRepo } from './helpers.js';
import { withWorktreeOwnership, writeFile, assertOwnedTree } from '../src/util/worktree-ownership.js';
import { commitAll, snapshot, restore, preserveFailedRun, applyFailedRun } from '../src/util/git.js';

async function git(repo: string, args: string[]) {
  return (await execa('git', args, { cwd: repo })).stdout;
}

describe('run ownership (#468)', () => {
  it('commits only run-owned files and leaves external untracked and tracked edits on disk', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await withWorktreeOwnership(repo, async () => {
        await writeFile(path.join(repo, 'owned.txt'), 'run');
        await externalWrite(path.join(repo, 'foreign.txt'), 'human');
        await externalWrite(path.join(repo, 'README.md'), 'human notes');
        const sha = await commitAll(repo, 'owned only');
        const names = (await git(repo, ['show', '--format=', '--name-only', sha])).split('\n');
        expect(names).toContain('owned.txt');
        expect(names).not.toContain('foreign.txt');
        expect(names).not.toContain('README.md');
        expect(await readFile(path.join(repo, 'foreign.txt'), 'utf8')).toBe('human');
        expect(await readFile(path.join(repo, 'README.md'), 'utf8')).toBe('human notes');
      });
    } finally { await cleanup(); }
  });

  for (const action of ['commit', 'rollback', 'write'] as const) {
    it(`refuses ${action} when an owned file was changed by another writer`, async () => {
      const { repo, cleanup } = await tempFixtureRepo();
      try {
        await withWorktreeOwnership(repo, async () => {
          const snap = await snapshot(repo);
          await writeFile(path.join(repo, 'owned.txt'), 'run');
          await externalWrite(path.join(repo, 'owned.txt'), 'human');
          const operation = action === 'commit' ? () => commitAll(repo, 'bad') : action === 'rollback'
            ? () => restore(repo, snap) : () => writeFile(path.join(repo, 'owned.txt'), 'overwrite');
          await expect(operation()).rejects.toThrow(/external changes detected.*owned.txt/);
          expect(await readFile(path.join(repo, 'owned.txt'), 'utf8')).toBe('human');
          expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(snap.head);
        });
      } finally { await cleanup(); }
    });
  }

  for (const kind of ['untracked', 'deleted', 'mode', 'head', 'index'] as const) {
    it.skipIf(kind === 'mode' && process.platform === 'win32')(`refuses rollback after an external ${kind} change, preserving that work`, async () => {
      const { repo, cleanup } = await tempFixtureRepo();
      try {
        await externalWrite(path.join(repo, 'existing.txt'), 'baseline');
        await git(repo, ['add', 'existing.txt']);
        await git(repo, ['commit', '-qm', 'baseline']);
        await withWorktreeOwnership(repo, async () => {
          const snap = await snapshot(repo);
          await writeFile(path.join(repo, 'owned.txt'), 'run');
          if (kind === 'untracked') await externalWrite(path.join(repo, 'human.txt'), 'human');
          if (kind === 'deleted') await unlink(path.join(repo, 'existing.txt'));
          if (kind === 'mode') await chmod(path.join(repo, 'existing.txt'), 0o755);
          if (kind === 'head') await git(repo, ['commit', '--allow-empty', '-qm', 'external commit']);
          if (kind === 'index') {
            await externalWrite(path.join(repo, 'human.txt'), 'human');
            await git(repo, ['add', 'human.txt']);
          }
          const status = await git(repo, ['status', '--porcelain']);
          const head = await git(repo, ['rev-parse', 'HEAD']);
          await expect(restore(repo, snap)).rejects.toThrow(/external changes detected/);
          expect(await git(repo, ['status', '--porcelain'])).toBe(status);
          expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
          expect(await readFile(path.join(repo, 'owned.txt'), 'utf8')).toBe('run');
        });
      } finally { await cleanup(); }
    });
  }

  it('preserves pre-existing staged and unstaged work when committing its own file', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await externalWrite(path.join(repo, 'human.txt'), 'staged');
      await git(repo, ['add', 'human.txt']);
      await externalWrite(path.join(repo, 'human.txt'), 'unstaged');
      await withWorktreeOwnership(repo, async () => {
        await writeFile(path.join(repo, 'owned.txt'), 'run');
        await commitAll(repo, 'run');
        expect(await git(repo, ['show', ':human.txt'])).toBe('staged');
        expect(await readFile(path.join(repo, 'human.txt'), 'utf8')).toBe('unstaged');
        expect(await git(repo, ['diff', '--cached', '--name-only'])).toBe('human.txt');
      });
    } finally { await cleanup(); }
  });

  it('failure preservation leaves the real index unchanged and normal rollback still works', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await withWorktreeOwnership(repo, async () => {
        const snap = await snapshot(repo);
        const index = await git(repo, ['ls-files', '--stage']);
        await writeFile(path.join(repo, 'owned.txt'), 'run');
        expect(await preserveFailedRun(repo, 'test')).toBeTruthy();
        expect(await git(repo, ['ls-files', '--stage'])).toBe(index);
        await restore(repo, snap);
        expect(await git(repo, ['status', '--porcelain'])).toBe('');
        await expect(assertOwnedTree(repo)).resolves.toBeUndefined();
      });
    } finally { await cleanup(); }
  });

  it('restores a preserved draft without staging or adopting unrelated user work', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await withWorktreeOwnership(repo, async () => {
        const snap = await snapshot(repo);
        await writeFile(path.join(repo, 'draft.md'), 'draft\n');
        await preserveFailedRun(repo, 'retry');
        await restore(repo, snap);
        const applied = await applyFailedRun(repo, 'retry');
        expect(applied.ok).toBe(true);
        expect(applied.files).toContain('draft.md');
        expect(await readFile(path.join(repo, 'draft.md'), 'utf8')).toBe('draft\n');
        await expect(assertOwnedTree(repo)).resolves.toBeUndefined();
        await commitAll(repo, 'recovered draft');
        expect(await git(repo, ['show', 'HEAD:draft.md'])).toBe('draft');
      });
    } finally { await cleanup(); }
  });

  it('keeps pre-existing untracked bytes out of a commit even after the run edits the file', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await externalWrite(path.join(repo, 'human.txt'), 'human');
      await withWorktreeOwnership(repo, async () => {
        const snap = await snapshot(repo);
        await expect(writeFile(path.join(repo, 'human.txt'), 'human plus run edit')).rejects.toThrow(/pre-existing changes/);
        await restore(repo, snap);
        expect(await readFile(path.join(repo, 'human.txt'), 'utf8')).toBe('human');
      });
    } finally { await cleanup(); }
  });

  it('runs commit hooks against the scoped index and refuses a hook that adds foreign paths', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
      await externalWrite(hook, '#!/bin/sh\ngit add foreign.txt\n');
      await chmod(hook, 0o755);
      await withWorktreeOwnership(repo, async () => {
        const head = await git(repo, ['rev-parse', 'HEAD']);
        await writeFile(path.join(repo, 'owned.txt'), 'run');
        await externalWrite(path.join(repo, 'foreign.txt'), 'human');
        await expect(commitAll(repo, 'bad hook')).rejects.toThrow(/commit hook changed/);
        expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
        expect(await git(repo, ['diff', '--cached', '--name-only'])).toBe('');
        expect(await readFile(path.join(repo, 'foreign.txt'), 'utf8')).toBe('human');
      });
    } finally { await cleanup(); }
  });

  for (const kind of ['file', 'commit'] as const) {
    it(`the real agent loop preserves an external ${kind} on provider failure and writes a summary`, async () => {
      const { repo, cleanup } = await tempFixtureRepo();
      try {
        let externalHead = '';
        const result = await runAgentLoop({
          repoRoot: repo, request: 'offline ownership test', model: 'gpt-5', maxTurns: 1,
          log: () => {},
          provider: {
            name: 'scripted',
            async chat() {
              await externalWrite(path.join(repo, 'human.txt'), 'external work');
              if (kind === 'commit') {
                await git(repo, ['add', 'human.txt']);
                await git(repo, ['commit', '-qm', 'external work']);
              }
              externalHead = await git(repo, ['rev-parse', 'HEAD']);
              throw new Error('scripted provider failure');
            },
          },
        });
        expect(result.outcome).toBe('failure');
        expect(result.exitPath).toBe('external-change');
        expect(result.summary).toContain('external changes detected');
        expect(await readFile(path.join(repo, 'human.txt'), 'utf8')).toBe('external work');
        expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(externalHead);
        expect(await readFile(path.join(result.transcriptDir, 'summary.md'), 'utf8')).toContain('external changes detected');
      } finally { await cleanup(); }
    });
  }

  it('stops before dispatching a tool when an owned file changes during a provider turn', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const result = await runAgentLoop({
        repoRoot: repo, request: 'offline dispatch boundary', model: 'gpt-5', maxTurns: 1, log: () => {},
        provider: { name: 'scripted', async chat() {
          await writeFile(path.join(repo, 'owned.txt'), 'run');
          await externalWrite(path.join(repo, 'owned.txt'), 'human');
          return { text: null, toolCalls: [{ id: 'read-1', name: 'read_file', args: { path: 'owned.txt' } }], usage: { inputTokens: 1, outputTokens: 1 } };
        } },
      });
      expect(result.exitPath).toBe('external-change');
      expect(await readFile(path.join(repo, 'owned.txt'), 'utf8')).toBe('human');
      const events = (await readFile(path.join(result.transcriptDir, 'transcript.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(events.some((event) => event.type === 'tool')).toBe(false);
    } finally { await cleanup(); }
  });
  it('nested stages share the ownership record', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await withWorktreeOwnership(repo, async () => {
        await withWorktreeOwnership(repo, () => writeFile(path.join(repo, 'nested.txt'), 'run'));
        await commitAll(repo, 'nested');
        expect(await git(repo, ['show', 'HEAD:nested.txt'])).toBe('run');
      });
    } finally { await cleanup(); }
  });
});
