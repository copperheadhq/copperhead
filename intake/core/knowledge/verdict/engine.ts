/**
 * The deterministic verdict engine (SPEC §14).
 *
 * APPROVE only when: inputs exist · readings admissible with sufficient
 * status · evidence conditions cover the requirement's · the qualifier
 * provides the needed guarantee · exact-decimal calculation satisfies the
 * requirement (boundaries inclusive). REFUSE only on admissible,
 * condition-compatible proof of violation. Everything else HOLDs with a
 * reason code. Pure functions over pinned snapshots — AC-8.6 determinism
 * and AC-8.8 provider-freedom hold by construction.
 */

import type {
  ConditionSet,
  Constraint,
  Decimal,
  Qualifier,
  Verdict,
  VerificationManifest,
} from "../types";
import {
  UnitError,
  compareMeasurements,
  parseUnit,
  shift,
  siValue,
  subtract,
  sumMeasurements,
  toDecimalString,
} from "../decimal";
import { conditionsCover, effectiveRequirement } from "./coverage";
import type {
  CheckRequest,
  EngineContext,
  EngineResult,
  FactSnapshot,
  FactSnapshotEntry,
} from "./types";

export const ENGINE_VERSION = "1.1.0";

/** The qualifier that provides the needed guarantee (SPEC §14, AC-8.2). */
function guaranteeQualifiers(constraint: Constraint): Qualifier[] {
  if (constraint.policy.bound === "TYPICAL_OK") return ["TYP", "NOM"];
  switch (constraint.kind) {
    case "max":
    case "budget_sum":
      return ["MAX"]; // upper-bound checks need the worst-case high
    case "min":
      return ["MIN"];
    case "equality":
      return ["NOM"];
  }
  return [];
}

const KNOWN_KINDS: readonly string[] = ["budget_sum", "max", "min", "equality"];

interface TermSelection {
  entry?: FactSnapshotEntry;
  hold?: { reasonCodes: Verdict["reasonCodes"]; reason: string };
}

function selectTermFact(
  term: { part: string; key: string },
  constraint: Constraint,
  requirement: ConditionSet,
  snapshot: FactSnapshot,
  strictStatus: boolean,
  qualifiers?: Qualifier[],
): TermSelection {
  const candidates = snapshot.facts.filter(
    (f) => f.part === term.part && f.key === term.key,
  );
  if (candidates.length === 0) {
    return {
      hold: {
        reasonCodes: ["EVIDENCE_MISSING"],
        reason: `no fact for ${term.part}/${term.key}`,
      },
    };
  }

  const wanted = qualifiers ?? guaranteeQualifiers(constraint);
  const qualified = candidates.filter((f) => wanted.includes(f.qualifier));
  if (qualified.length === 0) {
    return {
      hold: {
        reasonCodes: ["GUARANTEE_UNAVAILABLE"],
        reason: `${term.part}/${term.key}: no ${wanted.join("/")} reading ${qualifiers ? "for a stress check" : `under ${constraint.policy.bound} policy`} (available: ${[...new Set(candidates.map((f) => f.qualifier))].join(", ")})`,
      },
    };
  }

  if (qualified.some((f) => f.frozen || f.status === "disputed")) {
    return {
      hold: {
        reasonCodes: ["FACT_CONFLICT"],
        reason: `${term.part}/${term.key}: fact is disputed and frozen`,
      },
    };
  }

  const revisions = new Set(
    qualified.map((f) => f.reading.evidence.document.revision ?? ""),
  );
  const values = new Set(qualified.map((f) => f.value.si_value_decimal));
  if (revisions.size > 1 && values.size > 1) {
    return {
      hold: {
        reasonCodes: ["REVISION_CONFLICT"],
        reason: `${term.part}/${term.key}: conflicting values across document revisions [${[...revisions].join(", ")}]`,
      },
    };
  }

  const covering = qualified.filter(
    (f) => conditionsCover(f.conditions, requirement).covered,
  );
  if (covering.length === 0) {
    const sample = conditionsCover(qualified[0]!.conditions, requirement);
    return {
      hold: {
        reasonCodes: ["CONDITION_NOT_COVERED"],
        reason: `${term.part}/${term.key}: ${sample.failures.join("; ")}`,
      },
    };
  }

  if (strictStatus && covering.every((f) => f.status === "extracted")) {
    return {
      hold: {
        reasonCodes: ["INSUFFICIENT_EVIDENCE"],
        reason: `${term.part}/${term.key}: only extracted-status evidence under strict-status policy (§11.4)`,
      },
    };
  }

  const chosen = [...covering].sort((a, b) =>
    a.sha256 < b.sha256 ? -1 : 1,
  )[0]!;
  return { entry: chosen };
}

