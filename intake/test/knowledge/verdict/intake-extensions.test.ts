// The intake's changes to cortex's verdict engine (ground-intake-extraction D7): the three
// gaps closed, applied values, and absolute-maximum stress checks.

import { describe, expect, it } from "vitest";
import type { Constraint, Qualifier, Reading } from "../../../core/knowledge/types";
import { parseMeasurement } from "../../../core/knowledge/decimal";
import { evaluate } from "../../../core/knowledge/verdict/engine";
import type { CheckRequest, EngineContext, FactSnapshotEntry } from "../../../core/knowledge/verdict/types";

const CONTEXT: EngineContext = {
  decisionRunId: "run-0001",
  timestampISO: "2026-10-02T00:00:00Z",
  providers: [{ kind: "extraction", id: "fixture", version: "1" }],
  ruleVersion: "test-v1",
};
const PART = "demo:DEMO-IO-EXPANDER";

function fact(key: string, value: string, unit: string, qualifier: Qualifier): FactSnapshotEntry {
  const measurement = parseMeasurement(value, unit);
  const reading: Reading = {
    measurement,
    qualifier,
    conditions: {},
    confidence: 0.9,
    evidence: {
      evidenceId: `ev-${key}-${qualifier}`,
      document: { documentId: "doc", sha256: "a".repeat(64), revision: "A", authority: "MANUFACTURER" },
      page: 1,
      text: `${key} ${value} ${unit}`,
    },
    contributor: "test",
    method: { kind: "extraction", providerId: "fixture" },
    validators: [],
    addedAtISO: "2026-10-02T00:00:00Z",
  };
  return {
    part: PART,
    key,
    qualifier,
    value: measurement,
    conditions: {},
    status: "extracted",
    sha256: `${key}-${qualifier}`.padEnd(64, "0"),
    readingRef: `ev-${key}-${qualifier}`,
    reading,
  };
}

function constraint(overrides: Partial<Constraint>): Constraint {
  return {
    id: "c",
    description: "test constraint",
    kind: "max",
    limit: parseMeasurement("25", "uA"),
    affects: [],
    source: "test",
    policy: { bound: "WORST_CASE", missingCondition: "HOLD" },
    ...overrides,
  };
}

function request(c: Constraint, overrides: Partial<CheckRequest> = {}): CheckRequest {
  return { change: "test change", part: PART, constraint: c, terms: [], ...overrides };
}

const ABS_MAX_VIN = fact("abs_max_vin_V", "3.6", "V", "ABS_MAX");

describe("gaps closed in the intake's copy", () => {
  it("a unit dimension mismatch holds with DIMENSION_MISMATCH instead of throwing", () => {
    const c = constraint({ limit: parseMeasurement("3.3", "V") });
    const facts = [fact("quiescent_current_uA", "10", "uA", "MAX")];
    const { verdict } = evaluate(request(c, { terms: [{ part: PART, key: "quiescent_current_uA" }] }), { facts }, CONTEXT);
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reasonCodes).toEqual(["DIMENSION_MISMATCH"]);
  });

  it("an unknown constraint kind holds with UNSUPPORTED_OPERATOR", () => {
    const c = constraint({ kind: "ratio" as Constraint["kind"] });
    const { verdict } = evaluate(request(c, { terms: [{ part: PART, key: "x" }] }), { facts: [] }, CONTEXT);
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reasonCodes).toEqual(["UNSUPPORTED_OPERATOR"]);
  });

  it("an unknown missing-condition policy holds with UNSUPPORTED_OPERATOR", () => {
    const c = constraint({ policy: { bound: "WORST_CASE", missingCondition: "APPROVE" as "HOLD" } });
    const { verdict } = evaluate(request(c, { terms: [{ part: PART, key: "x" }] }), { facts: [] }, CONTEXT);
    expect(verdict.reasonCodes).toEqual(["UNSUPPORTED_OPERATOR"]);
  });

  it("stressFrom on a constraint that is not a max holds with UNSUPPORTED_OPERATOR", () => {
    const c = constraint({ kind: "min", stressFrom: { key: "abs_max_vin_V" } });
    const { verdict } = evaluate(request(c), { facts: [ABS_MAX_VIN] }, CONTEXT);
    expect(verdict.reasonCodes).toEqual(["UNSUPPORTED_OPERATOR"]);
  });
});

