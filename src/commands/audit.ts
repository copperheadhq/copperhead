import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { AuditError, parsePartAuditInput, type AuditInputRow } from '../research/markdown-parts.js';
import { resolveInRepo } from '../util/paths.js';
import { researchConfig, researchPartToolGate } from '../research/config.js';
import { JlcSearchProvider } from '../research/jlcsearch.js';
import { NexarPartProvider } from '../research/nexar.js';
import type { PartDataProvider, PartResult } from '../research/providers.js';
import { Transcript } from '../agent/transcript.js';
import { ObligationsLedger } from '../agent/ledger.js';
import type { RunContext } from '../agent/context.js';

export { AuditError, parsePartAuditInput, type AuditInputRow } from '../research/markdown-parts.js';

export type AuditStatus = 'pass' | 'warning' | 'failure';

export interface PartCandidate {
  part: PartResult;
  status: AuditStatus;
  issues: string[];
}

export interface PartAuditFinding extends AuditInputRow {
  match: 'exact' | 'candidates' | 'none';
  status: AuditStatus;
  issues: string[];
  part?: PartResult;
  candidates?: PartCandidate[];
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

function assessPart(part: PartResult, requiredQuantity?: number): PartCandidate {
  const issues: string[] = [];
  let status: AuditStatus = 'pass';
  const lifecycle = part.lifecycle.trim().toLowerCase();
  if (['eol', 'obsolete', 'end-of-life', 'end of life'].includes(lifecycle)) {
    status = 'failure';
    issues.push(`Lifecycle: ${part.lifecycle}`);
  }
  if (part.stockTotal <= 0) {
    status = 'failure';
    issues.push('Out of stock');
  } else if (requiredQuantity !== undefined && part.stockTotal < requiredQuantity) {
    status = 'failure';
    issues.push(`Not enough stock: need ${requiredQuantity.toLocaleString('en-US')}`);
  }
  const missing: string[] = [];
  if (!lifecycle || lifecycle === 'unknown') missing.push('lifecycle');
  if (!part.datasheetUrl) missing.push('datasheet');
  if (missing.length) issues.push(`Supplier did not provide ${missing.join(' or ')}`);
  if (status !== 'failure' && issues.length) status = 'warning';
  return { status, issues, part };
}

function auditRow(input: AuditInputRow, results: PartResult[]): PartAuditFinding {
  const requested = (input.mpn ?? input.query).trim().toUpperCase();
  const exact = results.find((part) => [part.mpn, part.supplierPartNumber].some((id) => id?.trim().toUpperCase() === requested));
  if (exact) return { ...input, match: 'exact', ...assessPart(exact, input.requiredQuantity) };
  if (input.mpn || !results.length) {
    return { ...input, match: 'none', status: 'failure', issues: [input.mpn
      ? 'Exact part number was not returned by the supplier. Check the number or try a part name.'
      : 'No matches returned. Try a shorter name, a package, or an exact part number.'] };
  }
  const seen = new Set<string>();
  const candidates = results.filter((part) => {
    const key = (part.supplierPartNumber ?? part.mpn).toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((part) => assessPart(part, input.requiredQuantity))
    // Preserve supplier relevance within each stock/lifecycle group.
    .sort((a, b) => Number(a.status === 'failure') - Number(b.status === 'failure')).slice(0, 3);
  return { ...input, match: 'candidates', status: 'warning', issues: ['Choose a candidate and check its specifications; compatibility has not been verified.'], candidates };
}

function cell(value: string | number | undefined): string {
  return String(value ?? '—').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

function price(part: PartResult | undefined, requiredQuantity?: number): string {
  const breaks = [...(part?.priceBreaks ?? [])].sort((a, b) => a.quantity - b.quantity);
  const eligible = breaks.filter((entry) => entry.quantity <= (requiredQuantity ?? 1));
  const found = eligible.at(-1) ?? breaks[0];
  return found ? `${found.unitPrice}${found.currency ? ` ${terminalText(found.currency)}` : ''}/each (${found.quantity}+${found.currency ? '' : '; currency unknown'})` : 'not supplied';
}

function terminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
}

function partDetails(candidate: PartCandidate, quantity: number | undefined, indent: string): string[] {
  const { part, issues } = candidate;
  const identity = [part.manufacturer === 'unknown' ? undefined : part.manufacturer, part.package, part.supplierPartNumber].filter(Boolean);
  const lines: string[] = [];
  if (identity.length) lines.push(`${indent}${identity.map((value) => terminalText(value!)).join(' · ')}`);
  if (part.description) {
    const description = terminalText(part.description);
    lines.push(`${indent}${description.length > 120 ? `${description.slice(0, 117)}…` : description}`);
  }
  const needed = quantity === undefined ? '' : ` (need ${quantity.toLocaleString('en-US')})`;
  lines.push(`${indent}Stock: ${part.stockTotal.toLocaleString('en-US')}${needed} · Price: ${price(part, quantity)}`);
  if (issues.length) lines.push(`${indent}${candidate.status === 'failure' ? 'Reason' : 'Review'}: ${issues.map(terminalText).join('; ')}`);
  if (part.supplierUrl) lines.push(`${indent}Part: ${terminalText(part.supplierUrl)}`);
  if (part.datasheetUrl) lines.push(`${indent}Datasheet: ${terminalText(part.datasheetUrl)}`);
  return lines;
}

function groups(findings: PartAuditFinding[]) {
  return {
    available: findings.filter((f) => f.match === 'exact' && f.status !== 'failure'),
    unavailable: findings.filter((f) => f.match === 'exact' && f.status === 'failure'),
    candidates: findings.filter((f) => f.match === 'candidates'),
    missing: findings.filter((f) => f.match === 'none'),
    review: findings.filter((f) => f.match === 'exact' && f.status === 'warning'),
  };
}

/** Human-readable results with mutually exclusive match counts and separate metadata notes. */
export function formatPartCheckTerminal(result: PartAuditResult): string {
  const { available, unavailable, candidates, missing, review } = groups(result.findings);
  const counts = [
    `${available.length} available${review.length ? ` (${review.length} need${review.length === 1 ? 's' : ''} review)` : ''}`,
    `${unavailable.length} unavailable`,
    ...(candidates.length ? [`${candidates.length} to choose`] : []),
    ...(missing.length ? [`${missing.length} not found`] : []),
  ];
  const lines = [
    `Parts check · ${terminalText(result.input)}`,
    `${result.provider === 'jlcsearch' ? 'JLCSearch' : 'Nexar'} · ${result.findings.length} part${result.findings.length === 1 ? '' : 's'} checked`,
    counts.join(' · '),
  ];
  for (const [heading, findings] of [
    ['Available', available], ['Choose a part', candidates], ['Not available', unavailable], ['Not found', missing],
  ] as const) {
    if (!findings.length) continue;
    lines.push('', `${heading} (${findings.length})`);
    for (const finding of findings) {
      const label = [finding.refdes, finding.query].filter(Boolean).join(' · ');
      lines.push(`  ${terminalText(label)} · line ${finding.line}`);
      if (finding.part) {
        lines.push(`    Exact match: ${terminalText(finding.part.mpn)}`);
        lines.push(...partDetails({ part: finding.part, status: finding.status, issues: finding.issues }, finding.requiredQuantity, '    '));
      } else if (finding.candidates) {
        lines.push(`    ${finding.candidates.length} suggested match${finding.candidates.length === 1 ? '' : 'es'} — check specifications before choosing`);
        for (const [index, candidate] of finding.candidates.entries()) {
          lines.push(`    ${index + 1}. ${terminalText(candidate.part.mpn)} · ${candidate.status === 'failure' ? 'unavailable for this request' : 'in stock'}`);
          lines.push(...partDetails(candidate, finding.requiredQuantity, '       '));
        }
      } else lines.push(`    ${finding.issues.map(terminalText).join('; ')}`);
      lines.push('');
    }
    if (lines.at(-1) === '') lines.pop();
  }
  if (candidates.length) lines.push('', 'To check a candidate exactly, add its MPN or LCSC number to the file (e.g. MPN: NE555P) and run again.');
  lines.push('', 'Stock and prices are supplier snapshots, not ordering guarantees.');
  if (result.output) lines.push(`Report: ${terminalText(result.output)}`);
  lines.push(`Run log: .copperhead/runs/${path.basename(result.transcriptDir)}`);
  return lines.join('\n');
}

function findingLabel(finding: PartAuditFinding): string {
  const quantity = finding.requiredQuantity === undefined ? '' : ` (need ${finding.requiredQuantity})`;
  return `${finding.refdes ? `${finding.refdes} · ` : ''}${finding.query}${quantity} · line ${finding.line}`;
}

function markdownMetadata(part: PartResult): string[] {
  const identity = [part.manufacturer === 'unknown' ? undefined : part.manufacturer, part.package, part.supplierPartNumber].filter(Boolean);
  return [
    ...(identity.length ? [`  - ${cell(identity.join(' · '))}`] : []),
    ...(part.description ? [`  - ${cell(part.description)}`] : []),
    ...(part.supplierUrl ? [`  - Part: ${cell(part.supplierUrl)}`] : []),
    ...(part.datasheetUrl ? [`  - Datasheet: ${cell(part.datasheetUrl)}`] : []),
  ];
}

export function formatPartAudit(result: Omit<PartAuditResult, 'report' | 'output'>): string {
  const { available, unavailable, candidates, missing, review } = groups(result.findings);
  const lines = [
    '# Parts availability check', '',
    `- **Input:** ${cell(result.input)}`,
    `- **Provider:** ${result.provider}`,
    `- **Outcome:** ${!result.ok ? 'FAIL' : review.length || candidates.length ? 'NEEDS REVIEW' : 'PASS'}`,
    `- **Run log:** ${result.transcriptDir}`, '',
    'A part can be available and need review when supplier metadata is incomplete.', '',
    '## Available now', '',
    ...(available.length ? available.flatMap((f) => [
      `- ${cell(findingLabel(f))} — ${f.part!.stockTotal} in stock; ${price(f.part, f.requiredQuantity)}${f.status === 'warning' ? '; needs review' : ''}`,
      ...markdownMetadata(f.part!),
    ]) : ['- None']), '',
    '## Not available', '',
    ...(unavailable.length ? unavailable.flatMap((f) => [
      `- ${cell(findingLabel(f))} — ${cell(f.issues.join('; '))}`,
      ...markdownMetadata(f.part!),
    ]) : ['- None']), '',
    '## Not found', '',
    ...(missing.length ? missing.map((f) => `- ${cell(findingLabel(f))} — ${cell(f.issues.join('; '))}`) : ['- None']), '',
    '## Needs review', '',
    ...(review.length ? review.map((f) => `- ${cell(findingLabel(f))} — ${cell(f.issues.join('; '))}`) : ['- None']), '',
    '## Choose a part', '',
    'Suggested matches are not confirmed selections. Check specifications and rerun with the chosen MPN or LCSC number.', '',
  ];
  if (!candidates.length) lines.push('- None', '');
  for (const finding of candidates) {
    lines.push(`### ${cell(findingLabel(finding))}`, '');
    for (const candidate of finding.candidates!) {
      const p = candidate.part;
      lines.push(`- **${cell(p.mpn)}** — ${candidate.status === 'failure' ? 'unavailable for this request' : 'in stock'}; ${p.stockTotal} in stock; ${price(p, finding.requiredQuantity)}`);
      lines.push(...markdownMetadata(p));
      if (candidate.issues.length) lines.push(`  - ${candidate.status === 'failure' ? 'Reason' : 'Review'}: ${cell(candidate.issues.join('; '))}`);
    }
    lines.push('');
  }
  lines.push('## Detail', '',
    '| Refdes | MPN | Required qty | Status | Stock | Lifecycle | Price | Datasheet | Notes |',
    '|---|---|---:|---|---:|---|---|---|---|');
  for (const finding of result.findings) {
    lines.push([
      cell(finding.refdes), cell(finding.part?.mpn ?? finding.query), cell(finding.requiredQuantity), finding.match === 'candidates' ? 'CHOOSE A PART' : finding.status.toUpperCase(),
      cell(finding.part?.stockTotal), cell(finding.part?.lifecycle), cell(price(finding.part, finding.requiredQuantity)),
      cell(finding.part?.datasheetUrl), cell(finding.issues.join('; ') || '—'),
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
      'parts check requires research.enabled=true in .copperhead/config.json; Nexar also requires NEXAR_CLIENT_ID and NEXAR_CLIENT_SECRET',
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
  const findings: PartAuditFinding[] = [];
  const cache = new Map<string, PartResult[]>();
  let failure: unknown;
  try {
    for (const row of rows) {
      const key = row.query.toUpperCase();
      let results = cache.get(key);
      if (!results) {
        results = await provider.search(ctx, row.query, row.mpn);
        cache.set(key, results);
      }
      const finding = auditRow(row, results);
      findings.push(finding);
      await transcript.event('part-audit-row', { query: row.query, line: row.line, mpn: row.mpn, refdes: row.refdes, match: finding.match, status: finding.status, issues: finding.issues });
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
    request: `parts check ${input}`,
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
