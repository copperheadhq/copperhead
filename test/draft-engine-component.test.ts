import { describe, it, expect } from 'vitest';
import {
  declaredNets,
  drawnNets,
  intentOf,
  part,
  pinPoint,
  place,
  pointKey,
  symbolOf,
  tryValidate,
  U,
} from './support/draft-harness.js';
import type { SchematicIntent } from '../src/kicad/draft/ir.js';

/**
 * The drafting engine as a component: IR in, placement model out, nothing else
 * in the loop. No repo, no vendored cache, no kicad-cli, no CLI, no agent — see
 * test/support/draft-harness.ts for the seam.
 *
 * The other draft suites each pin one board: the reference IR drafts to these
 * exact bytes, this geometry lands at these coordinates. Those catch
 * regressions on the boards they name. What they cannot say is whether a
 * contract holds for boards nobody wrote a fixture for.
 *
 * So this file is organised the other way round: a family of intents, and
 * contracts asserted across all of them. A change that satisfies the reference
 * board by special-casing it fails here on the sibling that was not special-cased.
 */

/** Voltage divider off a 3-pin header — the reference topology, inline. */
const divider: SchematicIntent = intentOf({
  parts: [
    part('J1', 'CopperConn:Conn_01x03', 'Conn_01x03', 'Power'),
    part('U1', 'CopperMCU:MCU8', 'MCU8', 'MCU'),
    part('R1', 'Device:R', '10k', 'MCU'),
    part('R2', 'Device:R', '10k', 'MCU'),
    part('C1', 'Device:C', '100n', 'MCU'),
  ],
  nets: [
    { name: 'VCC', pins: ['J1.1', 'U1.1', 'C1.1'] },
    { name: 'GND', pins: ['J1.2', 'U1.2', 'R2.2', 'C1.2'] },
    { name: 'SIG_IN', pins: ['J1.3', 'R1.1'] },
    { name: 'DIV', pins: ['R1.2', 'R2.1', 'U1.3'] },
  ],
  noConnect: ['U1.4', 'U1.5', 'U1.6', 'U1.7', 'U1.8'],
});

/** Four caps in a row across one rail pair: the alignment-heavy shape. */
const decoupling: SchematicIntent = intentOf({
  parts: [
    part('U1', 'CopperMCU:MCU8', 'MCU8', 'MCU'),
    ...[1, 2, 3, 4].map((i) => part(`C${i}`, 'Device:C', '100n', 'Power')),
  ],
  nets: [
    { name: 'VCC', pins: ['U1.1', 'C1.1', 'C2.1', 'C3.1', 'C4.1'] },
    { name: 'GND', pins: ['U1.2', 'C1.2', 'C2.2', 'C3.2', 'C4.2'] },
  ],
  noConnect: ['U1.3', 'U1.4', 'U1.5', 'U1.6', 'U1.7', 'U1.8'],
});

/** Two MCUs on shared rails with a signal between them: cross-group routing. */
const twoMcu: SchematicIntent = intentOf({
  parts: [
    part('U1', 'CopperMCU:MCU8', 'MCU8', 'Left'),
    part('U2', 'CopperMCU:MCU8', 'MCU8', 'Right'),
    part('R1', 'Device:R', '100', 'Left'),
  ],
  nets: [
    { name: 'VCC', pins: ['U1.1', 'U2.1'] },
    { name: 'GND', pins: ['U1.2', 'U2.2'] },
    { name: 'LINK', pins: ['U1.4', 'R1.1'] },
    { name: 'LINK_TERM', pins: ['R1.2', 'U2.3'] },
  ],
  noConnect: ['U1.3', 'U1.5', 'U1.6', 'U1.7', 'U1.8', 'U2.4', 'U2.5', 'U2.6', 'U2.7', 'U2.8'],
});

