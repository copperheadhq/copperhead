import path from 'node:path';
import { libraryCache } from '../kicad/cache.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { evidenceContract } from '../pcb/evidence.js';
import { importBoard } from '../pcb/ir/kicad/import.js';
import { extractFills } from '../pcb/ir/kicad/zones.js';
import { verifyDesign } from '../pcb/verify/index.js';
import { loadConstraints as loadLayoutConstraints } from '../pcb/intent/load.js';
import { loadConfig } from '../config.js';
import { runErc, runDrc } from '../kicad/cli.js';
import { formatViolations, type CheckReport } from '../kicad/report.js';
import { checkDrift, emptySchematicWarning, type DriftMismatch } from '../memory/drift.js';
import { manifestDrift } from '../kicad/parts/render.js';
import { loadConstraints, checkForbiddenPins, type ConstraintViolation } from '../memory/constraints.js';
import { pinNets, readSheetGeometry } from '../kicad/sexp.js';
import { scoreFromGeometry, type ScoreReport } from '../kicad/score.js';
import { checkLegibility, formatLegibility, LEGIBILITY_FAMILIES, type LegibilityFinding } from '../kicad/legibility.js';
import { openspecValidate } from '../openspec/cli.js';

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
  /**
   * The layout track: present when docs/LAYOUT.md carries layout evidence
   * (written by `pcb route --apply`, `pcb layout --apply`, or `pcb reuse
   * --apply`). The committed board is re-verified by the harness checkers (no
   * engine, no model); stale evidence or a failed gate fails the check.
   */
  layout: {
    ok: boolean;
    status: string;
    stale: boolean;
    selected: string | null;
    runDir: string;
    gates: { preflight: boolean; placement: boolean; routing: boolean };
    metrics: Record<string, number>;
    errors: { code: string; entityReferences: string[]; message: string }[];
  } | null;
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
  libraryCache.attach(repoRoot);
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
  } else {
    // The parts manifest is the one doc check that needs no schematic: a
    // docs-only repo (a create run before stage 4) still reports a manifest
    // that does not parse, or a BOM.md that is not its render. Silent when
    // there is no manifest, as before.
    drift = await manifestDrift(path.join(repoRoot, config.docs));
    if (drift.length) log(drift.map((m) => `drift: ${m.doc} claims "${m.claim}" but actual is "${m.actual}"`).join('\n'));
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

  let layout: CheckResult['layout'] = null;
  const layoutDoc = path.join(repoRoot, config.docs, 'LAYOUT.md');
  if (config.board && existsSync(path.join(repoRoot, config.board)) && existsSync(layoutDoc)) {
    const boardPath = path.join(repoRoot, config.board);
    const boardText = await readFile(boardPath, 'utf8');
    const proPath = boardPath.replace(/\.kicad_pcb$/, '.kicad_pro');
    const projectText = existsSync(proPath) ? await readFile(proPath, 'utf8') : undefined;
    const verdict = evidenceContract(await readFile(layoutDoc, 'utf8'), boardText, boardPath, projectText);
    if (verdict.evidence) {
      const { design } = importBoard({ boardText, boardPath, ...(projectText ? { projectText } : {}) });
      const { registry: layoutConstraints } = await loadLayoutConstraints(design, boardPath, {
        intentPath: config.pcb?.intentPath ?? null,
        docsDir: path.join(repoRoot, config.docs),
        repoRoot,
      });
      const v = verifyDesign({ design, fills: extractFills(boardText), ...(drc ? { drc } : {}), constraints: layoutConstraints });
      const errors = v.diagnostics
        .filter((d) => d.severity === 'error')
        .map((d) => ({ code: d.code, entityReferences: d.entityReferences, message: d.message }));
      const gates = { preflight: v.gates.preflight.passed, placement: v.gates.placement.passed, routing: v.gates.routing.passed };
      const status = verdict.stale ? 'STALE' : verdict.evidence.status;
      const layoutOk = !verdict.stale && gates.preflight && gates.placement && gates.routing;
      layout = {
        ok: layoutOk,
        status,
        stale: verdict.stale,
        selected: verdict.evidence.selected,
        runDir: verdict.evidence.runDir,
        gates,
        metrics: Object.fromEntries(Object.entries(v.metrics).filter((kv): kv is [string, number] => typeof kv[1] === 'number')),
        errors,
      };
      const failed = [...v.gates.preflight.failures, ...v.gates.placement.failures, ...v.gates.routing.failures]
        .map((d) => d.code)
        .filter((c, i, a) => a.indexOf(c) === i);
      log(
        layoutOk
          ? `layout ✓ ${verdict.evidence.status} (${verdict.evidence.selected ?? 'no engine'}, ${v.metrics.routed_nets ?? 0} net(s) routed, ${v.metrics.unrouted_count ?? 0} owed; evidence ${verdict.evidence.runDir})`
          : verdict.stale
            ? `layout: ${verdict.reason}`
            : `layout: gate failed (${failed.join(', ')}); evidence ${verdict.evidence.runDir}`,
      );
    }
  }

  const ok =
    (erc?.ok ?? true) &&
    (drc?.ok ?? true) &&
    drift.length === 0 &&
    (openspec?.ok ?? true) &&
    constraintViolations.length === 0 &&
    (layout?.ok ?? true);

  return {
    ok,
    erc: erc ? { ok: erc.ok, violations: erc.violations.length } : null,
    drc: drc ? { ok: drc.ok, violations: drc.violations.length, unrouted: drc.unrouted ?? 0, intrinsic: drc.intrinsic?.length ?? 0 } : null,
    drift: { ok: drift.length === 0, mismatches: drift, ...(driftWarning ? { warning: driftWarning } : {}) },
    openspec,
    constraints: { ok: constraintViolations.length === 0, violations: constraintViolations },
    layout,
    legibility,
  };
}
