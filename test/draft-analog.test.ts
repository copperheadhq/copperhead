import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { validateIntent, type SchematicIntent } from '../src/kicad/draft/ir.js';
import { draftSchematicPlacement, searchPassBudget } from '../src/kicad/draft/engine.js';
import { emitSchematic } from '../src/kicad/emit.js';
import { pinAbsolute } from '../src/kicad/sexp.js';

/**
 * The analog passes: feedback drawn around the amplifier, feedback bridges,
 * the placement search's limits, group colours, and the rule that no label
 * is ever anchored on another net's wire. They run on the placement model.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');

async function place(intent: SchematicIntent) {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-analog-'));
  try {
    const v = await validateIntent(intent, new SymbolSource(repo, [SYMLIB]), null);
    expect(v.ok, v.findings.map((f) => f.detail).join('; ')).toBe(true);
    const { model, report } = draftSchematicPlacement(v.validated!, 'board', '2020-01-01');
    return { model, report, symbols: v.validated!.symbols };
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

type Placed = Awaited<ReturnType<typeof place>>;

/** Where a pin's connection point landed on the sheet. */
function pinXY(p: Placed, ref: string, pin: string): { x: number; y: number } {
  const sym = p.model.symbols.find((s) => s.ref === ref)!;
  const def = p.symbols.get(ref)!.pins.find((q) => q.number === pin)!;
  return pinAbsolute(sym.at, sym.mirror ?? null, def);
}

/** Are two points joined by wires alone (ends meeting, or an end on a wire of the same run)? */
function wiredTogether(p: Placed, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const key = (x: number, y: number): string => `${x.toFixed(2)},${y.toFixed(2)}`;
  const onSeg = (w: { x1: number; y1: number; x2: number; y2: number }, x: number, y: number): boolean =>
    x >= Math.min(w.x1, w.x2) - 0.01 && x <= Math.max(w.x1, w.x2) + 0.01 && y >= Math.min(w.y1, w.y2) - 0.01 && y <= Math.max(w.y1, w.y2) + 0.01;
  const wires = p.model.wires;
  const parent = wires.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      const [w, o] = [wires[i]!, wires[j]!];
      if ([[w.x1, w.y1], [w.x2, w.y2]].some(([x, y]) => onSeg(o, x!, y!)) || [[o.x1, o.y1], [o.x2, o.y2]].some(([x, y]) => onSeg(w, x!, y!))) parent[find(i)] = find(j);
    }
  }
  const at = (pt: { x: number; y: number }): number[] =>
    wires.flatMap((w, i) => (key(w.x1, w.y1) === key(pt.x, pt.y) || key(w.x2, w.y2) === key(pt.x, pt.y) ? [find(i)] : []));
  const ra = at(a);
  return at(b).some((r) => ra.includes(r));
}

/** No label may stand on a wire of another net: KiCad would join the two nets. */
function expectNoLabelOnForeignWire(p: Placed): void {
  for (const l of p.model.labels) {
    const on = p.model.wires.filter(
      (w) =>
        w.net !== l.name &&
        l.x >= Math.min(w.x1, w.x2) - 0.01 &&
        l.x <= Math.max(w.x1, w.x2) + 0.01 &&
        l.y >= Math.min(w.y1, w.y2) - 0.01 &&
        l.y <= Math.max(w.y1, w.y2) + 0.01,
    );
    expect(on.map((w) => w.net), `label ${l.name} at (${l.x}, ${l.y})`).toEqual([]);
  }
}

const bomOf = (parts: SchematicIntent['parts']) => parts;

/** An inverting amplifier: input resistor into '-', gain resistor from '-' to the output. */
function inverting(libId: string): SchematicIntent {
  return {
    version: 1,
    parts: bomOf([
      { ref: 'J1', libId: 'Connector_Generic:Conn_01x02', value: 'IN', group: 'Amp' },
      { ref: 'U1', libId, value: 'AMP', group: 'Amp' },
      { ref: 'R1', libId: 'Device:R', value: '10k', group: 'Amp' },
      { ref: 'R2', libId: 'Device:R', value: '100k', group: 'Amp' },
      { ref: 'R3', libId: 'Device:R', value: '10k', group: 'Amp' },
      { ref: 'C9', libId: 'Device:C', value: '100n', group: 'Amp' },
    ]),
    nets: [
      { name: 'IN', pins: ['J1.1', 'R1.1'] },
      { name: 'SUM', pins: ['R1.2', 'U1.2', 'R2.1'] },
      { name: 'OUT', pins: ['U1.1', 'R2.2', 'R3.1'] },
      { name: 'VCC', pins: ['U1.8', 'C9.1'] },
      { name: 'GND', pins: ['J1.2', 'U1.3', 'U1.4', 'R3.2', 'C9.2'] },
    ],
  };
}

