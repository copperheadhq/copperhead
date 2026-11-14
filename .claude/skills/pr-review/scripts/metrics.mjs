#!/usr/bin/env node
// Deterministic metrics for the pr-review skill. Computes every number in the
// review's metrics block so the reviewer never re-derives (or guesses) them.
//
// Usage:
//   node .claude/skills/pr-review/scripts/metrics.mjs <pr-number> [flags]
//   node .claude/skills/pr-review/scripts/metrics.mjs --base <ref> [flags]
//
// Flags:
//   --dir <path>    measure in this checkout (the review worktree from
//                   worktree.mjs setup) instead of the current directory, so
//                   the user's working tree is never switched or touched
//   --no-tests      skip the test suite (and therefore coverage)
//   --no-coverage   run the suite but skip diff coverage
//   --base-tests    also run the suite at the merge base, in a temp worktree
//
// Output: a ready-to-paste metrics block, then how each number was obtained,
// then per-file detail and the uncovered changed src lines. Anything that
// could not be measured is reported as "not measured" with the reason.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// finite timeout so a hung subprocess (git fetch, vitest, npm i) cannot block forever
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

function tryRunCapture(cmd, args) {
  // like tryRun, but keeps stdout on nonzero exit (gh pr checks exits nonzero
  // whenever checks are failing or pending, with the JSON still on stdout)
  try {
    return run(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    return typeof e.stdout === 'string' && e.stdout ? e.stdout : null;
  }
}

// ---------- argument parsing ----------

const argv = process.argv.slice(2);
let prNumber = null;
let baseRefArg = null;
let runTests = true;
let runCoverage = true;
let runBaseTests = false;
let dirArg = null;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-tests') runTests = false;
  else if (a === '--no-coverage') runCoverage = false;
  else if (a === '--base-tests') runBaseTests = true;
  else if (a === '--base') baseRefArg = argv[++i];
  else if (a === '--dir') dirArg = argv[++i];
  else if (/^\d+$/.test(a)) prNumber = a;
  else {
    console.error(`unknown argument: ${a}`);
    process.exit(2);
  }
}
if (!prNumber && !baseRefArg) {
  console.error('usage: metrics.mjs <pr-number> | --base <ref>  [--dir <path>] [--no-tests] [--no-coverage] [--base-tests]');
  process.exit(2);
}

// --dir points at the review worktree, so every git command, the suite, and
// coverage run there and the user's own checkout is never entered.
if (dirArg) {
  if (!existsSync(dirArg)) {
    console.error(`--dir ${dirArg} does not exist (run: worktree.mjs setup ${prNumber ?? ''})`);
    process.exit(2);
  }
  process.chdir(dirArg);
}

const repoRoot = run('git', ['rev-parse', '--show-toplevel']).trim();
process.chdir(repoRoot);
const notes = []; // method / caveat lines, printed at the end

// ---------- resolve refs ----------

let baseRef; // branch name, e.g. "main"
let headRefName = null; // PR head branch name, if known
let ghMeta = null;

if (prNumber) {
  ghMeta = JSON.parse(
    run('gh', ['pr', 'view', prNumber, '--json', 'baseRefName,headRefName,additions,deletions,isDraft,mergeable'])
  );
  baseRef = ghMeta.baseRefName;
  headRefName = ghMeta.headRefName;
} else {
  baseRef = baseRefArg;
}

tryRun('git', ['fetch', '--quiet', 'origin', baseRef]);

