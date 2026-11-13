import { createHash } from 'node:crypto';
import { writeFile, unlink as ownedUnlink, ownershipFor, assertOwnedTree, ExternalChangeError, ownershipCheckpoint, restoreOwnershipCheckpoint, type OwnershipCheckpoint } from './worktree-ownership.js';
import { execa } from 'execa';
import { access, constants, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PreflightError } from './preflight.js';

/**
 * Paths copperhead must keep out of `git add -A`. KiCad ≥9 writes a
 * git-backed local-history directory (`.history/`, complete with its own nested
 * `.git`) into the project the first time kicad-cli touches it. Left untracked,
 * that nested repo has an unborn HEAD, so a plain `git add -A` in the parent
 * aborts with `error: '.history/' does not have a commit checked out` (exit
 * 128) — which fails the commit at the end of every KiCad-touching stage
 * (schematic, layout, outputs). Ignoring it is both correct (local history is
 * never a project artifact) and the fix for that abort. Kept as a list so other
 * KiCad transients can join it if they surface.
 */
const GIT_ADD_EXCLUDES = ['.history/'];

/**
 * Ensure the repo's root .gitignore lists each entry, appending only the
 * missing ones. Idempotent and best-effort: a failure here must never block a
 * commit, so it swallows its own errors. Run before any `git add -A` so a
 * git-backed KiCad `.history/` (or similar nested repo) is skipped instead of
 * aborting the add.
 */
export async function ensureIgnored(repo: string, entries: string[]): Promise<void> {
  try {
    const p = path.join(repo, '.gitignore');
    const text = existsSync(p) ? await readFile(p, 'utf8') : '';
    const present = new Set(text.split('\n').map((l) => l.trim()));
    const missing = entries.filter((e) => !present.has(e));
    if (!missing.length) return;
    const prefix = text.length && !text.endsWith('\n') ? '\n' : '';
    await writeFile(p, text + prefix + missing.join('\n') + '\n', 'utf8');
  } catch {
    // best-effort: .gitignore maintenance must never be the thing that fails a run
  }
}

export interface GitSnapshot {
  ownership?: OwnershipCheckpoint;
  head: string;
  stash: string | null;
  /**
   * Tree object holding the untracked-but-not-ignored files that `git stash
   * create` cannot capture. Without it a rollback's `git clean -fd` deletes
   * them for good; see snapshotUntracked().
   */
  untracked: string | null;
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd: repo, env: { GIT_LITERAL_PATHSPECS: '1' } });
  return stdout.trim();
}

/** Same as git(), with a scratch index so the repo's real index is untouched. */
async function gitWithIndex(repo: string, indexFile: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, {
    cwd: repo,
    env: { GIT_INDEX_FILE: indexFile, GIT_LITERAL_PATHSPECS: '1' },
  });
  return stdout.trim();
}

/** Monotonic suffix so two scratch indexes in one process never collide. */
let scratchIndexSeq = 0;

/**
 * Path for a throwaway index, inside the repo's own git dir rather than
 * TMPDIR: git guarantees that directory exists and is writable, so a hostile
 * or missing temp dir cannot make a snapshot fail and block a run from
 * starting. Absolute, because git resolves GIT_INDEX_FILE against cwd.
 */
async function scratchIndexPath(repo: string): Promise<string> {
  const gitDir = await git(repo, ['rev-parse', '--absolute-git-dir']);
  return path.join(gitDir, `copperhead-index-${process.pid}-${scratchIndexSeq++}`);
}

/**
 * Write the untracked-but-not-ignored files to a tree object and return its
 * sha, or null when there are none.
 *
 * `git stash create` only ever captures tracked changes, so on its own it
 * leaves every new file a run (or the user) has not added yet outside the
 * snapshot — and restore()'s `git clean -fd` then deletes exactly those. The
 * two sets line up: `--exclude-standard` skips ignored paths and plain
 * `clean -fd` (no -x) leaves them alone, so what is captured here is precisely
 * what the rollback would otherwise destroy.
 *
 * Built through a scratch GIT_INDEX_FILE rather than `git add -A`, because
 * this runs at the *start* of a run: staging the user's files would outlive a
 * successful run and silently rewrite their staged/unstaged split.
 */
