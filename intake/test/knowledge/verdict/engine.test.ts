import { describe, expect, it } from "vitest";
import type { Constraint, Qualifier, Reading } from "../../../core/knowledge/types";
import { parseMeasurement } from "../../../core/knowledge/decimal";
import { evaluate, operationalHold } from "../../../core/knowledge/verdict/engine";
import type { CheckRequest, EngineContext, FactSnapshotEntry } from "../../../core/knowledge/verdict/types";

const CONTEXT: EngineContext = {
  decisionRunId: "run-0001",
  timestampISO: "2026-08-07T00:00:00Z",
  providers: [{ kind: "extraction", id: "stub-extraction", version: "0.1.0" }],
  ruleVersion: "sleep-budget-v1.0.0",
};

function fact(overrides: {
  part?: string;
  key?: string;
  value: string;
  unit?: string;
  qualifier?: Qualifier;
  status?: FactSnapshotEntry["status"];
  frozen?: boolean;
  temperature?: string;
  revision?: string;
  sha?: string;
}): FactSnapshotEntry {
  const measurement = parseMeasurement(overrides.value, overrides.unit ?? "uA");
  const conditions = {
    vin: parseMeasurement("3.6", "V"),
    temperature: parseMeasurement(overrides.temperature ?? "25", "°C"),
  };
  const reading: Reading = {
    measurement,
    qualifier: overrides.qualifier ?? "MAX",
    conditions,
    confidence: 0.9,
    evidence: {
      evidenceId: `ev-${overrides.key ?? "iq"}-${overrides.value}`,
      document: {
        documentId: "doc-a",
        sha256: (overrides.sha ?? "a").repeat(64).slice(0, 64),
        revision: overrides.revision ?? "Rev C",
        authority: "MANUFACTURER",
      },
      page: 6,
      text: `IQ ${overrides.value} ${overrides.unit ?? "uA"}`,
    },
    contributor: "ingest-bot",
    method: { kind: "extraction", providerId: "stub-extraction" },
    validators: [],
    addedAtISO: "2026-08-01T00:00:00Z",
  };
  return {
    part: overrides.part ?? "st:STM32U083MCT6",
    key: overrides.key ?? "iq_sleep_uA",
    qualifier: overrides.qualifier ?? "MAX",
    value: measurement,
    conditions,
    status: overrides.status ?? "corroborated",
    ...(overrides.frozen !== undefined ? { frozen: overrides.frozen } : {}),
    sha256: (overrides.sha ?? "1").repeat(64).slice(0, 64),
    readingRef: `reading-${overrides.key ?? "iq"}-${overrides.qualifier ?? "MAX"}`,
    reading,
  };
}

const SLEEP_LIMIT: Constraint = {
  id: "sleep-current-budget",
  description: "sleep current budget",
  kind: "max",
  limit: parseMeasurement("25", "uA"),
  affects: ["iq_sleep_uA"],
  source: "power-budget.md",
  conditions: { temperature: parseMeasurement("25", "°C") },
  policy: { bound: "WORST_CASE", missingCondition: "HOLD" },
};

function request(overrides: Partial<CheckRequest> = {}): CheckRequest {
  return {
    change: "add sensor sampling in sleep",
    part: "st:STM32U083MCT6",
    constraint: SLEEP_LIMIT,
    terms: [{ part: "st:STM32U083MCT6", key: "iq_sleep_uA" }],
    ...overrides,
  };
}

