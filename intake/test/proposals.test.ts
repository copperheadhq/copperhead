// Binding proposals (add-binding-proposals; binding-proposals spec).

import { describe, expect, it } from "vitest";
import { buildPrompt, type ContextBundle, parseProposal } from "../proposals/bindings";

const BUNDLE: ContextBundle = {
  ref: "U1",
  value: "EXA-BUCK-1",
  library: "Example",
  part: "EXA-BUCK-1",
  sheet: "Power",
  pins: [
    { pin: "4", name: "VIN", type: "power_in", net: "+12V", ground: false, parts: [{ ref: "C1", value: "22uF", part: "Device:C", sheet: "Power", kind: "capacitor", otherNet: "GND", dnp: false }, { ref: "C2", value: "1uF", part: "Device:C", sheet: "Power", kind: "capacitor", otherNet: "GND", dnp: true }] },
    { pin: "3", name: "SW", type: "power_out", net: "SW", ground: false, parts: [{ ref: "L1", value: "4.7uH", part: "Device:L", sheet: "Power", kind: "inductor", otherNet: "+3V3", dnp: false }] },
  ],
  reach: [{ net: "+3V3", via: ["L1"], parts: [{ ref: "C4", value: "22uF", part: "Device:C", sheet: "Power", kind: "capacitor", otherNet: "GND", dnp: false }] }],
};

describe("binding proposals", () => {
  it("builds the same prompt from the same bundles, holding the bundles and the role guide", () => {
    const p = buildPrompt([BUNDLE]);
    expect(buildPrompt([BUNDLE])).toBe(p);
    expect(p).toContain('"ref":"U1"');
    expect(p).toMatch(/input-capacitor: capacitor between the regulator's input net/);
  });

  it("keeps only asked anchors, known kinds and roles, and fitted parts of the anchor's context", () => {
    const { blocks, dropped } = parseProposal(
      {
        blocks: [
          { anchor: "U1", kind: "buck", roles: { "input-capacitor": ["C1", "C2", "C99"], inductor: ["L1"], "output-capacitor": ["C4"], magic: ["C1"] }, why: "SW drives L1" },
          { anchor: "U7", kind: "ldo", roles: {} },
          { anchor: "U1", kind: "smps", roles: {} },
        ],
      },
      [BUNDLE],
    );
    expect(blocks).toEqual([{ anchor: "U1", kind: "buck", roles: { "input-capacitor": ["C1"], inductor: ["L1"], "output-capacitor": ["C4"] }, why: "SW drives L1" }]);
    expect(dropped).toEqual([
      "U1 input-capacitor: C2 is not a fitted part in its context",
      "U1 input-capacitor: C99 is not a fitted part in its context",
      'U1: unknown role "magic"',
      "block for U7: not a part that was asked about",
      'U1: unknown kind "smps"',
    ]);
    expect(parseProposal({}, [BUNDLE])).toEqual({ blocks: [], dropped: ["the reply has no blocks list"] });
  });
});
