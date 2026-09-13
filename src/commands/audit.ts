import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { parseNamedMarkdownTables } from '../memory/bom-table.js';
import { resolveInRepo } from '../util/paths.js';
import { researchConfig, researchPartToolGate } from '../research/config.js';
import { JlcSearchProvider } from '../research/jlcsearch.js';
import { NexarPartProvider } from '../research/nexar.js';
import type { PartDataProvider, PartResult } from '../research/providers.js';
import { Transcript } from '../agent/transcript.js';
import { ObligationsLedger } from '../agent/ledger.js';
import type { RunContext } from '../agent/context.js';

export class AuditError extends Error {}

export interface AuditInputRow {
  refdes?: string;
  mpn: string;
  requiredQuantity?: number;
}

export type AuditStatus = 'pass' | 'warning' | 'failure';

export interface PartAuditFinding {
  refdes?: string;
  mpn: string;
  requiredQuantity?: number;
  status: AuditStatus;
  issues: string[];
  part?: PartResult;
}

export interface PartAuditResult {
  ok: boolean;
  input: string;
  provider: 'jlcsearch' | 'nexar';
  findings: PartAuditFinding[];
  report: string;
  output?: string;
  transcriptDir: string;
}

export interface PartAuditOptions {
  repoRoot: string;
  input: string;
  output?: string;
}

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
}

function column(header: string[], names: string[]): number {
  return header.findIndex((cell) => names.includes(normalizedHeader(cell)));
}

function parseQuantity(value: string | undefined, row: number): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value.replace(/,/g, '').trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AuditError(`row ${row}: Required qty must be a positive whole number, got "${value}"`);
  }
  return parsed;
}

/** Parse GFM tables containing an exact `MPN` column and optional identifiers. */
export function parsePartAuditInput(markdown: string): AuditInputRow[] {
  const out: AuditInputRow[] = [];
  for (const table of parseNamedMarkdownTables(markdown)) {
    const headers = table.header.cells;
    const mpnColumn = column(headers, ['mpn', 'manufacturer part number', 'manufacturer part no']);
    if (mpnColumn < 0) continue;
    const refdesColumn = column(headers, ['refdes', 'reference', 'designator']);
    const quantityColumn = column(headers, ['required qty', 'required quantity', 'qty', 'quantity']);
    for (const [index, row] of table.rows.entries()) {
      const mpn = row.cells[mpnColumn]?.trim();
      if (!mpn) throw new AuditError(`row ${index + 1}: MPN is required`);
      const refdes = refdesColumn < 0 ? undefined : row.cells[refdesColumn]?.trim() || undefined;
      const requiredQuantity = quantityColumn < 0 ? undefined : parseQuantity(row.cells[quantityColumn], index + 1);
      out.push({ mpn, ...(refdes ? { refdes } : {}), ...(requiredQuantity ? { requiredQuantity } : {}) });
    }
  }
  if (!out.length) {
    throw new AuditError('no audit rows found: provide a Markdown table with an MPN column (optional: Refdes, Required qty)');
  }
  return out;
}

function exactMpn(results: PartResult[], mpn: string): PartResult | undefined {
  const requested = mpn.trim().toUpperCase();
  return results.find((part) => part.mpn.trim().toUpperCase() === requested);
}

function auditRow(input: AuditInputRow, results: PartResult[]): PartAuditFinding {
  const part = exactMpn(results, input.mpn);
  if (!part) {
    return { ...input, status: 'failure', issues: ['exact MPN was not returned by the selected provider'] };
  }
  const issues: string[] = [];
  let status: AuditStatus = 'pass';
  const lifecycle = part.lifecycle.trim().toLowerCase();
  if (['eol', 'obsolete', 'end-of-life'].includes(lifecycle)) {
    status = 'failure';
    issues.push(`lifecycle is ${part.lifecycle}`);
  }
  if (part.stockTotal <= 0) {
    status = 'failure';
    issues.push('reported stock is zero');
  } else if (input.requiredQuantity !== undefined && part.stockTotal < input.requiredQuantity) {
    status = 'failure';
    issues.push(`reported stock ${part.stockTotal} is below required quantity ${input.requiredQuantity}`);
  }
  if (lifecycle === 'unknown') {
    issues.push('lifecycle was not supplied by the provider');
  }
  if (!part.datasheetUrl) {
    issues.push('datasheet URL was not supplied by the provider');
  }
  if (status !== 'failure' && issues.length) status = 'warning';
  return { ...input, status, issues, part };
}

