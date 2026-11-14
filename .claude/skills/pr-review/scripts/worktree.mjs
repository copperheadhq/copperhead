#!/usr/bin/env node
// Isolated review worktree for the pr-review skill. Reviewing a PR must never
// touch the checkout the user is working in: no branch switch, no stash, no
// dirty tree. This script parks the PR head in a detached `git worktree` under
// the OS temp dir instead, so `gh pr checkout` is never needed.
//
// Usage:
//   node .claude/skills/pr-review/scripts/worktree.mjs setup <pr-number> [--install]
//   node .claude/skills/pr-review/scripts/worktree.mjs path <pr-number>
//   node .claude/skills/pr-review/scripts/worktree.mjs cleanup <pr-number>
//   node .claude/skills/pr-review/scripts/worktree.mjs cleanup --all
//
// Flags:
//   --install   run a real `npm ci` in the worktree instead of symlinking the
//               main checkout's node_modules (needed when the PR changes deps)
//
// setup prints `worktree: <path>` as its last line; feed that path to
// metrics.mjs --dir and read the PR's code from there.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

// finite timeout so a hung subprocess (git fetch, npm ci) cannot block forever
const EXEC_OPTS = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 };

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { ...EXEC_OPTS, ...opts });
}

function tryRun(cmd, args, opts = {}) {
  try {
    // probe commands are expected to fail sometimes: keep their stderr quiet
    return run(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch {
    return null;
  }
}

const notes = [];
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const exists = (p) => {
  try {
    lstatSync(p); // lstat, so a dangling symlink still counts as present
    return true;
  } catch {
    return false;
  }
};

// ---------- argument parsing ----------

const argv = process.argv.slice(2);
const command = argv.shift();
let prNumber = null;
let all = false;
let install = false;

for (const a of argv) {
  if (a === '--all') all = true;
  else if (a === '--install') install = true;
  else if (/^\d+$/.test(a)) prNumber = a;
  else {
    console.error(`unknown argument: ${a}`);
    process.exit(2);
  }
}

const USAGE = 'usage: worktree.mjs setup <pr-number> [--install] | path <pr-number> | cleanup <pr-number> | cleanup --all';
if (!['setup', 'path', 'cleanup'].includes(command)) {
  console.error(USAGE);
  process.exit(2);
}
if (!prNumber && !(command === 'cleanup' && all)) {
  console.error(USAGE);
  process.exit(2);
}

// ---------- locate the main checkout ----------

// Resolve the main checkout even when this script is invoked from inside a
// worktree: --git-common-dir points at the shared .git of the primary tree.
const repoRoot = run('git', ['rev-parse', '--show-toplevel']).trim();
let mainRoot = repoRoot;
const commonDir = tryRun('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']);
if (commonDir && basename(commonDir.trim()) === '.git') mainRoot = dirname(commonDir.trim());

// One base dir per clone, so two checkouts of the same repo never collide.
// The name must NOT start with `copperhead-`: sweepStaleTempDirs (src/util/tmp.ts)
// recursively removes `$TMPDIR/copperhead-*` dirs past a staleness cutoff, and the
// suite exercises it against the real temp dir with a 60s cutoff, which would
// delete the review worktree out from under the very run measuring it.
const baseDir = join(tmpdir(), 'pr-review-worktrees', `${basename(mainRoot)}-${createHash('sha1').update(real(mainRoot)).digest('hex').slice(0, 8)}`);
const worktreePath = (n) => join(baseDir, `pr-${n}`);
const prRef = (n) => `refs/pr-review/${n}`;

function listWorktrees() {
  const out = run('git', ['worktree', 'list', '--porcelain'], { cwd: mainRoot });
  const res = [];
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), head: null };
      res.push(cur);
    } else if (line.startsWith('HEAD ') && cur) {
      cur.head = line.slice('HEAD '.length);
    }
  }
  return res;
}

const findWorktree = (dir) => listWorktrees().find((w) => real(w.path) === real(dir));

// ---------- commands ----------

function removeWorktree(dir) {
  if (findWorktree(dir)) tryRun('git', ['worktree', 'remove', '--force', dir], { cwd: mainRoot, stdio: 'ignore' });
  // node_modules is a symlink into the main checkout: unlink it, never recurse through it
  const modules = join(dir, 'node_modules');
  if (exists(modules) && lstatSync(modules).isSymbolicLink()) unlinkSync(modules);
  rmSync(dir, { recursive: true, force: true });
  tryRun('git', ['worktree', 'prune'], { cwd: mainRoot, stdio: 'ignore' });
}

