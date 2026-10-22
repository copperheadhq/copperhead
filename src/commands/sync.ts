import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { checkDrift } from '../memory/drift.js';
import { loadConstraints, checkForbiddenPins } from '../memory/constraints.js';
import { pinNets } from '../kicad/sexp.js';
import { openspecValidate } from '../openspec/cli.js';
import { runAgentLoop, type RunResult } from '../agent/loop.js';
import type { RunMetaInput } from '../agent/runmeta.js';
import type { ProgressRenderer } from '../agent/render.js';

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
    // Match the whole key or its final dot-separated segment, but not any
    // suffix: `endsWith` let an unrelated key such as `power.unit_cost` satisfy
    // a `cost` budget. Budget names are free-form and may themselves be dotted,
    // in which case they match their own key exactly.
    if (!Object.keys(registry).some((k) => k === budget || k.split('.').pop() === budget)) {
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

  // coverage: docs the transparency layer expects.
  // `config.docs` is not normalised on load, so it may carry a trailing
  // separator, be nested, or be empty (docs at the repo root). Joining handles
  // all of those; concatenating produced `docsDECISIONS.md` for "docs", and
  // stripping then templating produced a root-absolute `/DECISIONS.md` for "".
  for (const name of ['DECISIONS.md', 'CHANGELOG.md']) {
    if (!existsSync(path.join(docsDir, name))) {
      resolvable.push({
        kind: 'coverage',
        doc: path.posix.join(config.docs.replace(/\\/g, '/'), name),
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