describe("FR-8 verdict engine fixtures", () => {
  it("AC-8.1: 24.9 / 25.0 / 25.1 uA vs a 25 uA limit → APPROVE / APPROVE / REFUSE", () => {
    for (const [value, decision] of [
      ["24.9", "APPROVE"],
      ["25.0", "APPROVE"],
      ["25.1", "REFUSE"],
    ] as const) {
      const { verdict } = evaluate(request(), { facts: [fact({ value })] }, CONTEXT);
      expect(verdict.decision, `at ${value} uA`).toBe(decision);
    }
  });

  it("AC-8.2: TYP-only evidence under worst-case policy → HOLD GUARANTEE_UNAVAILABLE", () => {
    const { verdict } = evaluate(
      request(),
      { facts: [fact({ value: "24", qualifier: "TYP" })] },
      CONTEXT,
    );
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reasonCodes).toContain("GUARANTEE_UNAVAILABLE");
  });

  it("AC-8.3: fact measured at 25°C, requirement at 60°C → HOLD CONDITION_NOT_COVERED", () => {
    const { verdict } = evaluate(
      request({
        requirementConditions: { temperature: parseMeasurement("60", "°C") },
      }),
      { facts: [fact({ value: "24.9" })] },
      CONTEXT,
    );
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reasonCodes).toContain("CONDITION_NOT_COVERED");
  });

  it("AC-8.4: budget 8 + 25 → REFUSE at 33 uA citing both terms; 8 + 17 → APPROVE at boundary", () => {
    const budget: Constraint = {
      ...SLEEP_LIMIT,
      kind: "budget_sum",
      affects: ["mcu.iq_sleep_uA", "sensor.iq_sleep_uA"],
    };
    const facts = (sensor: string) => ({
      facts: [
        fact({ part: "st:STM32U083MCT6", key: "iq_sleep_uA", value: "8", sha: "2" }),
        fact({ part: "bosch:BME280", key: "iq_sleep_uA", value: sensor, sha: "3" }),
      ],
    });
    const terms = [
      { part: "st:STM32U083MCT6", key: "iq_sleep_uA" },
      { part: "bosch:BME280", key: "iq_sleep_uA" },
    ];

    const refuse = evaluate(request({ constraint: budget, terms }), facts("25"), CONTEXT);
    expect(refuse.verdict.decision).toBe("REFUSE");
    expect(refuse.verdict.computed?.result.value_decimal).toBe("33");
    expect(refuse.verdict.computed?.terms).toHaveLength(2);
    expect(refuse.verdict.citedReadings).toHaveLength(2);
    expect(refuse.verdict.reasonCodes).toContain("BUDGET_EXCEEDED");

    const approve = evaluate(request({ constraint: budget, terms }), facts("17"), CONTEXT);
    expect(approve.verdict.decision).toBe("APPROVE");
    expect(approve.verdict.computed?.result.value_decimal).toBe("25");
  });

  it("AC-8.5: conflicting values across revisions → HOLD REVISION_CONFLICT", () => {
    const { verdict } = evaluate(
      request(),
      {
        facts: [
          fact({ value: "24", revision: "Rev B", sha: "4" }),
          fact({ value: "26", revision: "Rev C", sha: "5" }),
        ],
      },
      CONTEXT,
    );
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reasonCodes).toContain("REVISION_CONFLICT");
  });

  it("AC-8.6: identical request 100× → byte-identical output", () => {
    const one = JSON.stringify(
      evaluate(request(), { facts: [fact({ value: "24.9" })] }, CONTEXT),
    );
    for (let i = 0; i < 99; i++) {
      expect(
        JSON.stringify(
          evaluate(request(), { facts: [fact({ value: "24.9" })] }, CONTEXT),
        ),
      ).toBe(one);
    }
  });

  it("AC-8.7: dependency down → operational HOLD, never uncited", () => {
    const { verdict } = operationalHold(request(), CONTEXT, "index-store");
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reasonCodes).toEqual(["DEPENDENCY_UNAVAILABLE"]);
  });

  it("missing fact → HOLD EVIDENCE_MISSING; disputed fact → HOLD FACT_CONFLICT", () => {
    const missing = evaluate(request(), { facts: [] }, CONTEXT);
    expect(missing.verdict.decision).toBe("HOLD");
    expect(missing.verdict.reasonCodes).toContain("EVIDENCE_MISSING");

    const disputed = evaluate(
      request(),
      { facts: [fact({ value: "24.9", status: "disputed", frozen: true })] },
      CONTEXT,
    );
    expect(disputed.verdict.decision).toBe("HOLD");
    expect(disputed.verdict.reasonCodes).toContain("FACT_CONFLICT");
  });

  it("§11.4 strict-status: extracted-only deciding fact → HOLD", () => {
    const { verdict } = evaluate(
      request({ strictStatus: true }),
      { facts: [fact({ value: "24.9", status: "extracted" })] },
      CONTEXT,
    );
    expect(verdict.decision).toBe("HOLD");
    expect(verdict.reasonCodes).toContain("INSUFFICIENT_EVIDENCE");
  });
});

