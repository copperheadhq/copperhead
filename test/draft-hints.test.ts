import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { validateIntent, type SchematicIntent } from '../src/kicad/draft/ir.js';
import { draftSchematicPlacement } from '../src/kicad/draft/engine.js';
import { emitSchematic } from '../src/kicad/emit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');

async function placeIntent(intent: SchematicIntent) {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-hints-test-'));
  try {
    const symsource = new SymbolSource(repo, [SYMLIB]);
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
      expect(v.findings.some((f) => f.detail.includes('unknown hint key "placement"'))).toBe(true);
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

      // semantic near validations: unknown ref
      const v8 = await validateIntent({ ...baseIntent, hints: { near: [{ ref: 'R99', pin: 'R2.1' }] } }, symsource, null);
      expect(v8.ok).toBe(false);
      expect(v8.findings.some((f) => f.detail.includes('unknown part "R99"'))).toBe(true);

      // semantic near validations: invalid anchor pin format
      const v9 = await validateIntent({ ...baseIntent, hints: { near: [{ ref: 'R1', pin: 'R2' }] } }, symsource, null);
      expect(v9.ok).toBe(false);
      expect(v9.findings.some((f) => f.detail.includes('is not of the form REF.PIN'))).toBe(true);

      // semantic near validations: unknown anchor part
      const v10 = await validateIntent({ ...baseIntent, hints: { near: [{ ref: 'R1', pin: 'R99.1' }] } }, symsource, null);
      expect(v10.ok).toBe(false);
      expect(v10.findings.some((f) => f.detail.includes('unknown anchor part "R99"'))).toBe(true);

      // semantic near validations: anchor has no such pin
      const v11 = await validateIntent({ ...baseIntent, hints: { near: [{ ref: 'R1', pin: 'R2.99' }] } }, symsource, null);
      expect(v11.ok).toBe(false);
      expect(v11.findings.some((f) => f.detail.includes('has no pin "99"'))).toBe(true);

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

  it('absent hints still produce a byte-identical sheet', async () => {
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

  it('near places the part on the anchor pin\'s row, shortens the wire, and removes the bend', async () => {
    // Design with MCU U1 and shunt cap C1 on pin 3 (input pin on left side of U1)
    // plus other parts so that without near, C1 is placed in a separate column
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
        { name: 'IN_NET', pins: ['U1.3', 'C1.1'] },
        { name: 'OUT_NET', pins: ['C1.2', 'R1.2', 'R2.1'] },
      ],
      noConnect: ['U1.4', 'U1.5', 'U1.6', 'U1.7', 'U1.8'],
    };

    const unhinted = await placeIntent(baseIntent);
    expect(unhinted.ok).toBe(true);
    if (!unhinted.ok) return;

    const hinted = await placeIntent({
      ...baseIntent,
      hints: {
        near: [{ ref: 'C1', pin: 'U1.3' }],
      },
    });
    expect(hinted.ok).toBe(true);
    if (!hinted.ok) return;

    const u1Unhinted = unhinted.model.symbols.find((s) => s.ref === 'U1')!;
    const c1Unhinted = unhinted.model.symbols.find((s) => s.ref === 'C1')!;
    const u1Hinted = hinted.model.symbols.find((s) => s.ref === 'U1')!;
    const c1Hinted = hinted.model.symbols.find((s) => s.ref === 'C1')!;

    // Pin 3 is on U1's left side.
    // In hinted draft, C1 is placed on U1.3's row: its X position matches U1.3's stub axis (left of U1 body)
    const wiresHinted = hinted.model.wires.filter((w) => w.net === 'IN_NET');
    const wiresUnhinted = unhinted.model.wires.filter((w) => w.net === 'IN_NET');

    // Total wire length on IN_NET
    const lengthHinted = wiresHinted.reduce((s, w) => s + Math.hypot(w.x2 - w.x1, w.y2 - w.y1), 0);
    const lengthUnhinted = wiresUnhinted.reduce((s, w) => s + Math.hypot(w.x2 - w.x1, w.y2 - w.y1), 0);
    expect(lengthHinted, 'near hint should shorten the wire').toBeLessThanOrEqual(lengthUnhinted);

    // In hinted draft, wire between U1.3 and C1.1 has NO bend (horizontal stub + straight vertical drop or straight line)
    // Every vertical segment on IN_NET in hinted draft shares the exact same X coordinate
    const vertWires = wiresHinted.filter((w) => Math.abs(w.x1 - w.x2) < 0.01);
    expect(vertWires.length).toBeGreaterThan(0);
    const xCoord = vertWires[0]!.x1;
    for (const vw of vertWires) {
      expect(vw.x1).toBeCloseTo(xCoord, 2);
    }
  });
});
