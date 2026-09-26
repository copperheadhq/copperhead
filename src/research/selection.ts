import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { RunContext } from '../agent/context.js';
import { markTouched } from '../capabilities/helpers.js';
import { loadConstraints, saveConstraint } from '../memory/constraints.js';
import type { PartResult } from './providers.js';
import type { DatasheetIndexEntry } from './cache.js';

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((value) => value.trim());
}

function updateBomRow(
  markdown: string,
  refdes: string,
  update: (row: string[], mpnColumn: number, rationaleColumn: number) => void,
): string {
  const lines = markdown.split(/\r?\n/);
  let columns: { refdes: number; mpn: number; rationale: number } | undefined;
  let foundNamedHeader = false;
  let updated = false;

  const out = lines.map((line) => {
    if (!line.includes('|')) {
      columns = undefined;
      return line;
    }
    const row = cells(line);
    const refdesColumn = row.findIndex((value) => /^refdes$/i.test(value));
    if (refdesColumn >= 0) {
      const mpnColumn = row.findIndex((value) => /^mpn$/i.test(value));
      const rationaleColumn = row.findIndex((value) => /^rationale$/i.test(value));
      if (mpnColumn < 0 || rationaleColumn < 0) {
        throw new Error('BOM.md part table must contain named Refdes, MPN, and Rationale columns');
      }
      foundNamedHeader = true;
      columns = { refdes: refdesColumn, mpn: mpnColumn, rationale: rationaleColumn };
      return line;
    }
    if (!columns || row.every((value) => /^:?-+:?$/.test(value))) return line;
    if (row[columns.refdes] !== refdes) return line;
    update(row, columns.mpn, columns.rationale);
    updated = true;
    return `| ${row.map(cell).join(' | ')} |`;
  });

  if (!foundNamedHeader) throw new Error('BOM.md has no part table with named Refdes, MPN, and Rationale columns');
  if (!updated) throw new Error(`BOM.md has no row for ${refdes}; pass a refdes that exists before recording research`);
  return out.join('\n');
}

function normalizedMpn(value: string): string {
  return value.replace(/^UNVERIFIED\s*:\s*/i, '').trim().toUpperCase();
}

/** Dual-write a selected search result into constraints.json and BOM.md. */
export async function recordPartSelection(ctx: RunContext, refdes: string, part: PartResult): Promise<void> {
  const key = `sourcing.${refdes}`;
  const retrieved = new Date().toISOString();
  const price = part.priceBreaks.find((candidate) => candidate.quantity >= 1000) ?? part.priceBreaks.at(-1);
  const provider = part.source ?? 'part research';
  const source = `${provider} (${retrieved})`;
  const bomPath = path.join(ctx.repoRoot, ctx.config.docs, 'BOM.md');
  const rationale = `Sourced via ${provider}: ${part.manufacturer} ${part.mpn}; lifecycle ${part.lifecycle}; stock ${part.stockTotal}; retrieved ${retrieved}`;
  const markdown = await readFile(bomPath, 'utf8').catch(() => {
    throw new Error(`BOM.md is missing at ${path.relative(ctx.repoRoot, bomPath)}; create its ${refdes} row before recording a part selection`);
  });
  const updatedBom = updateBomRow(markdown, refdes, (row, mpnColumn, rationaleColumn) => {
    row[mpnColumn] = `UNVERIFIED: ${part.mpn}`;
    const prior = (row[rationaleColumn] ?? '').replace(/\s*VERIFIED\(datasheet\).*$/i, '').trim();
    row[rationaleColumn] = `${prior && prior !== 'UNVERIFIED' ? `${prior} ` : ''}${rationale}`;
  });

  ctx.ledger.onConstraintChange(key, [refdes]);
  await saveConstraint(ctx.repoRoot, key, {
    value: part.mpn,
    mpn: part.mpn,
    lifecycle: part.lifecycle,
    stockTotal: part.stockTotal,
    ...(price ? { price1k: price.unitPrice } : {}),
    retrieved,
    source,
    affects: [refdes],
  });
  ctx.filesTouched.add('.copperhead/constraints.json');
  await writeFile(bomPath, updatedBom, 'utf8');
  markTouched(ctx, path.relative(ctx.repoRoot, bomPath));
  ctx.ledger.clear('constraint-dual-write', key);
  ctx.sourcingSnapshotsWritten = (ctx.sourcingSnapshotsWritten ?? 0) + 1;
}

export async function recordDatasheetEvidence(
  ctx: RunContext,
  refdes: string,
  entry: Pick<DatasheetIndexEntry, 'mpn' | 'pdf' | 'text'>,
  section: string,
): Promise<void> {
  if (!entry.pdf || !entry.text || !section.trim()) throw new Error('datasheet evidence requires a cached PDF and a non-empty section');
  const registry = await loadConstraints(ctx.repoRoot);
  const key = `sourcing.${refdes}`;
  const prior = registry[key];
  if (!prior) throw new Error(`${key} is missing; record a selected part before attaching datasheet evidence`);
  const extracted = await readFile(path.join(ctx.repoRoot, entry.text), 'utf8');
  if (!extracted.includes(section.trim())) throw new Error(`datasheet section "${section.trim()}" is not present in ${entry.text}`);
  const citation = `${entry.pdf} §${section.trim()}`;
  const source = `${prior.source}; ${citation}`;
  const bomPath = path.join(ctx.repoRoot, ctx.config.docs, 'BOM.md');
  const markdown = await readFile(bomPath, 'utf8');
  const updatedBom = updateBomRow(markdown, refdes, (row, mpnColumn, rationaleColumn) => {
    if (normalizedMpn(row[mpnColumn] ?? '') !== normalizedMpn(entry.mpn)) {
      throw new Error(`${refdes} BOM row carries ${row[mpnColumn] || 'no MPN'}, not ${entry.mpn}`);
    }
    row[mpnColumn] = entry.mpn;
    if (!/(?<![A-Z])VERIFIED\(datasheet\)/i.test(row[rationaleColumn] ?? '')) {
      row[rationaleColumn] = `${row[rationaleColumn] ? `${row[rationaleColumn]} ` : ''}VERIFIED(datasheet) ${citation}`;
    }
  });

  ctx.ledger.onConstraintChange(key, [refdes]);
  await saveConstraint(ctx.repoRoot, key, {
    ...prior,
    source,
    evidence: [...(prior.evidence ?? []), citation],
  });
  ctx.filesTouched.add('.copperhead/constraints.json');
  await writeFile(bomPath, updatedBom, 'utf8');
  markTouched(ctx, path.relative(ctx.repoRoot, bomPath));
  ctx.ledger.clear('constraint-dual-write', key);
}
