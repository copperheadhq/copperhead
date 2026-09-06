import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { runErc, runDrc } from '../kicad/cli.js';
import { formatViolations, type CheckReport } from '../kicad/report.js';
import {
  checkRoutingCompleteness,
  checkDocumentationPresence,
  isCreateProducedRepo,
  type FabCheckResult,
} from '../kicad/fab.js';
import { checkDrift, emptySchematicWarning, type DriftMismatch } from '../memory/drift.js';
import { loadConstraints, checkForbiddenPins, type ConstraintViolation } from '../memory/constraints.js';
import { pinNets, readSheetGeometry } from '../kicad/sexp.js';
import { scoreFromGeometry, type ScoreReport } from '../kicad/score.js';
import { checkLegibility, formatLegibility, LEGIBILITY_FAMILIES, type LegibilityFinding } from '../kicad/legibility.js';
import { openspecValidate } from '../openspec/cli.js';

/**
 * `copperhead check` (alias `verify`): deterministic, zero LLM calls, CI-safe
 * (AC-2). This module must never import a provider.
 */

/** The fabrication release-gate checks implemented so far. BOM readiness,
 * schematic-to-PCB match, and output freshness are separate add-fab-release-gate
 * tasks (1.2–1.4); until they land they are *not* reported at all, so the gate
 * never claims a check it did not actually run. */
export interface FabGateResult {
  routing: FabCheckResult;
  docs: FabCheckResult;
}

/** Options for {@link runCheck}; `fab` runs the release gate over the DRC already done. */
export interface CheckOptions {
  fab?: boolean;
  /** Escalate `UNVERIFIED` BOM rows to failures (no-op until BOM readiness lands). */
  strict?: boolean;
}

export interface CheckResult {
  ok: boolean;
  erc: { ok: boolean; violations: number } | null;
  drc: { ok: boolean; violations: number } | null;
  drift: { ok: boolean; mismatches: DriftMismatch[]; warning?: string };
  openspec: { ok: boolean; detail: string } | null;
  constraints: { ok: boolean; violations: ConstraintViolation[] };
  /** Present only when `--fab` was requested. */
  fab?: FabGateResult;
  /**
   * Advisory at every severity (design C6): findings inform, the exit code
   * never depends on them, so existing repos gain information, not failures.
   * Always present — all families skipped when no schematic is configured.
   */
  legibility: {
    findings: LegibilityFinding[];
    counts: { error: number; advisory: number };
    skipped: { family: string; reason: string }[];
    disabled: string[];
    suppressed: { family: string; sheet: string; count: number }[];
    /** Advisory quantitative score; null when no schematic is configured. */
    score: ScoreReport | null;
  };
}