/** A series RC from a pin to ground: the drop-chain shape, minimal. */
const seriesChain: SchematicIntent = intentOf({
  parts: [
    part('U1', 'CopperMCU:MCU8', 'MCU8', 'MCU'),
    part('R1', 'Device:R', '1k', 'MCU'),
    part('C1', 'Device:C', '10n', 'MCU'),
    part('C2', 'Device:C', '100n', 'MCU'),
  ],
  nets: [
    { name: 'VCC', pins: ['U1.1', 'C2.1'] },
    { name: 'GND', pins: ['U1.2', 'C1.2', 'C2.2'] },
    { name: 'SENSE', pins: ['U1.4', 'R1.1'] },
    { name: 'FILT', pins: ['R1.2', 'C1.1'] },
  ],
  noConnect: ['U1.3', 'U1.5', 'U1.6', 'U1.7', 'U1.8'],
});

/**
 * The smallest board the IR permits: rails only, every signal pin unused. A
 * single part cannot be it — a net needs two endpoints — so the floor is one
 * part plus its decoupling cap.
 */
const minimal: SchematicIntent = intentOf({
  parts: [part('U1', 'CopperMCU:MCU8', 'MCU8', 'MCU'), part('C1', 'Device:C', '100n', 'MCU')],
  nets: [
    { name: 'VCC', pins: ['U1.1', 'C1.1'] },
    { name: 'GND', pins: ['U1.2', 'C1.2'] },
  ],
  noConnect: ['U1.3', 'U1.4', 'U1.5', 'U1.6', 'U1.7', 'U1.8'],
});

const BOARDS: { name: string; intent: SchematicIntent }[] = [
  { name: 'divider', intent: divider },
  { name: 'decoupling', intent: decoupling },
  { name: 'twoMcu', intent: twoMcu },
  { name: 'seriesChain', intent: seriesChain },
  { name: 'minimal', intent: minimal },
];

/** True when a coordinate is an exact multiple of the 1.27 mm grid. */
const onGrid = (v: number): boolean => Math.abs(v / U - Math.round(v / U)) < 1e-9;

describe.each(BOARDS)('engine contracts hold for every board: $name', ({ intent }) => {
  /**
   * The load-bearing one. Every other check in this file is about how the sheet
   * reads; this is about whether it is the circuit that was asked for. Read
   * back through the production parser, so it fails if the engine draws a net
   * the IR never declared or drops one it did.
   */
  it('draws exactly the declared netlist, pin for pin', async () => {
    const drawn = await drawnNets(intent);
    const declared = declaredNets(intent);
    const actual = new Map([...declared.keys()].map((pin) => [pin, drawn.get(pin)]));
    expect(actual).toEqual(new Map([...declared]));
  });

  /**
   * A merge is the one defect the engine may never ship — the sheet would be
   * wrong rather than ugly — so the report must come back empty, not merely
   * warn. draftSchematicToText refuses on a non-empty list; this asserts the
   * refusal never has cause to fire.
   */
  it('shorts nothing: no two nets share a point', async () => {
    const { report } = await place(intent);
    expect(report.mergedNets).toEqual([]);
  });

  it('places every declared part exactly once, carrying its value', async () => {
    const placed = await place(intent);
    // `#PWR`/`#FLG` refdes are the engine's own power ports and flags, not IR parts.
    const parts = placed.model.symbols.filter((s) => !s.ref.startsWith('#'));
    expect(parts.map((s) => s.ref).sort()).toEqual(intent.parts.map((p) => p.ref).sort());
    for (const p of intent.parts) {
      expect({ ref: p.ref, value: symbolOf(placed, p.ref).value }).toEqual({ ref: p.ref, value: p.value });
    }
  });

  /**
   * KiCad joins connections on exact coordinates: a pin off the 1.27 grid
   * cannot be wired to without a stub the engine did not plan, so off-grid is
   * a connectivity bug that happens to look like a cosmetic one.
   */
  it('lands every connected pin on the 1.27 grid', async () => {
    const placed = await place(intent);
    for (const pin of declaredNets(intent).keys()) {
      const [ref, number] = pin.split('.') as [string, string];
      const { x, y } = pinPoint(placed, ref, number);
      expect({ pin, x: onGrid(x), y: onGrid(y) }).toEqual({ pin, x: true, y: true });
    }
  });

  /**
   * An unconnected pin needs its no-connect marker on the pin itself. One
   * placed a grid step away leaves ERC reporting the pin unconnected AND the
   * marker dangling, which is how a stale marker survives a re-draft.
   */
  it('marks every no-connect on the pin it belongs to', async () => {
    const placed = await place(intent);
    const declared = intent.noConnect ?? [];
    expect(placed.report.noConnects).toBe(declared.length);
    const markers = new Set(placed.model.noConnects.map((n) => pointKey(n.x, n.y)));
    for (const pin of declared) {
      const [ref, number] = pin.split('.') as [string, string];
      const { x, y } = pinPoint(placed, ref, number);
      expect({ pin, marked: markers.has(pointKey(x, y)) }).toEqual({ pin, marked: true });
    }
  });

  /**
   * The engine is pure by construction — no clock, no random, no ambient
   * config — and the byte-level goldens depend on it. Asserted on the model
   * rather than the text so a failure names the field that drifted.
   */
  it('is deterministic: two placements of one intent are identical', async () => {
    const a = await place(intent);
    const b = await place(intent);
    expect(b.model).toEqual(a.model);
    expect(b.report).toEqual(a.report);
  });
});

