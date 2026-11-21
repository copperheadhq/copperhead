import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { validateIntent, type SchematicIntent } from '../src/kicad/draft/ir.js';
import { draftSchematicPlacement } from '../src/kicad/draft/engine.js';
import { emitSchematic } from '../src/kicad/emit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');

async function placeIntent(intent: SchematicIntent, symDirs: string[] = [SYMLIB]) {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-hints-test-'));
  try {
    const symsource = new SymbolSource(repo, symDirs);
    const v = await validateIntent(intent, symsource, null);
    if (!v.ok || !v.validated) {
      return { ok: false as const, findings: v.findings };
    }
    const drafted = draftSchematicPlacement(v.validated, 'board', '2020-01-01');
    const text = emitSchematic(drafted.model);
    return { ok: true as const, ...drafted, text, findings: [] };
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

describe('Schematic intent hints (Issue #482)', () => {
  it('unknown hint key returns a finding (e.g. hints.placement)', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-hints-val-'));
    try {
      const symsource = new SymbolSource(repo, [SYMLIB]);
      const intent = {
        version: 1,
        parts: [
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
        ],
        nets: [{ name: 'NET1', pins: ['R1.1', 'R2.1'] }],
        hints: {
          placement: { R1: 'near' },
        } as any,
      };
      const v = await validateIntent(intent, symsource, null);
      expect(v.ok).toBe(false);
      expect(v.findings.some((f) => f.detail.includes('unknown hint key "placement" (accepted: groupOrder, paper, date, near, labels)'))).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('wrong-typed near and labels return findings, not crashes', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-hints-val-'));
    try {
      const symsource = new SymbolSource(repo, [SYMLIB]);
      const baseIntent = {
        version: 1,
        parts: [
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
        ],
        nets: [{ name: 'NET1', pins: ['R1.1', 'R2.1'] }],
      };

      // near as non-array
      const v1 = await validateIntent({ ...baseIntent, hints: { near: 'R1' } as any }, symsource, null);
      expect(v1.ok).toBe(false);
      expect(v1.findings.some((f) => f.detail.includes('"hints.near" must be an array'))).toBe(true);

      // near element not an object
      const v2 = await validateIntent({ ...baseIntent, hints: { near: ['R1'] } as any }, symsource, null);
      expect(v2.ok).toBe(false);
      expect(v2.findings.some((f) => f.detail.includes('"hints.near[0]" must be an object'))).toBe(true);

      // near element with non-string ref
      const v3 = await validateIntent({ ...baseIntent, hints: { near: [{ ref: 123, pin: 'R2.1' }] } as any }, symsource, null);
      expect(v3.ok).toBe(false);
      expect(v3.findings.some((f) => f.detail.includes('"hints.near[0]" must be an object with non-empty string "ref" and "pin" fields'))).toBe(true);

      // near element with empty string pin
      const v4 = await validateIntent({ ...baseIntent, hints: { near: [{ ref: 'R1', pin: '' }] } as any }, symsource, null);
      expect(v4.ok).toBe(false);
      expect(v4.findings.some((f) => f.detail.includes('"hints.near[0]" must be an object with non-empty string "ref" and "pin" fields'))).toBe(true);

      // labels as non-array
      const v5 = await validateIntent({ ...baseIntent, hints: { labels: 'NET1' } as any }, symsource, null);
      expect(v5.ok).toBe(false);
      expect(v5.findings.some((f) => f.detail.includes('"hints.labels" must be an array of non-empty net-name strings'))).toBe(true);

      // labels containing non-strings or empty strings
      const v6 = await validateIntent({ ...baseIntent, hints: { labels: [123] } as any }, symsource, null);
      expect(v6.ok).toBe(false);
      expect(v6.findings.some((f) => f.detail.includes('"hints.labels" must be an array of non-empty net-name strings'))).toBe(true);

      const v7 = await validateIntent({ ...baseIntent, hints: { labels: [''] } as any }, symsource, null);
      expect(v7.ok).toBe(false);
      expect(v7.findings.some((f) => f.detail.includes('"hints.labels" must be an array of non-empty net-name strings'))).toBe(true);

      // labels with undeclared net name typo
      const vLabelsTypo = await validateIntent({
        ...baseIntent,
        hints: { labels: ['MIDD'] },
      }, symsource, null);
      expect(vLabelsTypo.ok).toBe(false);
      expect(vLabelsTypo.findings.some((f) => f.detail.includes('hints.labels: "MIDD" names no declared net'))).toBe(true);

      // labels with power/ground net
      const vLabelsPower = await validateIntent({
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'MAIN' },
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        ],
        nets: [
          { name: 'VCC', pins: ['U1.1', 'R1.1'], kind: 'power' },
          { name: 'GND', pins: ['U1.2', 'R1.2'], kind: 'ground' },
        ],
        noConnect: ['U1.3', 'U1.4', 'U1.5', 'U1.6', 'U1.7', 'U1.8'],
        hints: { labels: ['GND'] },
      }, symsource, null);
      expect(vLabelsPower.ok).toBe(false);
      expect(vLabelsPower.findings.some((f) => f.detail.includes('hints.labels: "GND" is a power/ground net (drawn with power symbols, never wired)'))).toBe(true);

      // labels naming net with non-array pins returns findings, not TypeError (N2)
      const vLabelsBadPins = await validateIntent({
        ...baseIntent,
        nets: [{ name: 'MID', pins: 'R1.1' as any }],
        hints: { labels: ['MID'] },
      }, symsource, null);
      expect(vLabelsBadPins.ok).toBe(false);
      expect(vLabelsBadPins.findings.some((f) => f.detail.includes('hints.labels: "MID" names no declared net'))).toBe(true);

      const vLabelsNullPins = await validateIntent({
        ...baseIntent,
        nets: [{ name: 'MID', pins: null as any }],
        hints: { labels: ['MID'] },
      }, symsource, null);
      expect(vLabelsNullPins.ok).toBe(false);
      expect(vLabelsNullPins.findings.some((f) => f.detail.includes('hints.labels: "MID" names no declared net'))).toBe(true);

      // semantic near validations: unknown ref
      const v8 = await validateIntent({ ...baseIntent, hints: { near: [{ ref: 'R99', pin: 'R2.1' }] } }, symsource, null);
      expect(v8.ok).toBe(false);
      expect(v8.findings.some((f) => f.detail.includes('unknown part "R99"'))).toBe(true);

      // semantic near validations: invalid anchor pin format
      const v9 = await validateIntent({ ...baseIntent, hints: { near: [{ ref: 'R1', pin: 'R2' }] } }, symsource, null);
      expect(v9.ok).toBe(false);
      expect(v9.findings.some((f) => f.detail.includes('is not of the form REF.PIN'))).toBe(true);

      // semantic near validations: self anchor
      const vNearSelf = await validateIntent({
        ...baseIntent,
        hints: { near: [{ ref: 'R1', pin: 'R1.1' }] },
      }, symsource, null);
      expect(vNearSelf.ok).toBe(false);
      expect(vNearSelf.findings.some((f) => f.detail.includes('hints.near: part "R1" cannot anchor on itself'))).toBe(true);

      // semantic near validations: unknown anchor part
      const v10 = await validateIntent({ ...baseIntent, hints: { near: [{ ref: 'R1', pin: 'R99.1' }] } }, symsource, null);
      expect(v10.ok).toBe(false);
      expect(v10.findings.some((f) => f.detail.includes('unknown anchor part "R99"'))).toBe(true);

      // semantic near validations: anchor has no such pin
      const v11 = await validateIntent({ ...baseIntent, hints: { near: [{ ref: 'R1', pin: 'R2.99' }] } }, symsource, null);
      expect(v11.ok).toBe(false);
      expect(v11.findings.some((f) => f.detail.includes('has no pin "99"'))).toBe(true);

      // semantic near validations: anchor pin on power/ground net
      const vNearPower = await validateIntent({
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'MAIN' },
          { ref: 'C1', libId: 'Device:C', value: '100n', group: 'MAIN' },
        ],
        nets: [
          { name: 'VCC', pins: ['U1.1', 'C1.1'] },
          { name: 'GND', pins: ['U1.2', 'C1.2'] },
        ],
        noConnect: ['U1.3', 'U1.4', 'U1.5', 'U1.6', 'U1.7', 'U1.8'],
        hints: { near: [{ ref: 'C1', pin: 'U1.1' }] },
      }, symsource, null);
      expect(vNearPower.ok).toBe(false);
      expect(vNearPower.findings.some((f) => f.detail.includes('hints.near: anchor pin "U1.1" is on power/ground net "VCC"; decoupling caps are placed by the bank, near accepts signal pins only'))).toBe(true);

      // semantic near validations: group mismatch (differing case or completely different)
      const vNearGroup = await validateIntent({
        version: 1,
        parts: [
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'main' },
          { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
        ],
        nets: [{ name: 'NET1', pins: ['R1.1', 'R2.1'] }],
        hints: { near: [{ ref: 'R1', pin: 'R2.1' }] },
      }, symsource, null);
      expect(vNearGroup.ok).toBe(false);
      expect(vNearGroup.findings.some((f) => f.detail.includes('must be in the same group'))).toBe(true);

      // semantic near validations: connector cannot be hung
      const vNearConn = await validateIntent({
        version: 1,
        parts: [
          { ref: 'J1', libId: 'Connector_Generic:Conn_01x02', value: 'Conn', group: 'MAIN' },
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        ],
        nets: [{ name: 'NET1', pins: ['J1.1', 'R1.1'] }],
        noConnect: ['J1.2', 'R1.2'],
        hints: { near: [{ ref: 'J1', pin: 'R1.1' }] },
      }, symsource, null);
      expect(vNearConn.ok).toBe(false);
      expect(vNearConn.findings.some((f) => f.detail.includes('is a connector; connectors cannot be hung near a pin'))).toBe(true);

      // semantic near validations: crystal cannot be hung
      const vNearCrystal = await validateIntent({
        version: 1,
        parts: [
          { ref: 'Y1', libId: 'Device:Crystal', value: '16MHz', group: 'MAIN' },
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        ],
        nets: [{ name: 'NET1', pins: ['Y1.1', 'R1.1'] }],
        noConnect: ['Y1.2', 'R1.2'],
        hints: { near: [{ ref: 'Y1', pin: 'R1.1' }] },
      }, symsource, null);
      expect(vNearCrystal.ok).toBe(false);
      expect(vNearCrystal.findings.some((f) => f.detail.includes('is a crystal or resonator; cannot be hung near a pin'))).toBe(true);

      // semantic near validations: 3-pin part cannot be hung
      const vNear3Pin = await validateIntent({
        version: 1,
        parts: [
          { ref: 'Q1', libId: 'Device:Q_NPN', value: '2N3904', group: 'MAIN' },
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        ],
        nets: [{ name: 'NET1', pins: ['Q1.1', 'R1.1'] }],
        noConnect: ['Q1.2', 'Q1.3', 'R1.2'],
        hints: { near: [{ ref: 'Q1', pin: 'R1.1' }] },
      }, symsource, null);
      expect(vNear3Pin.ok).toBe(false);
      expect(vNear3Pin.findings.some((f) => f.detail.includes('must be a two-lead part or test point to hang near a pin'))).toBe(true);

      // semantic near validations: not on the same net
      const v12 = await validateIntent({
        version: 1,
        parts: [
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R3', libId: 'Device:R', value: '10k', group: 'MAIN' },
        ],
        nets: [
          { name: 'NET1', pins: ['R1.1', 'R2.1'] },
          { name: 'NET2', pins: ['R2.2', 'R3.1'] },
        ],
        hints: { near: [{ ref: 'R3', pin: 'R1.1' }] },
      }, symsource, null);
      expect(v12.ok).toBe(false);
      expect(v12.findings.some((f) => f.detail.includes('are not on the same net'))).toBe(true);

      // semantic near validations: malformed nets: [null] does not crash
      const v13 = await validateIntent({
        ...baseIntent,
        nets: [null as any],
        hints: { near: [{ ref: 'R1', pin: 'R2.1' }] },
      }, symsource, null);
      expect(v13.ok).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('hints.near returns finding when part leads do not oppose', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-hints-val-'));
    try {
      const symContent = `(kicad_symbol_lib
\t(version 20231120)
\t(generator "copperhead-test")
\t(symbol "NonOpposing"
\t\t(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
\t\t(property "Value" "NonOpposing" (at 0 0 0) (effects (font (size 1.27 1.27))))
\t\t(symbol "NonOpposing_0_1"
\t\t\t(pin passive line (at 0 2.54 270) (length 2.54)
\t\t\t\t(name "A" (effects (font (size 1.27 1.27))))
\t\t\t\t(number "1" (effects (font (size 1.27 1.27))))
\t\t\t)
\t\t\t(pin passive line (at 2.54 0 180) (length 2.54)
\t\t\t\t(name "B" (effects (font (size 1.27 1.27))))
\t\t\t\t(number "2" (effects (font (size 1.27 1.27))))
\t\t\t)
\t\t)
\t)
)`;
      await writeFile(path.join(repo, 'Custom.kicad_sym'), symContent);
      const symsource = new SymbolSource(repo, [repo, SYMLIB]);
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'MAIN' },
          { ref: 'D1', libId: 'Custom:NonOpposing', value: 'D', group: 'MAIN' },
        ],
        nets: [
          { name: 'SIG', pins: ['U1.4', 'D1.1'] },
        ],
        noConnect: ['U1.1', 'U1.2', 'U1.3', 'U1.5', 'U1.6', 'U1.7', 'U1.8', 'D1.2'],
        hints: {
          near: [{ ref: 'D1', pin: 'U1.4' }],
        },
      };
      const v = await validateIntent(intent, symsource, null);
      expect(v.ok).toBe(false);
      expect(v.findings.some((f) => f.detail.includes('leads do not oppose; cannot be hung near a pin'))).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('hints: {} produces the same sheet as absent hints', async () => {
    const baseIntent: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'MAIN' },
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'C1', libId: 'Device:C', value: '100n', group: 'MAIN' },
      ],
      nets: [
        { name: 'VCC', pins: ['U1.1', 'R1.1'] },
        { name: 'GND', pins: ['U1.2', 'C1.2'] },
        { name: 'SIG', pins: ['U1.3', 'R1.2', 'C1.1'] },
      ],
      noConnect: ['U1.4', 'U1.5', 'U1.6', 'U1.7', 'U1.8'],
    };

    const resWithoutHints = await placeIntent(baseIntent);
    expect(resWithoutHints.ok).toBe(true);

    const resWithEmptyHints = await placeIntent({ ...baseIntent, hints: {} });
    expect(resWithEmptyHints.ok).toBe(true);

    if (resWithoutHints.ok && resWithEmptyHints.ok) {
      expect(resWithoutHints.text).toBe(resWithEmptyHints.text);
    }
  });

  it('labels forces a net-label pair and no long wire for the named net', async () => {
    // Two parts connected by LONG_NET across the sheet
    const intentWithoutHint: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R3', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R4', libId: 'Device:R', value: '10k', group: 'MAIN' },
      ],
      nets: [
        { name: 'NET_A', pins: ['R1.1', 'R2.1'] },
        { name: 'LONG_NET', pins: ['R2.2', 'R3.1'] },
        { name: 'NET_B', pins: ['R3.2', 'R4.1'] },
      ],
      noConnect: ['R1.2', 'R4.2'],
    };

    const withoutHint = await placeIntent(intentWithoutHint);
    expect(withoutHint.ok).toBe(true);
    if (!withoutHint.ok) return;

    // By default, LONG_NET is wired together as a continuous wire between R2 and R3
    const wiresWithoutHint = withoutHint.model.wires.filter((w) => w.net === 'LONG_NET');
    expect(wiresWithoutHint.length).toBeGreaterThan(0);
    // In withoutHint, wire segments meet at a common junction point connecting the parts
    const meetsWithoutHint = wiresWithoutHint.length >= 2 &&
      wiresWithoutHint.some((w1, i) =>
        wiresWithoutHint.some((w2, j) => i !== j && ((w1.x2 === w2.x2 && w1.y2 === w2.y2) || (w1.x1 === w2.x1 && w1.y1 === w2.y1)))
      );
    expect(meetsWithoutHint, 'LONG_NET should be a continuous wired connection without hint').toBe(true);
    // And only carries a single local label on the continuous wire
    expect(withoutHint.model.labels.filter((l) => l.name === 'LONG_NET').length).toBe(1);

    // With hints.labels: ["LONG_NET"], LONG_NET must be emitted as a net-label pair, no continuous wire
    const intentWithHint: SchematicIntent = {
      ...intentWithoutHint,
      hints: {
        labels: ['LONG_NET'],
      },
    };

    const withHint = await placeIntent(intentWithHint);
    expect(withHint.ok).toBe(true);
    if (!withHint.ok) return;

    const wiresWithHint = withHint.model.wires.filter((w) => w.net === 'LONG_NET');
    // None of the wire segments should connect to each other (independent stubs)
    const meetsWithHint = wiresWithHint.some((w1, i) =>
      wiresWithHint.some((w2, j) => i !== j && ((w1.x2 === w2.x2 && w1.y2 === w2.y2) || (w1.x1 === w2.x1 && w1.y1 === w2.y1)))
    );
    expect(meetsWithHint, 'LONG_NET wire segments must not meet (no continuous wire)').toBe(false);

    // Must be emitted as a net-label pair (two global labels on the net)
    const labels = withHint.model.labels.filter((l) => l.name === 'LONG_NET');
    expect(labels.length, 'LONG_NET must have a net-label pair').toBe(2);
    expect(labels.every((l) => l.kind === 'global'), 'labels must be global flags').toBe(true);
  });

  it('hints.labels forces label pair on op-amp feedback net', async () => {
    const baseIntent: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'U1', libId: 'CopperAmp:OpAmp', value: 'OpAmp', group: 'AMP' },
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'AMP' },
        { ref: 'R2', libId: 'Device:R', value: '10k', group: 'AMP' },
        { ref: 'R3', libId: 'Device:R', value: '10k', group: 'AMP' },
        { ref: 'C1', libId: 'Device:C', value: '100n', group: 'AMP' },
      ],
      nets: [
        { name: 'VCC', pins: ['U1.8', 'C1.1'], kind: 'power' },
        { name: 'GND', pins: ['U1.4', 'R2.2', 'C1.2', 'R3.2'], kind: 'ground' },
        { name: 'IN', pins: ['U1.3', 'R1.2'] },
        { name: 'FB', pins: ['U1.1', 'U1.2', 'R2.1'] },
        { name: 'SRC', pins: ['R1.1', 'R3.1'] },
      ],
      hints: {
        labels: ['FB'],
      },
    };
    const res = await placeIntent(baseIntent);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const fbWires = res.model.wires.filter((w) => w.net === 'FB');
    const totalFbWireLength = fbWires.reduce((s, w) => s + Math.hypot(w.x2 - w.x1, w.y2 - w.y1), 0);
    const fbLabels = res.model.labels.filter((l) => l.name === 'FB');
    // Without forced labels, the feedback loop is routed as a 40.64 mm loop with 2 labels.
    // With forced labels, feedback loop wire is skipped: total wire length is 7.62 mm with 3 labels.
    expect(totalFbWireLength).toBeLessThan(20);
    expect(totalFbWireLength).toBeCloseTo(7.62, 1);
    expect(fbLabels.length).toBe(3);
    expect(fbLabels.length).toBeGreaterThanOrEqual(2);
  });

  it('near places the part on the anchor pin\'s row, shortens the wire, and removes the bend', async () => {
    // Design with MCU U1 and shunt cap C1 on pin 4 (right side of U1 with no netted neighbours)
    const baseIntent: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'MAIN' },
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'C1', libId: 'Device:C', value: '100n', group: 'MAIN' },
      ],
      nets: [
        { name: 'VCC', pins: ['U1.1', 'R1.1'] },
        { name: 'GND', pins: ['U1.2', 'R2.2'] },
        { name: 'IN_NET', pins: ['U1.4', 'C1.1'] },
        { name: 'OUT_NET', pins: ['C1.2', 'R1.2', 'R2.1'] },
      ],
      noConnect: ['U1.3', 'U1.5', 'U1.6', 'U1.7', 'U1.8'],
    };

    const unhinted = await placeIntent(baseIntent);
    expect(unhinted.ok).toBe(true);
    if (!unhinted.ok) return;

    const hinted = await placeIntent({
      ...baseIntent,
      hints: {
        near: [{ ref: 'C1', pin: 'U1.4' }],
      },
    });
    expect(hinted.ok).toBe(true);
    if (!hinted.ok) return;

    // Assert report.notes has no hang refused entry
    expect(hinted.report.notes.some((n) => n.includes('hang refused') || n.includes('could not be honoured'))).toBe(false);

    const u1Hinted = hinted.model.symbols.find((s) => s.ref === 'U1')!;
    const c1Hinted = hinted.model.symbols.find((s) => s.ref === 'C1')!;

    // Pin 4 is on U1's right side.
    const wiresHinted = hinted.model.wires.filter((w) => w.net === 'IN_NET');
    const wiresUnhinted = unhinted.model.wires.filter((w) => w.net === 'IN_NET');

    // Total wire length on IN_NET
    const lengthHinted = wiresHinted.reduce((s, w) => s + Math.hypot(w.x2 - w.x1, w.y2 - w.y1), 0);
    const lengthUnhinted = wiresUnhinted.reduce((s, w) => s + Math.hypot(w.x2 - w.x1, w.y2 - w.y1), 0);
    expect(lengthHinted, 'near hint should shorten the wire').toBeLessThanOrEqual(lengthUnhinted);

    // Assert C1 sits on U1.4's stub side (right side)
    expect(c1Hinted.at.x).toBeGreaterThan(u1Hinted.at.x);
    // Wire between U1.4 and C1.1 has vertical drop
    const vertWires = wiresHinted.filter((w) => Math.abs(w.x1 - w.x2) < 0.01);
    expect(vertWires.length).toBeGreaterThan(0);
    const xCoord = vertWires[0]!.x1;
    for (const vw of vertWires) {
      expect(vw.x1).toBeCloseTo(xCoord, 2);
    }

    // Assert no wire on the hinted sheet crosses C1's pin-1 lead except at its ends
    const c1Pin1Y = c1Hinted.at.y - 3.81;
    const c1BodyY = c1Hinted.at.y - 1.27;
    const leadMinY = Math.min(c1Pin1Y, c1BodyY);
    const leadMaxY = Math.max(c1Pin1Y, c1BodyY);
    const crossingWires = hinted.model.wires.filter((w) => {
      if (Math.abs(w.y1 - w.y2) < 0.01) {
        const wireMinX = Math.min(w.x1, w.x2);
        const wireMaxX = Math.max(w.x1, w.x2);
        return wireMinX < c1Hinted.at.x && c1Hinted.at.x < wireMaxX && w.y1 > leadMinY && w.y1 < leadMaxY;
      }
      return false;
    });
    expect(crossingWires.length, 'no wire should cross C1 pin-1 lead').toBe(0);
  });

  it('near hint with neighbouring side pins falls back to a lane without refusal', async () => {
    const intent: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'MAIN' },
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R3', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'C1', libId: 'Device:C', value: '100n', group: 'MAIN' },
        { ref: 'C2', libId: 'Device:C', value: '100n', group: 'MAIN' },
      ],
      nets: [
        { name: 'VCC', pins: ['U1.1', 'C2.1'] },
        { name: 'GND', pins: ['U1.2', 'C2.2', 'R3.2'] },
        { name: 'A4', pins: ['U1.4', 'R1.1'] },
        { name: 'A5', pins: ['U1.5', 'C1.1'] },
        { name: 'A6', pins: ['U1.6', 'R2.1'] },
        { name: 'MID', pins: ['C1.2', 'R1.2', 'R2.2', 'R3.1'] },
      ],
      noConnect: ['U1.3', 'U1.7', 'U1.8'],
      hints: {
        near: [{ ref: 'C1', pin: 'U1.5' }],
      },
    };
    const res = await placeIntent(intent);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Assert no hang refused note and no drawn in a column note
    expect(res.report.notes.some((n) => n.includes('hang refused') || n.includes('could not be honoured'))).toBe(false);
    expect(res.report.notes.some((n) => n.includes('drawn in a column'))).toBe(false);
    const u1 = res.model.symbols.find((s) => s.ref === 'U1')!;
    const c1 = res.model.symbols.find((s) => s.ref === 'C1');
    expect(c1).toBeDefined();
    expect(c1!.at.x).toBeGreaterThan(u1.at.x);
  });

  it('near loop rail (dir = -1) and ground (dir = 1) branches', async () => {
    const intentRail: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'MAIN' },
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
      ],
      nets: [
        { name: 'VCC', pins: ['U1.1', 'R1.2'], kind: 'power' },
        { name: 'GND', pins: ['U1.2', 'R2.2'], kind: 'ground' },
        { name: 'SIG', pins: ['U1.3', 'R1.1', 'R2.1'] },
      ],
      noConnect: ['U1.4', 'U1.5', 'U1.6', 'U1.7', 'U1.8'],
      hints: {
        near: [{ ref: 'R1', pin: 'U1.3' }],
      },
    };
    const resRail = await placeIntent(intentRail);
    expect(resRail.ok).toBe(true);
    if (!resRail.ok) return;
    const r1 = resRail.model.symbols.find((s) => s.ref === 'R1')!;
    const u1Rail = resRail.model.symbols.find((s) => s.ref === 'U1')!;
    // dir = -1 (rail pull-up): rises above the pin row (smaller Y)
    expect(r1.at.y).toBeLessThan(u1Rail.at.y);

    const intentGround: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'MAIN' },
        { ref: 'C1', libId: 'Device:C', value: '100n', group: 'MAIN' },
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
      ],
      nets: [
        { name: 'VCC', pins: ['U1.1', 'R1.1'], kind: 'power' },
        { name: 'GND', pins: ['U1.2', 'C1.2'], kind: 'ground' },
        { name: 'SIG', pins: ['U1.3', 'C1.1', 'R1.2'] },
      ],
      noConnect: ['U1.4', 'U1.5', 'U1.6', 'U1.7', 'U1.8'],
      hints: {
        near: [{ ref: 'C1', pin: 'U1.3' }],
      },
    };
    const resGround = await placeIntent(intentGround);
    expect(resGround.ok).toBe(true);
    if (!resGround.ok) return;
    const c1 = resGround.model.symbols.find((s) => s.ref === 'C1')!;
    const u1Gnd = resGround.model.symbols.find((s) => s.ref === 'U1')!;
    // dir = 1 (ground drop): drops below the pin row (larger Y)
    expect(c1.at.y).toBeGreaterThan(u1Gnd.at.y);
  });

  it('near hint on non-IC anchor pulls anchor into claimAnchors', async () => {
    // Crystal Y1 has 2 pins (not an IC), is not a connector, not a switch, not a transistor.
    // It is pulled into claimAnchors specifically through nearHintsForGroup.
    const intent: SchematicIntent = {
      version: 1,
      parts: [
        { ref: 'Y1', libId: 'Device:Crystal', value: '16MHz', group: 'MAIN' },
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
      ],
      nets: [
        { name: 'NET1', pins: ['Y1.1', 'R1.1', 'R2.1'] },
        { name: 'NET2', pins: ['Y1.2', 'R2.2'] },
      ],
      noConnect: ['R1.2'],
      hints: {
        near: [{ ref: 'R1', pin: 'Y1.1' }],
      },
    };
    const res = await placeIntent(intent);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const y1 = res.model.symbols.find((s) => s.ref === 'Y1')!;
    const r1 = res.model.symbols.find((s) => s.ref === 'R1')!;
    expect(r1).toBeDefined();
    expect(y1).toBeDefined();
    expect(r1.at.x).toBeLessThan(y1.at.x);
  });

  it('nearRefs exempts capacitor from decoupling bank', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-hints-test-'));
    try {
      const symsource = new SymbolSource(repo, [SYMLIB]);
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'MAIN' },
          { ref: 'C1', libId: 'Device:C', value: '100n', group: 'MAIN' },
        ],
        nets: [
          { name: 'VCC', pins: ['U1.1', 'C1.1'], kind: 'power' },
          { name: 'GND', pins: ['U1.2', 'C1.2'], kind: 'ground' },
        ],
        noConnect: ['U1.3', 'U1.4', 'U1.5', 'U1.6', 'U1.7', 'U1.8'],
        hints: {
          near: [{ ref: 'C1', pin: 'U1.1' }],
        },
      };
      const syms = new Map([
        ['U1', await symsource.resolve('CopperMCU:MCU8')],
        ['C1', await symsource.resolve('Device:C')],
      ]);
      const resWithHint = draftSchematicPlacement({ intent, symbols: syms, manifest: null, warnings: [] }, 'board', '2020-01-01');
      const resWithoutHint = draftSchematicPlacement({ intent: { ...intent, hints: {} }, symbols: syms, manifest: null, warnings: [] }, 'board', '2020-01-01');
      const c1With = resWithHint.model.symbols.find((s) => s.ref === 'C1')!;
      const c1Without = resWithoutHint.model.symbols.find((s) => s.ref === 'C1')!;
      expect(c1With).toBeDefined();
      expect(c1Without).toBeDefined();
      expect(c1With.at).not.toEqual(c1Without.at);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