const checkedOutSha = run('git', ['rev-parse', 'HEAD']).trim();
let headSpec; // rev to diff/measure against
let onHead; // is the head actually checked out here (tests/coverage need this)
if (!headRefName) {
  headSpec = 'HEAD';
  onHead = true;
} else {
  // pull/<n>/head resolves for both same-repo and fork PRs, no checkout needed
  const prRef = `refs/pr-review/${prNumber}`;
  tryRun('git', ['fetch', '--quiet', 'origin', `+pull/${prNumber}/head:${prRef}`]);
  headSpec =
    (tryRun('git', ['rev-parse', '--verify', prRef]) && prRef) ||
    (tryRun('git', ['rev-parse', '--verify', `origin/${headRefName}`]) && `origin/${headRefName}`) ||
    (tryRun('git', ['rev-parse', '--verify', headRefName]) && headRefName);
  if (!headSpec) {
    console.error(`cannot resolve PR head "${headRefName}" locally; run: node .claude/skills/pr-review/scripts/worktree.mjs setup ${prNumber}`);
    process.exit(1);
  }
  // Compare commits, not branch names: the review worktree sits at the PR head
  // detached, so a name comparison would wrongly report it as not checked out.
  const headSha = run('git', ['rev-parse', '--verify', `${headSpec}^{commit}`]).trim();
  onHead = headSha === checkedOutSha;
  if (onHead) headSpec = 'HEAD';
  else notes.push(`PR head not checked out here: diff metrics use ${headSpec}; tests and coverage not run (node .claude/skills/pr-review/scripts/worktree.mjs setup ${prNumber}, then pass --dir <worktree>)`);
}

const baseSpec = tryRun('git', ['rev-parse', '--verify', `origin/${baseRef}`]) ? `origin/${baseRef}` : baseRef;
const mergeBase = run('git', ['merge-base', baseSpec, headSpec]).trim();

// ---------- diff stats ----------

const GENERATED = [/(^|\/)package-lock\.json$/, /(^|\/)dist\//, /\.snap$/, /(^|\/)node_modules\//, /^docs\/\.astro\//];
const isGenerated = (p) => GENERATED.some((re) => re.test(p));

// numstat rename forms: "a/{old => new}/b" or "old => new"
function normalizePath(p) {
  if (p.includes('{')) return p.replace(/\{[^}]* => ([^}]*)\}/g, '$1').replace(/\/\//g, '/');
  const m = p.match(/^(.*) => (.*)$/);
  return m ? m[2] : p;
}

function area(p) {
  if (p.startsWith('src/')) return 'src';
  if (p.startsWith('test/')) return 'test';
  if (p.startsWith('openspec/')) return 'spec';
  if (p.startsWith('docs/') || p.endsWith('.md')) return 'docs';
  return 'other';
}

const numstat = run('git', ['diff', '--numstat', mergeBase, headSpec])
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [a, d, ...rest] = l.split('\t');
    return { added: a === '-' ? 0 : Number(a), removed: d === '-' ? 0 : Number(d), path: normalizePath(rest.join('\t')), binary: a === '-' };
  });

const areas = { src: { a: 0, d: 0 }, test: { a: 0, d: 0 }, docs: { a: 0, d: 0 }, spec: { a: 0, d: 0 }, other: { a: 0, d: 0 } };
const gen = { files: 0, a: 0, d: 0 };
let totA = 0;
let totD = 0;
for (const f of numstat) {
  totA += f.added;
  totD += f.removed;
  if (isGenerated(f.path)) {
    gen.files++;
    gen.a += f.added;
    gen.d += f.removed;
    continue;
  }
  const k = areas[area(f.path)];
  k.a += f.added;
  k.d += f.removed;
}

const addedFiles = run('git', ['diff', '--name-status', '--diff-filter=A', mergeBase, headSpec])
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => normalizePath(l.split('\t').slice(1).join('\t')));
const addedSrcFiles = addedFiles.filter((p) => area(p) === 'src' && !isGenerated(p));
const newSrcLines = numstat.filter((f) => addedSrcFiles.includes(f.path)).reduce((s, f) => s + f.added, 0);
const modifiedSrcFiles = numstat.filter((f) => area(f.path) === 'src' && !isGenerated(f.path) && !addedSrcFiles.includes(f.path));

// changed (added) line numbers per src file, from zero-context hunks
const changedSrcLines = new Map(); // path -> Set<line>
{
  const diff = run('git', ['diff', '-U0', mergeBase, headSpec, '--', 'src/']);
  let file = null;
  for (const line of diff.split('\n')) {
    const f = line.match(/^\+\+\+ b\/(.*)$/);
    if (f) {
      file = f[1];
      continue;
    }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && file && !isGenerated(file)) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      if (!changedSrcLines.has(file)) changedSrcLines.set(file, new Set());
      const set = changedSrcLines.get(file);
      for (let i = 0; i < count; i++) set.add(start + i);
    }
  }
}
const totalChangedSrcLines = [...changedSrcLines.values()].reduce((s, v) => s + v.size, 0);