async function snapshotUntracked(repo: string): Promise<string | null> {
  const listed = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = listed.split('\0').filter(Boolean);
  if (!paths.length) return null;
  const usable = await readableOnly(repo, paths);
  if (!usable.length) return null;
  const indexFile = await scratchIndexPath(repo);
  try {
    await execa('git', ['update-index', '-z', '--add', '--stdin'], {
      cwd: repo,
      env: { GIT_INDEX_FILE: indexFile, GIT_LITERAL_PATHSPECS: '1' },
      input: usable.join('\0') + '\0',
    });
    return (await gitWithIndex(repo, indexFile, ['write-tree'])) || null;
  } catch (err) {
    // A path that passed the readability check above and still failed here
    // lost the race (permissions or existence changed in between). Same
    // refusal, since the same file would be destroyed by the rollback.
    throw unsnapshottable(String((err as Error).message).split('\n')[0] ?? 'unknown path');
  } finally {
    await rm(indexFile, { force: true }).catch(() => {});
  }
}

/**
 * Drop untracked paths that no longer exist, and refuse on any that exist but
 * cannot be read.
 *
 * `git update-index` aborts the whole batch with exit 128 on the first path it
 * cannot open, and this runs before the first turn, so one stray root-owned or
 * mode-000 file would otherwise refuse every `--allow-dirty` run with a bare
 * `fatal: Unable to process path …`. A vanished path is dropped rather than
 * refused: a file that no longer exists cannot be lost. One that exists but is
 * unreadable is refused deliberately rather than skipped, because `restore()`'s
 * `git clean -fd` deletes it either way, and skipping would quietly reinstate
 * exactly the data loss the untracked snapshot exists to prevent.
 */
