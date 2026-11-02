import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import {
  applyPartVerificationToolResult,
  formatPartVerificationContext,
  isVerifiedPart,
  loadPartVerificationCache,
  makePartCacheKey,
  parsePartVerificationRows,
  partCachePath,
  partVerificationContextEntries,
  recordPartVerificationToolResult,
  PART_CACHE_SCHEMA_VERSION,
} from '../src/util/part-cache.js';
import type { PartVerificationCache } from '../src/util/part-cache.js';
import { commitAll, PART_CACHE_PATH, preserveFailedRun, restore, snapshot } from '../src/util/git.js';
import { tempFixtureRepo } from './helpers.js';

const BOM = `| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| U1 | driver | Driver_Footprints:Driver_SOT23 | PART-1 | verified original choice |`;
const SEARCH_RESULT = 'installed symbols matching "PART-1":\n  - Driver:PART-1';
const PIN_RESULT = 'Driver:PART-1 — 3 pin(s), 1 unit(s):\n  1: IN · input\n  2: OUT · output\n  3: GND · power_in';
const FOOTPRINT_RESULT = 'OK  Driver_Footprints:Driver_SOT23\n(searched: stock footprints)';

const empty = (): PartVerificationCache => ({ schemaVersion: PART_CACHE_SCHEMA_VERSION, entries: {} });

async function recordCompleteVerification(repo: string, bom = BOM): Promise<void> {
  const rows = parsePartVerificationRows(bom);
  const cache = await loadPartVerificationCache(repo);
  await recordPartVerificationToolResult(repo, cache, rows, 'search_symbols', { query: 'PART-1' }, SEARCH_RESULT);
  await recordPartVerificationToolResult(repo, cache, rows, 'symbol_pins', { lib_id: 'Driver:PART-1' }, PIN_RESULT);
  await recordPartVerificationToolResult(
    repo,
    cache,
    rows,
    'check_footprints',
    { footprints: ['Driver_Footprints:Driver_SOT23'] },
    FOOTPRINT_RESULT,
  );
}

async function git(repo: string, ...args: string[]): Promise<string> {
  return (await execa('git', args, { cwd: repo })).stdout.trim();
}

