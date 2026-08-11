import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { parseBom, HEADER_ALIASES, norm } from '../kicad/bom-export.js';
import { verifyMpn, type VerificationResult, type MpnStatus } from '../kicad/catalog.js';

export class VerificationError extends Error {}

export interface VerifyPartsOptions {
  repoRoot: string;
  update?: boolean;
  strict?: boolean;
  log?: (s: string) => void;
}

export interface VerifyPartsResult {
  ok: boolean;
  results: VerificationResult[];
}

/**
 * Updates BOM.md LCSC column for resolved parts.
 */
export function updateBomLcsc(md: string, mpnToLcsc: Map<string, string>): { updatedMd: string; updatedCount: number } {
  const lineEnd = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);
  
  let headerRowIdx = -1;
  let lcscColIdx = -1;
  let mpnColIdx = -1;
  let headerCells: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] || '').trim();
    if (!line.startsWith('|')) continue;
    
    const cells = line.endsWith('|')
      ? line.split('|').slice(1, -1).map(c => c.trim())
      : line.split('|').slice(1).map(c => c.trim());
      
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator
    
    if (cells.some((c) => norm(c) === 'refdes' || norm(c) === 'reference' || norm(c) === 'designator')) {
      headerRowIdx = i;
      headerCells = cells;
      cells.forEach((c, idx) => {
        const field = HEADER_ALIASES[norm(c)];
        if (field === 'lcsc') lcscColIdx = idx;
        if (field === 'mpn') mpnColIdx = idx;
      });
      break;
    }
  }
  
  if (headerRowIdx === -1 || mpnColIdx === -1) {
    return { updatedMd: md, updatedCount: 0 };
  }
  
  if (lcscColIdx === -1) {
    console.warn("no LCSC column in docs/BOM.md; add one to use --update");
    return { updatedMd: md, updatedCount: 0 };
  }
  
  let updatedCount = 0;
  const updatedLines = [...lines];
  
  for (let i = headerRowIdx + 1; i < lines.length; i++) {
    const line = lines[i] || '';
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    
    const cells = trimmed.endsWith('|')
      ? trimmed.split('|').slice(1, -1).map(c => c.trim())
      : trimmed.split('|').slice(1).map(c => c.trim());
      
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // separator
    
    if (cells.length !== headerCells.length) {
      continue; // Skip rows where cell count does not match header to avoid corruption
    }
    
    const mpn = cells[mpnColIdx];
    if (mpn) {
      const resolvedLcsc = mpnToLcsc.get(mpn.trim().toLowerCase());
      if (resolvedLcsc && cells[lcscColIdx] !== resolvedLcsc) {
        cells[lcscColIdx] = resolvedLcsc;
        updatedCount++;
        updatedLines[i] = `| ${cells.join(' | ')} |`;
      }
    }
  }
  
  return { updatedMd: updatedLines.join(lineEnd), updatedCount };
}

/**
 * Runs part verification on BOM.md against LCSC distributor catalog.
 */
export async function runVerifyParts(opts: VerifyPartsOptions): Promise<VerifyPartsResult> {
  const config = await loadConfig(opts.repoRoot);
  const bomPath = path.join(opts.repoRoot, config.docs, 'BOM.md');
  if (!existsSync(bomPath)) {
    throw new VerificationError(
      `no ${path.join(config.docs, 'BOM.md')} to verify — run copperhead init on an existing project, or copperhead create`,
    );
  }

  const bomContent = await readFile(bomPath, 'utf8');
  const rows = parseBom(bomContent);

  const uniqueMpns = [...new Set(rows.filter(r => r.hasMpn).map(r => r.mpn.trim()))];
  const mpnResolutions = new Map<string, { status: MpnStatus; lcscCode?: string; candidates?: import('../kicad/catalog.js').CatalogItem[] }>();

  // Fetch resolutions in parallel batches of 5 to limit concurrency
  await batchParallel(uniqueMpns, 5, async (mpn) => {
    let attempts = 0;
    while (attempts < 2) {
      try {
        const res = await verifyMpn(mpn);
        mpnResolutions.set(mpn.toLowerCase(), {
          status: res.status,
          lcscCode: res.item?.lcscCode,
          candidates: res.candidates,
        });
        return;
      } catch (err) {
        attempts++;
        if (attempts < 2) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        // Degrade connection errors to LOOKUP FAILED / failed state for strict mode,
        // but surface that this was a lookup failure, not a genuine catalog miss.
        console.warn(err instanceof Error ? err.message : String(err));
        mpnResolutions.set(mpn.toLowerCase(), {
          status: 'LOOKUP FAILED',
        });
      }
    }
  });

  const results: VerificationResult[] = rows.map((row) => {
    if (!row.hasMpn) {
      return {
        refdes: row.refdes,
        mpn: row.mpn.trim(),
        status: 'SKIPPED',
        lcscCode: row.lcsc || undefined,
      };
    }
    const cleanMpn = row.mpn.trim();
    const resolution = mpnResolutions.get(cleanMpn.toLowerCase());
    return {
      refdes: row.refdes,
      mpn: cleanMpn,
      status: resolution?.status ?? 'NOT FOUND',
      lcscCode: resolution?.lcscCode || row.lcsc || undefined,
      candidates: resolution?.candidates,
    };
  });

  // Check overall validity
  const hasNotFound = results.some((r) => r.status === 'NOT FOUND');
  const hasLookupFailed = results.some((r) => r.status === 'LOOKUP FAILED');
  const hasNoStock = results.some((r) => r.status === 'NO STOCK');
  const ok = opts.strict
    ? (!hasNotFound && !hasNoStock && !hasLookupFailed)
    : (!hasNotFound && !hasLookupFailed);

  // Print tabular summary to log callback if provided
  const log = opts.log;
  if (log) {
    log(`\nVerifying BOM parts against catalog...`);
    log(`Refdes`.padEnd(10) + `MPN`.padEnd(25) + `Status`.padEnd(15) + `LCSC`);
    log(`-`.repeat(60));
    for (const r of results) {
      const mpnStr = r.mpn || '(empty)';
      log(
        r.refdes.padEnd(10) +
        mpnStr.padEnd(25) +
        r.status.padEnd(15) +
        (r.lcscCode || '-')
      );
      if (r.status === 'NOT FOUND' && r.candidates && r.candidates.length > 0) {
        const suggestions = r.candidates.slice(0, 3).map(c => c.mfr).join(', ');
        log(`  └─ Hint (near matches in catalog): ${suggestions}`);
      }
    }
    log('');
  }

  if (opts.update) {
    const mpnToLcsc = new Map<string, string>();
    for (const [mpn, res] of mpnResolutions.entries()) {
      if (res.status === 'RESOLVED' && res.lcscCode) {
        mpnToLcsc.set(mpn, res.lcscCode);
      }
    }
    const { updatedMd, updatedCount } = updateBomLcsc(bomContent, mpnToLcsc);
    if (updatedCount > 0) {
      await writeFile(bomPath, updatedMd, 'utf8');
      if (log) {
        log(`Updated ${updatedCount} LCSC code(s) in BOM.md.\n`);
      }
    }
  }

  return { ok, results };
}

/**
 * Runs a map function over items in parallel batches of a specified size to limit concurrency.
 */
async function batchParallel<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}
