import { describe, expect, it } from "vitest";
import type { Reading } from "../../../core/knowledge/types";
import { parseMeasurement } from "../../../core/knowledge/decimal";
import { parseConditions } from "../../../core/knowledge/parsers";
import { computeLadder } from "../../../core/knowledge/ladder/ladder";

function reading(overrides: {
  value: string;
  unit?: string;
  qualifier?: Reading["qualifier"];
  sha?: string;
  provider?: string;
  method?: Reading["method"]["kind"];
  conditions?: string;
  supersededBy?: string;
  addedAtISO?: string;
}): Reading {
  const sha = (overrides.sha ?? "a").repeat(64).slice(0, 64);
  return {
    measurement: parseMeasurement(overrides.value, overrides.unit ?? "uA"),
    qualifier: overrides.qualifier ?? "TYP",
    conditions: parseConditions(overrides.conditions ?? "VIN = 3.6 V, TA = 25°C"),
    confidence: 0.9,
    evidence: {
      evidenceId: `ev-${overrides.sha ?? "a"}-${overrides.value}`,
      document: {
        documentId: `doc-${overrides.sha ?? "a"}`,
        sha256: sha,
        revision: "Rev C",
        authority: "MANUFACTURER",
        ...(overrides.supersededBy !== undefined
          ? { supersededBy: overrides.supersededBy }
          : {}),
      },
      page: 6,
      text: `IQ ${overrides.value} ${overrides.unit ?? "uA"}`,
    },
    contributor: "ingest-bot",
    method: {
      kind: overrides.method ?? "extraction",
      ...(overrides.method === undefined || overrides.method === "extraction"
        ? { providerId: overrides.provider ?? "stub-extraction" }
        : {}),
    },
    validators: [],
    addedAtISO: overrides.addedAtISO ?? "2026-08-07T00:00:00Z",
  };
}

describe("corroboration ladder (SPEC §9)", () => {
  it("human verification wins its cluster → verified (AC-6.1)", () => {
    const { canonical } = computeLadder([
      reading({ value: "33" }),
      reading({ value: "33", method: "human" }),
    ]);
    expect(canonical[0]?.status).toBe("verified");
  });

  it("two distinct documents within TOL → corroborated (AC-6.2)", () => {
    const { canonical } = computeLadder([
      reading({ value: "33", sha: "a" }),
      reading({ value: "0.033", unit: "mA", sha: "b" }),
    ]);
    expect(canonical[0]?.status).toBe("corroborated");
    expect(canonical[0]?.distinctDocuments).toBe(2);
  });

  it("two clusters beyond TOL, no dominant → disputed and frozen (AC-6.3)", () => {
    const { canonical } = computeLadder([
      reading({ value: "33", sha: "a" }),
      reading({ value: "60", sha: "b" }),
    ]);
    expect(canonical[0]?.status).toBe("disputed");
    expect(canonical[0]?.frozen).toBe(true);
  });

  it("a dominant cluster is not a dispute", () => {
    const { canonical } = computeLadder([
      reading({ value: "33", sha: "a" }),
      reading({ value: "33", sha: "b" }),
      reading({ value: "60", sha: "c" }),
    ]);
    expect(canonical[0]?.status).toBe("corroborated");
    expect(canonical[0]?.value.si_value_decimal).toBe("0.000033");
  });

  it("the same document twice stays extracted (AC-6.4)", () => {
    const { canonical } = computeLadder([
      reading({ value: "33", sha: "a" }),
      reading({ value: "33", sha: "a" }),
    ]);
    expect(canonical[0]?.status).toBe("extracted");
  });

  it("different condition groups never falsely dispute (AC-6.5)", () => {
    const { canonical } = computeLadder([
      reading({ value: "33", conditions: "VIN = 3.6 V, TA = 25°C" }),
      reading({ value: "90", conditions: "VIN = 3.6 V, TA = 85°C" }),
    ]);
    expect(canonical).toHaveLength(2);
    expect(canonical.every((c) => c.status === "extracted")).toBe(true);
  });

  it("MIN and TYP never cluster together", () => {
    const { canonical } = computeLadder([
      reading({ value: "25", qualifier: "MIN" }),
      reading({ value: "33", qualifier: "TYP" }),
    ]);
    expect(canonical).toHaveLength(2);
  });

  it("cross-provider agreement on one document: crosscheck signal, not corroboration (AC-6.6)", () => {
    const { canonical, flags } = computeLadder([
      reading({ value: "33", sha: "a", provider: "provider-1" }),
      reading({ value: "33", sha: "a", provider: "provider-2" }),
    ]);
    expect(canonical[0]?.status).toBe("extracted");
    expect(canonical[0]?.crosscheckSignal).toBe(true);
    expect(flags).toHaveLength(0);
  });

  it("cross-provider disagreement routes to review (AC-6.6)", () => {
    const { flags } = computeLadder([
      reading({ value: "33", sha: "a", provider: "provider-1" }),
      reading({ value: "60", sha: "a", provider: "provider-2" }),
    ]);
    expect(flags[0]?.reasonCodes).toContain("PROVIDER_DISAGREEMENT");
  });

  it("superseded documents are excluded, not disputing", () => {
    const { canonical, superseded } = computeLadder([
      reading({ value: "33", sha: "a" }),
      reading({ value: "60", sha: "b", supersededBy: "doc-a" }),
    ]);
    expect(superseded).toHaveLength(1);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]?.status).toBe("extracted");
  });
});