function cleanup() {
  const targets = all
    ? listWorktrees()
        .map((w) => w.path)
        .filter((p) => real(p).startsWith(real(baseDir)))
    : [worktreePath(prNumber)];
  const removed = [];
  for (const w of targets) {
    if (findWorktree(w) || existsSync(w)) removed.push(w);
    removeWorktree(w);
  }
  // `git worktree remove` only knows registered trees, so a directory left
  // behind by an interrupted run needs the base dir swept as well
  if (all && existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
  else {
    try {
      rmdirSync(baseDir); // succeeds only once the last review worktree is gone
    } catch {
      // other reviews still parked here, or it never existed
    }
  }
  console.log(removed.length ? `removed: ${removed.join(', ')}` : `removed: nothing${all ? '' : ` (no review worktree for PR #${prNumber})`}`);

  const refs = (tryRun('git', ['for-each-ref', '--format=%(refname)', 'refs/pr-review/'], { cwd: mainRoot }) ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((r) => all || r === prRef(prNumber));
  for (const r of refs) tryRun('git', ['update-ref', '-d', r], { cwd: mainRoot, stdio: 'ignore' });
  if (refs.length) console.log(`deleted refs: ${refs.join(', ')}`);
}

function setup() {
  const dir = worktreePath(prNumber);

  const metaRaw = tryRun('gh', ['pr', 'view', prNumber, '--json', 'number,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft']);
  if (!metaRaw) {
    console.error(`cannot read PR #${prNumber} (is the gh CLI authenticated for this repo?)`);
    process.exit(1);
  }
  const meta = JSON.parse(metaRaw);

  // refs/pull/<n>/head resolves for fork PRs too, and fetching it into a
  // private ref namespace never moves any branch the user has checked out.
  if (tryRun('git', ['fetch', '--quiet', '--force', 'origin', `+refs/pull/${prNumber}/head:${prRef(prNumber)}`], { cwd: mainRoot }) === null) {
    notes.push(`could not fetch refs/pull/${prNumber}/head from origin; falling back to whatever ${prRef(prNumber)} already points at`);
  }
  const resolved = tryRun('git', ['rev-parse', '--verify', `${prRef(prNumber)}^{commit}`], { cwd: mainRoot });
  const sha = (resolved ?? '').trim() || meta.headRefOid;
  if (!sha) {
    console.error(`cannot resolve the head commit of PR #${prNumber}`);
    process.exit(1);
  }
  if (meta.headRefOid && sha !== meta.headRefOid) {
    notes.push(`fetched ${sha.slice(0, 12)} but the PR head is ${meta.headRefOid.slice(0, 12)}; the fetch is stale, re-run setup`);
  }

  tryRun('git', ['worktree', 'prune'], { cwd: mainRoot, stdio: 'ignore' });
  const existing = findWorktree(dir);
  if (existing) {
    const dirty = (tryRun('git', ['status', '--porcelain'], { cwd: dir }) ?? '').trim();
    if (existing.head === sha) {
      notes.push('reused the existing review worktree (already at the PR head)');
    } else if (dirty) {
      notes.push(`the existing review worktree is at ${(existing.head ?? '?').slice(0, 12)} and has local modifications: left untouched, run cleanup ${prNumber} to discard it`);
    } else {
      run('git', ['checkout', '--detach', '--force', sha], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
      notes.push(`updated the existing review worktree from ${(existing.head ?? '?').slice(0, 12)} to the PR head`);
    }
  } else {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); // leftover from an interrupted run
    mkdirSync(baseDir, { recursive: true });
    try {
      run('git', ['worktree', 'add', '--detach', dir, sha], { cwd: mainRoot, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      console.error(`git worktree add failed: ${(e.stderr || e.message || '').toString().split('\n')[0]}`);
      process.exit(1);
    }
  }

  // Dependencies: symlink by default (fast, and the review needs no writes),
  // real install only when asked, because the PR changed what is installed.
  const modules = join(dir, 'node_modules');
  const mainModules = join(mainRoot, 'node_modules');
  if (install) {
    if (exists(modules) && lstatSync(modules).isSymbolicLink()) unlinkSync(modules);
    try {
      run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
      notes.push('ran npm ci in the worktree (its own node_modules, isolated from the main checkout)');
    } catch (e) {
      // surface npm's own last line: "it failed" alone is not actionable
      const why = (e.stderr || e.message || '').toString().trim().split('\n').filter(Boolean).slice(-1)[0] ?? 'no output';
      notes.push(`npm ci failed in the worktree, so tests and coverage will not run there: ${why}`);
    }
  } else if (!exists(modules)) {
    if (existsSync(mainModules)) {
      symlinkSync(mainModules, modules, 'dir');
      notes.push('node_modules symlinked from the main checkout (read-only use; nothing is installed into it)');
    } else {
      notes.push('no node_modules in the main checkout: run setup again with --install, or the suite cannot run');
    }
  }
  if (!install && existsSync(mainModules)) {
    const lockHead = tryRun('git', ['show', `${sha}:package-lock.json`], { cwd: mainRoot });
    const lockMain = existsSync(join(mainRoot, 'package-lock.json')) ? readFileSync(join(mainRoot, 'package-lock.json'), 'utf8') : null;
    if (lockHead && lockMain && lockHead !== lockMain) {
      notes.push('the PR changes package-lock.json, so the symlinked node_modules is not the PR\'s dependency set: re-run setup with --install before trusting the suite result');
    }
  }

  // .env is deliberately not copied: secrets stay in the main checkout, and the
  // review path (check/verify, offline suite) is contractually key-free.
  console.log(`pr: #${meta.number} ${meta.headRefName} -> ${meta.baseRefName}${meta.isCrossRepository ? ' (fork)' : ''}${meta.isDraft ? ' (draft)' : ''}`);
  console.log(`head: ${sha}`);
  for (const n of notes) console.log(`note: ${n}`);
  console.log(`main checkout untouched: ${mainRoot} stays on its current branch`);
  console.log(`worktree: ${dir}`);
}

if (command === 'setup') setup();
else if (command === 'cleanup') cleanup();
else {
  const dir = worktreePath(prNumber);
  if (!findWorktree(dir)) {
    console.error(`no review worktree for PR #${prNumber} (run: worktree.mjs setup ${prNumber})`);
    process.exit(1);
  }
  console.log(dir);
}