function formatConditions(conditions: ConditionSet): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(conditions)) {
    if (value === undefined || key === "notes") continue;
    if (typeof value === "string") parts.push(`${key}=${value}`);
    else if ("min" in (value as object)) {
      const range = value as { min: Decimal; max: Decimal };
      parts.push(
        `${key}=${range.min.value_decimal}..${range.max.value_decimal} ${range.min.unit}`,
      );
    } else {
      const d = value as Decimal;
      parts.push(`${key}=${d.value_decimal} ${d.unit}`);
    }
  }
  return parts.length > 0 ? parts.join(", ") : "unconditioned";
}

/** Exact deviation of result beyond limit, expressed in the limit's unit. */
function deviation(result: Decimal, limit: Decimal): string {
  const diff = subtract(siValue(result), siValue(limit));
  const unit = parseUnit(limit.unit);
  return `${toDecimalString(shift(diff, -unit.powerToBase))} ${limit.unit}`;
}

export function evaluate(
  request: CheckRequest,
  snapshot: FactSnapshot,
  context: EngineContext,
): EngineResult {
  const constraint = request.constraint;
  // Gaps closed in the intake's copy (ground-intake-extraction D7): an unknown kind, an
  // unknown missing-condition policy, or a stress check on anything but `max` holds,
  // and a unit error holds instead of escaping the engine.
  if (
    !KNOWN_KINDS.includes(constraint.kind) ||
    constraint.policy.missingCondition !== "HOLD" ||
    (constraint.stressFrom !== undefined && constraint.kind !== "max")
  ) {
    return hold(request, context, ["UNSUPPORTED_OPERATOR"],
      `${constraint.id}: unsupported constraint (kind ${String(constraint.kind)}, missing-condition policy ${String(constraint.policy.missingCondition)}${constraint.stressFrom ? ", stressFrom on a non-max constraint" : ""})`);
  }
  try {
    return constraint.stressFrom
      ? evaluateStress(request, snapshot, context, constraint.stressFrom.key)
      : evaluateChecked(request, snapshot, context);
  } catch (error) {
    if (error instanceof UnitError) {
      return hold(request, context, [error.code], `${constraint.id}: ${error.message}`);
    }
    throw error;
  }
}

function hold(
  request: CheckRequest,
  context: EngineContext,
  reasonCodes: Verdict["reasonCodes"],
  reason: string,
): EngineResult {
  return finish(request, context, { decision: "HOLD", reason, reasonCodes, citedReadings: [] }, []);
}

function appliedExpression(applied: { label: string; value: Decimal }): string {
  return `${applied.value.value_decimal} ${applied.value.unit} [applied: ${applied.label}]`;
}

/**
 * Absolute-maximum stress check (ground-intake-extraction D7): the value the change applies
 * must not exceed the part's ABS_MAX reading nor the rule's own limit. The lower of the two
 * is the ceiling, and a refusal cites it.
 */
