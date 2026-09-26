import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunContext } from '../agent/context.js';
import { EgressSizeError, requestBytes } from './net.js';
import { researchConfig } from './config.js';
import { loadConstraints } from '../memory/constraints.js';

export interface DatasheetIndexEntry {
  mpn: string;
  url: string;
  retrieved: string;
  sha256?: string;
  size?: number;
  title?: string;
  pdf?: string;
  text?: string;
  status: 'cached' | 'not-cached';
  reason?: string;
}

interface DatasheetIndex {
  version: 1;
  entries: DatasheetIndexEntry[];
}

const indexUpdates = new Map<string, Promise<unknown>>();
let tempCounter = 0;

export function datasheetDir(repoRoot: string): string {
  return path.join(repoRoot, '.copperhead', 'datasheets');
}

async function loadIndex(repoRoot: string): Promise<DatasheetIndex> {
  const p = path.join(datasheetDir(repoRoot), 'index.json');
  if (!existsSync(p)) return { version: 1, entries: [] };
  try {
    const raw = JSON.parse(await readFile(p, 'utf8')) as Partial<DatasheetIndex>;
    return { version: 1, entries: Array.isArray(raw.entries) ? raw.entries : [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

async function saveIndex(repoRoot: string, index: DatasheetIndex): Promise<void> {
  const dir = datasheetDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, 'index.json');
  const temporary = path.join(dir, `.index.${process.pid}.${Date.now()}.${tempCounter++}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(index, null, 2) + '\n', 'utf8');
    await rename(temporary, target);
  } catch (err) {
    await unlink(temporary).catch(() => undefined);
    throw err;
  }
}

async function updateIndex<T>(repoRoot: string, mutate: (index: DatasheetIndex) => T | Promise<T>): Promise<T> {
  const previous = indexUpdates.get(repoRoot) ?? Promise.resolve();
  let result!: T;
  const current = previous.catch(() => undefined).then(async () => {
    const index = await loadIndex(repoRoot);
    result = await mutate(index);
    await saveIndex(repoRoot, index);
  });
  indexUpdates.set(repoRoot, current);
  try {
    await current;
    return result;
  } finally {
    if (indexUpdates.get(repoRoot) === current) indexUpdates.delete(repoRoot);
  }
}

function safeMpn(mpn: string): string {
  return mpn.trim().replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'datasheet';
}

/** Small, dependency-free extraction for ordinary PDF text operators. */
export function extractPdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const pages = raw.split(/\/Type\s*\/Page\b/).slice(1);
  const chunks = pages.length ? pages : [raw];
  return chunks
    .map((page, index) => {
      const text: string[] = [];
      for (const match of page.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*T[Jj]/g)) {
        text.push(match[1]!.replace(/\\([\\()nrt])/g, (_m, c: string) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c)));
      }
      for (const match of page.matchAll(/\[([^\]]+)\]\s*TJ/g)) {
        for (const part of match[1]!.matchAll(/\(([^()]*)\)/g)) text.push(part[1]!);
      }
      return `## Page ${index + 1}\n${text.join(' ')}`;
    })
    .join('\n\n')
    .trim();
}

export async function fetchDatasheet(ctx: RunContext, url: string, mpn: string, title?: string): Promise<DatasheetIndexEntry> {
  const index = await loadIndex(ctx.repoRoot);
  const cfg = researchConfig(ctx.config);
  const maxBytes = Math.floor(cfg.maxPdfMB * 1024 * 1024);
  const fresh = index.entries.find((entry) => {
    if (entry.url !== url || entry.status !== 'cached' || !entry.pdf || !entry.text) return false;
    const retrieved = Date.parse(entry.retrieved);
    return Number.isFinite(retrieved)
      && Date.now() - retrieved <= cfg.stalenessDays * 86_400_000
      && existsSync(path.join(ctx.repoRoot, entry.pdf))
      && existsSync(path.join(ctx.repoRoot, entry.text));
  });
  if (fresh) return fresh;

  let fetched: Awaited<ReturnType<typeof requestBytes>>;
  try {
    fetched = await requestBytes(ctx, url, {}, maxBytes);
  } catch (err) {
    if (!(err instanceof EgressSizeError)) throw err;
    const refused: DatasheetIndexEntry = {
      mpn,
      url,
      retrieved: new Date().toISOString(),
      ...(err.receivedBytes !== undefined ? { size: err.receivedBytes } : {}),
      ...(title ? { title } : {}),
      status: 'not-cached',
      reason: `size exceeds ${cfg.maxPdfMB} MB`,
    };
    await updateIndex(ctx.repoRoot, (latest) => {
      latest.entries.push(refused);
    });
    return refused;
  }
  const hash = createHash('sha256').update(fetched.bytes).digest('hex');
  const existing = index.entries.find((entry) => entry.url === url && entry.sha256 === hash && entry.status === 'cached');
  if (existing) return existing;
  const now = new Date().toISOString();
  const prefix = hash.slice(0, 8);
  const base = `${safeMpn(mpn)}-${prefix}`;
  const pdf = `.copperhead/datasheets/${base}.pdf`;
  const text = `.copperhead/datasheets/${base}.pdf.txt`;
  await mkdir(datasheetDir(ctx.repoRoot), { recursive: true });
  await writeFile(path.join(ctx.repoRoot, pdf), fetched.bytes);
  await writeFile(path.join(ctx.repoRoot, text), extractPdfText(fetched.bytes) + '\n', 'utf8');
  const entry: DatasheetIndexEntry = { mpn, url, retrieved: now, sha256: hash, size: fetched.bytes.byteLength, ...(title ? { title } : {}), pdf, text, status: 'cached' };
  const saved = await updateIndex(ctx.repoRoot, (latest) => {
    const concurrent = latest.entries.find((candidate) => candidate.url === url && candidate.sha256 === hash && candidate.status === 'cached');
    if (concurrent) return { entry: concurrent, old: undefined, created: false };
    const old = latest.entries.find((candidate) => candidate.url === url && candidate.status === 'cached' && candidate.sha256 !== hash);
    latest.entries.push(entry);
    return { entry, old, created: true };
  });
  if (saved.created) ctx.datasheetsCached = (ctx.datasheetsCached ?? 0) + 1;
  const old = saved.old;
  if (old?.pdf) {
    const constraints = await loadConstraints(ctx.repoRoot);
    for (const [key, constraint] of Object.entries(constraints)) {
      if (constraint.source.includes(old.pdf) || constraint.source.includes(old.text ?? '')) {
        ctx.ledger.add('affects-revisit', `${key} cites changed datasheet ${old.pdf}; revisit citation`, key);
      }
    }
  }
  return saved.entry;
}
