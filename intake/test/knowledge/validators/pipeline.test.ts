import { describe, expect, it } from "vitest";
import type { DocumentRef, EvidenceUnit, Reading } from "../../../core/knowledge/types";
import type { RawExtraction } from "../../../core/knowledge/provider/kinds";
import { toCandidates, type ParameterSpec } from "../../../core/knowledge/validators/candidate";
import { runPipeline } from "../../../core/knowledge/validators/pipeline";
import { checkRangeInvariants, reconcileDuplicates } from "../../../core/knowledge/validators/group";
import { orderReviewQueue } from "../../../core/knowledge/validators/routing";
import { appendCorrection } from "../../../core/knowledge/validators/versioning";

const DOC: DocumentRef = {
  documentId: "tps62840-revc",
  sha256: "a".repeat(64),
  revision: "Rev C",
  authority: "MANUFACTURER",
};

const UNIT: EvidenceUnit = {
  evidenceId: "ev-1",
  document: DOC,
  page: 6,
  table: "6.5",
  row: 3,
  text: "IQ | Quiescent current | 0.025 | 0.033 | 0.060 | mA | VIN = 3.6 V, TA = 25°C",
  bbox: { x: 40, y: 220, width: 520, height: 14 },
};

const PARAM: ParameterSpec = {
  key: "iq_sleep_uA",
  dimension: "current",
  requiredConditions: ["vin", "temperature"],
};

const KNOWN = new Map([[DOC.sha256, DOC]]);
const NOW = () => "2026-08-07T00:00:00Z";

function extraction(overrides: Partial<RawExtraction> = {}): RawExtraction {
  return {
    rawField: "iq_typ_mA",
    value: "0.033",
    unit: "mA",
    qualifier: "TYP",
    rawConditions: { VIN: "3.6 V", TA: "25°C" },
    confidence: 0.9,
    evidenceId: "ev-1",
    ...overrides,
  };
}

function run(e: RawExtraction, unit: EvidenceUnit = UNIT) {
  const [candidate] = toCandidates([e], {
    unit,
    parameter: PARAM,
    contributor: "ingest-bot",
    provider: { id: "stub-extraction", version: "0.1.0" },
  });
  return runPipeline(candidate!, { knownDocuments: KNOWN }, NOW);
}

describe("validator pipeline (SPEC §8)", () => {
  it("admits a clean candidate and builds a Reading with exact SI value", () => {
    const result = run(extraction());
    expect(result.outcome).toBe("ADMITTED");
    expect(result.reading?.measurement).toEqual({
      value_decimal: "0.033",
      unit: "mA",
      si_value_decimal: "0.000033",
    });
    expect(result.reading?.method.providerId).toBe("stub-extraction");
    expect(result.reading?.conditions.vin).toBeDefined();
  });

  it("rejects a forged evidence id (AC-3.2)", () => {
    const result = run(extraction({ evidenceId: "ev-fake" }));
    expect(result.outcome).toBe("REJECTED");
    expect(result.reasonCodes).toContain("EVIDENCE_ID_INVALID");
  });

  it("rejects an unknown document hash", () => {
    const result = run(
      extraction(),
      { ...UNIT, document: { ...DOC, sha256: "f".repeat(64) } },
    );
    expect(result.outcome).toBe("REJECTED");
  });

  it("rejects a dimension mismatch (AC-4.3)", () => {
    const result = run(extraction({ unit: "V", value: "0.033" }));
    expect(result.outcome).toBe("REJECTED");
    expect(result.reasonCodes).toContain("DIMENSION_MISMATCH");
  });

  it("rejects citation non-containment (AC-3.3)", () => {
    const result = run(extraction({ value: "0.060" }), { ...UNIT, text: "IQ | 0.033 | mA" });
    expect(result.outcome).toBe("REJECTED");
    expect(result.reasonCodes).toContain("CITATION_NOT_CONTAINED");
  });

  it("routes a missing required condition to review, never silent (AC-5.1)", () => {
    const result = run(extraction({ rawConditions: { VIN: "3.6 V" } }));
    expect(result.outcome).toBe("REVIEW_REQUIRED");
    expect(result.reasonCodes).toContain("CONDITION_MISSING");
  });

  it("routes a missing qualifier to review without guessing", () => {
    const noQualifier = extraction();
    delete noQualifier.qualifier;
    const result = run(noQualifier);
    expect(result.outcome).toBe("REVIEW_REQUIRED");
    expect(result.reasonCodes).toContain("QUALIFIER_MISSING");
    expect(result.reading).toBeUndefined();
  });

  it("routes non-manufacturer sources to review", () => {
    const result = run(
      extraction(),
      { ...UNIT, document: { ...DOC, authority: "COMMUNITY" } },
    );
    // Unknown-doc lookup uses sha256, still registered here.
    expect(result.reasonCodes).toContain("SOURCE_NOT_AUTHORITATIVE");
  });

  it("is immune to confidence: identical outcomes at 0.01 and 0.99 (AC-7.2)", () => {
    const low = run(extraction({ confidence: 0.01, unit: "V" }));
    const high = run(extraction({ confidence: 0.99, unit: "V" }));
    expect(low.outcome).toBe(high.outcome);
    expect(low.reasonCodes).toEqual(high.reasonCodes);
  });
});