// ---------- deps ----------

const pkgJsonChanged = numstat.some((f) => f.path === 'package.json');
let depsLine = null;
if (pkgJsonChanged) {
  const readDeps = (rev) => {
    const raw = tryRun('git', ['show', `${rev}:package.json`]);
    if (!raw) return null;
    const pkg = JSON.parse(raw);
    return { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  };
  const before = readDeps(mergeBase);
  const after = readDeps(headSpec);
  if (before && after) {
    const addedDeps = Object.keys(after).filter((k) => !(k in before));
    const removedDeps = Object.keys(before).filter((k) => !(k in after));
    const changedDeps = Object.keys(after)
      .filter((k) => k in before && before[k] !== after[k])
      .map((k) => `${k} ${before[k]} -> ${after[k]}`);
    depsLine = `deps: +[${addedDeps.join(', ') || 'none'}] -[${removedDeps.join(', ') || 'none'}] ~[${changedDeps.join(', ') || 'none'}] (package.json changed; run npm audit on base and head for the advisory delta)`;
  }
}

// ---------- ci checks ----------

let ciLine = null;
if (prNumber) {
  const buckets = (raw) => {
    if (!raw) return null;
    try {
      const c = { pass: 0, fail: 0, pending: 0, other: 0 };
      for (const { bucket } of JSON.parse(raw)) {
        if (bucket === 'pass') c.pass++;
        else if (bucket === 'fail' || bucket === 'cancel') c.fail++;
        else if (bucket === 'pending') c.pending++;
        else c.other++;
      }
      return c;
    } catch {
      return null;
    }
  };
  const all = buckets(tryRunCapture('gh', ['pr', 'checks', prNumber, '--json', 'bucket']));
  const req = buckets(tryRunCapture('gh', ['pr', 'checks', prNumber, '--required', '--json', 'bucket']));
  if (all) {
    ciLine =
      `ci: ${all.pass} pass / ${all.fail} fail / ${all.pending} pending` +
      (all.other ? ` / ${all.other} other` : '') +
      (req ? `; required checks: ${req.fail} failing, ${req.pending} pending` : '; required checks: none reported') +
      ' (gh pr checks)';
  } else {
    notes.push('ci: not measured (gh pr checks returned no parseable JSON; check CI state manually)');
  }
}

// ---------- test suite + coverage ----------

function parseVitestJson(path) {
  const r = JSON.parse(readFileSync(path, 'utf8'));
  const skipped = (r.numPendingTests ?? 0) + (r.numTodoTests ?? 0);
  return { pass: r.numPassedTests ?? 0, skip: skipped, fail: r.numFailedTests ?? 0, total: r.numTotalTests ?? 0 };
}

function runSuite(cwd, withCoverage, covDir) {
  const out = join(mkdtempSync(join(tmpdir(), 'pr-metrics-')), 'results.json');
  const args = ['vitest', 'run', '--reporter=json', `--outputFile=${out}`];
  if (withCoverage) {
    args.push(
      '--coverage.enabled',
      '--coverage.provider=v8',
      '--coverage.all',
      '--coverage.reporter=json',
      `--coverage.reportsDirectory=${covDir}`,
      '--coverage.include=src/**'
    );
  }
  tryRun('npx', args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] }); // nonzero exit on failing tests is fine
  return existsSync(out) ? parseVitestJson(out) : null;
}

let headSuite = null;
let baseSuite = null;
let coverage = null; // { pct, executable, covered, uncovered: Map<file, lines[]> }

