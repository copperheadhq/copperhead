# Review worktree reference

Reviewing a PR is read-only work, so it must leave the user's checkout exactly as it found it. `gh pr checkout` does the opposite: it moves HEAD, can refuse (or stash) over uncommitted work, and leaves the user on someone else's branch when the review ends. `scripts/worktree.mjs` replaces it with a detached `git worktree` that shares the repo's object store but has its own working directory.

## Commands

```bash
node .claude/skills/pr-review/scripts/worktree.mjs setup <n>             # create or refresh, prints "worktree: <path>"
node .claude/skills/pr-review/scripts/worktree.mjs setup <n> --install   # real npm ci instead of the node_modules symlink
node .claude/skills/pr-review/scripts/worktree.mjs path <n>              # print the path of an existing worktree
node .claude/skills/pr-review/scripts/worktree.mjs cleanup <n>           # remove it and delete refs/pr-review/<n>
node .claude/skills/pr-review/scripts/worktree.mjs cleanup --all         # sweep every leftover for this clone
```

## What setup does

1. Reads the PR with `gh pr view` (head branch, head OID, base, fork and draft flags).
2. Fetches `+refs/pull/<n>/head:refs/pr-review/<n>`. That ref form resolves for fork PRs as well as same-repo ones, and the private `refs/pr-review/` namespace means no branch the user has (or could check out) is ever moved. A fetched OID that disagrees with the PR's head OID is reported as a stale fetch.
3. Adds a detached worktree at that commit under `$TMPDIR/pr-review-worktrees/<repo>-<hash-of-path>/pr-<n>`. Detached on purpose: a worktree cannot check out a branch that is already checked out elsewhere, and detaching sidesteps that entirely. The path is derived from the main checkout's real path, so two clones of the same repo do not collide. The `pr-review-worktrees` name is load-bearing: `sweepStaleTempDirs` in [tmp.ts](src/util/tmp.ts) recursively removes `$TMPDIR/copperhead-*` past a staleness cutoff, and `tmp-sweep.test.ts` runs it against the real temp dir with a 60s cutoff, so a `copperhead-`-prefixed worktree gets deleted by the very suite run it is hosting.
4. Symlinks `node_modules` from the main checkout, so vitest runs with no install. Nothing is ever installed into it.

Re-running `setup` is safe: an existing worktree at the PR head is reused, a clean one behind the head is fast-forwarded with `git checkout --detach`, and one with local modifications is left alone with a note (discard it with `cleanup <n>` if you want it rebuilt).

## Dependencies

The symlink is the fast path and it is honest for the common case, where the PR does not change dependencies. When the PR does change `package-lock.json`, `setup` says so: re-run with `--install` to give the worktree a real `npm ci`, otherwise the suite result describes the wrong dependency set. `--install` is the slow path, so it is opt-in.

## What deliberately does not carry over

- `.env` and anything else untracked. Secrets stay in the main checkout, and the review path (the offline suite, `check`/`verify`) is contractually key-free, so nothing in a review should need them.
- `.copperhead/runs/`, `dist/`, and other ignored build output: the worktree starts from the committed tree, which is what the PR actually proposes.

## Reporting from the worktree

Findings quote repo-relative paths (`src/agent/loop.ts:42`), never the temp path: the author reads the report against their own checkout. The worktree path belongs in the session narration only, and the metrics script prints the commit and directory it measured so the report can state both.

The skill's own scripts and reference files are read and run from the main checkout, not from the worktree. A PR that edits `.claude/skills/pr-review/` would otherwise review itself with its own modified tooling.