export async function runCheck(repoRoot: string, log: (s: string) => void, opts: CheckOptions = {}): Promise<CheckResult> {
  const config = await loadConfig(repoRoot);
  let erc: CheckReport | null = null;
  let drc: CheckReport | null = null;

  if (config.schematic && existsSync(path.join(repoRoot, config.schematic))) {
    erc = await runErc(path.join(repoRoot, config.schematic));
    log(erc.ok ? 'ERC ✓' : formatViolations(erc));
  } else {
    log('ERC skipped (no schematic configured; run copperhead init)');
  }

  if (config.board && existsSync(path.join(repoRoot, config.board))) {
    drc = await runDrc(path.join(repoRoot, config.board));
    log(drc.ok ? 'DRC ✓' : formatViolations(drc));
  } else {
    log('DRC skipped (no board configured)');
  }

  let drift: DriftMismatch[] = [];
  let driftWarning: string | null = null;
  if (config.schematic && existsSync(path.join(repoRoot, config.schematic))) {
    drift = await checkDrift(repoRoot, config.docs, config.schematic);
    log(drift.length === 0 ? 'drift ✓' : drift.map((m) => `drift: ${m.doc} claims "${m.claim}" but actual is "${m.actual}"`).join('\n'));
    // Informational, never a failure: the zero-symbol drift exemption is for
    // bootstrap, but an established repo that lost its schematic content
    // deserves a visible note rather than a silent green.
    driftWarning = await emptySchematicWarning(repoRoot, config.docs, config.schematic);
    if (driftWarning) log(`drift warning: ${driftWarning}`);
  }

  let openspec: { ok: boolean; detail: string } | null = null;
  if (existsSync(path.join(repoRoot, 'openspec', 'config.yaml'))) {
    const res = await openspecValidate(repoRoot);
    openspec = { ok: res.ok, detail: res.output };
    log(res.ok ? 'openspec ✓' : `openspec: ${res.output}`);
  }

  let legibility: CheckResult['legibility'];
  if (config.schematic && existsSync(path.join(repoRoot, config.schematic))) {
    const report = await checkLegibility(path.join(repoRoot, config.schematic), {
      docsDir: path.join(repoRoot, config.docs),
      ...(config.legibility ? { config: config.legibility } : {}),
    });
    const score = scoreFromGeometry(
      await readSheetGeometry(path.join(repoRoot, config.schematic)),
      report,
      config.legibility,
    );
    legibility = {
      findings: report.findings,
      counts: report.counts,
      skipped: report.skipped,
      disabled: report.disabled,
      suppressed: report.suppressed,
      score,
    };
    log(formatLegibility(report));
    log(`legibility score: ${score.composite}/100${score.cap ? ` (capped: ${score.cap.reason})` : ''}`);
  } else {
    legibility = {
      findings: [],
      counts: { error: 0, advisory: 0 },
      skipped: LEGIBILITY_FAMILIES.map((family) => ({ family, reason: 'no schematic configured' })),
      disabled: [],
      suppressed: [],
      score: null,
    };
    log('legibility skipped (no schematic configured)');
  }

  let constraintViolations: ConstraintViolation[] = [];
  if (config.schematic && existsSync(path.join(repoRoot, config.schematic))) {
    const registry = await loadConstraints(repoRoot);
    const pins = await pinNets(path.join(repoRoot, config.schematic));
    constraintViolations = checkForbiddenPins(registry, pins);
    if (Object.keys(registry).length) {
      log(
        constraintViolations.length === 0
          ? 'constraints ✓'
          : constraintViolations.map((v) => `constraint ${v.key}: ${v.description} (source: ${v.source})`).join('\n'),
      );
    }
  }

  let fab: FabGateResult | undefined;
  if (opts.fab) {
    // Routing completeness reuses the DRC already run above — never a second
    // kicad-cli call (spec: "reuse the DRC run already performed by check").
    const routing = checkRoutingCompleteness(drc);
    // Documentation presence is pure over file contents (task 1.5).
    const docsDir = config.docs.replace(/[/\\]+$/, '');
    const layoutAbs = path.join(repoRoot, docsDir, 'LAYOUT.md');
    const layoutMd = existsSync(layoutAbs) ? await readFile(layoutAbs, 'utf8') : null;
    const docs = checkDocumentationPresence({
      layoutMd,
      devplanExists: existsSync(path.join(repoRoot, docsDir, 'DEVPLAN.md')),
      isCreateRepo: isCreateProducedRepo(config),
    });
    // Only the implemented checks are reported: routing (task 1.1) and docs
    // (task 1.5). BOM readiness, schematic-to-PCB match, and output freshness
    // (tasks 1.2/1.3/1.4) are omitted rather than faked as pass.
    fab = { routing, docs };
    for (const [name, r] of Object.entries(fab)) {
      const mark = r.status === 'fail' ? '✗' : r.status === 'warn' ? '⚠' : '✓';
      log(`fab ${name} ${mark}`);
      for (const v of r.violations) {
        const loc = v.location ? ` (${v.location})` : '';
        log(`  - ${v.claim}: ${v.actual}${loc}`);
      }
    }
  }

  const ok =
    (erc?.ok ?? true) &&
    (drc?.ok ?? true) &&
    drift.length === 0 &&
    (openspec?.ok ?? true) &&
    constraintViolations.length === 0 &&
    (fab === undefined || Object.values(fab).every((r) => r.status !== 'fail'));

  return {
    ok,
    erc: erc ? { ok: erc.ok, violations: erc.violations.length } : null,
    drc: drc ? { ok: drc.ok, violations: drc.violations.length } : null,
    drift: { ok: drift.length === 0, mismatches: drift, ...(driftWarning ? { warning: driftWarning } : {}) },
    openspec,
    constraints: { ok: constraintViolations.length === 0, violations: constraintViolations },
    ...(fab ? { fab } : {}),
    legibility,
  };
}