if (runTests && onHead) {
  let covDir = null;
  let doCov = runCoverage && totalChangedSrcLines > 0;
  if (runCoverage && totalChangedSrcLines === 0) notes.push('diff coverage: skipped, no changed src lines');
  if (doCov) {
    const req = createRequire(join(repoRoot, 'package.json'));
    try {
      req.resolve('@vitest/coverage-v8');
    } catch {
      if (tryRun('npm', ['i', '-D', '--no-save', '@vitest/coverage-v8'], { stdio: 'ignore' }) === null) {
        notes.push('diff coverage: not measured (could not install @vitest/coverage-v8)');
        doCov = false;
      } else {
        notes.push('installed @vitest/coverage-v8 with --no-save (not persisted to package.json)');
      }
    }
  }
  if (doCov) covDir = mkdtempSync(join(tmpdir(), 'pr-cov-'));

  headSuite = runSuite(repoRoot, doCov, covDir);
  if (!headSuite) notes.push('head suite: not measured (vitest produced no JSON results)');

  if (doCov) {
    const covPath = join(covDir, 'coverage-final.json');
    if (existsSync(covPath)) {
      const cov = JSON.parse(readFileSync(covPath, 'utf8'));
      const byPath = new Map(Object.entries(cov)); // absolute path -> file coverage
      let executable = 0;
      let covered = 0;
      const uncovered = new Map();
      for (const [file, lines] of changedSrcLines) {
        const entry = byPath.get(join(repoRoot, file));
        if (!entry) {
          // file has no coverage data at all: count every changed line as uncovered
          executable += lines.size;
          uncovered.set(file, [...lines].sort((x, y) => x - y));
          notes.push(`${file}: absent from coverage data, all its changed lines counted uncovered`);
          continue;
        }
        const execLines = new Map(); // line -> hit?
        for (const [k, loc] of Object.entries(entry.statementMap)) {
          const line = loc.start.line;
          const hit = (entry.s[k] ?? 0) > 0;
          execLines.set(line, (execLines.get(line) ?? false) || hit);
        }
        const miss = [];
        for (const line of lines) {
          if (!execLines.has(line)) continue; // not executable (comment, type, blank)
          executable++;
          if (execLines.get(line)) covered++;
          else miss.push(line);
        }
        if (miss.length) uncovered.set(file, miss.sort((x, y) => x - y));
      }
      coverage = { executable, covered, pct: executable ? Math.round((covered / executable) * 1000) / 10 : null, uncovered };
    } else {
      notes.push('diff coverage: not measured (coverage-final.json missing)');
    }
  }
} else if (runTests && !onHead) {
  notes.push('head suite and coverage: not measured (PR head not checked out here; set up the review worktree and pass --dir)');
} else {
  notes.push('head suite and coverage: skipped (--no-tests)');
}

if (runBaseTests && onHead) {
  const wt = mkdtempSync(join(tmpdir(), 'pr-base-'));
  try {
    run('git', ['worktree', 'add', '--detach', wt, mergeBase], { stdio: 'ignore' });
    // repoRoot may itself be the review worktree, whose node_modules is a
    // symlink into the main checkout: linking to a link resolves the same way
    if (existsSync(join(repoRoot, 'node_modules'))) symlinkSync(join(repoRoot, 'node_modules'), join(wt, 'node_modules'), 'dir');
    else notes.push('base suite: no node_modules to link into the base worktree');
    baseSuite = runSuite(wt, false, null);
    if (!baseSuite) notes.push('base suite: not measured (vitest produced no JSON results in the worktree)');
    if (baseSuite && pkgJsonChanged)
      notes.push('base suite: ran against the head node_modules (symlinked), but package.json changed since the merge base, so this is not a clean dependency baseline');
  } catch (e) {
    notes.push(`base suite: not measured (worktree run failed: ${e.message?.split('\n')[0]})`);
  } finally {
    tryRun('git', ['worktree', 'remove', '--force', wt], { stdio: 'ignore' });
    // never recurse into the symlinked node_modules while deleting the worktree
    const linked = join(wt, 'node_modules');
    if (existsSync(linked) && lstatSync(linked).isSymbolicLink()) rmSync(linked, { force: true });
    rmSync(wt, { recursive: true, force: true });
  }
} else if (runBaseTests) {
  notes.push('base suite: not run (PR head not checked out here)');
} else {
  notes.push('base suite: not run (pass --base-tests to run it in a temp worktree, or read base CI)');
}

