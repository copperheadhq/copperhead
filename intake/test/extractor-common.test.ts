// The extraction contract on the adapter side (ground-intake-extraction D3; task 4.4).

import { describe, expect, it } from "vitest";
import { buildExtractionPrompt, parseJsonReply, PROMPT_TEMPLATE_HASH, toExtractions } from "../adapters/extractor-common";
import { DEFAULT_FIELD_SPECS } from "../core/fields";
import { unit } from "./support/fixtures";

describe("the prompt", () => {
  it("lists every unit by id with its footnote markers, and every requested field", () => {
    const units = [
      unit({ evidenceId: "ev-1-p1-l1", text: "Supply Voltage | 4.5 | 16 | V" }),
      unit({ evidenceId: "ev-1-p1-l2", text: "(Low State)", footnoteRefs: ["3"] }),
    ];
    const prompt = buildExtractionPrompt(units, DEFAULT_FIELD_SPECS);
    expect(prompt).toContain("[ev-1-p1-l1] Supply Voltage | 4.5 | 16 | V");
    expect(prompt).toContain("[ev-1-p1-l2] (Low State) [^3]");
    for (const s of DEFAULT_FIELD_SPECS) expect(prompt).toContain(`- ${s.key}: `);
    expect(prompt).not.toMatch(/snippet/i);
  });

  it("has a stable template hash", () => {
    expect(PROMPT_TEMPLATE_HASH).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("re-validating model output", () => {
  const good = { field: "supply_voltage_V", evidenceId: "ev-1-p1-l1", value: "16", unit: "V", qualifier: "MAX", confidence: 0.9 };

  it("keeps a well-formed extraction", () => {
    expect(toExtractions({ extractions: [good] })).toEqual({ extractions: [good], dropped: 0 });
  });

  it("drops an entry carrying text or coordinates of its own", () => {
    const withSnippet = { ...good, snippet: "Supply Voltage 16 V" };
    const withBox = { ...good, bbox: { x: 0, y: 0, width: 1, height: 1 } };
    expect(toExtractions({ extractions: [withSnippet, withBox, good] })).toEqual({ extractions: [good], dropped: 2 });
  });

  it("drops wrong types, an unknown qualifier and an out-of-range confidence", () => {
    const bad = [
      { ...good, evidenceId: 3 },
      { ...good, qualifier: "PEAK" },
      { ...good, confidence: 1.4 },
      { ...good, conditions: { VCC: 5 } },
    ];
    expect(toExtractions({ extractions: bad }).dropped).toBe(4);
  });

  it("refuses output with no extractions array, and finds JSON inside a fenced reply", () => {
    expect(() => toExtractions({ fields: [] })).toThrow(/no extractions array/);
    expect(parseJsonReply('```json\n{"extractions": []}\n```')).toEqual({ extractions: [] });
  });
});