function evaluateStress(
  request: CheckRequest,
  snapshot: FactSnapshot,
  context: EngineContext,
  key: string,
): EngineResult {
  const constraint = request.constraint;
  const applied = request.applied ?? [];
  if (applied.length !== 1) {
    return hold(request, context, ["SCOPE_EMPTY"],
      `${constraint.id}: a stress check compares exactly one applied value (got ${applied.length})`);
  }
  const requirement = effectiveRequirement(constraint.conditions, request.requirementConditions);
  const selection = selectTermFact({ part: request.part, key }, constraint, requirement, snapshot,
    request.strictStatus ?? false, ["ABS_MAX"]);
  if (selection.hold) return hold(request, context, selection.hold.reasonCodes, selection.hold.reason);
  const absMax = selection.entry!;
  const value = applied[0]!;
  const ruleIsLower = compareMeasurements(constraint.limit, absMax.value) <= 0;
  const ceiling = ruleIsLower ? constraint.limit : absMax.value;
  const satisfied = compareMeasurements(value.value, ceiling) <= 0;
  const computed: NonNullable<Verdict["computed"]> = {
    expression: `${appliedExpression(value)} ≤ ${absMax.value.value_decimal} ${absMax.value.unit} [${absMax.part}/${absMax.key} ABS_MAX] and ≤ ${constraint.limit.value_decimal} ${constraint.limit.unit} [rule]`,
    terms: [
      { term: `applied/${value.label}`, value: value.value, readingRef: "applied" },
      { term: `${absMax.part}/${absMax.key}`, value: absMax.value, readingRef: absMax.readingRef },
    ],
    result: value.value,
    limit: ceiling,
  };
  const ceilingName = ruleIsLower
    ? `the rule's ${constraint.limit.value_decimal} ${constraint.limit.unit} limit`
    : `the ${absMax.value.value_decimal} ${absMax.value.unit} absolute maximum of ${absMax.key}`;
  if (satisfied) {
    return finish(request, context, {
      decision: "APPROVE",
      reason: `${constraint.description}: ${value.value.value_decimal} ${value.value.unit} applied is within ${ceilingName} (${formatConditions(requirement)})`,
      reasonCodes: ["REQUIREMENT_SATISFIED"],
      computed,
      citedReadings: [absMax.reading],
    }, [absMax]);
  }
  const over = deviation(value.value, ceiling);
  return finish(request, context, {
    decision: "REFUSE",
    reason: `${constraint.description}: ${value.value.value_decimal} ${value.value.unit} applied exceeds ${ceilingName} by ${over} under ${formatConditions(requirement)}`,
    reasonCodes: ["BUDGET_EXCEEDED"],
    computed,
    citedReadings: [absMax.reading],
    proposedFix: `apply at most ${ceiling.value_decimal} ${ceiling.unit} to ${absMax.key}, or choose a part rated for ${value.value.value_decimal} ${value.value.unit}`,
  }, [absMax]);
}

