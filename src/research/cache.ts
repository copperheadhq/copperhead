import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunContext } from '../agent/context.js';
import { requestBytes } from './net.js';
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

export function datasheetDir(repoRoot: string): string {
  return path.join(repoRoot, '.copperhead', 'datasheets');
}

async function loadIndex(repoRoot: string): Promise<DatasheetIndex> {
  const p = path.join(datasheetDir(repoRoot), 'index.json');
  if (!existsSync(p)) return { version: 1, entries: [] };
  const raw = JSON.parse(await readFile(p, 'utf8')) as Partial<DatasheetIndex>;
  return { version: 1, entries: Array.isArray(raw.entries) ? raw.entries : [] };
}

async function saveIndex(repoRoot: string, index: DatasheetIndex): Promise<void> {
  await mkdir(datasheetDir(repoRoot), { recursive: true });
  await writeFile(path.join(datasheetDir(repoRoot), 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
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
      for (const match of page.matchAll(/\(([^()]*(?:\\.[^()]*)*)\)\s*T[Jj]/g)) {
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
  const maxBytes = researchConfig(ctx.config).maxPdfMB * 1024 * 1024;
  // Read just past the configured limit so the cache can write a traceable
  // `not-cached` entry instead of losing the URL to the generic egress cap.
  const fetched = await requestBytes(ctx, url, {}, Math.floor(maxBytes) + 1);
  const hash = createHash('sha256').update(fetched.bytes).digest('hex');
  const existing = index.entries.find((entry) => entry.url === url && entry.sha256 === hash && entry.status === 'cached');
  if (existing) return existing;
  const now = new Date().toISOString();
  if (fetched.bytes.byteLength > maxBytes) {
    const refused: DatasheetIndexEntry = { mpn, url, retrieved: now, size: fetched.bytes.byteLength, ...(title ? { title } : {}), status: 'not-cached', reason: `size exceeds ${researchConfig(ctx.config).maxPdfMB} MB` };
    index.entries.push(refused);
    await saveIndex(ctx.repoRoot, index);
    return refused;
  }
  const prefix = hash.slice(0, 8);
  const base = `${safeMpn(mpn)}-${prefix}`;
  const pdf = `.copperhead/datasheets/${base}.pdf`;
  const text = `.copperhead/datasheets/${base}.pdf.txt`;
  await mkdir(datasheetDir(ctx.repoRoot), { recursive: true });
  await writeFile(path.join(ctx.repoRoot, pdf), fetched.bytes);
  await writeFile(path.join(ctx.repoRoot, text), extractPdfText(fetched.bytes) + '\n', 'utf8');
  const entry: DatasheetIndexEntry = { mpn, url, retrieved: now, sha256: hash, size: fetched.bytes.byteLength, ...(title ? { title } : {}), pdf, text, status: 'cached' };
  const old = index.entries.find((candidate) => candidate.url === url && candidate.status === 'cached' && candidate.sha256 !== hash);
  index.entries.push(entry);
  await saveIndex(ctx.repoRoot, index);
  ctx.datasheetsCached = (ctx.datasheetsCached ?? 0) + 1;
  if (old?.pdf) {
    const constraints = await loadConstraints(ctx.repoRoot);
    for (const [key, constraint] of Object.entries(constraints)) {
      if (constraint.source.includes(old.pdf) || constraint.source.includes(old.text ?? '')) {
        ctx.ledger.add('affects-revisit', `${key} cites changed datasheet ${old.pdf}; revisit citation`, key);
      }
    }
  }
  return entry;
}

export async function readDatasheetIndex(repoRoot: string): Promise<DatasheetIndexEntry[]> {
  return (await loadIndex(repoRoot)).entries;
}
