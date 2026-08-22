import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execa } from 'execa';
import { checkpoint, wipRef, snapshot, restore, headCommit, branchName } from '../src/util/git.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * Issue #208: a failed stage attempt rolls the tree back, and the work it had
 * accepted survives only as a stash of tracked files. Anything the agent left
 * untracked is destroyed outright, so a retry restarts from zero and hours of
 * accepted work exist nowhere.
 *
 * `checkpoint` records the working state to `refs/copperhead/wip/<stage>` before
 * the rollback. The branch is deliberately untouched: the verification gate
 * still decides what lands on it, and the checkpoint is reachable only by its
 * own ref.
 */

const git = (repo: string, args: string[]) => execa('git', args, { cwd: repo });

async function commitEverything(repo: string, message: string): Promise<void> {
  await git(repo, ['add', '-A']);
  // The fixture may already be clean; committing nothing is an error, not a no-op.
  const { stdout } = await git(repo, ['status', '--porcelain']);
  if (stdout.trim()) await git(repo, ['commit', '-q', '-m', message]);
}

describe('WIP checkpoints (issue #208)', () => {
  it('preserves untracked work that a rollback would destroy', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await commitEverything(repo, 'base');
      const snap = await snapshot(repo);

      // The shape the issue describes: an accepted draft (tracked edit) plus an
      // untracked handoff doc the agent wrote for the next attempt.
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs', 'BOM.md'), '# BOM\n\n| Ref | Part |\n| --- | --- |\n| R1 | 10k |\n', 'utf8');
      await writeFile(path.join(repo, 'HANDOFF.md'), 'what attempt 1 learned\n', 'utf8');

      const sha = await checkpoint(repo, 'schematic', 'copperhead: WIP schematic attempt 1 — NOT CERTIFIED');
      expect(sha, 'a dirty tree should produce a checkpoint').toBeTruthy();

      await restore(repo, snap);

      // The rollback did its job.
      expect(existsSync(path.join(repo, 'HANDOFF.md')), 'rollback should remove the untracked file').toBe(false);

      // ...and the work is still recoverable from the checkpoint, including the
      // untracked file, which is what the stash-based preservation loses.
      const { stdout: files } = await git(repo, ['show', '--name-only', '--format=', sha!]);
      expect(files).toContain('HANDOFF.md');

      const { stdout: handoff } = await git(repo, ['show', `${sha}:HANDOFF.md`]);
      expect(handoff).toBe('what attempt 1 learned');

      const { stdout: bom } = await git(repo, ['show', `${sha}:docs/BOM.md`]);
      expect(bom).toContain('| R1 | 10k |');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('leaves the branch, HEAD and working tree untouched', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await commitEverything(repo, 'base');
      const headBefore = await headCommit(repo);
      const branchBefore = await branchName(repo);

      await writeFile(path.join(repo, 'NOTES.md'), 'in progress\n', 'utf8');
      // Something staged, to prove the temporary index leaves the real one alone.
      await writeFile(path.join(repo, 'STAGED.md'), 'staged\n', 'utf8');
      await git(repo, ['add', 'STAGED.md']);

      const sha = await checkpoint(repo, 'schematic', 'copperhead: WIP');
      expect(sha).toBeTruthy();

      expect(await headCommit(repo), 'HEAD must not move').toBe(headBefore);
      expect(await branchName(repo), 'the branch must not change').toBe(branchBefore);
      expect(await readFile(path.join(repo, 'NOTES.md'), 'utf8')).toBe('in progress\n');

      // The real index still holds exactly what the caller staged.
      const { stdout: staged } = await git(repo, ['diff', '--cached', '--name-only']);
      expect(staged.trim()).toBe('STAGED.md');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('is not reachable from the branch, so nothing uncertified lands on it', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await commitEverything(repo, 'base');
      await writeFile(path.join(repo, 'NOTES.md'), 'in progress\n', 'utf8');

      const sha = await checkpoint(repo, 'schematic', 'copperhead: WIP');

      const { stdout: onBranch } = await git(repo, ['log', '--format=%H']);
      expect(onBranch.split('\n')).not.toContain(sha);

      // It is reachable by its own ref, which is the point.
      const { stdout: resolved } = await git(repo, ['rev-parse', wipRef('schematic')]);
      expect(resolved.trim()).toBe(sha);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('records nothing when the tree is clean', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await commitEverything(repo, 'base');
      expect(await checkpoint(repo, 'schematic', 'copperhead: WIP')).toBeNull();
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('keeps one ref per stage, and the newest attempt for a stage', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await commitEverything(repo, 'base');

      await writeFile(path.join(repo, 'A.md'), 'first\n', 'utf8');
      const first = await checkpoint(repo, 'schematic', 'copperhead: WIP schematic attempt 1');

      await writeFile(path.join(repo, 'A.md'), 'second\n', 'utf8');
      const second = await checkpoint(repo, 'schematic', 'copperhead: WIP schematic attempt 2');

      await mkdir(path.join(repo, 'outputs'), { recursive: true });
      await writeFile(path.join(repo, 'outputs', 'B.md'), 'other stage\n', 'utf8');
      const other = await checkpoint(repo, 'layout-draft', 'copperhead: WIP layout-draft attempt 1');

      expect(second).not.toBe(first);
      const { stdout: schematicRef } = await git(repo, ['rev-parse', wipRef('schematic')]);
      expect(schematicRef.trim(), 'the stage ref should advance to the latest attempt').toBe(second);

      const { stdout: layoutRef } = await git(repo, ['rev-parse', wipRef('layout-draft')]);
      expect(layoutRef.trim(), 'each stage keeps its own ref').toBe(other);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('does not throw when the repo cannot take a checkpoint', async () => {
    // A checkpoint is a safety net, never a gate: it must not fail the stage
    // that was about to be rolled back anyway.
    await expect(checkpoint(path.join('does', 'not', 'exist'), 'schematic', 'x')).resolves.toBeNull();
  }, 60_000);
});