describe('issue #446 persistent part verification cache', () => {
  it('round-trips the verified symbol, pin, and footprint results', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await recordCompleteVerification(repo);
      const cache = await loadPartVerificationCache(repo);
      const [row] = parsePartVerificationRows(BOM);

      expect(row).toBeDefined();
      expect(isVerifiedPart(row!, cache)).toBe(true);
      expect(cache.entries[makePartCacheKey(row!)]?.symbolPins?.result).toBe(PIN_RESULT);
      expect(await readFile(partCachePath(repo), 'utf8')).toContain('"schemaVersion": 1');
    } finally {
      await cleanup();
    }
  });

  it('survives rollback under the default target-repo .gitignore (no cache ignore line)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      expect(await readFile(path.join(repo, '.gitignore'), 'utf8')).not.toContain(PART_CACHE_PATH);
      const before = await snapshot(repo);
      await recordCompleteVerification(repo);

      await restore(repo, before);

      const [row] = parsePartVerificationRows(BOM);
      expect(existsSync(partCachePath(repo))).toBe(true);
      expect(isVerifiedPart(row!, await loadPartVerificationCache(repo))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('keeps the newer cache when a dirty snapshot captured an older, unignored copy', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // an older partial cache exists and is untracked-not-ignored at snapshot time
      const rows = parsePartVerificationRows(BOM);
      await recordPartVerificationToolResult(repo, empty(), rows, 'search_symbols', { query: 'PART-1' }, SEARCH_RESULT);
      const before = await snapshot(repo);
      expect(before.untracked).not.toBeNull();
      await recordCompleteVerification(repo);

      await restore(repo, before);

      expect(isVerifiedPart(rows[0]!, await loadPartVerificationCache(repo))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('survives the failed-run stash plus rollback, and is never staged into that stash', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const before = await snapshot(repo);
      await recordCompleteVerification(repo);
      await writeFile(path.join(repo, 'partial.md'), 'failed attempt output\n', 'utf8');

      const stash = await preserveFailedRun(repo, 'test-run');
      expect(stash).not.toBeNull();
      const stashed = await git(repo, 'ls-tree', '-r', '--name-only', stash!);
      expect(stashed).toContain('partial.md');
      expect(stashed).not.toContain(PART_CACHE_PATH);
      await restore(repo, before);

      expect(existsSync(path.join(repo, 'partial.md'))).toBe(false);
      expect(isVerifiedPart(parsePartVerificationRows(BOM)[0]!, await loadPartVerificationCache(repo))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('commitAll ignores the cache in the target repo and never commits it', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await recordCompleteVerification(repo);
      await writeFile(path.join(repo, 'notes.md'), 'a real change\n', 'utf8');

      await commitAll(repo, 'stage commit');

      expect(await git(repo, 'ls-files')).not.toContain(PART_CACHE_PATH);
      expect((await readFile(path.join(repo, '.gitignore'), 'utf8')).split(/\r?\n/)).toContain(PART_CACHE_PATH);
      expect(existsSync(partCachePath(repo))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('commitAll leaves the target .gitignore alone when no cache exists', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, 'notes.md'), 'a real change\n', 'utf8');
      await commitAll(repo, 'stage commit');
      expect(await readFile(path.join(repo, '.gitignore'), 'utf8')).not.toContain(PART_CACHE_PATH);
    } finally {
      await cleanup();
    }
  });

  it('invalidates an entry when any cell in the BOM row changes', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await recordCompleteVerification(repo);
      const changedBom = BOM.replace('verified original choice', 'new rationale');
      const [oldRow] = parsePartVerificationRows(BOM);
      const [changedRow] = parsePartVerificationRows(changedBom);

      expect(changedRow!.bomRowHash).not.toBe(oldRow!.bomRowHash);
      expect(isVerifiedPart(changedRow!, await loadPartVerificationCache(repo))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('formats one compact line per part instead of the raw tool output', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await recordCompleteVerification(repo);
      const cache = await loadPartVerificationCache(repo);
      const context = formatPartVerificationContext(
        partVerificationContextEntries(parsePartVerificationRows(BOM), cache),
      );

      const lines = context.split('\n');
      expect(lines[0]).toBe('## Cached part-selection verification');
      expect(lines).toHaveLength(3);
      expect(lines[2]).toBe(
        '- U1: PART-1; Driver:PART-1; 3 pins; footprint Driver_Footprints:Driver_SOT23 OK; fully verified',
      );
      expect(context).toContain('Do not repeat the search_symbols, symbol_pins, or check_footprints calls');
      expect(context).not.toContain('IN · input');
      expect(context).not.toContain('installed symbols matching');
    } finally {
      await cleanup();
    }
  });

  it('formats partial entries and part swaps on their single line', () => {
    const cache = empty();
    const rows = parsePartVerificationRows(BOM);
    applyPartVerificationToolResult(cache, rows, 'search_symbols', { query: 'PART-1' }, SEARCH_RESULT);
    const swappedRows = parsePartVerificationRows(BOM.replace('PART-1', 'PART-2'));
    applyPartVerificationToolResult(
      cache,
      swappedRows,
      'check_footprints',
      { footprints: ['Driver_Footprints:Driver_SOT23'] },
      FOOTPRINT_RESULT,
    );

    const context = formatPartVerificationContext(Object.values(cache.entries));
    expect(context).toContain(
      '- U1: PART-1; symbol found, lib_id unconfirmed; pins unconfirmed; footprint Driver_Footprints:Driver_SOT23 unchecked; partially verified',
    );
    expect(context).toContain(
      '- U1: PART-2; symbol unchecked; pins unconfirmed; footprint Driver_Footprints:Driver_SOT23 OK; swapped from PART-1; partially verified',
    );
    expect(formatPartVerificationContext([])).toBe('');
  });

  it('carries entries recorded by a rolled-back attempt even when the current BOM has no rows', () => {
    const cache = empty();
    const touched = applyPartVerificationToolResult(
      cache,
      parsePartVerificationRows(BOM),
      'search_symbols',
      { query: 'PART-1' },
      SEARCH_RESULT,
    );
    expect(touched).toHaveLength(1);

    expect(partVerificationContextEntries([], cache)).toEqual([]);
    const carried = partVerificationContextEntries([], cache, touched);
    expect(carried.map((entry) => entry.partNumber)).toEqual(['PART-1']);
    // a key the cache no longer holds is dropped, not rendered as undefined
    expect(partVerificationContextEntries([], cache, ['v1::gone::gone::0'])).toEqual([]);
  });

  it('ignores corrupt JSON and unknown schema versions without throwing', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.dirname(partCachePath(repo)), { recursive: true });
      await writeFile(partCachePath(repo), '{broken json', 'utf8');
      expect(Object.keys((await loadPartVerificationCache(repo)).entries)).toHaveLength(0);

      await writeFile(partCachePath(repo), JSON.stringify({ schemaVersion: 999, entries: {} }), 'utf8');
      expect(Object.keys((await loadPartVerificationCache(repo)).entries)).toHaveLength(0);

      await writeFile(partCachePath(repo), JSON.stringify({ schemaVersion: 1, entries: [] }), 'utf8');
      expect(Object.keys((await loadPartVerificationCache(repo)).entries)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('returns an empty cache when the cache path cannot be read', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // a directory where the file should be: readFile fails with EISDIR, not ENOENT
      await mkdir(partCachePath(repo), { recursive: true });
      expect(await loadPartVerificationCache(repo)).toEqual(empty());
    } finally {
      await cleanup();
    }
  });

  it('drops malformed entries and keeps the valid ones', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await recordCompleteVerification(repo);
      const valid = JSON.parse(await readFile(partCachePath(repo), 'utf8')) as PartVerificationCache;
      const [key, entry] = Object.entries(valid.entries)[0]!;
      await writeFile(
        partCachePath(repo),
        JSON.stringify({
          schemaVersion: 1,
          entries: {
            [key]: entry,
            notAnObject: 'x',
            missingRefdes: { ...entry, refdes: undefined },
            wrongSchema: { ...entry, schemaVersion: 2 },
            badSearch: { ...entry, symbolSearch: { query: 1, result: 'x' } },
            badPins: { ...entry, symbolPins: { libId: 'x' } },
            badFootprint: { ...entry, footprintResult: 7 },
          },
        }),
        'utf8',
      );

      expect(Object.keys((await loadPartVerificationCache(repo)).entries)).toEqual([key]);
    } finally {
      await cleanup();
    }
  });

  it('persists partial verification results before the remaining checks finish', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const rows = parsePartVerificationRows(BOM);
      const cache = await loadPartVerificationCache(repo);
      await recordPartVerificationToolResult(repo, cache, rows, 'search_symbols', { query: 'PART-1' }, SEARCH_RESULT);

      const reloaded = await loadPartVerificationCache(repo);
      const [row] = rows;
      const entry = reloaded.entries[Object.keys(reloaded.entries)[0]!];
      expect(entry?.symbolSearch?.result).toBe(SEARCH_RESULT);
      expect(isVerifiedPart(row!, reloaded)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('records a verified BOM part swap against the prior part number', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await recordCompleteVerification(repo);
      const swappedBom = BOM.replace('PART-1', 'PART-2');
      const rows = parsePartVerificationRows(swappedBom);
      const cache = await loadPartVerificationCache(repo);
      await recordPartVerificationToolResult(
        repo,
        cache,
        rows,
        'search_symbols',
        { query: 'PART-2' },
        'installed symbols matching PART-2:\n  - Driver:PART-2',
      );

      const updated = await loadPartVerificationCache(repo);
      const swapped = Object.values(updated.entries).find((entry) => entry.partNumber === 'PART-2');
      expect(swapped?.partSwap).toEqual({
        oldPart: 'PART-1',
        newPart: 'PART-2',
        reason: 'part number changed in the BOM',
      });
    } finally {
      await cleanup();
    }
  });
});

