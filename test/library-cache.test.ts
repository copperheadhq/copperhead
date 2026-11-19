import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, cp, utimes, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { libraryCache, CACHE_DIR } from '../src/kicad/cache.js';
import { resolveLibrarySymbol } from '../src/kicad/symlib.js';
import { readFootprintPads } from '../src/kicad/footprints.js';
import { snapshot, restore } from '../src/util/git.js';
import { tempFixtureRepo } from './helpers.js';

// structured-part-selection, kicad-tooling delta: symbol pins and footprint
// pads are cached by (file, mtime), persisted under .copperhead/cache/, and
// the store survives the agent loop's rollback.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');

let work: string;
beforeEach(async () => {
  libraryCache.reset();
  work = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-'));
  await cp(SYMLIB, path.join(work, 'symbols'), { recursive: true });
  await mkdir(path.join(work, 'fp.pretty'));
  await writeFile(path.join(work, 'fp.pretty', 'X.kicad_mod'), '(footprint "X" (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")) (pad "2" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))\n');
});
afterEach(async () => {
  libraryCache.reset();
  await rm(work, { recursive: true, force: true });
});

describe('library cache', () => {
  it('serves a second symbol resolution from the cache and re-parses after the file changes', async () => {
    const dirs = [path.join(work, 'symbols')];
    const first = await resolveLibrarySymbol('CopperMCU:MCU8', dirs);
    expect(first.status).toBe('ok');
    expect(libraryCache.misses).toBe(1);
    const second = await resolveLibrarySymbol('CopperMCU:MCU8', dirs);
    expect(second).toEqual(first);
    expect(libraryCache.hits).toBe(1);
    // the file changes: its mtime moves, the keyed entry is ignored
    const file = path.join(work, 'symbols', 'CopperMCU.kicad_sym');
    const later = new Date(Date.now() + 60_000);
    await utimes(file, later, later);
    await resolveLibrarySymbol('CopperMCU:MCU8', dirs);
    expect(libraryCache.misses).toBe(2);
    expect(libraryCache.hits).toBe(1);
  });

  it('caches footprint pads the same way', async () => {
    const file = path.join(work, 'fp.pretty', 'X.kicad_mod');
    const a = await readFootprintPads(file);
    const b = await readFootprintPads(file);
    expect([...b.numbers]).toEqual(['1', '2']);
    expect(a.numbers).not.toBe(b.numbers); // a fresh Set per call, never the cache's own
    expect(libraryCache.hits).toBe(1);
  });

  it('persists to .copperhead/cache/ and ignores a corrupt store', async () => {
    const repo = path.join(work, 'repo');
    await mkdir(path.join(repo, CACHE_DIR), { recursive: true });
    await writeFile(path.join(repo, CACHE_DIR, 'library.json'), '{not json');
    libraryCache.attach(repo);
    const dirs = [path.join(work, 'symbols')];
    expect((await resolveLibrarySymbol('Device:R', dirs)).status).toBe('ok');
    libraryCache.flush();
    const store = JSON.parse(await readFile(path.join(repo, CACHE_DIR, 'library.json'), 'utf8'));
    expect(store.version).toBe(1);
    expect(Object.keys(store.symbols)).toHaveLength(1);
    // a fresh process-equivalent: reset, attach, and the entry is a hit
    libraryCache.reset();
    libraryCache.attach(repo);
    await resolveLibrarySymbol('Device:R', dirs);
    expect(libraryCache.hits).toBe(1);
  });

  it('survives the agent loop rollback of a failed run', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // the fixture's .gitignore does not name the cache: the directory ignores itself
      const snap = await snapshot(repo);
      libraryCache.attach(repo);
      await resolveLibrarySymbol('Device:R', [path.join(work, 'symbols')]);
      libraryCache.flush();
      const store = path.join(repo, CACHE_DIR, 'library.json');
      expect(existsSync(store)).toBe(true);
      expect(await readFile(path.join(repo, CACHE_DIR, '.gitignore'), 'utf8')).toBe('*\n');
      expect((await execa('git', ['status', '--porcelain'], { cwd: repo })).stdout).toBe(''); // the cache is invisible to git
      await writeFile(path.join(repo, 'scratch.txt'), 'a failed run wrote this');
      await restore(repo, snap);
      expect(existsSync(path.join(repo, 'scratch.txt'))).toBe(false);
      expect(existsSync(store)).toBe(true);
    } finally {
      libraryCache.reset();
      await cleanup();
    }
  }, 30000);
});
