import { execa } from 'execa';
import { access, constants, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const { stdout } = await execa('git', args, { cwd: repo });
  return stdout.trim();
}

/** Same as git(), with a scratch index so the repo's real index is untouched. */
async function gitWithIndex(repo: string, indexFile: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, {
    cwd: repo,
    env: { GIT_INDEX_FILE: indexFile },
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
      env: { GIT_INDEX_FILE: indexFile },
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
  return { head, stash, untracked };
}

/**
 * Hard-restore the working tree to a snapshot (AC-3.6). The run audit trail
 * (.copperhead/runs/) survives rollback: it is the evidence of what failed.
 */
export async function restore(repo: string, snap: GitSnapshot): Promise<void> {
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
    await ensureIgnored(repo, GIT_ADD_EXCLUDES);
    // Never leave the audit trail staged: a staged-but-not-in-HEAD path is
    // deleted by restore()'s `reset --hard`, which silently defeats its
    // `clean -e .copperhead/runs` protection (that flag only spares untracked
    // files) — the in-flight run's transcript dir vanishes mid-run. Staging
    // then unstaging (rather than an exclude pathspec) because `git add`
    // errors outright when a pathspec touches gitignored paths, and runs/ is
    // gitignored in some target repos but tracked in others.
    await git(repo, ['add', '-A']);
    await git(repo, ['reset', '-q', '--', '.copperhead/runs']);
    const sha = await git(repo, ['stash', 'create']);
    if (!sha) return null;
    await git(repo, ['stash', 'store', '-m', `copperhead failed run ${runId}`, sha]);
    return sha;
  } catch {
    return null;
  }
}

/** Current branch name, or "HEAD" when detached. Read-only metadata probe. */
export async function branchName(repo: string): Promise<string> {
  return git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export async function headCommit(repo: string): Promise<string> {
  return git(repo, ['rev-parse', 'HEAD']);
}

/** Count of uncommitted paths (staged, unstaged, and untracked). */
export async function uncommittedCount(repo: string): Promise<number> {
  const status = await git(repo, ['status', '--porcelain']);
  return status ? status.split('\n').length : 0;
}

export async function commitAll(repo: string, message: string): Promise<string> {
  await ensureIgnored(repo, GIT_ADD_EXCLUDES);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '--no-verify', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

export async function changedFiles(repo: string, sinceHead: string): Promise<string[]> {
  const tracked = await git(repo, ['diff', '--name-only', sinceHead]);
  const untracked = await git(repo, ['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')])].filter(Boolean);
}