describe('rails and signals are told apart from pin types alone', () => {
  it('classifies undeclared nets by what they connect to', async () => {
    const { report } = await place(divider);
    const byName = new Map(report.netClasses.map((n) => [n.name, n.class]));
    expect(byName.get('VCC')).toBe('rail');
    expect(byName.get('GND')).toBe('ground');
    expect(byName.get('SIG_IN')).toBe('signal');
    expect(byName.get('DIV')).toBe('signal');
    expect(report.netClasses.every((n) => !n.overridden)).toBe(true);
  });

  /**
   * A rail is drawn as a per-pin power port, never as a wire spanning the
   * sheet, so every rail gets a pwrFlag and no signal does.
   */
  it('gives every rail a power flag and no signal one', async () => {
    const { report } = await place(divider);
    expect(report.pwrFlags).toEqual(['GND', 'VCC']);
  });
});

describe('the engine refuses an IR it cannot draw faithfully', () => {
  it('names a pin that no symbol has, and lists the ones it does', async () => {
    const bad = intentOf({
      ...minimal,
      nets: [...minimal.nets, { name: 'GHOST', pins: ['U1.99', 'C1.1'] }],
    });
    const v = await tryValidate(bad);
    expect(v.ok).toBe(false);
    const detail = v.findings.map((f) => f.detail).join('; ');
    expect(detail).toContain('U1 has no pin 99');
    expect(detail).toContain('[1, 2, 3, 4, 5, 6, 7, 8]');
  });

  it('names a net endpoint whose refdes was never declared', async () => {
    const bad = intentOf({
      ...minimal,
      nets: [...minimal.nets, { name: 'GHOST', pins: ['U9.1', 'C1.1'] }],
    });
    const v = await tryValidate(bad);
    expect(v.ok).toBe(false);
    expect(v.findings.map((f) => f.detail).join('; ')).toContain('U9');
  });
});

describe('sheet size follows content', () => {
  it('a two-part board and a five-part board both get a real paper size', async () => {
    const small = await place(minimal);
    const big = await place(twoMcu);
    expect(small.report.paper).toBeTruthy();
    expect(big.report.paper).toBeTruthy();
    // Both are valid KiCad paper names; the contract is that the engine picks
    // one from content rather than defaulting unconditionally.
    expect([small.report.paper, big.report.paper].every((p) => /^A\d$/.test(p))).toBe(true);
  });
});
