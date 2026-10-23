import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { runInit } from '../src/memory/scaffold.js';
import { saveConstraint, loadConstraints } from '../src/memory/constraints.js';
import { syncVerify, syncResolve } from '../src/commands/sync.js';
import { runCheck } from '../src/commands/check.js';
import type { Provider, Turn } from '../src/agent/types.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * `copperhead sync` end to end (AC-7, build-copperhead-phase-1 task 10.5).
 * gating-sync covers the verify phase in isolation; this file covers what the
 * command does with it: the clean no-op and its idempotence, the refusal on a
 * requirement violation, and the resolve phase landing a fix for each kind of
 * resolvable drift. The resolve runs use a scripted provider through
 * syncResolve's test seam, so no model and no network are involved: the script
 * plays the tool calls a model would, and the real gates, ledger and commit
 * path decide whether the run lands.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const git = async (repo: string, args: string[]): Promise<string> => (await execa('git', args, { cwd: repo })).stdout;

/** An initialized fixture repo, committed, so sync starts from a clean tree. */
async function initializedRepo(): Promise<string> {
  const { repo, cleanup } = await tempFixtureRepo();
  cleanups.push(cleanup);
  await runInit({ repoRoot: repo, installHooks: false });
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init docs']);
  return repo;
}

async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', message]);
}

/** Every file git would see (tracked, or untracked and not ignored), hashed. */
async function treeHashes(repo: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of (await git(repo, ['ls-files', '-co', '--exclude-standard'])).split('\n').filter(Boolean).sort()) {
    const p = path.join(repo, f);
    out[f] = existsSync(p) ? createHash('sha256').update(await readFile(p)).digest('hex') : '(deleted)';
  }
  return out;
}