function evaluateChecked(
  request: CheckRequest,
  snapshot: FactSnapshot,
  context: EngineContext,
): EngineResult {
  const constraint = request.constraint;
  const applied = request.applied ?? [];
  const requirement = effectiveRequirement(
    constraint.conditions,
    request.requirementConditions,
  );

  const selections = request.terms.map((term) =>
    selectTermFact(
      term,
      constraint,
      requirement,
      snapshot,
      request.strictStatus ?? false,
    ),
  );

  const holds = selections.filter((s) => s.hold !== undefined);
  if (holds.length > 0 || (request.terms.length === 0 && applied.length === 0)) {
    const reasonCodes = [
      ...new Set(holds.flatMap((s) => s.hold!.reasonCodes)),
    ];
    return finish(request, context, {
      decision: "HOLD",
      reason:
        holds.map((s) => s.hold!.reason).join("; ") ||
        "no terms to evaluate",
      reasonCodes: reasonCodes.length > 0 ? reasonCodes : ["SCOPE_EMPTY"],
      citedReadings: [],
    }, []);
  }

  const chosen = selections.map((s) => s.entry!);
  if (constraint.kind !== "budget_sum" && chosen.length + applied.length !== 1) {
    return hold(request, context, ["UNSUPPORTED_OPERATOR"],
      `${constraint.id}: a ${constraint.kind} check compares exactly one value (got ${chosen.length} facts and ${applied.length} applied)`);
  }
  const total =
    constraint.kind === "budget_sum"
      ? sumMeasurements([...chosen.map((f) => f.value), ...applied.map((a) => a.value)], constraint.limit.unit)
      : (chosen[0]?.value ?? applied[0]!.value);

  const comparison = compareMeasurements(total, constraint.limit);
  // Boundaries are inclusive (AC-8.1, AC-8.4).
  const satisfied =
    constraint.kind === "min"
      ? comparison >= 0
      : constraint.kind === "equality"
        ? comparison === 0
        : comparison <= 0;

  const computed: NonNullable<Verdict["computed"]> = {
    expression:
      [
        ...chosen.map((f) => `${f.value.value_decimal} ${f.value.unit} [${f.part}/${f.key} ${f.qualifier}]`),
        ...applied.map(appliedExpression),
      ].join(" + ") +
      ` ${constraint.kind === "min" ? "≥" : constraint.kind === "equality" ? "=" : "≤"} ${constraint.limit.value_decimal} ${constraint.limit.unit}`,
    terms: [
      ...chosen.map((f) => ({
        term: `${f.part}/${f.key}`,
        value: f.value,
        readingRef: f.readingRef,
      })),
      ...applied.map((a) => ({ term: `applied/${a.label}`, value: a.value, readingRef: "applied" })),
    ],
    result: total,
    limit: constraint.limit,
  };

  if (satisfied) {
    return finish(request, context, {
      decision: "APPROVE",
      reason: `${constraint.description}: ${total.value_decimal} ${total.unit} satisfies the ${constraint.limit.value_decimal} ${constraint.limit.unit} limit (${formatConditions(requirement)})`,
      reasonCodes: ["REQUIREMENT_SATISFIED"],
      computed,
      citedReadings: chosen.map((f) => f.reading),
    }, chosen);
  }

  // Admissible, condition-compatible proof of violation → cited REFUSE (AC-9.1).
  const over = deviation(total, constraint.limit);
  return finish(request, context, {
    decision: "REFUSE",
    reason: `${constraint.description}: computed ${total.value_decimal} ${total.unit} violates the ${constraint.limit.value_decimal} ${constraint.limit.unit} limit by ${over} under ${formatConditions(requirement)}`,
    reasonCodes: ["BUDGET_EXCEEDED"],
    computed,
    citedReadings: chosen.map((f) => f.reading),
    proposedFix: `reduce ${constraint.affects.join(" + ") || "the affected budget"} by at least ${over}`,
  }, chosen);
}

function finish(
  request: CheckRequest,
  context: EngineContext,
  verdictFields: Omit<Verdict, "change" | "ruleVersion" | "citedConstraint">,
  usedFacts: FactSnapshotEntry[],
): EngineResult {
  const verdict: Verdict = {
    change: request.change,
    ...verdictFields,
    citedConstraint: request.constraint,
    ruleVersion: context.ruleVersion,
  };
  const manifest: VerificationManifest = {
    timestampISO: context.timestampISO,
    part: request.part,
    change: request.change,
    checksRun: [request.constraint.id],
    verdict,
    factVersions: usedFacts.map((f) => ({
      key: f.key,
      qualifier: f.qualifier,
      sha256: f.sha256,
      status: f.status,
    })),
    providers: context.providers,
    decisionRunId: context.decisionRunId,
  };
  return { verdict, manifest };
}

/**
 * Operational HOLD (AC-8.7): when a dependency is down, callers emit this —
 * never an uncited answer. Kept in the engine so the shape and reason codes
 * stay canonical.
 */
export function operationalHold(
  request: CheckRequest,
  context: EngineContext,
  dependency: string,
): EngineResult {
  return finish(request, context, {
    decision: "HOLD",
    reason: `dependency unavailable: ${dependency} — refusing to answer without evidence`,
    reasonCodes: ["DEPENDENCY_UNAVAILABLE"],
    citedReadings: [],
  }, []);
}
