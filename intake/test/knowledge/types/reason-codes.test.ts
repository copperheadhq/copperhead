import { describe, expect, it } from "vitest";
import { ALL_REASON_CODES, isReasonCode, REASON_CODES } from "../../../core/knowledge/types/reason-codes";

describe("reason-code catalog (Appendix A)", () => {
  it("contains cortex's eight categories and the intake's own", () => {
    expect(Object.keys(REASON_CODES).sort()).toEqual(
      [
        "conditions",
        "data",
        "decision",
        "evidence",
        "intake",
        "operations",
        "provider",
        "query",
        "revision",
      ].sort(),
    );
  });

  it("has no duplicate codes across categories", () => {
    expect(new Set(ALL_REASON_CODES).size).toBe(ALL_REASON_CODES.length);
  });

  it("recognizes catalog codes and rejects ad-hoc strings", () => {
    expect(isReasonCode("CONDITION_NOT_COVERED")).toBe(true);
    expect(isReasonCode("PART_UNRESOLVED")).toBe(true);
    expect(isReasonCode("SOMETHING_MADE_UP")).toBe(false);
  });
});