async function readableOnly(repo: string, paths: string[]): Promise<string[]> {
  const usable: string[] = [];
  for (const p of paths) {
    try {
      await access(path.join(repo, p), constants.R_OK);
      usable.push(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw unsnapshottable(p);
    }
  }
  return usable;
}

function unsnapshottable(what: string): PreflightError {
  return new PreflightError(
    `cannot read untracked file: ${what}`,
    'a run started with --allow-dirty promises your uncommitted work survives a failed run, but a file copperhead cannot read cannot be snapshotted, and the rollback would delete it with nothing to restore it from',
    [
      `make it readable: chmod +r "${what}"`,
      'or delete it, or add it to .gitignore so the rollback leaves it alone',
      'or commit your work and rerun without --allow-dirty',
    ],
  );
}

/**
 * Re-materialize the untracked files captured by snapshotUntracked(). Runs
 * after `stash apply` so tracked restores win any path collision.
 */
async function restoreUntracked(repo: string, tree: string): Promise<void> {
  const indexFile = await scratchIndexPath(repo);
  try {
    await gitWithIndex(repo, indexFile, ['read-tree', tree]);
    await gitWithIndex(repo, indexFile, ['checkout-index', '-a', '-f']);
  } finally {
    await rm(indexFile, { force: true }).catch(() => {});
  }
}

export async function isGitRepo(repo: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/** False on an unborn HEAD (fresh `git init` with no commits yet). */
export async function hasCommits(repo: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--quiet', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function isDirty(repo: string): Promise<boolean> {
  const status = await git(repo, ['status', '--porcelain']);
  return status.length > 0;
}

/**
 * The run-blocking git gates, in order: repo -> commits -> dirty (AC-3.8).
 * Throws a PreflightError whose message explains why the run is refused and
 * how to fix it; a caller that catches only needs err.message.
 */
export async function gitPreflight(repo: string, opts: { allowDirty?: boolean } = {}): Promise<void> {
  if (!(await isGitRepo(repo))) {
    throw new PreflightError(
      'not a git repository; copperhead requires git for snapshots and rollback',
      'every run snapshots HEAD before editing so a failed run can be rolled back losslessly; without git there is no snapshot and no undo',
      ['git init', 'git add -A && git commit -m "initial commit"', 'rerun the same copperhead command'],
    );
  }
  if (!(await hasCommits(repo))) {
    throw new PreflightError(
      'repository has no commits; copperhead requires at least one commit for snapshots and rollback',
      'the pre-run snapshot is the current HEAD commit; with an unborn HEAD there is nothing to roll back to if verification fails',
      ['git add -A && git commit -m "initial commit"', 'rerun the same copperhead command'],
    );
  }
  if ((await isDirty(repo)) && !opts.allowDirty) {
    throw new PreflightError(
      'working tree is dirty; copperhead refuses to run on uncommitted changes by default',
      'a rollback hard-resets to the pre-run snapshot, which would silently destroy your uncommitted work',
      [
        'git add -A && git commit — to keep your changes (recommended)',
        'git stash — to set them aside for now',
        'or rerun with --allow-dirty to let copperhead preserve them via "git stash create"',
      ],
    );
  }
}

/**
 * Snapshot the working tree before a run. On a clean tree HEAD is enough;
 * with --allow-dirty we keep a `git stash create` object for tracked changes
 * plus a tree of the untracked files it cannot see, so uncommitted work
 * survives a rollback intact (SPEC §7).
 */
export async function snapshot(repo: string): Promise<GitSnapshot> {
  const head = await git(repo, ['rev-parse', 'HEAD']);
  let stash: string | null = null;
  let untracked: string | null = null;
  if (await isDirty(repo)) {
    stash = (await git(repo, ['stash', 'create'])) || null;
    untracked = await snapshotUntracked(repo);
  }
  const ownership = await ownershipCheckpoint(repo);
  return { head, stash, untracked, ...(ownership ? { ownership } : {}) };
}

/**
 * Hard-restore the working tree to a snapshot (AC-3.6). The run audit trail
 * (.copperhead/runs/) survives rollback: it is the evidence of what failed.
 */
export async function restore(repo: string, snap: GitSnapshot): Promise<void> {
  if (ownershipFor(repo)) {
    if (!snap.ownership) throw new ExternalChangeError('rollback snapshot has no ownership checkpoint');
    return restoreOwnershipCheckpoint(repo, snap.ownership);
  }
  // `git clean -e` only protects untracked paths. A run directory can become
  // staged (for example while preserving failed work), and `reset --hard`
  // deletes such paths before clean runs. Copy it outside the repository so
  // the audit trail survives regardless of its index state.
  const runs = path.join(repo, '.copperhead', 'runs');
  let backupRoot: string | null = null;
  let backup: string | null = null;
  try {
    try {
      backupRoot = await mkdtemp(path.join(tmpdir(), 'copperhead-runs-'));
      backup = path.join(backupRoot, 'runs');
      if (existsSync(runs)) await cp(runs, backup, { recursive: true });
    } catch (err) {
      backup = null;
      console.warn(`warning: could not preserve failed-run audit trail before rollback: ${(err as Error).message}`);
    }

    try {
      await git(repo, ['reset', '--hard', snap.head]);
      await git(repo, ['clean', '-fd', '-e', '.copperhead/runs']);
      if (snap.stash) {
        await git(repo, ['stash', 'apply', snap.stash]);
      }
      // The clean above deleted every untracked file; put back the ones that
      // were there before the run. Never fatal: a rollback that restored the
      // tracked state is still better than one that threw halfway.
      if (snap.untracked) {
        try {
          await restoreUntracked(repo, snap.untracked);
        } catch (err) {
          console.warn(
            `warning: could not restore untracked files after rollback: ${(err as Error).message}`,
          );
        }
      }
    } finally {
      if (backup && existsSync(backup)) {
        try {
          await mkdir(path.dirname(runs), { recursive: true });
          // Restored runs are intentionally untracked; their audit contents
          // are ignored by the target-repository convention.
          await cp(backup, runs, { recursive: true, force: true });
        } catch (err) {
          console.warn(`warning: could not restore failed-run audit trail: ${(err as Error).message}`);
        }
      }
    }
  } finally {
    if (backupRoot) {
      try {
        await rm(backupRoot, { recursive: true, force: true });
      } catch (err) {
        console.warn(`warning: could not clean failed-run audit backup: ${(err as Error).message}`);
      }
    }
  }
}

/**
 * Preserve a failed run's work as a stash entry before rollback, so a failure
 * is recoverable instead of destroyed. `git stash create` alone ignores
 * untracked files (most of what a docs-stage run produces), so everything is
 * staged first; restore() resets the index anyway. Never throws: preservation
 * must not be able to block the rollback itself.
 */
export async function preserveFailedRun(repo: string, runId: string): Promise<string | null> {
  try {
    if (!(await isDirty(repo))) return null;
    await assertOwnedTree(repo);
    await ensureIgnored(repo, GIT_ADD_EXCLUDES);
    // Never leave the audit trail staged: a staged-but-not-in-HEAD path is
    // deleted by restore()'s `reset --hard`, which silently defeats its
    // `clean -e .copperhead/runs` protection (that flag only spares untracked
    // files) — the in-flight run's transcript dir vanishes mid-run. Staging
    // then unstaging (rather than an exclude pathspec) because `git add`
    // errors outright when a pathspec touches gitignored paths, and runs/ is
    // gitignored in some target repos but tracked in others.
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-preserve-index-'));
    let sha: string;
    try {
      const index = path.join(dir, 'index');
      await gitWithIndex(repo, index, ['read-tree', 'HEAD']);
      await gitWithIndex(repo, index, ['add', '-A']);
      await gitWithIndex(repo, index, ['reset', '-q', '--', '.copperhead/runs']);
      await assertOwnedTree(repo);
      sha = await gitWithIndex(repo, index, ['stash', 'create']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    if (!sha) return null;
    await git(repo, ['stash', 'store', '-m', `copperhead failed run ${runId}`, sha]);
    return sha;
  } catch {
    return null;
  }
}

/** Whether `preserveFailedRun` left an entry for `runId`. */
export async function hasFailedRun(repo: string, runId: string): Promise<boolean> {
  try {
    const marker = `copperhead failed run ${runId}`;
    return (await git(repo, ['stash', 'list'])).split('\n').some((l) => l.endsWith(marker));
  } catch {
    return false;
  }
}

export type AppliedRun = { ok: true; files: string[] } | { ok: false; files: string[]; error: string };

/**
 * Put a preserved run's work back on the tree (design D5): find the stash entry
 * `preserveFailedRun` left for `runId`, apply it, and drop it on success so the
 * list does not grow with every retry. `files` names what the entry touched. An
 * entry that does not apply cleanly is kept, the tree is put back as it was, and
 * the conflict is reported, so a retry never starts from a half-applied draft.
 * No entry for the run is not an error: nothing to restore, no files.
 */
export async function applyFailedRun(repo: string, runId: string): Promise<AppliedRun> {
  const marker = `copperhead failed run ${runId}`;
  let ref: string | undefined;
  try {
    const list = await git(repo, ['stash', 'list']);
    const line = list.split('\n').find((l) => l.endsWith(marker));
    if (!line) return { ok: true, files: [] };
    ref = line.slice(0, line.indexOf(':'));
  } catch (err) {
    return { ok: false, files: [], error: (err as Error).message };
  }
  // The entry was taken against a commit; on any other HEAD its files could
  // overwrite work that was committed since, so it is kept and reported.
  let base: string;
  let head: string;
  try {
    base = await git(repo, ['rev-parse', `${ref}^`]);
    head = await git(repo, ['rev-parse', 'HEAD']);
  } catch (err) {
    return { ok: false, files: [], error: (err as Error).message };
  }
  if (base !== head) {
    return {
      ok: false,
      files: [],
      error: `stash entry "${marker}" was taken on ${base.slice(0, 10)} and HEAD is now ${head.slice(0, 10)}; not applied`,
    };
  }
  if (ownershipFor(repo)) return applyOwnedFailedRun(repo, ref, marker);
  await assertOwnedTree(repo);
  const snap = await snapshot(repo);
  let files: string[] = [];
  try {
    // The entry's tree is the whole draft as it stood, newer than anything on the
    // tree from an earlier attempt (the rollback puts the previous draft back as
    // an untracked file). A three-way `stash apply` would see that earlier draft
    // as "ours" and stop on an add/add conflict, so the entry's files are checked
    // out of its tree directly: each path takes the entry's bytes, a path the
    // entry dropped is removed. Staging first lets `git diff` name exactly the
    // paths that change, so untouched files earlier stages left uncommitted are
    // not reported as restored; the index is emptied again at the end, and the
    // audit trail stays out of it, as in preservation.
    await ensureIgnored(repo, GIT_ADD_EXCLUDES);
    await git(repo, ['add', '-A']);
    await git(repo, ['reset', '-q', '--', '.copperhead/runs']);
    files = (await git(repo, ['diff', '--name-only', ref])).split('\n').filter(Boolean);
    if (files.length) {
      const inEntry = new Set((await git(repo, ['ls-tree', '-r', '--name-only', ref])).split('\n').filter(Boolean));
      const take = files.filter((f) => inEntry.has(f));
      const drop = files.filter((f) => !inEntry.has(f));
      if (take.length) await git(repo, ['checkout', ref, '--', ...take]);
      for (const f of drop) await rm(path.join(repo, f), { force: true });
    }
    await git(repo, ['reset', '-q']);
  } catch (err) {
    try {
      await restore(repo, snap);
    } catch {
      // the failure is reported either way; the entry is kept
    }
    return { ok: false, files, error: `stash entry "${marker}" could not be applied: ${(err as Error).message.split('\n')[0]}` };
  }
  try {
    await git(repo, ['stash', 'drop', ref]);
  } catch {
    // a stale entry is harmless; the work is on the tree
  }
  return { ok: true, files };
}

/** Current branch name, or "HEAD" when detached. Read-only metadata probe. */
export async function branchName(repo: string): Promise<string> {
  return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export async function headCommit(repo: string): Promise<string> {
  return git(repo, ['rev-parse', 'HEAD']);
}

/** A file's exact bytes at a commit (no trimming), or null when it is not there. */
export async function fileAtCommit(repo: string, commit: string, rel: string): Promise<string | null> {
  const res = await execa('git', ['show', `${commit}:${rel.split(path.sep).join('/')}`], { cwd: repo, reject: false, stripFinalNewline: false });
  return res.exitCode === 0 ? String(res.stdout) : null;
}

/** Count of uncommitted paths (staged, unstaged, and untracked). */
export async function uncommittedCount(repo: string): Promise<number> {
  const status = await git(repo, ['status', '--porcelain']);
  return status ? status.split('\n').length : 0;
}

export async function commitAll(repo: string, message: string): Promise<string> {
  if (ownershipFor(repo)) return commitOwned(repo, message);
  await ensureIgnored(repo, GIT_ADD_EXCLUDES);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

export async function changedFiles(repo: string, sinceHead: string): Promise<string[]> {
  const tracked = await git(repo, ['diff', '--name-only', sinceHead]);
  const untracked = await git(repo, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')])].filter(Boolean);
}

/** Commit only bytes authored by the active run; retain the caller's index. */
async function commitOwned(repo: string, message: string): Promise<string> {
  const run = ownershipFor(repo)!;
  await assertOwnedTree(repo, false);
  await ensureIgnored(repo, GIT_ADD_EXCLUDES);
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-commit-index-'));
  const index = path.join(dir, 'index');
  try {
    await gitWithIndex(repo, index, ['read-tree', run.head]);
    for (const rel of run.owned) {
      if (run.dirtyAtStart.has(rel)) throw new ExternalChangeError(rel + ' had pre-existing changes');
      const expected = run.expected.get(rel);
      if (!expected) {
        await gitWithIndex(repo, index, ['update-index', '--force-remove', '--', rel]);
        continue;
      }
      const data = await readFile(path.join(repo, rel));
      if (createHash('sha256').update(data).digest('hex') !== expected.hash) throw new ExternalChangeError(rel);
      const { stdout: blob } = await execa('git', ['hash-object', '-w', `--path=${rel}`, '--stdin'], { cwd: repo, input: data });
      await gitWithIndex(repo, index, ['update-index', '--add', '--cacheinfo', String(expected.mode.toString(8)), blob.trim(), rel]);
    }
    await assertOwnedTree(repo, false);
    const staged = await gitWithIndex(repo, index, ['diff', '--cached', '--name-only', '-z']);
    if (!staged) return run.head;
    // Build the commit without moving HEAD, then publish it with an expected
    // parent. A normal `git commit` could adopt an external HEAD that moved
    // after our check and commit the old tree over that person's new commit.
    const messageFile = path.join(dir, 'message');
    await writeFile(messageFile, message + '\n', 'utf8');
    const hook = async (name: string, args: string[] = []): Promise<void> => {
      await gitWithIndex(repo, index, ['hook', 'run', '--ignore-missing', name, ...(args.length ? ['--', ...args] : [])]);
    };
    const tree = await gitWithIndex(repo, index, ['write-tree']);
    await hook('pre-commit');
    await hook('prepare-commit-msg', [messageFile, 'message']);
    await hook('commit-msg', [messageFile]);
    await assertOwnedTree(repo, false);
    if (await gitWithIndex(repo, index, ['write-tree']) !== tree) {
      throw new ExternalChangeError('a commit hook changed the staged tree');
    }
    const sign = await execa('git', ['config', '--bool', 'commit.gpgsign'], { cwd: repo, reject: false });
    const head = await gitWithIndex(repo, index, ['commit-tree', tree, '-p', run.head, ...(sign.stdout.trim() === 'true' ? ['-S'] : []), '-F', messageFile]);
    await assertOwnedTree(repo, false);
    await git(repo, ['update-ref', '-m', `commit: ${message.split('\n')[0]}`, run.headRef, head, run.head]);
    if ((await git(repo, ['rev-parse', '--symbolic-full-name', 'HEAD'])) !== run.headRef || await headCommit(repo) !== head) {
      throw new ExternalChangeError('HEAD changed during commit; run commit retained');
    }
    // Do not refresh/adopt unrelated external file changes after committing.
    // Reset only committed paths in the real index, retaining pre-existing stages.
    if (await git(repo, ['ls-files', '--stage', '-z']) !== run.index.trim()) {
      throw new ExternalChangeError('Git index changed during commit; commit retained');
    }
    const paths = staged.split('\0').filter(Boolean);
    await git(repo, ['reset', '-q', head, '--', ...paths]);
    run.head = head;
    run.index = (await execa('git', ['ls-files', '--stage', '-z'], { cwd: repo, stripFinalNewline: false })).stdout;
    try { await hook('post-commit'); } catch (err) {
      console.warn(`warning: post-commit hook failed after ${head}: ${(err as Error).message}`);
    }
    return head;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function applyOwnedFailedRun(repo: string, ref: string, marker: string): Promise<AppliedRun> {
  const snap = await snapshot(repo);
  const files: string[] = [];
  try {
    await assertOwnedTree(repo);
    const { stdout: changed } = await execa('git', ['diff', '--name-only', '-z', `${ref}^`, ref], { cwd: repo, stripFinalNewline: false });
    for (const rel of changed.split('\0').filter(Boolean)) {
      if (rel === '.copperhead/runs' || rel.startsWith('.copperhead/runs/')) continue;
      const owner = ownershipFor(repo)!;
      if (owner.dirtyAtStart.has(rel) && !owner.owned.has(rel)) throw new ExternalChangeError(rel + ' has pre-existing changes');
      const { stdout: entry } = await execa('git', ['ls-tree', ref, '--', rel], { cwd: repo, env: { GIT_LITERAL_PATHSPECS: '1' } });
      if (entry) {
        if (!entry.startsWith('100644 ') && !entry.startsWith('100755 ')) throw new ExternalChangeError(rel + ' is not a regular file');
        const { stdout: bytes } = await execa('git', ['show', `${ref}:${rel}`], { cwd: repo, encoding: 'buffer', stripFinalNewline: false });
        const file = path.join(repo, rel);
        const existing = await readFile(file).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return null;
          throw err;
        });
        if (existing?.equals(bytes)) continue;
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, bytes);
      } else if (owner.expected.has(rel)) {
        await ownedUnlink(path.join(repo, rel));
      } else continue;
      files.push(rel);
    }
    await git(repo, ['stash', 'drop', ref]);
    return { ok: true, files };
  } catch (err) {
    try { await restore(repo, snap); } catch { /* leave external work for inspection */ }
    return { ok: false, files, error: `stash entry "${marker}" could not be applied: ${(err as Error).message}` };
  }
}
