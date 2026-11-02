import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCanonicalTables } from '../memory/bom-table.js';

export const PART_CACHE_SCHEMA_VERSION = 1;
export const PART_CACHE_FILENAME = 'part-cache.json';

export interface PartVerificationRow {
  refdes: string;
  partNumber: string;
  value: string;
  footprint: string;
  bomRowHash: string;
}

export interface PartVerificationEntry extends PartVerificationRow {
  schemaVersion: number;
  symbolSearch?: { query: string; result: string };
  symbolPins?: { libId: string; result: string };
  footprintResult?: string;
  partSwap?: { oldPart: string; newPart: string; reason: string };
  updatedAt: string;
}

export interface PartVerificationCache {
  schemaVersion: number;
  entries: Record<string, PartVerificationEntry>;
}

export function partCachePath(repoRoot: string): string {
  return path.join(repoRoot, '.copperhead', PART_CACHE_FILENAME);
}

export function makePartCacheKey(row: PartVerificationRow): string {
  return [
    `v${PART_CACHE_SCHEMA_VERSION}`,
    encodeURIComponent(row.partNumber),
    encodeURIComponent(row.footprint),
    row.bomRowHash,
  ].join('::');
}

export function parsePartVerificationRows(bomText: string): PartVerificationRow[] {
  const parsed = parseCanonicalTables(bomText);
  const rows: PartVerificationRow[] = [];
  for (const table of parsed) {
    const column = (pattern: RegExp, fallback: number): number => {
      const index = table.header.cells.findIndex((cell) => pattern.test(cell));
      return index >= 0 ? index : fallback;
    };
    const refIndex = column(/^refdes$/i, 0);
    const valueIndex = column(/^value$/i, 1);
    const footprintIndex = column(/^footprint$/i, 2);
    const partIndex = column(/^mpn$/i, 3);
    for (const row of table.rows) {
      const refdes = row.cells[refIndex]?.trim();
      const partNumber = row.cells[partIndex]?.trim();
      if (!refdes || !partNumber) continue;
      rows.push({
        refdes,
        partNumber,
        value: row.cells[valueIndex]?.trim() ?? '',
        footprint: row.cells[footprintIndex]?.trim() ?? '',
        bomRowHash: createHash('sha256').update(JSON.stringify(row.cells)).digest('hex'),
      });
    }
  }
  return rows;
}

function isEntry(value: unknown): value is PartVerificationEntry {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<PartVerificationEntry>;
  return (
    row.schemaVersion === PART_CACHE_SCHEMA_VERSION &&
    typeof row.refdes === 'string' &&
    typeof row.partNumber === 'string' &&
    typeof row.value === 'string' &&
    typeof row.footprint === 'string' &&
    typeof row.bomRowHash === 'string' &&
    typeof row.updatedAt === 'string' &&
    (row.symbolSearch === undefined ||
      (typeof row.symbolSearch.query === 'string' && typeof row.symbolSearch.result === 'string')) &&
    (row.symbolPins === undefined ||
      (typeof row.symbolPins.libId === 'string' && typeof row.symbolPins.result === 'string')) &&
    (row.footprintResult === undefined || typeof row.footprintResult === 'string')
  );
}

function emptyCache(): PartVerificationCache {
  return { schemaVersion: PART_CACHE_SCHEMA_VERSION, entries: {} };
}

/**
 * Load the cache. Advisory state: a missing, unreadable, corrupt, or
 * unknown-schema file yields an empty cache instead of failing the stage.
 */
export async function loadPartVerificationCache(repoRoot: string): Promise<PartVerificationCache> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(partCachePath(repoRoot), 'utf8'));
  } catch {
    return emptyCache();
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    (raw as Partial<PartVerificationCache>).schemaVersion !== PART_CACHE_SCHEMA_VERSION ||
    !(raw as Partial<PartVerificationCache>).entries ||
    typeof (raw as Partial<PartVerificationCache>).entries !== 'object' ||
    Array.isArray((raw as Partial<PartVerificationCache>).entries)
  ) {
    return emptyCache();
  }
  const entries = Object.fromEntries(
    Object.entries((raw as PartVerificationCache).entries).filter(([, entry]) => isEntry(entry)),
  ) as Record<string, PartVerificationEntry>;
  return { schemaVersion: PART_CACHE_SCHEMA_VERSION, entries };
}