describe('feedback around the amplifier', () => {
  it('wires a follower output to its own inverting input, as one run', async () => {
    const p = await place({
      version: 1,
      parts: [
        { ref: 'J1', libId: 'Connector_Generic:Conn_01x02', value: 'IN', group: 'Buffer' },
        { ref: 'U1', libId: 'CopperAmp:OpAmp', value: 'AMP', group: 'Buffer' },
        { ref: 'R1', libId: 'Device:R', value: '1k', group: 'Buffer' },
        { ref: 'C1', libId: 'Device:C', value: '1u', group: 'Buffer' },
        { ref: 'C9', libId: 'Device:C', value: '100n', group: 'Buffer' },
      ],
      nets: [
        { name: 'IN', pins: ['J1.1', 'R1.1'] },
        { name: 'NIN', pins: ['R1.2', 'U1.3'] },
        { name: 'OUT', pins: ['U1.1', 'U1.2', 'C1.1'] },
        { name: 'VCC', pins: ['U1.8', 'C9.1'] },
        { name: 'GND', pins: ['J1.2', 'U1.4', 'C1.2', 'C9.2'] },
      ],
    });
    expect(wiredTogether(p, pinXY(p, 'U1', '1'), pinXY(p, 'U1', '2'))).toBe(true);
    expect(p.report.mergedNets).toEqual([]);
    expectNoLabelOnForeignWire(p);
  });

  it('names a net that is only the feedback loop once', async () => {
    const p = await place({
      version: 1,
      parts: [
        { ref: 'J1', libId: 'Connector_Generic:Conn_01x02', value: 'IN', group: 'Buffer' },
        { ref: 'U1', libId: 'CopperAmp:OpAmp', value: 'AMP', group: 'Buffer' },
        { ref: 'R1', libId: 'Device:R', value: '1k', group: 'Buffer' },
        { ref: 'C9', libId: 'Device:C', value: '100n', group: 'Buffer' },
      ],
      nets: [
        { name: 'IN', pins: ['J1.1', 'R1.1'] },
        { name: 'NIN', pins: ['R1.2', 'U1.3'] },
        { name: 'FB', pins: ['U1.1', 'U1.2'] },
        { name: 'VCC', pins: ['U1.8', 'C9.1'] },
        { name: 'GND', pins: ['J1.2', 'U1.4', 'C9.2'] },
      ],
    });
    expect(wiredTogether(p, pinXY(p, 'U1', '1'), pinXY(p, 'U1', '2'))).toBe(true);
    expect(p.model.labels.filter((l) => l.name === 'FB')).toHaveLength(1);
    expectNoLabelOnForeignWire(p);
  });

  it.each(['CopperAmp:OpAmp', 'CopperAmp:OpAmpIN'])('bridges the gain resistor across the amplifier (%s)', async (libId) => {
    const p = await place(inverting(libId));
    const u1 = p.model.symbols.find((s) => s.ref === 'U1')!;
    const r2 = p.model.symbols.find((s) => s.ref === 'R2')!;
    // across the amplifier: between its input and output pins, above or below its body
    expect(r2.at.x).toBeGreaterThan(pinXY(p, 'U1', '2').x);
    expect(r2.at.x).toBeLessThan(pinXY(p, 'U1', '1').x);
    expect(Math.abs(r2.at.y - u1.at.y)).toBeGreaterThanOrEqual(5.08);
    expect(p.report.mergedNets).toEqual([]);
    expectNoLabelOnForeignWire(p);
  });
});