describe("MIN/TYP/MAX handling (AC-4.2, AC-4.4)", () => {
  const row: RawExtraction[] = [
    extraction({ rawField: "iq_min_mA", value: "0.025", qualifier: "MIN" }),
    extraction({ rawField: "iq_typ_mA", value: "0.033", qualifier: "TYP" }),
    extraction({ rawField: "iq_max_mA", value: "0.060", qualifier: "MAX" }),
  ];

  function admittedReadings(extractions: RawExtraction[]): Reading[] {
    return toCandidates(extractions, {
      unit: UNIT,
      parameter: PARAM,
      contributor: "ingest-bot",
      provider: { id: "stub-extraction" },
    })
      .map((c) => runPipeline(c, { knownDocuments: KNOWN }, NOW))
      .map((r) => r.reading)
      .filter((r): r is Reading => r !== undefined);
  }

  it("splits a row into three separate readings (AC-4.2)", () => {
    const readings = admittedReadings(row);
    expect(readings).toHaveLength(3);
    expect(new Set(readings.map((r) => r.qualifier))).toEqual(
      new Set(["MIN", "TYP", "MAX"]),
    );
  });

  it("flags MIN > MAX under identical conditions (AC-4.4)", () => {
    const readings = admittedReadings([
      extraction({ rawField: "iq_min_mA", value: "0.060", qualifier: "MIN" }),
      extraction({ rawField: "iq_max_mA", value: "0.025", qualifier: "MAX" }),
    ]);
    const violations = checkRangeInvariants(readings);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.detail).toContain("MIN > MAX");
  });

  it("does not falsely flag across different condition groups", () => {
    const hot = extraction({
      rawField: "iq_min_mA",
      value: "0.060",
      qualifier: "MIN",
      rawConditions: { VIN: "3.6 V", TA: "85°C" },
    });
    const cold = extraction({ rawField: "iq_max_mA", value: "0.025", qualifier: "MAX" });
    const hotUnit = {
      ...UNIT,
      text: "IQ | Quiescent current | 0.025 | 0.033 | 0.060 | mA | VIN = 3.6 V, TA = 85°C",
    };
    const readings = [
      ...admittedReadings([cold]),
      ...toCandidates([hot], {
        unit: hotUnit,
        parameter: PARAM,
        contributor: "ingest-bot",
        provider: { id: "stub-extraction" },
      })
        .map((c) => runPipeline(c, { knownDocuments: KNOWN }, NOW))
        .map((r) => r.reading)
        .filter((r): r is Reading => r !== undefined),
    ];
    expect(readings).toHaveLength(2);
    expect(checkRangeInvariants(readings)).toHaveLength(0);
  });

  it("merges identical duplicates and reviews conflicting ones", () => {
    const twice = admittedReadings([row[1]!, row[1]!]);
    const merged = reconcileDuplicates(twice);
    expect(merged[0]?.status).toBe("MERGED");

    const conflicting = admittedReadings([
      row[1]!,
      extraction({ rawField: "iq_typ_mA", value: "0.060", qualifier: "TYP" }),
    ]);
    const reviewed = reconcileDuplicates(conflicting);
    expect(reviewed[0]?.status).toBe("REVIEW_REQUIRED");
  });
});

describe("review queue routing (AC-7.1)", () => {
  it("orders by calibrated shortfall, uncalibrated first", () => {
    const ordered = orderReviewQueue(
      [
        { taskId: "a", providerId: "calibrated", confidence: 0.7 },
        { taskId: "b", providerId: "calibrated", confidence: 0.4 },
        { taskId: "c", providerId: "uncalibrated", confidence: 0.99 },
      ],
      { calibrated: { reviewRoutingThreshold: 0.75 } },
    );
    expect(ordered.map((i) => i.taskId)).toEqual(["c", "b", "a"]);
  });
});

describe("append-only corrections (AC-14.1)", () => {
  it("preserves the original and records reviewer/reason/version", () => {
    const reading = run(extraction()).reading!;
    const parameter = {
      key: PARAM.key,
      dimension: PARAM.dimension,
      readings: [reading],
      canonical: [],
    };
    const { parameter: next, record } = appendCorrection(
      parameter,
      0,
      {
        measurement: { value_decimal: "0.035", unit: "mA", si_value_decimal: "0.000035" },
        qualifier: reading.qualifier,
        conditions: reading.conditions,
      },
      { reviewer: "animesh", reason: "misread cell", timestampISO: NOW() },
    );
    expect(parameter.readings).toHaveLength(1);
    expect(parameter.readings[0]).toBe(reading);
    expect(next.readings).toHaveLength(2);
    expect(next.readings[1]?.contributor).toBe("animesh");
    expect(next.readings[1]?.method.kind).toBe("human");
    expect(record).toEqual({
      audit: { reviewer: "animesh", reason: "misread cell", timestampISO: NOW() },
      corrects: 0,
      version: 1,
    });
  });
});
