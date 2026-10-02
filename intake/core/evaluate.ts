// Change evaluation (ground-intake-extraction D7): a change descriptor becomes one engine check
// per constraint it touches, in registry order. The first HOLD or REFUSE decides; APPROVE needs
// at least one check and no failure. Pure.

import { parseMeasurement, UnitError } from "./knowledge/decimal";
import type { Constraint, Decimal, Verdict } from "./knowledge/types";
import { evaluate } from "./knowledge/verdict/engine";
import type { CheckRequest, EngineContext, EngineResult, FactSnapshot } from "./knowledge/verdict/types";
import type { ChangeDescriptor } from "./model";

export interface EvaluateInput {
  change: ChangeDescriptor;
  partId: string;
  snapshot: FactSnapshot;
  constraints: Constraint[];
  context: EngineContext;
}

export interface EvaluateResult {
  verdict: Verdict;
  /** Every check that ran, in order, with its own verdict and manifest. */
  checks: EngineResult[];
}

/** Deterministic fixes the intake knows better than the generic budget advice. */
function proposeFix(constraint: Constraint, change: ChangeDescriptor, fallback: string | undefined): string | undefined {
  if (constraint.kind === "budget_sum" && /pull[- ]?up/i.test(change.label)) {
    return "use the MCU internal pull-up instead of an external resistor (leakage stays within budget)";
  }
  return fallback;
}

function hold(change: ChangeDescriptor, reasonCodes: Verdict["reasonCodes"], reason: string, ruleVersion: string): Verdict {
  return { change: change.label, decision: "HOLD", reason, reasonCodes, citedReadings: [], ruleVersion };
}

function touches(constraint: Constraint, change: ChangeDescriptor): boolean {
  return change.contributions.some(
    (c) => constraint.affects.includes(c.factKey) || (constraint.stressFrom?.key === c.factKey && c.value !== undefined),
  );
}

export function evaluateChange(input: EvaluateInput): EvaluateResult {
  const { change, partId, snapshot, constraints, context } = input;
  const checks: EngineResult[] = [];
  const touched = constraints.filter((c) => touches(c, change));
  if (touched.length === 0) {
    return { verdict: hold(change, ["SCOPE_EMPTY"], `no constraint is affected by "${change.label}"`, context.ruleVersion), checks };
  }
  let approve: Verdict | undefined;
  for (const constraint of touched) {
    const relevant = change.contributions.filter(
      (c) => constraint.affects.includes(c.factKey) || constraint.stressFrom?.key === c.factKey,
    );
    const applied: { label: string; value: Decimal }[] = [];
    try {
      for (const c of relevant.filter((c) => c.value !== undefined)) {
        if (c.unit === undefined) {
          return { verdict: hold(change, ["UNIT_UNKNOWN"], `"${change.label}" applies ${c.value} to ${c.factKey} with no unit`, context.ruleVersion), checks };
        }
        applied.push({ label: change.label, value: parseMeasurement(String(c.value), c.unit) });
      }
    } catch (err) {
      if (err instanceof UnitError) {
        return { verdict: hold(change, [err.code], `"${change.label}": ${err.message}`, context.ruleVersion), checks };
      }
      throw err;
    }
    const request: CheckRequest = {
      change: change.label,
      part: partId,
      constraint,
      terms: constraint.stressFrom
        ? []
        : relevant.filter((c) => c.value === undefined).map((c) => ({ part: partId, key: c.factKey })),
      applied,
    };
    const result = evaluate(request, snapshot, context);
    checks.push(result);
    const verdict = result.verdict;
    if (verdict.decision === "REFUSE") {
      const fix = proposeFix(constraint, change, verdict.proposedFix);
      return { verdict: fix === undefined ? verdict : { ...verdict, proposedFix: fix }, checks };
    }
    if (verdict.decision === "HOLD") return { verdict, checks };
    approve ??= verdict;
  }
  return { verdict: approve!, checks };
}
