import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config.js';
import { runErc, runDrc } from '../kicad/cli.js';
import { formatViolations, type CheckReport } from '../kicad/report.js';
import { checkDrift, emptySchematicWarning, type DriftMismatch } from '../memory/drift.js';
import { loadConstraints, checkForbiddenPins, type ConstraintViolation } from '../memory/constraints.js';
import { pinNets, readSheetGeometry } from '../kicad/sexp.js';
import { scoreFromGeometry, type ScoreReport } from '../kicad/score.js';
import { checkLegibility, formatLegibility, LEGIBILITY_FAMILIES, type LegibilityFinding } from '../kicad/legibility.js';
import { openspecValidate } from '../openspec/cli.js';
import { validatePartsManifest } from '../kicad/parts/validator.js';
import { renderBomMarkdown } from '../kicad/parts/bom-renderer.js';
import { headingsOf } from '../kicad/draft/ir.js';
import { FootprintResolver } from '../kicad/footprints.js';

/**
 * `copperhead check` (alias `verify`): deterministic, zero LLM calls, CI-safe
 * (AC-2). This module must never import a provider.
 */
export interface CheckResult {
  ok: boolean;
  erc: { ok: boolean; violations: number } | null;
  drc: { ok: boolean; violations: number; unrouted: number; intrinsic: number } | null;
  drift: { ok: boolean; mismatches: DriftMismatch[]; warning?: string };
  openspec: { ok: boolean; detail: string } | null;
  constraints: { ok: boolean; violations: ConstraintViolation[] };
  manifest?: { ok: boolean; errors: string[]; drift: boolean };
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
    log(drc.ok && !drc.intrinsic?.length ? `DRC ✓${drc.unrouted ? ` (${drc.unrouted} unrouted)` : ''}` : formatViolations(drc));
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

  let manifestReport: { ok: boolean; errors: string[]; drift: boolean } | null = null;
  const manifestPath = path.join(repoRoot, config.docs, 'parts.intent.json');

  if (existsSync(manifestPath)) {
    const errors: string[] = [];
    let isDrift = false;

    let rawManifest = '';
    try {
      rawManifest = await readFile(manifestPath, 'utf8');
    } catch (err) {
      errors.push(`failed to read parts.intent.json: ${(err as Error).message}`);
    }

    if (errors.length === 0) {
      if (!rawManifest.trim()) {
        errors.push('parts.intent.json is empty');
      } else {
        try {
          const subsystemsPath = path.join(repoRoot, config.docs, 'SUBSYSTEMS.md');
          const subHeadings = existsSync(subsystemsPath) ? await headingsOf(subsystemsPath) : null;
          const anchor = config.board ?? config.schematic;
          const footprints = await FootprintResolver.create({
            projectDir: anchor ? path.dirname(path.join(repoRoot, anchor)) : repoRoot,
          });

          const valRes = await validatePartsManifest(rawManifest, {
            subsystemsHeadings: subHeadings,
            footprints,
          });

          if (!valRes.ok) {
            errors.push(...valRes.findings.map((f) => f.detail));
          } else {
            const bomPath = path.join(repoRoot, config.docs, 'BOM.md');
            if (!existsSync(bomPath)) {
              errors.push('BOM.md is missing but parts.intent.json exists; run draft_bom');
              isDrift = true;
            } else {
              try {
                const actualBom = await readFile(bomPath, 'utf8');
                const expectedBom = renderBomMarkdown(valRes.expandedParts, valRes.substitutions);
                const normActual = actualBom.replace(/\r\n/g, '\n').trim();
                const normExpected = expectedBom.replace(/\r\n/g, '\n').trim();
                if (normActual !== normExpected) {
                  errors.push('BOM.md is out of sync with parts.intent.json; run draft_bom to synchronize');
                  isDrift = true;
                }
              } catch (err) {
                errors.push(`failed to read BOM.md: ${(err as Error).message}`);
              }
            }
          }
        } catch (resolverErr) {
          errors.push(`manifest resolver failure: ${(resolverErr as Error).message}`);
        }
      }
    }

    manifestReport = {
      ok: errors.length === 0,
      errors,
      drift: isDrift,
    };

    if (manifestReport.ok) {
      log('parts manifest ✓');
    } else {
      for (const err of manifestReport.errors) {
        log(`manifest: ${err}`);
      }
    }
  }

  const ok =
    (erc?.ok ?? true) &&
    (drc?.ok ?? true) &&
    drift.length === 0 &&
    (openspec?.ok ?? true) &&
    constraintViolations.length === 0 &&
    (manifestReport?.ok ?? true);

  return {
    ok,
    erc: erc ? { ok: erc.ok, violations: erc.violations.length } : null,
    drc: drc ? { ok: drc.ok, violations: drc.violations.length, unrouted: drc.unrouted ?? 0, intrinsic: drc.intrinsic?.length ?? 0 } : null,
    drift: { ok: drift.length === 0, mismatches: drift, ...(driftWarning ? { warning: driftWarning } : {}) },
    openspec,
    constraints: { ok: constraintViolations.length === 0, violations: constraintViolations },
    legibility,
    ...(manifestReport ? { manifest: manifestReport } : {}),
  };
}