export async function savePartVerificationCache(repoRoot: string, cache: PartVerificationCache): Promise<void> {
  const file = partCachePath(repoRoot);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

function isVerifiedEntry(entry: PartVerificationEntry | undefined): boolean {
  if (!entry?.footprintResult) return false;
  if (/^[RCL]\d/i.test(entry.refdes)) return true;
  return Boolean(entry.symbolSearch && entry.symbolPins);
}

export function isVerifiedPart(row: PartVerificationRow, cache: PartVerificationCache): boolean {
  return isVerifiedEntry(cache.entries[makePartCacheKey(row)]);
}

/** The `Lib:Name` ids a search_symbols result lists, one per `  - ` line. */
function listedLibIds(result: string): string[] {
  return result
    .split('\n')
    .map((line) => /^\s*-\s+(\S+)\s*$/.exec(line)?.[1])
    .filter((id): id is string => !!id);
}

/**
 * A search credits a row only by its MPN: the query is the MPN, or the result
 * lists a symbol whose name is the MPN. A value or refdes that merely appears
 * inside the query ("3.3" in "AMS1117-3.3") never counts.
 */
function rowMatchesSearch(row: PartVerificationRow, query: string, result: string): boolean {
  const mpn = row.partNumber.trim().toLowerCase();
  if (!mpn) return false;
  if (query.trim().toLowerCase() === mpn) return true;
  return listedLibIds(result).some((id) => id.slice(id.indexOf(':') + 1).toLowerCase() === mpn);
}

function entryFor(row: PartVerificationRow, cache: PartVerificationCache): PartVerificationEntry {
  const key = makePartCacheKey(row);
  const existing = cache.entries[key];
  if (existing) return existing;
  const previous = Object.values(cache.entries).find(
    (entry) => entry.refdes === row.refdes && entry.partNumber !== row.partNumber,
  );
  const entry: PartVerificationEntry = {
    ...row,
    schemaVersion: PART_CACHE_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    ...(previous
      ? {
          partSwap: {
            oldPart: previous.partNumber,
            newPart: row.partNumber,
            reason: 'part number changed in the BOM',
          },
        }
      : {}),
  };
  cache.entries[key] = entry;
  return entry;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Fold one successful tool result into the in-memory cache. Returns the keys
 * of the entries it changed (empty when the result verified nothing).
 */
export function applyPartVerificationToolResult(
  cache: PartVerificationCache,
  rows: PartVerificationRow[],
  toolName: string,
  args: Record<string, unknown>,
  result: string,
): string[] {
  const touched = new Set<string>();
  if (toolName === 'search_symbols' && typeof args.query === 'string' && /installed symbols matching/i.test(result)) {
    for (const row of rows.filter((candidate) => rowMatchesSearch(candidate, args.query as string, result))) {
      entryFor(row, cache).symbolSearch = { query: args.query, result };
      touched.add(makePartCacheKey(row));
    }
  } else if (toolName === 'symbol_pins' && typeof args.lib_id === 'string') {
    const libId = args.lib_id;
    const pinMatch = new RegExp(`^${escapeRegExp(libId)}\\s+—\\s+\\d+ pin\\(s\\)`, 'm');
    if (pinMatch.test(result)) {
      for (const row of rows) {
        const key = makePartCacheKey(row);
        const entry = cache.entries[key];
        if (entry?.symbolSearch && listedLibIds(entry.symbolSearch.result).includes(libId)) {
          entry.symbolPins = { libId, result };
          entry.updatedAt = new Date().toISOString();
          touched.add(key);
        }
      }
    }
  } else if (toolName === 'check_footprints' && Array.isArray(args.footprints)) {
    for (const footprint of args.footprints) {
      if (typeof footprint !== 'string') continue;
      if (!new RegExp(`^OK\\s+${escapeRegExp(footprint)}\\s*$`, 'm').test(result)) continue;
      for (const row of rows.filter((candidate) => candidate.footprint === footprint)) {
        entryFor(row, cache).footprintResult = `OK ${footprint}`;
        touched.add(makePartCacheKey(row));
      }
    }
  }
  return [...touched];
}

/** apply + save: persists the cache when the result verified anything. */
export async function recordPartVerificationToolResult(
  repoRoot: string,
  cache: PartVerificationCache,
  rows: PartVerificationRow[],
  toolName: string,
  args: Record<string, unknown>,
  result: string,
): Promise<string[]> {
  const touched = applyPartVerificationToolResult(cache, rows, toolName, args, result);
  if (touched.length) await savePartVerificationCache(repoRoot, cache);
  return touched;
}

/**
 * The entries a part-selection attempt is told about: those matching a row of
 * the current BOM, plus those an earlier attempt of the stage recorded
 * (`carriedKeys`). The carried set matters because a failed attempt is rolled
 * back: its BOM rows are gone, so their row hashes match nothing on disk.
 */
export function partVerificationContextEntries(
  rows: PartVerificationRow[],
  cache: PartVerificationCache,
  carriedKeys: Iterable<string> = [],
): PartVerificationEntry[] {
  const keys = new Set<string>();
  for (const row of rows) keys.add(makePartCacheKey(row));
  for (const key of carriedKeys) keys.add(key);
  return [...keys].map((key) => cache.entries[key]).filter((entry): entry is PartVerificationEntry => !!entry);
}

function pinCount(result: string | undefined): string {
  const count = result ? /—\s+(\d+) pin\(s\)/.exec(result)?.[1] : undefined;
  return count ? `${count} pins` : 'pins unconfirmed';
}

/**
 * One compact line per part (refdes, MPN, lib_id, pin count, footprint
 * status), never the raw tool output: the block rides on every turn of a
 * retry, and on a large BOM raw pin dumps would dominate the prompt.
 */
export function formatPartVerificationContext(entries: PartVerificationEntry[]): string {
  if (!entries.length) return '';
  return [
    '## Cached part-selection verification',
    "These parts were verified on this machine, by the current BOM or by an earlier attempt of this stage that was rolled back (so BOM.md may not list them yet). Do not repeat the search_symbols, symbol_pins, or check_footprints calls recorded here; call symbol_pins only when you need pin detail. Finish the incomplete checks, and keep these parts unless the design requires a change.",
    ...entries.map((entry) => {
      const libId = entry.symbolPins?.libId ?? (entry.symbolSearch ? 'symbol found, lib_id unconfirmed' : 'symbol unchecked');
      const footprint = entry.footprintResult
        ? `footprint ${entry.footprint} OK`
        : `footprint ${entry.footprint || '(none)'} unchecked`;
      const swap = entry.partSwap ? `; swapped from ${entry.partSwap.oldPart}` : '';
      const status = isVerifiedEntry(entry) ? 'fully verified' : 'partially verified';
      return `- ${entry.refdes}: ${entry.partNumber}; ${libId}; ${pinCount(entry.symbolPins?.result)}; ${footprint}${swap}; ${status}`;
    }),
  ].join('\n');
}
