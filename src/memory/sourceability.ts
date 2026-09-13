import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ResearchConfig } from '../config.js';
import { loadConstraints, type ConstraintRegistry } from './constraints.js';
import { parseBomTable } from './bom-table.js';

export interface SourceabilityFinding {
  refdes: string;
  kind: 'missing' | 'stale' | 'zero-stock' | 'lifecycle' | 'citation';
  detail: string;
  severity: 'warning' | 'error';
}

export interface SourceabilityReport {
  findings: SourceabilityFinding[];
  snapshots: number;
}

function stale(retrieved: string, days: number): boolean {
  const timestamp = Date.parse(retrieved);
  return !Number.isFinite(timestamp) || Date.now() - timestamp > days * 86_400_000;
}

async function citationFindings(repoRoot: string, constraints: ConstraintRegistry): Promise<SourceabilityFinding[]> {
  const indexPath = path.join(repoRoot, '.copperhead', 'datasheets', 'index.json');
  const entries: { pdf?: string; text?: string; status?: string }[] = existsSync(indexPath)
    ? ((JSON.parse(await readFile(indexPath, 'utf8')) as { entries?: unknown[] }).entries ?? []).filter(
        (entry): entry is { pdf?: string; text?: string; status?: string } => !!entry && typeof entry === 'object',
      )
    : [];
  const byPdf = new Map(entries.filter((e) => e.pdf).map((e) => [e.pdf!, e]));
  const out: SourceabilityFinding[] = [];
  for (const [key, constraint] of Object.entries(constraints)) {
    if (!constraint.source.includes('.copperhead/datasheets/')) continue;
    const refdes = key.replace(/^sourcing\./, '');
    const match = constraint.source.match(/(\.copperhead\/datasheets\/[^\s§,)]+)/);
    const entry = match ? byPdf.get(match[1]!.replace(/\.pdf\.txt$/, '.pdf')) ?? byPdf.get(match[1]!) : undefined;
    if (!entry || entry.status !== 'cached' || !entry.pdf || !entry.text) {
      out.push({ refdes, kind: 'citation', detail: `${key} cites a missing or uncached datasheet artifact`, severity: 'error' });
      continue;
    }
    const pdfPath = path.join(repoRoot, entry.pdf);
    if (!existsSync(pdfPath)) {
      out.push({ refdes, kind: 'citation', detail: `${key} cites missing file ${entry.pdf}`, severity: 'error' });
      continue;
    }
    const indexed = (entries.find((candidate) => candidate.pdf === entry.pdf) as { sha256?: string } | undefined)?.sha256;
    if (indexed && createHash('sha256').update(await readFile(pdfPath)).digest('hex') !== indexed) {
      out.push({ refdes, kind: 'citation', detail: `${key} cites ${entry.pdf}, but its content hash differs from datasheets/index.json`, severity: 'error' });
      continue;
    }
    const section = constraint.source.split('§')[1]?.trim();
    if (section && !existsSync(path.join(repoRoot, entry.text))) {
      out.push({ refdes, kind: 'citation', detail: `${key} cites missing extracted text ${entry.text}`, severity: 'error' });
    } else if (section) {
      const text = await readFile(path.join(repoRoot, entry.text), 'utf8');
      if (!text.includes(section)) out.push({ refdes, kind: 'citation', detail: `${key} citation section "${section}" is absent from ${entry.text}`, severity: 'error' });
    }
  }
  return out;
}

export async function checkSourceability(repoRoot: string, docsDir: string, config: ResearchConfig | undefined, strict: boolean): Promise<SourceabilityReport> {
  const findings: SourceabilityFinding[] = [];
  const constraints = await loadConstraints(repoRoot);
  const bomPath = path.join(repoRoot, docsDir, 'BOM.md');
  if (!existsSync(bomPath)) return { findings: await citationFindings(repoRoot, constraints), snapshots: 0 };
  const rows = parseBomTable(await readFile(bomPath, 'utf8')).filter((row) => row.mpn && row.mpn !== 'UNVERIFIED');
  let snapshots = 0;
  const days = config?.stalenessDays ?? 30;
  for (const row of rows) {
    const key = `sourcing.${row.refdes}`;
    const snapshot = constraints[key];
    if (!snapshot) {
      findings.push({ refdes: row.refdes, kind: 'missing', detail: `${key} is missing for MPN ${row.mpn}`, severity: strict ? 'error' : 'warning' });
      continue;
    }
    snapshots++;
    const lifecycle = String(snapshot.lifecycle ?? '').toLowerCase();
    if (lifecycle === 'eol' || lifecycle === 'obsolete' || lifecycle === 'end-of-life') {
      findings.push({ refdes: row.refdes, kind: 'lifecycle', detail: `${row.refdes} lifecycle is ${snapshot.lifecycle}`, severity: 'error' });
    }
    if (Number(snapshot.stockTotal ?? 0) <= 0) findings.push({ refdes: row.refdes, kind: 'zero-stock', detail: `${row.refdes} had zero stock at retrieval`, severity: strict ? 'error' : 'warning' });
    if (typeof snapshot.retrieved !== 'string' || stale(snapshot.retrieved, days)) findings.push({ refdes: row.refdes, kind: 'stale', detail: `${row.refdes} sourcing snapshot is older than ${days} days`, severity: strict ? 'error' : 'warning' });
  }
  findings.push(...(await citationFindings(repoRoot, constraints)));
  return { findings, snapshots };
}
