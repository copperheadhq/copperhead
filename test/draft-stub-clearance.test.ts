import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { validateIntent, type SchematicIntent } from '../src/kicad/draft/ir.js';
import { draftSchematicPlacement } from '../src/kicad/draft/engine.js';

/**
 * Wire endpoints moved for typographic reasons must still be electrically
 * clear (#217).
 *
 * Two passes decide where a stub ends by asking a question about TEXT: the
 * power pass picks a length that keeps the rail name from colliding, and the
 * label nudge rides a stub outward until its label reads clean. Neither used to
 * ask where the wire's ENDPOINT landed, so both could park a live end on
 * another net's wire. The merged-net gate caught the result and refused, which
 * is why nothing shipped wrong, but the boards could not be drafted at all.
 *
 * Found by pointing the engine at real designs (draft-real-corpus.test.ts):
 * cm5_minima shorted +5V to GND, interf_u shorted /PC-RD to /WR_REG. Those need
 * a KiCad install to reproduce, so the geometry is pinned here on fixture
 * symbols instead.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');

async function place(intent: SchematicIntent) {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-clearance-'));
  try {
    const v = await validateIntent(intent, new SymbolSource(repo, [SYMLIB], false), null);
    expect(v.ok, v.findings.map((f) => f.detail).join('; ')).toBe(true);
    return draftSchematicPlacement(v.validated!, 'board', '2020-01-01');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

/** Wire endpoints and interiors that two different nets share. */
function contacts(model: { wires: { x1: number; y1: number; x2: number; y2: number; net: string }[] }): string[] {
  const out: string[] = [];
  const on = (px: number, py: number, s: { x1: number; y1: number; x2: number; y2: number }): boolean => {
    const eps = 0.005;
    if (Math.abs(s.x1 - s.x2) < eps) {
      return Math.abs(px - s.x1) < eps && py >= Math.min(s.y1, s.y2) - eps && py <= Math.max(s.y1, s.y2) + eps;
    }
    if (Math.abs(s.y1 - s.y2) < eps) {
      return Math.abs(py - s.y1) < eps && px >= Math.min(s.x1, s.x2) - eps && px <= Math.max(s.x1, s.x2) + eps;
    }
    return false;
  };
  for (const a of model.wires) {
    for (const b of model.wires) {
      if (a.net === b.net) continue;
      for (const [px, py] of [
        [a.x1, a.y1],
        [a.x2, a.y2],
      ] as const) {
        if (on(px, py, b)) out.push(`${a.net} end (${px},${py}) on ${b.net}`);
      }
    }
  }
  return [...new Set(out)];
}

describe('a power stub clears foreign connection points, not just foreign text', () => {
  /**
   * The cm5_minima geometry: two rails on one part, their pins one column
   * apart and facing each other across four grid units. Both stubs run two
   * units inward and meet exactly in the middle, tying the rails together.
   *
   * The old power pass chose its length purely from where the value text
   * stopped colliding, so nothing looked at that endpoint at all.
   */
  it('pulls a rail stub back rather than meeting the opposing rail head-on', async () => {
    const { model, report } = await place({
      version: 1,
      parts: [
        { ref: 'U1', libId: 'CopperStack:FacingRails', value: 'FacingRails', group: 'Main' },
        { ref: 'C1', libId: 'Device:C', value: '100n', group: 'Main' },
        { ref: 'R1', libId: 'Device:R', value: '10k', group: 'Main' },
      ],
      nets: [
        { name: 'VBUS', pins: ['U1.1', 'C1.1'] },
        { name: 'GND', pins: ['U1.2', 'C1.2'] },
        { name: 'SENSE', pins: ['U1.3', 'R1.1'] },
      ],
      noConnect: ['R1.2'],
    });
    expect(report.mergedNets).toEqual([]);
    expect(contacts(model)).toEqual([]);
  });

  /**
   * The engine may not overcorrect either: a rail whose stub is already clear
   * keeps the length the text rules chose, so a pin's power symbol stays where
   * a reader expects it and the byte-pinned boards do not move.
   */
  it('leaves a stub that was already clear exactly where it was', async () => {
    const { model, report } = await place({
      version: 1,
      parts: [
        { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
        { ref: 'C1', libId: 'Device:C', value: '100n', group: 'Main' },
      ],
      nets: [
        { name: 'VCC', pins: ['U1.1', 'C1.1'] },
        { name: 'GND', pins: ['U1.2', 'C1.2'] },
      ],
      noConnect: ['U1.3', 'U1.4', 'U1.5', 'U1.6', 'U1.7', 'U1.8'],
    });
    expect(report.mergedNets).toEqual([]);
    // U1's rails leave horizontal pins, so they run the 4-unit length the
    // engine uses to clear neighbouring rows. Nothing here forces a shift.
    const rail = model.wires.find((w) => w.net === 'VCC' && Math.abs(w.y1 - w.y2) < 0.005);
    expect(rail).toBeDefined();
    expect(Math.abs(rail!.x2 - rail!.x1) / 1.27).toBeCloseTo(4, 5);
  });
});

describe('a nudged label drags its stub, so the stub must stay clear too', () => {
  /**
   * An invariant guard, not a reproduction. The nudge half of #217 was found on
   * interf_u, where a labelled stub rode from two units to four and parked on a
   * wired net's trunk; two sweeps over fixture-scale intents (varying part
   * count, part type, net-name length, and the mix of wired pairs to labelled
   * runs) failed to recreate that geometry, so the reproducing case lives only
   * in the opt-in corpus sweep.
   *
   * This board does exercise the pass — the long names force labels to collide
   * and ride — so it holds the invariant against future regressions. It passed
   * before the fix as well, and should be read as coverage of the pass rather
   * than as the test that pins the bug.
   */
  it('never rides a stub onto another net while clearing its label', async () => {
    const parts = [
      { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
      { ref: 'U2', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
      { ref: 'U3', libId: 'CopperMCU:MCU8', value: 'MCU8', group: 'Main' },
    ];
    // Long names on adjacent pins force the label de-collision pass to run.
    const nets = [
      { name: 'VCC', pins: ['U1.1', 'U2.1', 'U3.1'] },
      { name: 'GND', pins: ['U1.2', 'U2.2', 'U3.2'] },
      { name: 'PERIPHERAL_RESET_REQUEST', pins: ['U1.4', 'U2.3'] },
      { name: 'PERIPHERAL_STATUS_STROBE', pins: ['U1.5', 'U3.3'] },
      { name: 'PERIPHERAL_DATA_READY_IRQ', pins: ['U1.6', 'U2.4'] },
      { name: 'PERIPHERAL_CLOCK_ENABLE_B', pins: ['U1.7', 'U3.4'] },
      { name: 'PERIPHERAL_ADDRESS_LATCH', pins: ['U1.8', 'U2.5'] },
      { name: 'SECONDARY_BUS_HANDSHAKE', pins: ['U2.6', 'U3.5'] },
      { name: 'SECONDARY_BUS_DIRECTION', pins: ['U2.7', 'U3.6'] },
    ];
    const { model, report } = await place({
      version: 1,
      parts,
      nets,
      noConnect: ['U2.8', 'U3.7', 'U3.8'],
    });
    expect(report.mergedNets).toEqual([]);
    expect(contacts(model)).toEqual([]);
  });
});
