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

export async function loadPartVerificationCache(repoRoot: string): Promise<PartVerificationCache> {
  let text: string;
  try {
    text = await readFile(partCachePath(repoRoot), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyCache();
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return emptyCache();
    throw error;
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

export function isVerifiedPart(row: PartVerificationRow, cache: PartVerificationCache): boolean {
  const entry = cache.entries[makePartCacheKey(row)];
  if (!entry?.footprintResult) return false;
  if (/^[RCL]\d/i.test(row.refdes)) return true;
  return Boolean(entry.symbolSearch && entry.symbolPins);
}

function rowMatchesQuery(row: PartVerificationRow, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return [row.partNumber, row.value, row.refdes].some((candidate) => {
    const value = candidate.trim().toLowerCase();
    return value.length >= 3 && (normalized === value || normalized.includes(value));
  });
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

export async function recordPartVerificationToolResult(
  repoRoot: string,
  cache: PartVerificationCache,
  rows: PartVerificationRow[],
  toolName: string,
  args: Record<string, unknown>,
  result: string,
): Promise<void> {
  let updated = false;
  if (toolName === 'search_symbols' && typeof args.query === 'string' && /installed symbols matching/i.test(result)) {
    for (const row of rows.filter((candidate) => rowMatchesQuery(candidate, args.query as string))) {
      entryFor(row, cache).symbolSearch = { query: args.query, result };
      updated = true;
    }
  } else if (toolName === 'symbol_pins' && typeof args.lib_id === 'string') {
    const pinMatch = new RegExp(`^${args.lib_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+—\\s+\\d+ pin\\(s\\)`, 'm');
    if (pinMatch.test(result)) {
      for (const row of rows) {
        const entry = cache.entries[makePartCacheKey(row)];
        if (entry?.symbolSearch?.result.includes(args.lib_id)) {
          entry.symbolPins = { libId: args.lib_id, result };
          entry.updatedAt = new Date().toISOString();
          updated = true;
        }
      }
    }
  } else if (toolName === 'check_footprints' && Array.isArray(args.footprints)) {
    for (const footprint of args.footprints) {
      if (typeof footprint !== 'string') continue;
      const escaped = footprint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`^OK\\s+${escaped}\\s*$`, 'm').test(result)) continue;
      for (const row of rows.filter((candidate) => candidate.footprint === footprint)) {
        entryFor(row, cache).footprintResult = `OK ${footprint}`;
        updated = true;
      }
    }
  }
  if (updated) await savePartVerificationCache(repoRoot, cache);
}

export function formatPartVerificationContext(
  rows: PartVerificationRow[],
  cache: PartVerificationCache,
): string {
  const current = rows
    .map((row) => ({ row, entry: cache.entries[makePartCacheKey(row)] }))
    .filter(({ entry }) => entry !== undefined);
  if (!current.length) return '';
  return [
    '## Cached part-selection verification',
    'These results were verified on this machine and match the current BOM row hash. Do not repeat their successful search_symbols, symbol_pins, or check_footprints calls. Continue any incomplete checks, and keep the BOM rows unchanged unless the design requires a part change.',
    ...current.map(({ row, entry }) =>
      [
        `- ${row.refdes}: ${row.partNumber}; footprint ${row.footprint || '(none)'}; ${isVerifiedPart(row, cache) ? 'fully verified' : 'partially verified'}`,
        ...(entry!.partSwap
          ? [`  - Part swap: ${entry!.partSwap.oldPart} -> ${entry!.partSwap.newPart} (${entry!.partSwap.reason})`]
          : []),
        ...(entry!.symbolSearch ? [`  - search_symbols: ${entry!.symbolSearch.result}`] : []),
        ...(entry!.symbolPins ? [`  - symbol_pins: ${entry!.symbolPins.result}`] : []),
        ...(entry!.footprintResult ? [`  - check_footprints: ${entry!.footprintResult}`] : []),
      ].join('\n'),
    ),
  ].join('\n');
}
