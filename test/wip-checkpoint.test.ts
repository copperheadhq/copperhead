import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execa } from 'execa';
import { checkpoint, checkpointTree, recordWipRef, wipRef, snapshot, restore, headCommit, branchName } from '../src/util/git.js';
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

  it('returns null rather than throwing when the temp directory cannot be allocated', async () => {
    // Regression: mkdtemp() used to run outside the try block, so an
    // allocation failure rejected instead of returning null like every other
    // checkpoint failure. Forcing os.tmpdir() to resolve to a path that does
    // not exist reproduces that allocation failure.
    const { repo, cleanup } = await tempFixtureRepo();
    const savedEnv = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    try {
      await commitEverything(repo, 'base');
      await writeFile(path.join(repo, 'NOTES.md'), 'in progress\n', 'utf8');

      const bogus = path.join(repo, 'does-not-exist', 'nested');
      process.env.TMPDIR = bogus;
      process.env.TMP = bogus;
      process.env.TEMP = bogus;

      await expect(checkpointTree(repo, 'copperhead: WIP')).resolves.toBeNull();
    } finally {
      // `process.env.X = undefined` sets the literal string "undefined"
      // rather than unsetting X — on a machine where one of these was never
      // set (TMPDIR is commonly unset on Linux, falling back to /tmp), that
      // would leave os.tmpdir() permanently broken for every test that runs
      // after this one, in this same process.
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await cleanup();
    }
  }, 60_000);

  it('never edits .gitignore, even when it must exclude a path from the checkpoint', async () => {
    // Regression: checkpoint() used to call ensureIgnored() to keep .history/
    // out of the commit, which writes to the caller's .gitignore. That both
    // pollutes the checkpoint with an unrelated edit (the next git add -A
    // would pick the .gitignore change straight back up) and can produce a
    // checkpoint out of nothing but that edit when the excluded path was the
    // only pre-existing dirty content.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await commitEverything(repo, 'base');
      const gitignoreBefore = existsSync(path.join(repo, '.gitignore'))
        ? await readFile(path.join(repo, '.gitignore'), 'utf8')
        : null;

      await mkdir(path.join(repo, '.history'), { recursive: true });
      await writeFile(path.join(repo, '.history', 'scratch.txt'), 'excluded\n', 'utf8');
      await writeFile(path.join(repo, 'NOTES.md'), 'in progress\n', 'utf8');

      const sha = await checkpoint(repo, 'schematic', 'copperhead: WIP');
      expect(sha, 'the non-excluded file should still produce a checkpoint').toBeTruthy();

      const gitignoreAfter = existsSync(path.join(repo, '.gitignore'))
        ? await readFile(path.join(repo, '.gitignore'), 'utf8')
        : null;
      expect(gitignoreAfter, '.gitignore must be byte-identical to before the checkpoint').toBe(gitignoreBefore);

      const { stdout: files } = await git(repo, ['show', '--name-only', '--format=', sha!]);
      expect(files).toContain('NOTES.md');
      expect(files).not.toContain('.history/scratch.txt');
      expect(files).not.toContain('.gitignore');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('produces no checkpoint when the only pre-existing dirty path is excluded', async () => {
    // Regression: with the old ensureIgnored() call, writing .history/ into
    // .gitignore was itself a dirty-tree change, so a tree whose only real
    // content was under .history/ still produced a checkpoint — one holding
    // nothing but the .gitignore edit.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await commitEverything(repo, 'base');
      await mkdir(path.join(repo, '.history'), { recursive: true });
      await writeFile(path.join(repo, '.history', 'scratch.txt'), 'excluded\n', 'utf8');

      await expect(checkpoint(repo, 'schematic', 'copperhead: WIP')).resolves.toBeNull();
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('checkpointTree() before restore() captures the failed attempt; checkpoint() after does not', async () => {
    // This is the bug the split exists to fix (issue #208 follow-up): the
    // create pipeline used to call checkpoint() *after* runAgentLoop had
    // already rolled the tree back on failure, so it checkpointed the clean,
    // restored tree rather than the failed attempt. checkpointTree() lets a
    // caller capture the dirty tree first — this test reproduces both the old
    // bug and the fix in one place, with the exact call order each uses.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await commitEverything(repo, 'base');
      const snap = await snapshot(repo);

      // The shape of a failed attempt's work: an accepted draft plus an
      // untracked handoff note, exactly as runAgentLoop would leave it right
      // before its own fail()/refused branch calls restore().
      await writeFile(path.join(repo, 'DRAFT.md'), 'accepted draft content\n', 'utf8');
      await writeFile(path.join(repo, 'HANDOFF.md'), 'what this attempt learned\n', 'utf8');

      // The fix: runAgentLoop's failure paths now capture before rolling back.
      const failedAttemptCommit = await checkpointTree(repo, 'copperhead: WIP checkpoint — NOT CERTIFIED (test)');
      expect(failedAttemptCommit, 'the dirty tree should produce a checkpoint').toBeTruthy();

      // The rollback runAgentLoop performs right after.
      await restore(repo, snap);
      expect(existsSync(path.join(repo, 'HANDOFF.md')), 'rollback should remove the untracked file').toBe(false);
      expect(existsSync(path.join(repo, 'DRAFT.md')), 'rollback should remove the tracked draft').toBe(false);

      // create.ts, once it knows the stage, points the ref at what was
      // already captured — it does not re-derive from the (now clean) tree.
      await recordWipRef(repo, 'schematic', failedAttemptCommit!);
      const { stdout: resolved } = await git(repo, ['rev-parse', wipRef('schematic')]);
      expect(resolved.trim()).toBe(failedAttemptCommit);

      const { stdout: files } = await git(repo, ['show', '--name-only', '--format=', failedAttemptCommit!]);
      expect(files, 'the checkpoint must hold the failed attempt, not the post-rollback tree').toContain('HANDOFF.md');
      expect(files).toContain('DRAFT.md');

      // The bug, reproduced: calling checkpoint() the old way — after the
      // rollback, the way create.ts used to — finds a clean tree and records
      // nothing, silently losing the attempt this whole feature exists to
      // preserve.
      const postRollbackAttempt = await checkpoint(repo, 'schematic', 'copperhead: WIP (post-rollback, buggy order)');
      expect(postRollbackAttempt, 'checkpointing after restore() has nothing left to capture').toBeNull();
    } finally {
      await cleanup();
    }
  }, 60_000);
});
