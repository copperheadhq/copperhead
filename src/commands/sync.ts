import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execa } from 'execa';
import { loadConfig } from '../config.js';
import { checkDrift } from '../memory/drift.js';
import { loadConstraints, checkForbiddenPins } from '../memory/constraints.js';
import { pinNets } from '../kicad/sexp.js';
import { openspecValidate } from '../openspec/cli.js';
import { runAgentLoop, type RunResult } from '../agent/loop.js';
import type { Provider } from '../agent/types.js';
import type { RunMetaInput } from '../agent/runmeta.js';
import type { ProgressRenderer } from '../agent/render.js';
import type { RunContext } from '../agent/context.js';
import {
  addDeclinedOutcomes,
  compareBrief,
  formatBriefComparison,
  loadReconciliationRecord,
  trackedCurrentBrief,
  writeReconciliationRecord,
  type BriefComparison,
} from '../memory/brief-reconciliation.js';

/**
 * `copperhead sync` (design D14): deterministic verify phase, then an optional
 * spec-gated resolve phase. Truth precedence: KiCad files are ground truth for
 * as-built facts; specs/budgets for requirements. Requirement violations are
 * flagged, never auto-resolved.
 */
export interface SyncItem {
  kind: 'drift' | 'dual-write' | 'pins-h' | 'coverage' | 'openspec';
  doc: string;
  claim: string;
  actual: string;
  resolution: string;
}

export interface SyncViolationItem {
  kind: 'requirement-violation';
  description: string;
  governedBy: string;
}

export interface SyncReport {
  resolvable: SyncItem[];
  violations: SyncViolationItem[];
}