describe('the placement search', () => {
  it('never turns a connector, only mirrors it', async () => {
    for (const libId of ['CopperAmp:OpAmp', 'CopperAmp:OpAmpIN']) {
      const p = await place(inverting(libId));
      const j1 = p.model.symbols.find((s) => s.ref === 'J1')!;
      expect(j1.at.rot, libId).toBe(0);
    }
  });

  it('keeps a crystal and its load caps to the flanking idiom, but not the parts on its ground', async () => {
    const p = await place({
      version: 1,
      parts: [
        { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
        { ref: 'Y1', libId: 'Device:Crystal', value: '16MHz', group: 'Main' },
        { ref: 'C1', libId: 'Device:C', value: '22p', group: 'Main' },
        { ref: 'C2', libId: 'Device:C', value: '22p', group: 'Main' },
      ],
      nets: [
        { name: 'OSC1', pins: ['U1.4', 'Y1.1', 'C1.1'] },
        { name: 'OSC2', pins: ['U1.5', 'Y1.2', 'C2.1'] },
        { name: 'GND', pins: ['C1.2', 'C2.2', 'U1.2'] },
      ],
    });
    const at = (ref: string) => p.model.symbols.find((s) => s.ref === ref)!.at;
    expect(at('C1').y).toBeCloseTo(at('C2').y, 5);
    expect(at('C1').rot).toBe(at('C2').rot);
    expectNoLabelOnForeignWire(p);
  });
});

describe('group colours', () => {
  it('colours power warm, connectors neutral and every other group from the cycle, dashed over a tint', async () => {
    const p = await place({
      version: 1,
      parts: [
        { ref: 'J1', libId: 'Connector_Generic:Conn_01x02', value: 'IN', group: 'Connectors' },
        { ref: 'U1', libId: 'CopperStack:PWRIC', value: 'PWRIC', group: 'Power' },
        { ref: 'U2', libId: 'CopperAmp:OpAmp', value: 'AMP', group: 'Amp' },
        { ref: 'U3', libId: 'CopperAmp:OpAmp', value: 'AMP', group: 'Filter' },
      ],
      nets: [
        { name: 'VIN', pins: ['J1.1', 'U1.1'] },
        { name: 'VCC', pins: ['U1.3', 'U2.8', 'U3.8'] },
        { name: 'SIG', pins: ['U2.1', 'U3.3'] },
        { name: 'FB1', pins: ['U2.2', 'U2.3'] },
        { name: 'GND', pins: ['J1.2', 'U1.2', 'U1.4', 'U2.4', 'U3.4', 'U3.2', 'U3.1'] },
      ],
    });
    const colour = (name: string) => p.model.rectangles.find((r) => r.name === name)!.color;
    expect(colour('Power')).toEqual([220, 110, 20]);
    expect(colour('Connectors')).toEqual([72, 72, 72]);
    expect(colour('Amp')).not.toEqual(colour('Filter'));
    for (const r of p.model.rectangles) expect(r.stroke).toBe('dash');
    const text = emitSchematic(p.model);
    expect(text).toContain('(stroke (width 0.3) (type dash) (color 220 110 20 1))');
    expect(text).toContain('(fill (type color) (color 220 110 20 0.08))');
  });

  it.each(['Test Points', 'Test-Points', 'test_point'])('colours a test-point group neutral (%s)', async (group) => {
    const p = await place({
      version: 1,
      parts: [
        { ref: 'J1', libId: 'Connector_Generic:Conn_01x02', value: 'TP', group },
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'Amp' },
      ],
      nets: [
        { name: 'SIG', pins: ['J1.1', 'R1.1'] },
        { name: 'GND', pins: ['J1.2', 'R1.2'] },
      ],
    });
    expect(p.model.rectangles.find((r) => r.name === group)!.color).toEqual([72, 72, 72]);
  });

  it('escapes a line break in emitted text', async () => {
    const p = await place(inverting('CopperAmp:OpAmp'));
    p.model.captions[0]!.text = 'Two\nlines';
    expect(emitSchematic(p.model)).toContain('"Two\\nlines"');
  });
});

describe('the placement search spends its passes where they can help', () => {
  it('budgets passes by part count, so a large board is not a full draft pass per trial for minutes', () => {
    expect(searchPassBudget(4)).toBe(60);
    expect(searchPassBudget(25)).toBe(60);
    expect(searchPassBudget(50)).toBe(30);
    expect(searchPassBudget(100)).toBe(15);
    expect(searchPassBudget(160)).toBe(9);
    expect(searchPassBudget(1000)).toBe(6);
  });

  it('does not search a large sheet with no label on anything and no crossing', async () => {
    // thirty parts, each pair on its own two nets: nothing crosses, nothing overlaps
    const parts = [];
    const nets = [];
    for (let i = 1; i <= 15; i++) {
      parts.push({ ref: `J${i}`, libId: 'Connector_Generic:Conn_01x02', value: 'IN', group: `Block ${i}` });
      parts.push({ ref: `R${i}`, libId: 'Device:R', value: '10k', group: `Block ${i}` });
      nets.push({ name: `SIG${i}`, pins: [`J${i}.1`, `R${i}.1`] });
      nets.push({ name: `RET${i}`, pins: [`J${i}.2`, `R${i}.2`] });
    }
    const p = await place({ version: 1, parts, nets });
    expect(p.report.notes.filter((n) => n.startsWith('placement search'))).toEqual([]);
  });
});
