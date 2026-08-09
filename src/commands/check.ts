import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { runErc, runDrc } from '../kicad/cli.js';
import { formatViolations, type CheckReport } from '../kicad/report.js';
import { checkDrift, emptySchematicWarning, type DriftMismatch } from '../memory/drift.js';
import { loadConstraints, checkForbiddenPins, type ConstraintViolation } from '../memory/constraints.js';
import {
  loadSchematic,
  geometryFromLoaded,
  pinNetsFromLoaded,
  symbolsFromLoaded,
} from '../kicad/sexp.js';
import { scoreFromGeometry, type ScoreReport } from '../kicad/score.js';
import {
  checkLegibilityFromGeometry,
  formatLegibility,
  LEGIBILITY_FAMILIES,
  type LegibilityFinding,
} from '../kicad/legibility.js';
import { openspecValidate } from '../openspec/cli.js';

/**
 * `copperhead check` (alias `verify`): deterministic, zero LLM calls, CI-safe
 * (AC-2). This module must never import a provider.
 */
export interface CheckResult {
  ok: boolean;
  erc: { ok: boolean; violations: number } | null;
  drc: { ok: boolean; violations: number } | null;
  drift: { ok: boolean; mismatches: DriftMismatch[]; warning?: string };
  openspec: { ok: boolean; detail: string } | null;
  constraints: { ok: boolean; violations: ConstraintViolation[] };
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

export async function runCheck(repoRoot: string, log: (s: string) => void): Promise<CheckResult> {
  const config = await loadConfig(repoRoot);
  const schRel = config.schematic;
  const schPath = schRel ? path.join(repoRoot, schRel) : null;
  const schExists = schPath !== null && existsSync(schPath);
  const boardPath = config.board ? path.join(repoRoot, config.board) : null;
  const boardExists = boardPath !== null && existsSync(boardPath);
  const hasOpenspec = existsSync(path.join(repoRoot, 'openspec', 'config.yaml'));

  const [erc, drc, openspec] = await Promise.all([
    schExists
      ? runErc(schPath!)
      : Promise.resolve(null as CheckReport | null),
    boardExists
      ? runDrc(boardPath!)
      : Promise.resolve(null as CheckReport | null),
    hasOpenspec
      ? openspecValidate(repoRoot).then((res) => ({ ok: res.ok, detail: res.output }))
      : Promise.resolve(null as { ok: boolean; detail: string } | null),
  ]);

  if (erc) log(erc.ok ? 'ERC ✓' : formatViolations(erc));
  else log('ERC skipped (no schematic configured; run copperhead init)');

  if (drc) log(drc.ok ? 'DRC ✓' : formatViolations(drc));
  else log('DRC skipped (no board configured)');

  if (openspec) log(openspec.ok ? 'openspec ✓' : `openspec: ${openspec.detail}`);

  let drift: DriftMismatch[] = [];
  let driftWarning: string | null = null;
  let legibility: CheckResult['legibility'];
  let constraintViolations: ConstraintViolation[] = [];

  if (schExists && schRel) {
    const loaded = await loadSchematic(schPath!);
    const symbols = symbolsFromLoaded(loaded);
    const geometry = geometryFromLoaded(loaded);
    const pins = pinNetsFromLoaded(loaded);

    drift = await checkDrift(repoRoot, config.docs, schRel, loaded);
    log(
      drift.length === 0
        ? 'drift ✓'
        : drift.map((m) => `drift: ${m.doc} claims "${m.claim}" but actual is "${m.actual}"`).join('\n'),
    );
    driftWarning = await emptySchematicWarning(repoRoot, config.docs, schRel, symbols);
    if (driftWarning) log(`drift warning: ${driftWarning}`);

    const legReport = await checkLegibilityFromGeometry(geometry, {
      docsDir: path.join(repoRoot, config.docs),
      ...(config.legibility ? { config: config.legibility } : {}),
    });
    const score = scoreFromGeometry(geometry, legReport, config.legibility);
    legibility = {
      findings: legReport.findings,
      counts: legReport.counts,
      skipped: legReport.skipped,
      disabled: legReport.disabled,
      suppressed: legReport.suppressed,
      score,
    };
    log(formatLegibility(legReport));
    log(`legibility score: ${score.composite}/100${score.cap ? ` (capped: ${score.cap.reason})` : ''}`);

    const registry = await loadConstraints(repoRoot);
    constraintViolations = checkForbiddenPins(registry, pins);
    if (Object.keys(registry).length) {
      log(
        constraintViolations.length === 0
          ? 'constraints ✓'
          : constraintViolations.map((v) => `constraint ${v.key}: ${v.description} (source: ${v.source})`).join('\n'),
      );
    }
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

  const ok =
    (erc?.ok ?? true) &&
    (drc?.ok ?? true) &&
    drift.length === 0 &&
    (openspec?.ok ?? true) &&
    constraintViolations.length === 0;

  return {
    ok,
    erc: erc ? { ok: erc.ok, violations: erc.violations.length } : null,
    drc: drc ? { ok: drc.ok, violations: drc.violations.length } : null,
    drift: { ok: drift.length === 0, mismatches: drift, ...(driftWarning ? { warning: driftWarning } : {}) },
    openspec,
    constraints: { ok: constraintViolations.length === 0, violations: constraintViolations },
    legibility,
  };
}