async function dirtyPaths(repoRoot: string): Promise<string[]> {
  const { stdout } = await execa('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repoRoot });
  return stdout.split('\0').filter(Boolean);
}

function onlyBriefIsModified(entries: string[], briefPath: string): boolean {
  return entries.length > 0 && entries.every((entry) => {
    const status = entry.slice(0, 2);
    const changedPath = entry.slice(3);
    return changedPath === briefPath && status.includes('M') && [...status].every((char) => char === ' ' || char === 'M');
  });
}

export async function syncVerify(repoRoot: string): Promise<SyncReport> {
  const config = await loadConfig(repoRoot);
  const resolvable: SyncItem[] = [];
  const violations: SyncViolationItem[] = [];

  if (config.schematic && existsSync(path.join(repoRoot, config.schematic))) {
    for (const m of await checkDrift(repoRoot, config.docs, config.schematic)) {
      resolvable.push({
        kind: 'drift',
        doc: m.doc,
        claim: m.claim,
        actual: m.actual,
        resolution: `update ${m.doc} to match the as-built schematic (KiCad files are truth for as-built facts)`,
      });
    }
  }

  // dual-write audit: every registry key should be mentioned in some doc, and
  // every budget in config should exist in the registry
  const registry = await loadConstraints(repoRoot);
  const docsDir = path.join(repoRoot, config.docs);
  let docsText = '';
  for (const name of ['SPEC.md', 'BOM.md', 'PINOUT.md', 'SUBSYSTEMS.md', 'LAYOUT.md']) {
    const p = path.join(docsDir, name);
    if (existsSync(p)) docsText += `\n<<<${name}>>>\n` + (await readFile(p, 'utf8'));
  }
  for (const key of Object.keys(registry)) {
    const shortKey = key.split('.').pop()!;
    if (docsText && !docsText.includes(shortKey)) {
      resolvable.push({
        kind: 'dual-write',
        doc: 'constraints.json',
        claim: `constraint ${key} exists in registry`,
        actual: 'no doc mentions it',
        resolution: `add the constraint to the doc named by its source (${registry[key]!.source})`,
      });
    }
  }
  for (const [budget, value] of Object.entries(config.budgets)) {
    if (!Object.keys(registry).some((k) => k.endsWith(budget))) {
      resolvable.push({
        kind: 'dual-write',
        doc: '.copperhead/config.json',
        claim: `budget ${budget}=${value} configured`,
        actual: 'not in constraints.json',
        resolution: 'record_constraint with the budget value and its source',
      });
    }
  }

  // PINOUT.md vs generated pins.h
  const pinsH = path.join(repoRoot, 'firmware', 'src', 'pins.h');
  if (existsSync(pinsH) && existsSync(path.join(docsDir, 'PINOUT.md'))) {
    const header = await readFile(pinsH, 'utf8');
    const pinout = await readFile(path.join(docsDir, 'PINOUT.md'), 'utf8');
    for (const m of header.matchAll(/#define\s+PIN_(\w+)\s+(\S+)/g)) {
      if (!pinout.includes(m[1]!)) {
        resolvable.push({
          kind: 'pins-h',
          doc: 'firmware/src/pins.h',
          claim: `defines PIN_${m[1]}`,
          actual: 'PINOUT.md does not mention it',
          resolution: 'regenerate pins.h from PINOUT.md (PINOUT.md is the single source of truth)',
        });
      }
    }
  }

  // coverage: docs the transparency layer expects
  for (const name of ['DECISIONS.md', 'CHANGELOG.md']) {
    if (!existsSync(path.join(docsDir, name))) {
      resolvable.push({
        kind: 'coverage',
        doc: `${config.docs}${name}`,
        claim: 'exists (transparency layer)',
        actual: 'missing',
        resolution: 'scaffold it (copperhead init creates it)',
      });
    }
  }

  if (existsSync(path.join(repoRoot, 'openspec', 'config.yaml'))) {
    const res = await openspecValidate(repoRoot);
    if (!res.ok) {
      resolvable.push({
        kind: 'openspec',
        doc: 'openspec/',
        claim: 'specs and changes validate',
        actual: res.output.split('\n')[0] ?? 'validation failed',
        resolution: 'fix the reported spec/change issues',
      });
    }
  }

  // requirement violations: never auto-resolved (AC-7.3)
  if (config.schematic && existsSync(path.join(repoRoot, config.schematic))) {
    const pins = await pinNets(path.join(repoRoot, config.schematic));
    for (const v of checkForbiddenPins(registry, pins)) {
      violations.push({
        kind: 'requirement-violation',
        description: v.description,
        governedBy: v.source,
      });
    }
  }

  return { resolvable, violations };
}

export async function syncBriefVerify(repoRoot: string): Promise<BriefComparison> {
  const config = await loadConfig(repoRoot);
  return compareBrief(repoRoot, config.docs);
}

export function validateBriefDecisions(
  decisions: string[],
  itemIds: string[],
): { ok: true; outcomes: { id: string; outcome: 'applied' | 'declined'; rationale: string }[] } | { ok: false; detail: string } {
  const expected = new Set(itemIds);
  const outcomes = new Map<string, { outcome: 'applied' | 'declined'; rationale: string }>();
  const conflicts = new Set<string>();
  for (const entry of decisions) {
    if (!entry.trimStart().toLowerCase().startsWith('brief')) continue;
    const match = /^brief\s*:\s*(B[1-9]\d*)\s+(applied|declined)\s*\|\s*why\s*:\s*([\s\S]*)$/i.exec(entry.trim());
    if (!match || !expected.has(match[1]!)) continue;
    const rationale = match[3]!.trim();
    if (!rationale) continue;
    const prior = outcomes.get(match[1]!);
    const outcome = match[2]!.toLowerCase() as 'applied' | 'declined';
    if (prior && prior.outcome !== outcome) conflicts.add(match[1]!);
    outcomes.set(match[1]!, { outcome, rationale });
  }
  if (conflicts.size) return { ok: false, detail: `conflicting decisions for ${[...conflicts].join(', ')}` };
  const missing = itemIds.filter((id) => !outcomes.has(id));
  if (missing.length) return { ok: false, detail: `missing explicit applied/declined decision for ${missing.join(', ')}` };
  return { ok: true, outcomes: itemIds.map((id) => ({ id, ...outcomes.get(id)! })) };
}

export async function syncBriefResolve(
  repoRoot: string,
  report: BriefComparison,
  model: string,
  log: (line: string) => void,
  extras?: { renderer?: ProgressRenderer; meta?: RunMetaInput; provider?: Provider },
): Promise<{ ok: boolean; run: RunResult }> {
  if (report.status === 'unknown' || !report.path || report.currentText === undefined || !report.currentSha256 || !report.items.length) {
    throw new Error(report.detail ?? 'there are no changed brief blocks to reconcile');
  }
  const existingChanges = await dirtyPaths(repoRoot);
  const briefIsDirty = existingChanges.length > 0 && onlyBriefIsModified(existingChanges, report.path);
  if (existingChanges.length > 0 && !briefIsDirty) {
    throw new Error('brief reconciliation requires a clean working tree, except for changes to the configured tracked brief; commit or stash other changes before running sync --brief');
  }
  const config = await loadConfig(repoRoot);
  const itemList = report.items
    .map((item) => `### ${item.id}
Before:
${item.before || '(no lines)'}
After:
${item.after || '(no lines)'}`)
    .join('\n\n');
  const prompt = [
    'Reconcile every changed block in the product brief below with the existing design and documentation.',
    'The immutable origin record stays unchanged. Do not edit the brief file. For each block, either implement the changed requirement using the available gated tools, then record it as applied, or explicitly decline it with a clear rationale.',
    'Before calling finish(done), call record_decision once for every block. The decision value must be exactly `brief:<ID> applied` or `brief:<ID> declined`, for example `brief:B1 applied`; provide a non-empty rationale. Repeated identical outcomes are acceptable, conflicting outcomes are not.',
    'A declined outcome is visible to check and does not mean the design implements that requirement. Do not claim it was implemented.',
    'Run the normal verification tools for all design edits. The reconciliation record advances only after every block has an outcome, all verification and sync obligations pass, and the run commits.',
    `Comparison baseline: ${report.baseline ?? 'unknown'} (${report.baselineSha256 ?? 'unknown'}). Current brief SHA-256: ${report.currentSha256}.`,
    `Repository-relative brief: ${report.path}`,
    `\n## Changed blocks\n${itemList}`,
    `\n## Current brief\n${report.currentText}`,
  ].join('\n\n');
  const itemIds = report.items.map((item) => item.id);
  const expectedSha = report.currentSha256;
  const briefPath = report.path;
  const res = await runAgentLoop({
    repoRoot,
    model,
    request: 'reconcile changed requirements in the product brief',
    stagePrompt: prompt,
    log,
    ...(extras?.provider ? { provider: extras.provider } : {}),
    ...(extras?.renderer ? { renderer: extras.renderer } : {}),
    ...(extras?.meta ? { meta: extras.meta } : {}),
    ...(briefIsDirty ? { allowDirty: true, preTouched: [briefPath] } : {}),
    stageGate: async (ctx: RunContext) => {
      const checked = validateBriefDecisions(ctx.decisions, itemIds);
      return checked.ok ? null : `brief reconciliation is incomplete: ${checked.detail}`;
    },
    beforeCommit: async (ctx: RunContext) => {
      const checked = validateBriefDecisions(ctx.decisions, itemIds);
      if (!checked.ok) throw new Error(`brief reconciliation is incomplete: ${checked.detail}`);
      const current = await trackedCurrentBrief(repoRoot, briefPath, expectedSha, { allowWorktreeChange: briefIsDirty });
      if (!current) throw new Error('brief changed, became untracked, or differs from HEAD during reconciliation; no reconciliation state was written');
      const existing = await loadReconciliationRecord(repoRoot);
      const statePath = path.join(repoRoot, '.copperhead', 'brief-reconciliation.json');
      if (report.baseline === 'origin' && existsSync(statePath)) throw new Error('brief reconciliation state changed during the run');
      if (report.baseline === 'reconciled' && (!existing || existing.sha256 !== report.baselineSha256)) throw new Error('brief reconciliation state changed during the run');
      if (existing && existing.briefPath !== briefPath) throw new Error('reconciliation record refers to a different brief path');
      const record = {
        schemaVersion: 1 as const,
        briefPath,
        sha256: expectedSha,
        gitBlob: current.gitBlob,
        refusals: addDeclinedOutcomes(
          existing?.refusals ?? report.refusals,
          expectedSha,
          checked.outcomes.map((outcome) => {
            const item = report.items.find((entry) => entry.id === outcome.id)!;
            return { ...outcome, change: item.after || `Removed requirement:\n${item.before}` };
          }),
        ),
      };
      await writeReconciliationRecord(repoRoot, record);
      ctx.filesTouched.add('.copperhead/brief-reconciliation.json');
    },
  });
  return { ok: res.outcome === 'success', run: res };
}

export function formatBriefSyncReport(report: BriefComparison): string {
  return formatBriefComparison(report);
}

export function formatSyncReport(report: SyncReport): string {
  const lines: string[] = [];
  if (!report.resolvable.length && !report.violations.length) {
    return 'sync: no inconsistencies';
  }
  if (report.resolvable.length) {
    lines.push(`${report.resolvable.length} resolvable inconsistency(ies):`);
    for (const i of report.resolvable) {
      lines.push(`- [${i.kind}] ${i.doc}: claims "${i.claim}" but actual is "${i.actual}"`);
      lines.push(`    resolution: ${i.resolution}`);
    }
  }
  if (report.violations.length) {
    lines.push(`${report.violations.length} REQUIREMENT VIOLATION(S) (not auto-resolved; human decision needed):`);
    for (const v of report.violations) {
      lines.push(`- ${v.description}`);
      lines.push(`    governed by: ${v.governedBy}`);
    }
  }
  return lines.join('\n');
}

export async function syncResolve(
  repoRoot: string,
  report: SyncReport,
  model: string,
  log: (s: string) => void,
  extras?: { renderer?: ProgressRenderer; meta?: RunMetaInput },
): Promise<{ ok: boolean; run: RunResult }> {
  const reportText = formatSyncReport(report);
  const res = await runAgentLoop({
    repoRoot,
    model,
    request: 'resolve design-state inconsistencies found by copperhead sync',
    stagePrompt: `You are resolving drift found by the deterministic sync verifier. The inconsistency report is below. Truth precedence: the KiCad files are ground truth for as-built facts (fix the docs to match); openspec specs and SPEC.md budgets are ground truth for requirements. Do NOT touch anything listed as a requirement violation; those are for the human. Apply each proposed resolution, verify, and finish.\n\n${reportText}`,
    log,
    ...(extras?.renderer ? { renderer: extras.renderer } : {}),
    ...(extras?.meta ? { meta: extras.meta } : {}),
  });
  // The full RunResult travels with the verdict so a non-CLI caller (the MCP
  // server) can report the transcript path and files touched the way `do` does.
  return { ok: res.outcome === 'success', run: res };
}