describe('issue #446 part verification matching', () => {
  const MIXED_BOM = `| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| U1 | AMS1117-3.3 | Package_TO_SOT_SMD:SOT-223-3_TabPin2 | AMS1117-3.3 | 3.3 V LDO |
| D1 | 3.3 | Diode_SMD:D_SOD-123 | BZT52C3V3 | 3.3 V zener clamp |
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | pull-up |`;
  const AMS_SEARCH = 'installed symbols matching "AMS1117-3.3":\n  - Regulator_Linear:AMS1117-3.3';
  const AMS_PINS = 'Regulator_Linear:AMS1117-3.3 — 3 pin(s), 1 unit(s):\n  1: GND · power_in';

  it('does not credit a search to a row whose value is a substring of the query (AMS1117-3.3 vs D1 "3.3")', () => {
    const cache = empty();
    const rows = parsePartVerificationRows(MIXED_BOM);
    const [u1, d1] = rows;
    applyPartVerificationToolResult(cache, rows, 'search_symbols', { query: 'AMS1117-3.3' }, AMS_SEARCH);
    applyPartVerificationToolResult(cache, rows, 'symbol_pins', { lib_id: 'Regulator_Linear:AMS1117-3.3' }, AMS_PINS);
    applyPartVerificationToolResult(
      cache,
      rows,
      'check_footprints',
      { footprints: ['Diode_SMD:D_SOD-123', 'Package_TO_SOT_SMD:SOT-223-3_TabPin2'] },
      'OK  Diode_SMD:D_SOD-123\nOK  Package_TO_SOT_SMD:SOT-223-3_TabPin2',
    );

    expect(isVerifiedPart(u1!, cache)).toBe(true);
    expect(isVerifiedPart(d1!, cache)).toBe(false);
    const d1Entry = cache.entries[makePartCacheKey(d1!)];
    expect(d1Entry?.symbolSearch).toBeUndefined();
    expect(d1Entry?.symbolPins).toBeUndefined();
    expect(formatPartVerificationContext(partVerificationContextEntries(rows, cache))).toContain(
      '- D1: BZT52C3V3; symbol unchecked; pins unconfirmed; footprint Diode_SMD:D_SOD-123 OK; partially verified',
    );
  });

  it('credits a search whose result lists a symbol named exactly the MPN', () => {
    const cache = empty();
    const bom = `| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| U2 | mcu | Package_SO:SOIC-8 | MCU8 | controller |`;
    const rows = parsePartVerificationRows(bom);
    const touched = applyPartVerificationToolResult(
      cache,
      rows,
      'search_symbols',
      { query: 'MCU' },
      'installed symbols matching "MCU":\n  - CopperMCU:MCU8\n  - CopperMCU:MCU16',
    );
    expect(touched).toEqual([makePartCacheKey(rows[0]!)]);
    // a listed name that only starts with the MPN does not count
    expect(
      applyPartVerificationToolResult(
        empty(),
        parsePartVerificationRows(bom.replace('| MCU8 |', '| MCU |')),
        'search_symbols',
        { query: 'controller' },
        'installed symbols matching "controller":\n  - CopperMCU:MCU8',
      ),
    ).toEqual([]);
  });

  it('treats an R/C/L row as verified on its footprint alone, but not an active part', () => {
    const cache = empty();
    const rows = parsePartVerificationRows(MIXED_BOM);
    applyPartVerificationToolResult(
      cache,
      rows,
      'check_footprints',
      { footprints: ['Resistor_SMD:R_0603_1608Metric', 'Package_TO_SOT_SMD:SOT-223-3_TabPin2'] },
      'OK  Resistor_SMD:R_0603_1608Metric\nOK  Package_TO_SOT_SMD:SOT-223-3_TabPin2',
    );
    expect(isVerifiedPart(rows[2]!, cache)).toBe(true); // R1
    expect(isVerifiedPart(rows[0]!, cache)).toBe(false); // U1 still needs its symbol and pins
  });

  it('ignores symbol_pins results that miss or name a symbol no search listed', () => {
    const cache = empty();
    const rows = parsePartVerificationRows(MIXED_BOM);
    applyPartVerificationToolResult(cache, rows, 'search_symbols', { query: 'AMS1117-3.3' }, AMS_SEARCH);

    // a miss: the result is not a pin table for that lib_id
    expect(
      applyPartVerificationToolResult(
        cache,
        rows,
        'symbol_pins',
        { lib_id: 'Regulator_Linear:AMS1117-3.3' },
        'no symbol "AMS1117-3.3" in Regulator_Linear; closest: AMS1117-5.0',
      ),
    ).toEqual([]);
    // a real pin table, but for a lib_id the search never listed
    expect(
      applyPartVerificationToolResult(
        cache,
        rows,
        'symbol_pins',
        { lib_id: 'Regulator_Linear:AMS1117' },
        'Regulator_Linear:AMS1117 — 3 pin(s), 1 unit(s):\n  1: GND · power_in',
      ),
    ).toEqual([]);
    // a non-string lib_id is not a symbol_pins call it can attribute
    expect(applyPartVerificationToolResult(cache, rows, 'symbol_pins', { lib_id: 7 }, AMS_PINS)).toEqual([]);
    expect(cache.entries[makePartCacheKey(rows[0]!)]?.symbolPins).toBeUndefined();
  });

  it('ignores check_footprints misses and non-string footprint ids', () => {
    const cache = empty();
    const rows = parsePartVerificationRows(MIXED_BOM);
    expect(
      applyPartVerificationToolResult(
        cache,
        rows,
        'check_footprints',
        { footprints: [42, null, 'Diode_SMD:D_SOD-123'] },
        'MISS Diode_SMD:D_SOD-123: library "Diode_SMD" has no such footprint; closest installed: Diode_SMD:D_SOD-323',
      ),
    ).toEqual([]);
    expect(applyPartVerificationToolResult(cache, rows, 'check_footprints', { footprints: 'x' }, 'OK  x')).toEqual([]);
    expect(cache.entries).toEqual({});
  });

  it('ignores a search_symbols miss and unrelated tools', () => {
    const cache = empty();
    const rows = parsePartVerificationRows(MIXED_BOM);
    expect(
      applyPartVerificationToolResult(
        cache,
        rows,
        'search_symbols',
        { query: 'AMS1117-3.3' },
        'no installed symbol matches "AMS1117-3.3"',
      ),
    ).toEqual([]);
    expect(applyPartVerificationToolResult(cache, rows, 'read_file', { path: 'docs/BOM.md' }, MIXED_BOM)).toEqual([]);
    expect(cache.entries).toEqual({});
  });
});
