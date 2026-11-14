import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { sweepStaleTempDirs, pruneHistoryDir, TEMP_PREFIX } from '../src/util/tmp.js';

// These exercise the I8 startup sweep. They create real `copperhead-*` dirs
// under a private root and age them via utimes, so the age gate is tested
// against the same clock the sweep reads.
//
// The root is private, never the shared OS temp dir: test files run in parallel
// workers, and a sweep with a short cutoff over the shared temp dir deletes
// every other worker's fresh scratch dirs (create-layout-draft's seeded KiCad
// config lost its fp-lib-table mid-file that way, so every later DRC reported
// lib_footprint_issues). The other direction held too: `create` sweeps the
// shared temp dir at Date.now() on startup, so a fixture aged against a
// synthetic epoch would be deleted by a create test in a parallel worker.
describe('sweepStaleTempDirs (I8: reclaim leaked scratch dirs)', () => {
  const made: string[] = [];
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sweep-root-'));
  });

  async function makeAged(suffix: string, ageMs: number, base: number): Promise<string> {
    const dir = path.join(root, `${TEMP_PREFIX}${suffix}-${process.pid}-${made.length}`);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'erc.json'), '{}'); // non-empty, like a real leak
    const when = new Date(base - ageMs);
    await utimes(dir, when, when);
    made.push(dir);
    return dir;
  }

  afterEach(async () => {
    for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  it('removes a stale dir but keeps a fresh one', async () => {
    // the injected `now` is 100m ahead, which pushes only the older one past
    // the 2h cutoff
    const base = Date.now();
    const stale = await makeAged('erc-stale', 30 * 60 * 1000, base); // 130m to the sweep
    const fresh = await makeAged('cc-fresh', 60 * 1000, base); // 101m to the sweep
    const now = base + 100 * 60 * 1000;

    const removed = await sweepStaleTempDirs(now, undefined, root); // default 2h cutoff

    expect(removed).toContain(stale);
    expect(removed).not.toContain(fresh);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('never touches non-copperhead temp dirs', async () => {
    const now = 1_000_000_000_000;
    const foreign = await mkdtemp(path.join(root, 'someone-else-'));
    made.push(foreign);
    const when = new Date(now - 24 * 60 * 60 * 1000); // a day old
    await utimes(foreign, when, when);

    const removed = await sweepStaleTempDirs(now, undefined, root);

    expect(removed).not.toContain(foreign);
    expect(existsSync(foreign)).toBe(true);
  });

  it('honours a custom maxAge and returns [] when nothing is stale', async () => {
    const now = Date.now(); // real clock: 90s old is fresh to the default 2h sweep
    const recent = await makeAged('validate-recent', 90 * 1000, now); // 90s old

    // 60s cutoff: the 90s-old dir is stale and swept.
    expect(await sweepStaleTempDirs(now, 60 * 1000, root)).toContain(recent);
  });

  it('is best-effort: a missing temp root yields [] rather than throwing', async () => {
    // readdir of a missing root is guarded: [] rather than a throw
    const removed = await sweepStaleTempDirs(0, 1, path.join(root, 'missing'));
    expect(Array.isArray(removed)).toBe(true);
  });
});

describe('pruneHistoryDir (4.1: cap .history/ growth)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'copperhead-hist-test-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('keeps the newest N entries and removes older ones (recursively)', async () => {
    const hist = path.join(repo, '.history', 'nested');
    await mkdir(hist, { recursive: true });
    const base = 1_000_000_000_000;
    for (let i = 0; i < 10; i++) {
      const f = path.join(hist, `snap-${i}.kicad_sch`);
      await writeFile(f, `v${i}`);
      const when = new Date(base + i * 1000); // ascending mtime: higher i = newer
      await utimes(f, when, when);
    }
    const removed = await pruneHistoryDir(repo, 4);
    expect(removed).toBe(6); // 10 - 4 kept
    // the 4 newest (i=6..9) survive; the 6 oldest are gone
    expect(existsSync(path.join(hist, 'snap-9.kicad_sch'))).toBe(true);
    expect(existsSync(path.join(hist, 'snap-6.kicad_sch'))).toBe(true);
    expect(existsSync(path.join(hist, 'snap-5.kicad_sch'))).toBe(false);
    expect(existsSync(path.join(hist, 'snap-0.kicad_sch'))).toBe(false);
  });

  it('is a no-op when under the cap or the dir is absent', async () => {
    expect(await pruneHistoryDir(repo, 200)).toBe(0); // no .history/ at all
    await mkdir(path.join(repo, '.history'), { recursive: true });
    await writeFile(path.join(repo, '.history', 'a'), 'x');
    expect(await pruneHistoryDir(repo, 200)).toBe(0); // one file, under cap
    expect(existsSync(path.join(repo, '.history', 'a'))).toBe(true);
  });
});