// ---------- output ----------

const compress = (lines) => {
  const out = [];
  let s = lines[0];
  let p = lines[0];
  for (const l of lines.slice(1)) {
    if (l === p + 1) {
      p = l;
      continue;
    }
    out.push(s === p ? `${s}` : `${s}-${p}`);
    s = p = l;
  }
  out.push(s === p ? `${s}` : `${s}-${p}`);
  return out.join(',');
};

const suiteStr = (r) => (r ? `${r.pass}/${r.skip}/${r.fail}` : 'not measured');
const testLines = areas.test.a;

const block = [];
block.push(
  `lines: +${totA} / -${totD} (net ${totA - totD}) across ${numstat.length} files  ·  src +${areas.src.a}/-${areas.src.d}, test +${areas.test.a}/-${areas.test.d}, docs +${areas.docs.a}/-${areas.docs.d}, spec +${areas.spec.a}/-${areas.spec.d}, other +${areas.other.a}/-${areas.other.d}`
);
if (gen.files) block.push(`generated (excluded from areas): ${gen.files} file(s), +${gen.a}/-${gen.d}`);
block.push(`new vs net: ${addedFiles.length} new files (${addedSrcFiles.length} in src), ${numstat.length - addedFiles.length} modified; ${newSrcLines} new src lines (the net-new surface)`);
block.push(`tests: +${testLines} test lines; suite ${suiteStr(baseSuite)} -> ${suiteStr(headSuite)} (pass/skip/fail, base -> head)`);
if (coverage && coverage.executable === 0) {
  block.push('diff coverage: 0 executable changed src lines measured (every changed src line is a comment, type, or blank; measured via vitest v8)');
} else if (coverage) {
  const unc = [...coverage.uncovered.entries()].map(([f, ls]) => `${f}:${compress(ls)}`);
  block.push(
    `diff coverage: ${coverage.pct}% of changed executable src lines exercised (${coverage.covered}/${coverage.executable}, measured via vitest v8)` +
      (unc.length ? `; uncovered: ${unc.slice(0, 40).join(', ')}${unc.length > 40 ? `, +${unc.length - 40} more files (full list below)` : ''}` : '')
  );
} else {
  block.push('diff coverage: not measured (see notes)');
}
if (depsLine) block.push(depsLine);
if (ciLine) block.push(ciLine);

console.log('== metrics block ==');
console.log(block.join('\n'));

console.log('\n== method ==');
console.log(`measured in: ${repoRoot}${dirArg ? ' (review worktree; the user\'s checkout was not entered)' : ''}`);
console.log(`merge base: ${mergeBase} (git merge-base ${baseSpec} ${headSpec})`);
console.log('areas: git diff --numstat against the merge base, classified src/ test/ openspec/ docs+*.md/ other; generated files excluded');
console.log('suite: npx vitest run --reporter=json; coverage: vitest --coverage.provider=v8 intersected with the changed src lines from git diff -U0');
if (ghMeta) console.log(`pr: mergeable=${ghMeta.mergeable} draft=${ghMeta.isDraft} (gh pr view); gh totals +${ghMeta.additions}/-${ghMeta.deletions} include generated files`);
for (const n of notes) console.log(`note: ${n}`);

if (addedSrcFiles.length || modifiedSrcFiles.length) {
  console.log('\n== src files ==');
  for (const p of addedSrcFiles) {
    const f = numstat.find((x) => x.path === p);
    console.log(`A ${p} +${f?.added ?? 0}`);
  }
  for (const f of modifiedSrcFiles) console.log(`M ${f.path} +${f.added}/-${f.removed}`);
}

if (coverage && coverage.uncovered.size) {
  console.log('\n== uncovered changed src lines (full list) ==');
  for (const [f, ls] of [...coverage.uncovered.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    console.log(`${f}: ${compress(ls)}`);
  }
}
console.log(`\nchanged src lines total: ${totalChangedSrcLines} (fan-out threshold input: src +${areas.src.a}/-${areas.src.d})`);
