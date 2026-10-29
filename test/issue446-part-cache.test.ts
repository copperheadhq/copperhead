import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import {
  formatPartVerificationContext,
  isVerifiedPart,
  loadPartVerificationCache,
  parsePartVerificationRows,
  partCachePath,
  recordPartVerificationToolResult,
} from '../src/util/part-cache.js';
import { restore, snapshot } from '../src/util/git.js';
import { tempFixtureRepo } from './helpers.js';

const BOM = `| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| U1 | driver | Driver_Footprints:Driver_SOT23 | PART-1 | verified original choice |`;
const SEARCH_RESULT = 'installed symbols matching "PART-1":\n  - Driver:PART-1';
const PIN_RESULT = 'Driver:PART-1 — 3 pin(s), 1 unit(s):\n  1: IN · input';
const FOOTPRINT_RESULT = 'OK Driver_Footprints:Driver_SOT23';

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

describe('issue #446 persistent part verification cache', () => {
  it('round-trips the verified symbol, pin, and footprint results', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await recordCompleteVerification(repo);
      const cache = await loadPartVerificationCache(repo);
      const [row] = parsePartVerificationRows(BOM);

      expect(row).toBeDefined();
      expect(isVerifiedPart(row!, cache)).toBe(true);
      expect(formatPartVerificationContext([row!], cache)).toContain(PIN_RESULT);
      expect(await readFile(partCachePath(repo), 'utf8')).toContain('"schemaVersion": 1');
    } finally {
      await cleanup();
    }
  });

  it('survives the same git rollback used by failed agent runs', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await writeFile(path.join(repo, '.gitignore'), '.env\n.copperhead/runs/\n.copperhead/part-cache.json\n', 'utf8');
      await execa('git', ['add', '.gitignore'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'ignore runtime cache'], { cwd: repo });
      const before = await snapshot(repo);
      await recordCompleteVerification(repo);

      await restore(repo, before);

      const [row] = parsePartVerificationRows(BOM);
      expect(isVerifiedPart(row!, await loadPartVerificationCache(repo))).toBe(true);
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

  it('exposes unchanged verified rows as skipped results on retry', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await recordCompleteVerification(repo);
      const [row] = parsePartVerificationRows(BOM);
      const context = formatPartVerificationContext([row!], await loadPartVerificationCache(repo));

      expect(context).toContain('U1: PART-1');
      expect(context).toContain('fully verified');
      expect(context).toContain('Do not repeat their successful search_symbols');
    } finally {
      await cleanup();
    }
  });

  it('ignores corrupt JSON and unknown schema versions without throwing', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.dirname(partCachePath(repo)), { recursive: true });
      await writeFile(partCachePath(repo), '{broken json', 'utf8');
      expect(Object.keys((await loadPartVerificationCache(repo)).entries)).toHaveLength(0);

      await writeFile(partCachePath(repo), JSON.stringify({ schemaVersion: 999, entries: {} }), 'utf8');
      expect(Object.keys((await loadPartVerificationCache(repo)).entries)).toHaveLength(0);
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