describe("FR-9 cited refusal (AC-9.1–9.3)", () => {
  it("names value, limit, deviation, conditions, and a specific fix", () => {
    const { verdict } = evaluate(
      request(),
      { facts: [fact({ value: "33" })] },
      CONTEXT,
    );
    expect(verdict.decision).toBe("REFUSE");
    expect(verdict.reason).toContain("33 uA");
    expect(verdict.reason).toContain("25 uA");
    expect(verdict.reason).toContain("8 uA"); // deviation
    expect(verdict.reason).toContain("temperature=25 °C");
    expect(verdict.proposedFix).toContain("8 uA");
    expect(verdict.citedReadings.length).toBeGreaterThan(0);
    expect(verdict.reasonCodes.length).toBeGreaterThan(0);
  });
});

describe("FR-11 manifests (AC-11.2)", () => {
  it("carries decisionRunId, pinned fact versions, and the provider set", () => {
    const { manifest } = evaluate(
      request(),
      { facts: [fact({ value: "24.9" })] },
      CONTEXT,
    );
    expect(manifest.decisionRunId).toBe("run-0001");
    expect(manifest.factVersions).toEqual([
      {
        key: "iq_sleep_uA",
        qualifier: "MAX",
        sha256: "1".repeat(64),
        status: "corroborated",
      },
    ]);
    expect(manifest.providers[0]?.id).toBe("stub-extraction");
    expect(manifest.checksRun).toEqual(["sleep-current-budget"]);
  });

  it("pins a degraded provider flag into the manifest verbatim (AC-2.3)", () => {
    // The engine is provider-free (AC-8.8), so it cannot compute degradation
    // itself; it must carry the caller's flag through unchanged, so an auditor
    // can see that a verdict rested on a provider running without its
    // required capabilities.
    const providers = [
      { kind: "extraction", id: "stub-extraction", version: "0.1.0", degraded: true },
    ];
    const { manifest } = evaluate(
      request(),
      { facts: [fact({ value: "24.9" })] },
      { ...CONTEXT, providers },
    );
    expect(manifest.providers).toEqual(providers);
  });
});

describe("condition coverage details", () => {
  it("evidence range covers a requirement point; a point never covers a range", () => {
    const rangeFact = {
      ...fact({ value: "24.9" }),
      conditions: {
        temperature: {
          min: parseMeasurement("-40", "°C"),
          max: parseMeasurement("85", "°C"),
        },
      },
    };
    const covered = evaluate(
      request({ requirementConditions: { temperature: parseMeasurement("60", "°C") } }),
      { facts: [rangeFact] },
      CONTEXT,
    );
    expect(covered.verdict.decision).toBe("APPROVE");

    const pointVsRange = evaluate(
      request({
        requirementConditions: {
          temperature: {
            min: parseMeasurement("-40", "°C"),
            max: parseMeasurement("85", "°C"),
          },
        },
      }),
      { facts: [fact({ value: "24.9" })] },
      CONTEXT,
    );
    expect(pointVsRange.verdict.decision).toBe("HOLD");
    expect(pointVsRange.verdict.reasonCodes).toContain("CONDITION_NOT_COVERED");
  });
});
