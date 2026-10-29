import { readdir, stat, rm, mkdtemp, writeFile, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Newest local-history entries to keep when capping `.history/` (see
 *  pruneHistoryDir). Enough to preserve a useful recovery window, bounded enough
 *  that the dir cannot grow without limit across a long run. */
export const DEFAULT_HISTORY_KEEP = 200;

/**
 * Cap the growth of a repo's `.history/` directory (4.1). KiCad (and editor
 * local-history) rewrite a snapshot on every project touch, so across a long
 * run `.history/` grows without bound and was a contributor to the disk-fill
 * halt (I8). It is gitignored, so its contents are disposable: keep the newest
 * `keepNewest` files by mtime and remove the rest. Recursive (local history
 * mirrors the workspace tree), best-effort (every error is swallowed — pruning
 * housekeeping must never fail a run), and a no-op when the dir is absent or
 * already under the cap. Returns the number of files removed.
 */
export async function pruneHistoryDir(repoRoot: string, keepNewest = DEFAULT_HISTORY_KEEP): Promise<number> {
  const root = path.join(repoRoot, '.history');
  const files: Array<{ full: string; mtimeMs: number }> = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip it
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        try {
          const st = await stat(full);
          files.push({ full, mtimeMs: st.mtimeMs });
        } catch {
          // stat race — skip this file
        }
      }
    }
  };
  await walk(root);
  if (files.length <= keepNewest) return 0;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  let removed = 0;
  for (const f of files.slice(keepNewest)) {
    try {
      await rm(f.full, { force: true });
      removed++;
    } catch {
      // permission/race — leave it, keep pruning the rest
    }
  }
  return removed;
}

/**
 * Every scratch dir copperhead makes under the OS temp dir shares this prefix:
 * kicad-cli ERC/DRC (`copperhead-`), the KiCad edit probe (`copperhead-validate-`),
 * the failed-run backup (`copperhead-runs-`), and the provider working dirs
 * (`copperhead-cc-`, `copperhead-codex-`). Each site removes its own dir in a
 * `finally`, but a watchdog SIGKILL of the process tree or a hard abort skips
 * that cleanup, so stale dirs accumulate across runs and can eventually fill the
 * disk (I8). A prefix match lets one sweep reclaim all of them.
 */
export const TEMP_PREFIX = 'copperhead-';

/**
 * Ownership marker filename placed inside every sweepable temporary directory
 * created by Copperhead. Prevents accidental recursive deletion of unrelated
 * directories whose names begin with `copperhead-`.
 */
export const TEMP_OWNERSHIP_MARKER_NAME = '.copperhead-owned-temp';

/**
 * Exact contents of the ownership marker file.
 */
export const TEMP_OWNERSHIP_MARKER_CONTENT = 'copperhead-owned-temp\nv1\n';

/**
 * Create a scratch directory under `root` (defaults to OS tempdir) with the
 * required `copperhead-` prefix, immediately stamped with the ownership marker.
 * If marker creation fails, the newly created directory is cleaned up and the
 * error is re-thrown.
 */
export async function createCopperheadTempDir(
  prefixSuffix = '',
  root = tmpdir(),
): Promise<string> {
  const prefix = prefixSuffix ? `${TEMP_PREFIX}${prefixSuffix}` : TEMP_PREFIX;
  const dir = await mkdtemp(path.join(root, prefix));
  try {
    const markerPath = path.join(dir, TEMP_OWNERSHIP_MARKER_NAME);
    await writeFile(markerPath, TEMP_OWNERSHIP_MARKER_CONTENT, 'utf8');
  } catch (err) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
  return dir;
}

/** Default staleness cutoff for the startup sweep: 2h. Safe even for multi-hour
 * runs (10-min turns × per-stage retries × 8 stages): a live run's only
 * long-lived scratch dir is the provider's reused cwd, which is `utimes`-touched
 * every turn (ClaudeCodeProvider.ensureCwd), so its mtime never goes stale while
 * the process is alive; per-call kicad-cli dirs are removed within a turn. A dir
 * older than this therefore belongs to a dead run, and the window is short enough
 * that such a leak is reclaimed on the very next invocation. */
export const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * Remove leaked `copperhead-*` scratch dirs left in the OS temp dir by earlier
 * runs whose `finally` cleanup was skipped (watchdog kill / hard abort). Only
 * dirs whose mtime is older than `maxAgeMs` AND that contain the positive
 * ownership marker (`.copperhead-owned-temp`) are removed, so a concurrent run's
 * fresh scratch dirs and unrelated user dirs matching the prefix are never touched.
 * Symlinks are never followed (checked via `lstat`).
 * Best-effort: every error is swallowed (a temp dir we can't stat or remove is
 * not worth failing a run over), and the function returns the paths it removed
 * so a caller can log the reclaim.
 *
 * `now` is injected so the behaviour is deterministically testable; callers pass
 * `Date.now()`. `root` is the OS temp dir; tests pass a private directory, since
 * a sweep with a short cutoff over the shared temp dir deletes the scratch dirs
 * of every other process on the machine (a parallel test file's seeded KiCad
 * config among them).
 */
export async function sweepStaleTempDirs(now: number, maxAgeMs = DEFAULT_STALE_MS, root = tmpdir()): Promise<string[]> {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return removed; // no temp dir / not readable — nothing to sweep
  }
  for (const name of entries) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(root, name);
    try {
      const lst = await lstat(full);
      if (!lst.isDirectory() || lst.isSymbolicLink()) continue;
      if (now - lst.mtimeMs < maxAgeMs) continue; // too fresh: could be a live run

      // Verify positive ownership marker before deletion
      const markerPath = path.join(full, TEMP_OWNERSHIP_MARKER_NAME);
      try {
        const markerStat = await lstat(markerPath);
        if (!markerStat.isFile() || markerStat.isSymbolicLink()) continue;
        if (markerStat.size !== Buffer.byteLength(TEMP_OWNERSHIP_MARKER_CONTENT, 'utf8')) continue;
        const markerContent = await readFile(markerPath, 'utf8');
        if (markerContent !== TEMP_OWNERSHIP_MARKER_CONTENT) continue;
      } catch {
        // Missing marker, unreadable, or not a regular file: not a copperhead-owned scratch dir
        continue;
      }

      await rm(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      // stat/rm race or permission issue — skip this entry, keep sweeping.
    }
  }
  return removed;
}
