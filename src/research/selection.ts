import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunContext } from '../agent/context.js';
import { saveConstraint } from '../memory/constraints.js';
import type { PartResult } from './providers.js';
import type { DatasheetIndexEntry } from './cache.js';

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** Dual-write a selected search result into constraints.json and BOM.md. */
export async function recordPartSelection(ctx: RunContext, refdes: string, part: PartResult): Promise<void> {
  const key = `sourcing.${refdes}`;
  const retrieved = new Date().toISOString();
  const price = part.priceBreaks.find((p) => p.quantity >= 1000) ?? part.priceBreaks.at(-1);
  const provider = part.source ?? 'part research';
  const source = `${provider} (${retrieved})`;
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

  const bomPath = path.join(ctx.repoRoot, ctx.config.docs, 'BOM.md');
  const rationale = `Sourced via ${provider}: ${part.manufacturer} ${part.mpn}; lifecycle ${part.lifecycle}; stock ${part.stockTotal}; retrieved ${retrieved}`;
  if (await fileExists(bomPath)) {
    const lines = (await readFile(bomPath, 'utf8')).split(/\r?\n/);
    let updated = false;
    const out = lines.map((line) => {
      if (!line.includes('|') || /^\s*\|?\s*Refdes\b/i.test(line) || /^\s*\|?\s*-+/.test(line)) return line;
      const raw = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((v) => v.trim());
      if (raw[0] !== refdes) return line;
      while (raw.length < 5) raw.push('');
      raw[3] = part.mpn;
      raw[4] = `${raw[4] && raw[4] !== 'UNVERIFIED' ? raw[4] + ' ' : ''}${rationale}`;
      updated = true;
      return `| ${raw.map(cell).join(' | ')} |`;
    });
    if (!updated) throw new Error(`BOM.md has no row for ${refdes}; pass a refdes that exists before recording a part selection`);
    await writeFile(bomPath, out.join('\n'), 'utf8');
  } else {
    await mkdir(path.dirname(bomPath), { recursive: true });
    await appendFile(bomPath, `\n\nSourcing ${refdes}: ${rationale}\n`, 'utf8');
  }
  ctx.filesTouched.add(path.relative(ctx.repoRoot, bomPath));
  ctx.filesTouched.add('.copperhead/constraints.json');
  ctx.sourcingSnapshotsWritten = (ctx.sourcingSnapshotsWritten ?? 0) + 1;
  ctx.ledger.clear('constraint-dual-write', key);
  ctx.ledger.clear('affects-revisit', `${key} affects ${refdes}`);
}

export async function recordDatasheetEvidence(ctx: RunContext, refdes: string, entry: Pick<DatasheetIndexEntry, 'mpn' | 'pdf' | 'text'>, section: string): Promise<void> {
  if (!entry.pdf || !entry.text || !section.trim()) throw new Error('datasheet evidence requires a cached PDF and a non-empty section');
  const { loadConstraints } = await import('../memory/constraints.js');
  const registry = await loadConstraints(ctx.repoRoot);
  const key = `sourcing.${refdes}`;
  const prior = registry[key];
  if (!prior) throw new Error(`${key} is missing; record a selected part before attaching datasheet evidence`);
  const extracted = await readFile(path.join(ctx.repoRoot, entry.text), 'utf8');
  if (!extracted.includes(section.trim())) throw new Error(`datasheet section "${section.trim()}" is not present in ${entry.text}`);
  const source = `${prior.source}; ${entry.pdf} §${section.trim()}`;
  await saveConstraint(ctx.repoRoot, key, { ...prior, source, evidence: [...(prior.evidence ?? []), `${entry.pdf} §${section.trim()}`] });
  const bomPath = path.join(ctx.repoRoot, ctx.config.docs, 'BOM.md');
  const md = await readFile(bomPath, 'utf8');
  const lines = md.split(/\r?\n/);
  let updated = false;
  const out = lines.map((line) => {
    if (!line.includes('|') || /^\s*\|?\s*Refdes\b/i.test(line) || /^\s*\|?\s*-+/.test(line)) return line;
    const raw = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((v) => v.trim());
    if (raw[0] !== refdes) return line;
    while (raw.length < 5) raw.push('');
    if (raw[3] !== entry.mpn) throw new Error(`${refdes} BOM row carries ${raw[3] || 'no MPN'}, not ${entry.mpn}`);
    if (!/VERIFIED\(datasheet\)/i.test(raw[4]!)) raw[4] = `${raw[4] ? raw[4] + ' ' : ''}VERIFIED(datasheet) ${entry.pdf} §${section.trim()}`;
    updated = true;
    return `| ${raw.map(cell).join(' | ')} |`;
  });
  if (!updated) throw new Error(`BOM.md has no row for ${refdes}`);
  await writeFile(bomPath, out.join('\n'), 'utf8');
  ctx.filesTouched.add(path.relative(ctx.repoRoot, bomPath));
  ctx.filesTouched.add('.copperhead/constraints.json');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await readFile(p, 'utf8');
    return true;
  } catch {
    return false;
  }
}