function cell(value: string | number | undefined): string {
  return String(value ?? '—').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

function price(part: PartResult | undefined): string {
  const found = part?.priceBreaks[0];
  return found ? `${found.unitPrice}${found.currency ? ` ${found.currency}` : ''} @ ${found.quantity}` : '—';
}

function findingLabel(finding: PartAuditFinding): string {
  const quantity = finding.requiredQuantity === undefined ? '' : ` (need ${finding.requiredQuantity})`;
  return `${finding.refdes ? `${finding.refdes} · ` : ''}${finding.mpn}${quantity}`;
}

export function formatPartAudit(result: Omit<PartAuditResult, 'report' | 'output'>): string {
  const available = result.findings.filter((finding) => finding.status !== 'failure');
  const unavailable = result.findings.filter((finding) => finding.status === 'failure');
  const review = result.findings.filter((finding) => finding.status === 'warning');
  const lines = [
    '# Parts availability audit',
    '',
    `- **Input:** ${result.input}`,
    `- **Provider:** ${result.provider}`,
    `- **Outcome:** ${result.ok ? 'PASS' : 'FAIL'}`,
    `- **Audit transcript:** ${result.transcriptDir}`,
    '',
    '## Available now',
    '',
    ...(available.length
      ? available.map((finding) => `- ${findingLabel(finding)} — ${finding.part!.stockTotal} in stock; ${price(finding.part)}`)
      : ['- None']),
    '',
    '## Not available',
    '',
    ...(unavailable.length
      ? unavailable.map((finding) => `- ${findingLabel(finding)} — ${finding.issues.join('; ')}`)
      : ['- None']),
    '',
    '## Needs review',
    '',
    ...(review.length
      ? review.map((finding) => `- ${findingLabel(finding)} — ${finding.issues.join('; ')}`)
      : ['- None']),
    '',
    '## Detail',
    '',
    '| Refdes | MPN | Required qty | Status | Stock | Lifecycle | Price | Datasheet | Notes |',
    '|---|---|---:|---|---:|---|---|---|---|',
  ];
  for (const finding of result.findings) {
    lines.push([
      cell(finding.refdes), cell(finding.mpn), cell(finding.requiredQuantity), finding.status.toUpperCase(),
      cell(finding.part?.stockTotal), cell(finding.part?.lifecycle), cell(price(finding.part)),
      finding.part?.datasheetUrl ? '[link](' + finding.part.datasheetUrl + ')' : '—',
      cell(finding.issues.join('; ') || '—'),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('', 'Stock and pricing are retrieval-time supplier snapshots, not an ordering guarantee.');
  return lines.join('\n') + '\n';
}

function auditContext(repoRoot: string, config: Awaited<ReturnType<typeof loadConfig>>, transcript: Transcript): RunContext {
  return {
    repoRoot,
    config,
    transcript,
    ledger: new ObligationsLedger(false),
    runId: path.basename(transcript.dir),
    interactive: false,
    confirm: async () => true,
    editsUnlocked: false,
    changeId: null,
    proposalValidated: false,
    filesTouched: new Set(),
    decisions: [],
    lastErc: null,
    lastDrc: null,
    lastLegibility: null,
    lastScore: null,
    networkRequests: 0,
    datasheetsCached: 0,
    sourcingSnapshotsWritten: 0,
    repairCycles: 0,
    finishRequest: null,
  };
}

/** Live, model-free audit. It only reads the input and writes an ignored run transcript unless --output is given. */
export async function runPartAudit(opts: PartAuditOptions): Promise<PartAuditResult> {
  const config = await loadConfig(opts.repoRoot);
  if (!researchPartToolGate(config)) {
    throw new AuditError(
      'part audit requires research.enabled=true in .copperhead/config.json; Nexar also requires NEXAR_CLIENT_ID and NEXAR_CLIENT_SECRET',
    );
  }
  const inputPath = resolveInRepo(opts.repoRoot, opts.input);
  const input = path.relative(opts.repoRoot, inputPath) || path.basename(inputPath);
  const rows = parsePartAuditInput(await readFile(inputPath, 'utf8'));
  const transcript = new Transcript(opts.repoRoot);
  await transcript.init();
  const ctx = auditContext(opts.repoRoot, config, transcript);
  const providerName = researchConfig(config).provider;
  const provider: PartDataProvider = providerName === 'nexar' ? new NexarPartProvider() : new JlcSearchProvider();
  await transcript.event('part-audit-start', { input, provider: providerName, rows: rows.length });
  let findings: PartAuditFinding[] = [];
  let failure: unknown;
  try {
    for (const row of rows) {
      const results = await provider.search(ctx, row.mpn, row.mpn);
      const finding = auditRow(row, results);
      findings.push(finding);
      await transcript.event('part-audit-row', { mpn: row.mpn, refdes: row.refdes, status: finding.status, issues: finding.issues });
    }
  } catch (err) {
    failure = err;
  }
  const ok = !failure && findings.every((finding) => finding.status !== 'failure');
  const partial = { ok, input, provider: providerName, findings, transcriptDir: transcript.dir };
  const report = formatPartAudit(partial);
  let output: string | undefined;
  if (!failure && opts.output) {
    const outputPath = resolveInRepo(opts.repoRoot, opts.output);
    await writeFile(outputPath, report, 'utf8');
    output = path.relative(opts.repoRoot, outputPath);
  }
  await transcript.event('part-audit-finish', { ok, findings: findings.length, ...(failure ? { error: (failure as Error).message } : {}) });
  await transcript.writeSummary({
    request: `audit ${input}`,
    changeId: null,
    plan: 'Live, model-free supplier audit; no BOM or constraint snapshots were written.',
    filesTouched: output ? [output] : [],
    ercResult: null,
    drcResult: null,
    decisions: [],
    tokensIn: 0,
    tokensOut: 0,
    outcome: failure || !ok ? 'failure' : 'success',
    openObligations: null,
    ...(failure ? { detail: (failure as Error).message } : {}),
    research: { requests: ctx.networkRequests ?? 0, datasheetsCached: 0, snapshotsWritten: 0 },
  });
  if (failure) throw failure;
  return { ...partial, report, ...(output ? { output } : {}) };
}