/** The real CLI, as a user or CI runs it. */
async function sync(repo: string): Promise<{ exitCode: number; stdout: string }> {
  const res = await execa('npx', ['tsx', 'src/cli.ts', '--repo', repo, 'sync'], {
    cwd: ROOT,
    reject: false,
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { exitCode: res.exitCode ?? -1, stdout: res.stdout };
}

/** Plays each turn in order, repeating the last one. */
function scriptedProvider(turns: Partial<Turn>[]): Provider {
  let i = 0;
  return {
    name: 'scripted',
    async chat(): Promise<Turn> {
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      return {
        text: t.text ?? null,
        toolCalls: (t.toolCalls ?? []).map((c, j) => ({ ...c, id: `call-${i}-${j}` })),
        usage: t.usage ?? { inputTokens: 100, outputTokens: 10 },
      };
    },
  };
}

/** The spec gate a resolve run passes before it may edit (invariant 1). */
const unlock: Partial<Turn> = {
  toolCalls: [
    { name: 'propose_change', args: { id: 'sync-resolve', why: 'resolve sync drift', what_changes: '- fix the docs', tasks: '- [ ] fix' } },
    { name: 'validate_change', args: {} },
  ],
};
const finish: Partial<Turn> = { toolCalls: [{ name: 'finish', args: { outcome: 'done', summary: 'drift resolved' } }] };

/** Run the resolve phase on the repo's current report with a scripted provider. */
async function resolveWith(repo: string, turns: Partial<Turn>[]): Promise<{ ok: boolean; summary: string; commits: number; files: string[] }> {
  const before = Number(await git(repo, ['rev-list', '--count', 'HEAD']));
  const report = await syncVerify(repo);
  expect(report.violations).toEqual([]);
  expect(report.resolvable.length, 'the fixture must have drift to resolve').toBeGreaterThan(0);
  const { ok, run } = await syncResolve(repo, report, 'gpt-5', () => {}, { provider: scriptedProvider(turns) });
  const files = (await git(repo, ['show', '--name-only', '--format=', 'HEAD'])).split('\n').filter(Boolean);
  return { ok, summary: run.summary, commits: Number(await git(repo, ['rev-list', '--count', 'HEAD'])) - before, files };
}

describe('copperhead sync on a consistent repo (AC-7.5)', () => {
  it('exits 0 with no inconsistencies, edits and commits nothing, and a second run is a no-op', async () => {
    const repo = await initializedRepo();
    const head = await git(repo, ['rev-parse', 'HEAD']);
    const before = await treeHashes(repo);

    for (const run of [1, 2]) {
      const res = await sync(repo);
      expect(res.exitCode, `run ${run}: ${res.stdout}`).toBe(0);
      expect(res.stdout).toMatch(/no inconsistencies/i);
      expect(await git(repo, ['rev-parse', 'HEAD']), `run ${run} committed`).toBe(head);
      expect(await treeHashes(repo), `run ${run} changed the tree`).toEqual(before);
    }
  }, 180_000);
});

describe('copperhead sync on a requirement violation (AC-7.3)', () => {
  it('flags it with exit 2, never rewrites anything, and commits nothing', async () => {
    const repo = await initializedRepo();
    // GPIO14 carries KEY_DAH in the fixture; forbidding it is a requirement violation
    await saveConstraint(repo, 'pins.forbidden_gpio14', { forbidden: ['GPIO14'], source: 'esp32-s3 datasheet', affects: ['U1'] });
    await commitAll(repo, 'forbid GPIO14');
    const head = await git(repo, ['rev-parse', 'HEAD']);
    const before = await treeHashes(repo);

    const res = await sync(repo);
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain('GPIO14');
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(await treeHashes(repo)).toEqual(before);
  }, 180_000);
});

describe('copperhead sync resolve phase lands each kind of drift', () => {
  it('doc drift: BOM.md is brought back to the as-built schematic, then check reports drift clean (AC-7.1)', async () => {
    const repo = await initializedRepo();
    const bomPath = path.join(repo, 'docs', 'BOM.md');
    await writeFile(bomPath, (await readFile(bomPath, 'utf8')).replace('| R1 | 10k |', '| R1 | 47k |'), 'utf8');
    await commitAll(repo, 'drift R1');
    expect((await syncVerify(repo)).resolvable.map((i) => i.kind)).toEqual(['drift']);

    const res = await resolveWith(repo, [
      unlock,
      {
        toolCalls: [
          { name: 'edit_file', args: { path: 'docs/BOM.md', old_string: '| R1 | 47k |', new_string: '| R1 | 10k |' } },
          { name: 'check_drift', args: {} },
        ],
      },
      finish,
    ]);
    expect(res.ok, res.summary).toBe(true);
    expect(res.commits, 'the resolve run lands as a single commit').toBe(1);
    expect(res.files).toEqual(expect.arrayContaining(['docs/BOM.md', 'docs/CHANGELOG.md']));
    expect(await git(repo, ['status', '--porcelain'])).toBe('');
    expect((await runCheck(repo, () => {})).drift.ok).toBe(true);
    expect((await syncVerify(repo)).resolvable).toEqual([]);
  }, 180_000);

  it('dual-write gap, registry to docs: a constraint no doc mentions gets written into its source doc (AC-7.2)', async () => {
    const repo = await initializedRepo();
    await saveConstraint(repo, 'rf.antenna_keepout_mm', { min: 5, source: 'docs/LAYOUT.md', affects: [] });
    await commitAll(repo, 'record keepout');
    expect((await syncVerify(repo)).resolvable.map((i) => i.kind)).toEqual(['dual-write']);

    const layout = await readFile(path.join(repo, 'docs', 'LAYOUT.md'), 'utf8');
    const anchor = layout.split('\n').find((l) => l.startsWith('# '))!;
    const res = await resolveWith(repo, [
      unlock,
      {
        toolCalls: [
          {
            name: 'edit_file',
            args: { path: 'docs/LAYOUT.md', old_string: anchor, new_string: `${anchor}\n\n- antenna_keepout_mm: 5 mm minimum (constraints.json rf.antenna_keepout_mm)` },
          },
          { name: 'check_drift', args: {} },
        ],
      },
      finish,
    ]);
    expect(res.ok, res.summary).toBe(true);
    expect(res.commits).toBe(1);
    expect(res.files).toEqual(expect.arrayContaining(['docs/LAYOUT.md', 'docs/CHANGELOG.md']));
    expect(await readFile(path.join(repo, 'docs', 'LAYOUT.md'), 'utf8')).toContain('antenna_keepout_mm');
    expect((await syncVerify(repo)).resolvable).toEqual([]);
  }, 180_000);

  it('dual-write gap, config to registry: a configured budget missing from constraints.json gets recorded (AC-7.2)', async () => {
    const repo = await initializedRepo();
    const configPath = path.join(repo, '.copperhead', 'config.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    await writeFile(configPath, JSON.stringify({ ...config, budgets: { sleep_current_uA: 25 } }, null, 2) + '\n', 'utf8');
    await commitAll(repo, 'configure a budget');
    expect((await syncVerify(repo)).resolvable.map((i) => i.kind)).toEqual(['dual-write']);

    const spec = await readFile(path.join(repo, 'docs', 'SPEC.md'), 'utf8');
    const anchor = spec.split('\n').find((l) => /^#{1,6}\s.*Budgets/i.test(l))!;
    const res = await resolveWith(repo, [
      unlock,
      {
        toolCalls: [
          { name: 'record_constraint', args: { key: 'power.sleep_current_uA', max: 25, source: 'docs/SPEC.md', affects: [] } },
          { name: 'edit_file', args: { path: 'docs/SPEC.md', old_string: anchor, new_string: `${anchor}\n\n- sleep_current_uA: 25 (max)` } },
          { name: 'check_drift', args: {} },
        ],
      },
      finish,
    ]);
    expect(res.ok, res.summary).toBe(true);
    expect(res.commits).toBe(1);
    expect(res.files).toEqual(expect.arrayContaining(['.copperhead/constraints.json', 'docs/SPEC.md', 'docs/CHANGELOG.md']));
    expect(Object.keys(await loadConstraints(repo))).toContain('power.sleep_current_uA');
    expect((await syncVerify(repo)).resolvable).toEqual([]);
  }, 180_000);
});
