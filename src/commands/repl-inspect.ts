/**
 * Read-only inspect helpers for REPL slash commands (/sync, /config, /runs…).
 * All deterministic, no LLM.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { execa } from 'execa';
import { loadConfig } from '../config.js';
import { checkDrift } from '../memory/drift.js';
import { loadConstraints } from '../memory/constraints.js';
import { parseBomTable } from '../memory/bom-table.js';
import { syncVerify, formatSyncReport } from './sync.js';
import { listSymbols, listNets, pinNets } from '../kicad/sexp.js';
import { openspecValidate } from '../openspec/cli.js';
import { copper, dim, ok, warn, err } from '../agent/theme.js';
import { traceRule } from '../agent/animate.js';
import { shortPath } from '../util/paths.js';
import { branchName, headCommit, isDirty, isGitRepo, uncommittedCount } from '../util/git.js';

function meta(label: string, value: string): string {
  return `  ${dim(label.padEnd(12))} ${value}`;
}

async function sortedRunIds(repoRoot: string): Promise<string[]> {
  const runsDir = path.join(repoRoot, '.copperhead', 'runs');
  if (!existsSync(runsDir)) return [];
  return (await readdir(runsDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
}

async function resolveSchematic(
  repoRoot: string,
): Promise<{ schPath: string } | { message: string }> {
  const config = await loadConfig(repoRoot);
  if (!config.schematic) {
    return { message: 'no schematic configured (run copperhead init)' };
  }
  const schPath = path.join(repoRoot, config.schematic);
  if (!existsSync(schPath)) {
    return { message: `schematic missing: ${config.schematic}` };
  }
  return { schPath };
}

/** `/sync` — verify-only inconsistency report (never auto-resolves). */
export async function formatSyncInspect(repoRoot: string): Promise<string> {
  const report = await syncVerify(repoRoot);
  const body = formatSyncReport(report);
  const headline =
    !report.resolvable.length && !report.violations.length
      ? ok('  sync: clean')
      : report.violations.length
        ? err(`  sync: ${report.violations.length} requirement violation(s), ${report.resolvable.length} resolvable`)
        : warn(`  sync: ${report.resolvable.length} resolvable inconsistency(ies)`);
  return ['', copper('  Sync'), traceRule(12), '', headline, '', ...body.split('\n').map((l) => `  ${l}`), ''].join(
    '\n',
  );
}

/** `/config` — full resolved config view. */
export async function formatConfigInspect(repoRoot: string): Promise<string> {
  const c = await loadConfig(repoRoot);
  const lines = [
    '',
    copper('  Config'),
    traceRule(14),
    '',
    meta('schematic', c.schematic ?? dim('null')),
    meta('board', c.board ?? dim('null')),
    meta('docs', c.docs),
    meta('model', c.model ?? dim('null (use --model / env)')),
    meta('maxTurns', String(c.maxTurns)),
    meta('repair', String(c.maxRepairCycles)),
    meta('origin', c.origin ?? dim('unset')),
    meta('llmCache', c.llmCache ? 'on' : 'off'),
    meta('historyCap', c.historyCap ? 'on' : 'off'),
    meta('budgets', Object.keys(c.budgets).length ? JSON.stringify(c.budgets) : dim('{}')),
  ];
  if (c.stageMaxTurns && Object.keys(c.stageMaxTurns).length) {
    lines.push(meta('stageTurns', JSON.stringify(c.stageMaxTurns)));
  }
  lines.push('');
  lines.push(dim(`  file  ${shortPath(path.join(repoRoot, '.copperhead/config.json'))}`));
  lines.push('');
  return lines.join('\n');
}