describe("applied values", () => {
  it("are summed exactly in a budget beside fact terms", () => {
    const c = constraint({ kind: "budget_sum", limit: parseMeasurement("25", "uA") });
    const facts = [fact("quiescent_current_uA", "0.1", "uA", "MAX")];
    const { verdict } = evaluate(
      request(c, {
        terms: [{ part: PART, key: "quiescent_current_uA" }],
        applied: [{ label: "100k pull-up", value: parseMeasurement("33", "uA") }],
      }),
      { facts },
      CONTEXT,
    );
    expect(verdict.decision).toBe("REFUSE");
    expect(verdict.computed?.result.value_decimal).toBe("33.1");
    expect(verdict.computed?.terms.map((t) => t.term)).toEqual([`${PART}/quiescent_current_uA`, "applied/100k pull-up"]);
  });

  it("an applied value alone is compared with a max limit", () => {
    const c = constraint({ limit: parseMeasurement("3.3", "V") });
    const { verdict } = evaluate(request(c, { applied: [{ label: "rail", value: parseMeasurement("3.3", "V") }] }), { facts: [] }, CONTEXT);
    expect(verdict.decision).toBe("APPROVE");
  });

  it("a max compares one value: a fact and an applied value together hold", () => {
    const c = constraint({ limit: parseMeasurement("3.3", "V") });
    const { verdict } = evaluate(
      request(c, {
        terms: [{ part: PART, key: "abs_max_vin_V" }],
        applied: [{ label: "rail", value: parseMeasurement("3", "V") }],
      }),
      { facts: [fact("abs_max_vin_V", "3.6", "V", "MAX")] },
      CONTEXT,
    );
    expect(verdict.reasonCodes).toEqual(["UNSUPPORTED_OPERATOR"]);
  });
});

describe("absolute-maximum stress checks", () => {
  const rail = (limit: string) =>
    constraint({ id: "rail_voltage_max", description: "rail voltage", limit: parseMeasurement(limit, "V"), stressFrom: { key: "abs_max_vin_V" } });

  it("refuses an applied value above the absolute maximum, citing the reading (GT-2)", () => {
    const { verdict } = evaluate(
      request(rail("5"), { applied: [{ label: "connect 5 V rail", value: parseMeasurement("5", "V") }] }),
      { facts: [ABS_MAX_VIN] },
      CONTEXT,
    );
    expect(verdict.decision).toBe("REFUSE");
    expect(verdict.computed?.result.value_decimal).toBe("5");
    expect(verdict.computed?.limit.value_decimal).toBe("3.6");
    expect(verdict.citedReadings.map((r) => r.qualifier)).toEqual(["ABS_MAX"]);
    expect(verdict.citedConstraint?.id).toBe("rail_voltage_max");
    expect(verdict.reason).toContain("absolute maximum of abs_max_vin_V");
  });

  it("refuses on the rule's limit when it is the lower ceiling", () => {
    const { verdict } = evaluate(
      request(rail("3.3"), { applied: [{ label: "connect 3.5 V rail", value: parseMeasurement("3.5", "V") }] }),
      { facts: [ABS_MAX_VIN] },
      CONTEXT,
    );
    expect(verdict.decision).toBe("REFUSE");
    expect(verdict.computed?.limit.value_decimal).toBe("3.3");
    expect(verdict.reason).toContain("the rule's 3.3 V limit");
  });

  it("approves an applied value within both ceilings, inclusive", () => {
    const { verdict } = evaluate(
      request(rail("5"), { applied: [{ label: "connect 3.6 V rail", value: parseMeasurement("3.6", "V") }] }),
      { facts: [ABS_MAX_VIN] },
      CONTEXT,
    );
    expect(verdict.decision).toBe("APPROVE");
  });

  it("holds when the part has no ABS_MAX reading, even with a MAX reading", () => {
    const { verdict } = evaluate(
      request(rail("5"), { applied: [{ label: "rail", value: parseMeasurement("5", "V") }] }),
      { facts: [fact("abs_max_vin_V", "3.6", "V", "MAX")] },
      CONTEXT,
    );
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reasonCodes).toEqual(["GUARANTEE_UNAVAILABLE"]);
  });

  it("holds without exactly one applied value", () => {
    const { verdict } = evaluate(request(rail("5")), { facts: [ABS_MAX_VIN] }, CONTEXT);
    expect(verdict.reasonCodes).toEqual(["SCOPE_EMPTY"]);
  });

  it("is deterministic: 100 runs give byte-identical output", () => {
    const run = () =>
      JSON.stringify(
        evaluate(
          request(rail("5"), { applied: [{ label: "connect 5 V rail", value: parseMeasurement("5", "V") }] }),
          { facts: [ABS_MAX_VIN] },
          CONTEXT,
        ),
      );
    const first = run();
    for (let i = 0; i < 100; i++) expect(run()).toBe(first);
  });
});

describe("ABS_MAX is never a guarantee qualifier", () => {
  it("a worst-case max does not accept an ABS_MAX reading", () => {
    const c = constraint({ limit: parseMeasurement("5", "V") });
    const { verdict } = evaluate(request(c, { terms: [{ part: PART, key: "abs_max_vin_V" }] }), { facts: [ABS_MAX_VIN] }, CONTEXT);
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reasonCodes).toEqual(["GUARANTEE_UNAVAILABLE"]);
  });
});