/** `/git` — porcelain status + branch tip. */
export async function formatGitInspect(repoRoot: string): Promise<string> {
  if (!(await isGitRepo(repoRoot))) {
    return ['', warn('  git: not a repository'), ''].join('\n');
  }
  const [branch, commit, dirty, n, porcelain] = await Promise.all([
    branchName(repoRoot).catch(() => 'unknown'),
    headCommit(repoRoot).catch(() => 'unknown'),
    isDirty(repoRoot).catch(() => null),
    uncommittedCount(repoRoot).catch(() => null),
    execa('git', ['status', '--porcelain'], { cwd: repoRoot }).then((r) =>
      r.stdout ? r.stdout.split('\n').filter(Boolean) : [],
    ),
  ]);
  const state =
    dirty === null ? 'unknown' : dirty ? warn(`dirty (${n ?? '?'} file(s))`) : ok('clean');
  const lines = [
    '',
    copper('  Git'),
    traceRule(10),
    '',
    meta('branch', `${branch}@${commit.slice(0, 7)}`),
    meta('state', state),
    '',
  ];
  if (porcelain.length) {
    lines.push(dim('  changes:'));
    for (const row of porcelain.slice(0, 40)) lines.push(`  ${row}`);
    if (porcelain.length > 40) lines.push(dim(`  … and ${porcelain.length - 40} more`));
    lines.push('');
  }
  return lines.join('\n');
}

/** `/drift` — doc↔schematic only (no ERC/DRC). */
export async function formatDriftInspect(repoRoot: string): Promise<string> {
  const config = await loadConfig(repoRoot);
  if (!config.schematic) {
    return ['', warn('  drift: no schematic configured (run copperhead init)'), ''].join('\n');
  }
  const mismatches = await checkDrift(repoRoot, config.docs, config.schematic);
  if (!mismatches.length) {
    return ['', ok('  drift: docs match schematic'), ''].join('\n');
  }
  const lines = [
    '',
    copper('  Drift'),
    traceRule(12),
    '',
    warn(`  ${mismatches.length} mismatch(es):`),
    '',
  ];
  for (const m of mismatches.slice(0, 30)) {
    lines.push(`  ${copper('▸')} ${m.doc}`);
    lines.push(dim(`      claim   ${m.claim}`));
    lines.push(dim(`      actual  ${m.actual}`));
  }
  if (mismatches.length > 30) lines.push(dim(`  … and ${mismatches.length - 30} more`));
  lines.push('');
  return lines.join('\n');
}

/** `/constraints` — registry summary. */
export async function formatConstraintsInspect(repoRoot: string): Promise<string> {
  const registry = await loadConstraints(repoRoot);
  const keys = Object.keys(registry).sort();
  if (!keys.length) {
    return ['', dim('  constraints: none recorded yet'), ''].join('\n');
  }
  const lines = [
    '',
    copper('  Constraints'),
    traceRule(20),
    '',
    dim(`  ${keys.length} open constraint(s)`),
    '',
  ];
  for (const key of keys.slice(0, 40)) {
    const c = registry[key]!;
    const bound =
      c.value !== undefined
        ? String(c.value)
        : [c.min !== undefined ? `min ${c.min}` : '', c.max !== undefined ? `max ${c.max}` : '']
            .filter(Boolean)
            .join(', ') || (c.forbidden?.length ? `forbidden ${c.forbidden.join(',')}` : '—');
    lines.push(`  ${copper(key)}  ${bound}`);
    lines.push(dim(`    source ${c.source} · affects ${c.affects.join(', ') || '—'}`));
  }
  if (keys.length > 40) lines.push(dim(`  … and ${keys.length - 40} more`));
  lines.push('');
  return lines.join('\n');
}

/** `/runs` — recent `.copperhead/runs/` summaries. */
export async function formatRunsInspect(repoRoot: string): Promise<string> {
  const runsDir = path.join(repoRoot, '.copperhead', 'runs');
  const entries = await sortedRunIds(repoRoot);
  if (!entries.length) {
    return ['', dim('  runs: none yet'), ''].join('\n');
  }

  const lines = ['', copper('  Recent runs'), traceRule(18), ''];
  for (const id of entries.slice(0, 12)) {
    const summaryPath = path.join(runsDir, id, 'summary.md');
    const reportPath = path.join(runsDir, id, 'REPORT.md');
    let outcome = dim('unknown');
    if (existsSync(summaryPath)) {
      const text = await readFile(summaryPath, 'utf8');
      const m =
        text.match(/exitPath[:\s*`]+([a-z-]+)/i) ||
        text.match(/\*\*Exit(?:\s*path)?:\*\*\s*`?([a-z-]+)/i) ||
        text.match(/## Run stats[\s\S]*?`([a-z-]+)`/);
      if (m?.[1]) {
        const pathName = m[1];
        outcome =
          pathName === 'done' ? ok(pathName) : /fail|error|refus|exhaust|stall/i.test(pathName) ? err(pathName) : warn(pathName);
      } else if (/## Run stats/i.test(text)) {
        outcome = dim('recorded');
      }
    }
    const extras = existsSync(reportPath) ? dim(' · report') : '';
    lines.push(`  ${copper(id)}  ${outcome}${extras}`);
  }
  if (entries.length > 12) lines.push(dim(`  … and ${entries.length - 12} older`));
  lines.push('');
  lines.push(dim(`  dir  ${shortPath(runsDir)}`));
  lines.push('');
  return lines.join('\n');
}

/** `/parts` — schematic symbol table (refdes / value / footprint). */
export async function formatPartsInspect(repoRoot: string): Promise<string> {
  const resolved = await resolveSchematic(repoRoot);
  if ('message' in resolved) {
    return ['', warn(`  parts: ${resolved.message}`), ''].join('\n');
  }
  const syms = await listSymbols(resolved.schPath);
  if (!syms.length) {
    return ['', dim('  parts: schematic has no components'), ''].join('\n');
  }
  const refW = Math.max(4, ...syms.map((s) => s.ref.length));
  const valW = Math.min(24, Math.max(5, ...syms.map((s) => s.value.length)));
  const lines = [
    '',
    copper('  Parts'),
    traceRule(12),
    '',
    dim(`  ${'ref'.padEnd(refW)}  ${'value'.padEnd(valW)}  footprint`),
    '',
  ];
  for (const s of syms.slice(0, 60)) {
    const val = s.value.length > valW ? s.value.slice(0, valW - 1) + '…' : s.value;
    lines.push(`  ${copper(s.ref.padEnd(refW))}  ${val.padEnd(valW)}  ${dim(s.footprint || '—')}`);
  }
  if (syms.length > 60) lines.push(dim(`  … and ${syms.length - 60} more`));
  lines.push('');
  return lines.join('\n');
}

/** `/nets` — net names and pin attachments from the schematic. */
export async function formatNetsInspect(repoRoot: string): Promise<string> {
  const resolved = await resolveSchematic(repoRoot);
  if ('message' in resolved) {
    return ['', warn(`  nets: ${resolved.message}`), ''].join('\n');
  }
  const [names, pins] = await Promise.all([listNets(resolved.schPath), pinNets(resolved.schPath)]);
  const byNet = new Map<string, string[]>();
  for (const p of pins) {
    const net = p.net ?? '(unconnected)';
    const tag = p.pinName ? `${p.ref}.${p.pinName}` : `${p.ref}:${p.pinNumber}`;
    const list = byNet.get(net) ?? [];
    list.push(tag);
    byNet.set(net, list);
  }
  const ordered = [...new Set([...names, ...byNet.keys()])].sort((a, b) => {
    if (a === '(unconnected)') return 1;
    if (b === '(unconnected)') return -1;
    return a.localeCompare(b);
  });
  const lines = ['', copper('  Nets'), traceRule(10), '', dim(`  ${ordered.length} net(s)`), ''];
  for (const net of ordered.slice(0, 40)) {
    const attached = (byNet.get(net) ?? []).sort();
    const preview = attached.slice(0, 8).join(', ');
    const extra = attached.length > 8 ? dim(` +${attached.length - 8}`) : '';
    lines.push(`  ${copper(net)}  ${dim(preview)}${extra}`);
  }
  if (ordered.length > 40) lines.push(dim(`  … and ${ordered.length - 40} more`));
  lines.push('');
  return lines.join('\n');
}

/** `/bom` — parsed docs/BOM.md (inspect only; no export). */
export async function formatBomInspect(repoRoot: string): Promise<string> {
  const config = await loadConfig(repoRoot);
  const bomPath = path.join(repoRoot, config.docs, 'BOM.md');
  if (!existsSync(bomPath)) {
    return ['', warn('  bom: docs/BOM.md not found'), ''].join('\n');
  }
  const rows = parseBomTable(await readFile(bomPath, 'utf8'));
  if (!rows.length) {
    return ['', dim('  bom: no parseable rows in BOM.md'), ''].join('\n');
  }
  const refW = Math.max(5, ...rows.map((r) => r.refdes.length));
  const lines = ['', copper('  BOM'), traceRule(8), '', dim(`  ${rows.length} row(s) from ${shortPath(bomPath)}`), ''];
  for (const r of rows.slice(0, 50)) {
    const flags = r.flags.length ? dim(` [${r.flags.join(',')}]`) : '';
    lines.push(
      `  ${copper(r.refdes.padEnd(refW))}  ${r.value ?? '—'}  ${dim(r.footprint ?? '')}${flags}`,
    );
    if (r.mpn) lines.push(dim(`    mpn ${r.mpn}`));
  }
  if (rows.length > 50) lines.push(dim(`  … and ${rows.length - 50} more`));
  lines.push('');
  return lines.join('\n');
}

/** `/openspec` — `openspec validate` summary (same gate as check). */
export async function formatOpenSpecInspect(repoRoot: string): Promise<string> {
  const cfgPath = path.join(repoRoot, 'openspec', 'config.yaml');
  if (!existsSync(cfgPath)) {
    return ['', dim('  openspec: no openspec/config.yaml in this repo'), ''].join('\n');
  }
  const res = await openspecValidate(repoRoot);
  const headline = res.ok ? ok('  openspec: valid') : err('  openspec: validation failed');
  const body = res.output
    .trim()
    .split('\n')
    .slice(0, 30)
    .map((l) => `  ${l}`)
    .join('\n');
  const lines = ['', copper('  OpenSpec'), traceRule(16), '', headline, ''];
  if (body) lines.push(body, '');
  return lines.join('\n');
}

/** `/last` — preview the newest run summary.md. */
export async function formatLastInspect(repoRoot: string): Promise<string> {
  const entries = await sortedRunIds(repoRoot);
  if (!entries.length) {
    return ['', dim('  last: no runs yet'), ''].join('\n');
  }
  const id = entries[0]!;
  const runsDir = path.join(repoRoot, '.copperhead', 'runs');
  const summaryPath = path.join(runsDir, id, 'summary.md');
  const transcriptPath = path.join(runsDir, id, 'transcript.jsonl');
  const lines = ['', copper('  Last run'), traceRule(14), '', meta('id', id), ''];
  if (!existsSync(summaryPath)) {
    lines.push(dim('  summary.md missing'), '');
    return lines.join('\n');
  }
  const text = await readFile(summaryPath, 'utf8');
  const preview = text.split('\n').slice(0, 40);
  lines.push(dim(`  ${shortPath(summaryPath)}`));
  if (existsSync(transcriptPath)) {
    lines.push(dim(`  ${shortPath(transcriptPath)}`));
  }
  lines.push('');
  for (const line of preview) lines.push(`  ${line}`);
  if (text.split('\n').length > 40) lines.push(dim('  … truncated'));
  lines.push('');
  return lines.join('\n');
}
