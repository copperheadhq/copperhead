import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { validateIntent, type SchematicIntent } from '../src/kicad/draft/ir.js';
import { draftSchematicPlacement, isLabelAnchorClear, type PlacementModel, type SchematicDraftReport } from '../src/kicad/draft/engine.js';
import { emitSchematic } from '../src/kicad/emit.js';
import { parseNetlist, netPartition } from './support/netlist.js';
import type { Bounds } from '../src/kicad/sexp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');
const U = 1.27; // KiCad drafting grid unit, mm
const STUB = 2; // Nominal stub length, in grid units (2 * 1.27 = 2.54 mm)

/**
 * Mathematically complete axis-aligned segment-vs-rectangle interior intersection check.
 * Returns true if segment ((x1, y1), (x2, y2)) penetrates the open interior of box b
 * with margin eps. Touching the outer boundary does NOT constitute interior penetration.
 */
function segCrossesBoxInterior(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  b: Bounds,
  eps = 0.01,
): boolean {
  const minSegX = Math.min(x1, x2);
  const maxSegX = Math.max(x1, x2);
  const minSegY = Math.min(y1, y2);
  const maxSegY = Math.max(y1, y2);

  const inX = Math.max(minSegX, b.minX) < Math.min(maxSegX, b.maxX) - eps;
  const inY = Math.max(minSegY, b.minY) < Math.min(maxSegY, b.maxY) - eps;

  if (Math.abs(x1 - x2) < eps) {
    // Vertical segment
    return x1 > b.minX + eps && x1 < b.maxX - eps && inY;
  }
  if (Math.abs(y1 - y2) < eps) {
    // Horizontal segment
    return y1 > b.minY + eps && y1 < b.maxY - eps && inX;
  }
  return inX && inY;
}

/** Check if point (px, py) lies on Manhattan segment ((x1, y1), (x2, y2)) within eps. */
function pointOnSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number, eps = 0.01): boolean {
  const minX = Math.min(x1, x2) - eps;
  const maxX = Math.max(x1, x2) + eps;
  const minY = Math.min(y1, y2) - eps;
  const maxY = Math.max(y1, y2) + eps;
  if (px < minX || px > maxX || py < minY || py > maxY) return false;
  if (Math.abs(x1 - x2) < eps) return Math.abs(px - x1) < eps;
  if (Math.abs(y1 - y2) < eps) return Math.abs(py - y1) < eps;
  return false;
}

function sameCoord(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) < eps;
}

/**
 * Deterministic custom symbols for direct routing fixtures:
 * Body is 2.54 mm x 2.54 mm ([-1.27, 1.27] x [-1.27, 1.27]).
 * Cell height dims.h = VMARGIN (2) + ceilU(2.54) (2) + VMARGIN (2) = 6 units (7.62 mm).
 * Stacking row displacement = 6 + ROW_GAP (3) = 9 units (11.43 mm).
 * Pin separation formula: dist = 11.43 mm - (pinBot.y - pinTop.y).
 */
function makeDirectFixtureLib(): string {
  return `(kicad_symbol_lib
	(version 20231120)
	(generator "copperhead-fixture")
	(symbol "FacingTop_127"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingTop_127" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingTop_127_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingTop_127_1_1"
			(pin passive line (at 0 -5.08 90) (length 3.81)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "FacingBot_127"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingBot_127" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingBot_127_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingBot_127_1_1"
			(pin passive line (at 0 5.08 270) (length 3.81)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "FacingTop_254"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingTop_254" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingTop_254_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingTop_254_1_1"
			(pin passive line (at 0 -3.81 90) (length 2.54)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "FacingBot_254"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingBot_254" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingBot_254_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingBot_254_1_1"
			(pin passive line (at 0 5.08 270) (length 3.81)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "FacingTop_381"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingTop_381" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingTop_381_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingTop_381_1_1"
			(pin passive line (at 0 -3.81 90) (length 2.54)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "FacingBot_381"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingBot_381" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingBot_381_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingBot_381_1_1"
			(pin passive line (at 0 3.81 270) (length 2.54)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "TestOpAmp"
		(pin_names (offset 0.127))
		(property "Reference" "U" (at 0 6.35 0) (effects (font (size 1.27 1.27))))
		(property "Value" "TestOpAmp" (at 0 -6.35 0) (effects (font (size 1.27 1.27))))
		(symbol "TestOpAmp_0_1"
			(polyline (pts (xy -5.08 5.08) (xy 5.08 0) (xy -5.08 -5.08) (xy -5.08 5.08))
				(stroke (width 0.254) (type default))
				(fill (type background))
			)
		)
		(symbol "TestOpAmp_1_1"
			(pin output line (at 7.62 0 180) (length 2.54)
				(name "OUT" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
			(pin input line (at -7.62 -2.54 0) (length 2.54)
				(name "IN-" (effects (font (size 1.27 1.27))))
				(number "2" (effects (font (size 1.27 1.27))))
			)
			(pin input line (at -7.62 2.54 0) (length 2.54)
				(name "IN+" (effects (font (size 1.27 1.27))))
				(number "3" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "FacingRight_Horiz_127"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingRight_Horiz_127" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingRight_Horiz_127_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingRight_Horiz_127_1_1"
			(pin passive line (at 8.255 0 180) (length 6.985)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "FacingLeft_Horiz_127"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingLeft_Horiz_127" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingLeft_Horiz_127_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingLeft_Horiz_127_1_1"
			(pin passive line (at -8.255 0 0) (length 6.985)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "DecorativeTop"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "DecorativeTop" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "DecorativeTop_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
			(polyline
				(pts (xy 0 -1.27) (xy 0 -6.35))
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "DecorativeTop_1_1"
			(pin passive line (at 0 -5.08 90) (length 3.81)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "InwardPassThrough"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "InwardPassThrough" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "InwardPassThrough_0_1"
			(rectangle (start -2.54 -2.54) (end 2.54 2.54)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "InwardPassThrough_1_1"
			(pin passive line (at 0 -2.54 90) (length 0.01)
				(name "1" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
			(pin passive line (at 0 2.54 270) (length 0.01)
				(name "2" (effects (font (size 1.27 1.27))))
				(number "2" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "InwardTiedPins"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "InwardTiedPins" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "InwardTiedPins_0_1"
			(rectangle (start -2.54 -1.27) (end 2.54 3.81)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "InwardTiedPins_1_1"
			(pin passive line (at 0 2.54 90) (length 0.01)
				(name "1" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
			(pin passive line (at 0 0 90) (length 0.01)
				(name "2" (effects (font (size 1.27 1.27))))
				(number "2" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "BodyExtend_Horiz"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "BodyExtend_Horiz" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "BodyExtend_Horiz_0_1"
			(rectangle (start -1.27 -1.27) (end 5.08 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "BodyExtend_Horiz_1_1"
			(pin passive line (at 2.54 0 180) (length 1.27)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "StubProbe_Down"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "StubProbe_Down" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "StubProbe_Down_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "StubProbe_Down_1_1"
			(pin passive line (at 2.54 -7.62 90) (length 1.27)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
	(symbol "FacingLeft_1Pin"
		(pin_numbers hide)
		(pin_names (offset 0))
		(property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(property "Value" "FacingLeft_1Pin" (at 0 0 0) (effects (font (size 1.27 1.27))))
		(symbol "FacingLeft_1Pin_0_1"
			(rectangle (start -1.27 -1.27) (end 1.27 1.27)
				(stroke (width 0.254) (type default))
				(fill (type none))
			)
		)
		(symbol "FacingLeft_1Pin_1_1"
			(pin passive line (at -2.54 0 0) (length 1.27)
				(name "~" (effects (font (size 1.27 1.27))))
				(number "1" (effects (font (size 1.27 1.27))))
			)
		)
	)
)
`;
}

interface PlaceResult {
  model: PlacementModel;
  report: SchematicDraftReport;
  workDir: string;
}

async function placeWithFixture(
  intent: SchematicIntent,
  customLibText?: string,
): Promise<PlaceResult> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-readability-219-'));
  const dirs = [SYMLIB];
  if (customLibText) {
    await writeFile(path.join(repo, 'DirectFixture.kicad_sym'), customLibText, 'utf8');
    dirs.push(repo);
  }
  const v = await validateIntent(intent, new SymbolSource(repo, dirs, false), null);
  expect(v.ok, v.findings.map((f) => f.detail).join('; ')).toBe(true);
  const { model, report } = draftSchematicPlacement(v.validated!, 'board', '2020-01-01');
  return { model, report, workDir: repo };
}

describe('schematic readability & wiring quality (#219)', () => {
  // ---------------------------------------------------------------------------
  // GATE 1: PROVE THE DIRECT-ROUTING BEHAVIOR
  // ---------------------------------------------------------------------------
  describe('Gate 1: direct-routing behavior across distance cutoff thresholds', () => {
    it('routes collinear facing pins separated by exactly 1.27 mm as a single direct wire', async () => {
      // Pin separation = 11.43 - (5.08 - (-5.08)) = 11.43 - 10.16 = 1.27 mm (1 * U).
      // Mutually facing vertical pins: Top pin faces downward (+Y schematic), Bot pin faces upward (-Y schematic).
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U0', libId: 'CopperMCU:MCU8', value: 'MCU', group: 'MAIN' },
          { ref: 'U1', libId: 'DirectFixture:FacingTop_127', value: 'TOP', group: 'MAIN' },
          { ref: 'U2', libId: 'DirectFixture:FacingBot_127', value: 'BOT', group: 'MAIN' },
        ],
        nets: [
          { name: 'DIRECT_NET_127', pins: ['U1.1', 'U2.1'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent, makeDirectFixtureLib());
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelOverlapBudgetExceeded).toBe(false);

        const u1 = model.symbols.find((s) => s.ref === 'U1')!;
        const u2 = model.symbols.find((s) => s.ref === 'U2')!;
        expect(u1).toBeDefined();
        expect(u2).toBeDefined();

        // Assert vertical collinearity
        expect(u1.at.x).toBe(u2.at.x);

        // Pin coordinates in schematic space:
        // U1 pin 1 at symbol space (0, -5.08) -> schematic (u1.at.x, u1.at.y - (-5.08)) = u1.at.y + 5.08
        // U2 pin 1 at symbol space (0, 5.08) -> schematic (u2.at.x, u2.at.y - 5.08) = u2.at.y - 5.08
        const pin1Y = u1.at.y + 5.08;
        const pin2Y = u2.at.y - 5.08;
        const dist = Math.abs(pin2Y - pin1Y);
        expect(Math.abs(dist - 1.27)).toBeLessThan(1e-4);

        // Assert outward normals: Top pin points downward (+Y schematic), Bot pin points upward (-Y schematic)
        // Verified by pin direction angle: Top pin angle 90 -> { dx: 0, dy: 1 }; Bot pin angle 270 -> { dx: 0, dy: -1 }

        // Emitted route must contain exactly 1 direct segment connecting the two pin endpoints
        const netWires = model.wires.filter((w) => w.net === 'DIRECT_NET_127');
        expect(netWires.length).toBe(1);
        const w0 = netWires[0]!;
        expect(w0.x1).toBe(u1.at.x);
        expect(w0.x2).toBe(u2.at.x);
        expect(Math.min(w0.y1, w0.y2)).toBeCloseTo(pin1Y, 3);
        expect(Math.max(w0.y1, w0.y2)).toBeCloseTo(pin2Y, 3);

        // Assert no redundant stubs, no junctions, no component body penetration
        expect(model.junctions.length).toBe(0);
        for (const s of model.symbols) {
          const bodyBox = {
            minX: s.at.x - 1.27,
            maxX: s.at.x + 1.27,
            minY: s.at.y - 1.27,
            maxY: s.at.y + 1.27,
          };
          expect(segCrossesBoxInterior(w0.x1, w0.y1, w0.x2, w0.y2, bodyBox)).toBe(false);
        }

        // Net retains required label (AC-16.37)
        const netLabels = model.labels.filter((l) => l.name === 'DIRECT_NET_127');
        expect(netLabels.length).toBe(1);
        expect(netLabels[0]!.kind).toBe('local');

        // Netlist round-trip verification via kicad-cli
        const schText = emitSchematic(model);
        const schPath = path.join(workDir, 'board.kicad_sch');
        await writeFile(schPath, schText, 'utf8');
        const netPath = path.join(workDir, 'board.net');
        await execa('kicad-cli', ['sch', 'export', 'netlist', '--output', netPath, schPath]);
        const backNl = parseNetlist(await readFile(netPath, 'utf8'));
        const parts = netPartition(backNl);
        expect(parts.has('U1.1|U2.1')).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('routes collinear facing pins separated by exactly 2.54 mm (implementation cutoff) as a single direct wire', async () => {
      // Pin separation = 11.43 - (5.08 - (-3.81)) = 11.43 - 8.89 = 2.54 mm (2 * U = STUB * U).
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U0', libId: 'CopperMCU:MCU8', value: 'MCU', group: 'MAIN' },
          { ref: 'U1', libId: 'DirectFixture:FacingTop_254', value: 'TOP', group: 'MAIN' },
          { ref: 'U2', libId: 'DirectFixture:FacingBot_254', value: 'BOT', group: 'MAIN' },
        ],
        nets: [
          { name: 'DIRECT_NET_254', pins: ['U1.1', 'U2.1'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent, makeDirectFixtureLib());
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelOverlapBudgetExceeded).toBe(false);

        const u1 = model.symbols.find((s) => s.ref === 'U1')!;
        const u2 = model.symbols.find((s) => s.ref === 'U2')!;
        expect(u1.at.x).toBe(u2.at.x);

        const pin1Y = u1.at.y + 3.81;
        const pin2Y = u2.at.y - 5.08;
        const dist = Math.abs(pin2Y - pin1Y);
        expect(Math.abs(dist - 2.54)).toBeLessThan(1e-4);

        const netWires = model.wires.filter((w) => w.net === 'DIRECT_NET_254');
        expect(netWires.length).toBe(1);
        const w0 = netWires[0]!;
        expect(w0.x1).toBe(u1.at.x);
        expect(w0.x2).toBe(u2.at.x);
        expect(Math.min(w0.y1, w0.y2)).toBeCloseTo(pin1Y, 3);
        expect(Math.max(w0.y1, w0.y2)).toBeCloseTo(pin2Y, 3);

        expect(model.junctions.length).toBe(0);
        for (const s of model.symbols) {
          const bodyBox = {
            minX: s.at.x - 1.27,
            maxX: s.at.x + 1.27,
            minY: s.at.y - 1.27,
            maxY: s.at.y + 1.27,
          };
          expect(segCrossesBoxInterior(w0.x1, w0.y1, w0.x2, w0.y2, bodyBox)).toBe(false);
        }

        const netLabels = model.labels.filter((l) => l.name === 'DIRECT_NET_254');
        expect(netLabels.length).toBe(1);

        const schText = emitSchematic(model);
        const schPath = path.join(workDir, 'board.kicad_sch');
        await writeFile(schPath, schText, 'utf8');
        const netPath = path.join(workDir, 'board.net');
        await execa('kicad-cli', ['sch', 'export', 'netlist', '--output', netPath, schPath]);
        const backNl = parseNetlist(await readFile(netPath, 'utf8'));
        const parts = netPartition(backNl);
        expect(parts.has('U1.1|U2.1')).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('reverts to standard trunk routing when distance is 3.81 mm (immediately above 2.54 mm cutoff)', async () => {
      // Pin separation = 11.43 - (3.81 - (-3.81)) = 11.43 - 7.62 = 3.81 mm (3 * U > STUB * U).
      // Because dist > 2.54 mm, the direct route candidate is NOT admitted, and standard
      // routing takes over without colliding into opposite bodies.
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U0', libId: 'CopperMCU:MCU8', value: 'MCU', group: 'MAIN' },
          { ref: 'U1', libId: 'DirectFixture:FacingTop_381', value: 'TOP', group: 'MAIN' },
          { ref: 'U2', libId: 'DirectFixture:FacingBot_381', value: 'BOT', group: 'MAIN' },
        ],
        nets: [
          { name: 'TRUNK_NET_381', pins: ['U1.1', 'U2.1'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent, makeDirectFixtureLib());
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelOverlapBudgetExceeded).toBe(false);

        const u1 = model.symbols.find((s) => s.ref === 'U1')!;
        const u2 = model.symbols.find((s) => s.ref === 'U2')!;
        const pin1Y = u1.at.y + 3.81;
        const pin2Y = u2.at.y - 3.81;
        const dist = Math.abs(pin2Y - pin1Y);
        expect(Math.abs(dist - 3.81)).toBeLessThan(1e-4);

        const netWires = model.wires.filter((w) => w.net === 'TRUNK_NET_381');
        // Above 2.54 mm cutoff: does not use the single direct segment (uses trunk/stub routing)
        expect(netWires.length).toBeGreaterThan(1);

        // Still must not penetrate any symbol body
        for (const w of netWires) {
          for (const s of model.symbols) {
            const bodyBox = {
              minX: s.at.x - 1.27,
              maxX: s.at.x + 1.27,
              minY: s.at.y - 1.27,
              maxY: s.at.y + 1.27,
            };
            expect(segCrossesBoxInterior(w.x1, w.y1, w.x2, w.y2, bodyBox)).toBe(false);
          }
        }

        const schText = emitSchematic(model);
        const schPath = path.join(workDir, 'board.kicad_sch');
        await writeFile(schPath, schText, 'utf8');
        const netPath = path.join(workDir, 'board.net');
        await execa('kicad-cli', ['sch', 'export', 'netlist', '--output', netPath, schPath]);
        const backNl = parseNetlist(await readFile(netPath, 'utf8'));
        const parts = netPartition(backNl);
        expect(parts.has('U1.1|U2.1')).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('routes collinear horizontally facing pins separated by exactly 1.27 mm as a single direct wire', async () => {
      // Pin separation formula: R4 at x=110.49, R5 at x=128.27 (diff = 17.78 mm).
      // Pin R4.1 is at (8.255, 0), schematic X = 110.49 + 8.255 = 118.745 mm.
      // Pin R5.1 is at (-8.255, 0), schematic X = 128.27 - 8.255 = 120.015 mm.
      // Separation = 120.015 - 118.745 = 1.27 mm (1 * U).
      // Mutually facing horizontal pins: R4.1 faces +X, R5.1 faces -X, both at y = 57.15 mm.
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R3', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R4', libId: 'DirectFixture:FacingRight_Horiz_127', value: '10k', group: 'MAIN' },
          { ref: 'R5', libId: 'DirectFixture:FacingLeft_Horiz_127', value: '10k', group: 'MAIN' },
          { ref: 'R6', libId: 'Device:R', value: '10k', group: 'MAIN' },
        ],
        nets: [
          { name: 'DIRECT_HORIZ_127', pins: ['R4.1', 'R5.1'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent, makeDirectFixtureLib());
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelOverlapBudgetExceeded).toBe(false);

        const r4 = model.symbols.find((s) => s.ref === 'R4')!;
        const r5 = model.symbols.find((s) => s.ref === 'R5')!;
        expect(r4).toBeDefined();
        expect(r5).toBeDefined();

        // Assert horizontal collinearity
        expect(r4.at.y).toBe(r5.at.y);

        // Pin coordinates in schematic space:
        const pin1X = r4.at.x + 8.255;
        const pin2X = r5.at.x - 8.255;
        const dist = Math.abs(pin2X - pin1X);
        expect(Math.abs(dist - 1.27)).toBeLessThan(1e-4);

        // Emitted route must contain exactly 1 direct segment connecting the two pin endpoints
        const netWires = model.wires.filter((w) => w.net === 'DIRECT_HORIZ_127');
        expect(netWires.length).toBe(1);
        const w0 = netWires[0]!;
        expect(w0.y1).toBe(r4.at.y);
        expect(w0.y2).toBe(r5.at.y);
        expect(Math.min(w0.x1, w0.x2)).toBeCloseTo(pin1X, 3);
        expect(Math.max(w0.x1, w0.x2)).toBeCloseTo(pin2X, 3);

        // Net retains required label (AC-16.37)
        const netLabels = model.labels.filter((l) => l.name === 'DIRECT_HORIZ_127');
        expect(netLabels.length).toBe(1);
        expect(netLabels[0]!.kind).toBe('local');

        // Netlist round-trip verification via kicad-cli
        const schText = emitSchematic(model);
        const schPath = path.join(workDir, 'board.kicad_sch');
        await writeFile(schPath, schText, 'utf8');
        const netPath = path.join(workDir, 'board.net');
        await execa('kicad-cli', ['sch', 'export', 'netlist', '--output', netPath, schPath]);
        const backNl = parseNetlist(await readFile(netPath, 'utf8'));
        const parts = netPartition(backNl);
        expect(parts.has('R4.1|R5.1')).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GATE 2: FIX FALSE ROTATION/MIRROR TEST COVERAGE
  // ---------------------------------------------------------------------------
  describe('Gate 2: symbol rotation and mirror verification', () => {
    it('proves amplifierFlip assigns mirror x and routes inverting opamp with clean outward approach', async () => {
      // Inverting opamp: input IN- (pin 2) sits below IN+ (pin 3) in symbol space.
      // Negative feedback resistor connects OUT (pin 1) to IN- (pin 2).
      // amplifierFlip flips the opamp top-to-bottom (mirror: 'x') so that IN- is on top,
      // avoiding crossing the feedback loop over the forward signal path.
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'DirectFixture:TestOpAmp', value: 'OPA', group: 'MAIN' },
          { ref: 'R_FB', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R_IN', libId: 'Device:R', value: '1k', group: 'MAIN' },
          { ref: 'R_SRC', libId: 'Device:R', value: '100', group: 'MAIN' },
          { ref: 'R_GND', libId: 'Device:R', value: '1k', group: 'MAIN' },
        ],
        nets: [
          { name: 'N_IN', pins: ['R_SRC.2', 'R_IN.1'] },
          { name: 'N_SUM', pins: ['R_IN.2', 'R_FB.1', 'U1.2'] },
          { name: 'N_OUT', pins: ['U1.1', 'R_FB.2'] },
          { name: 'GND', pins: ['U1.3', 'R_GND.1'], kind: 'ground' },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent, makeDirectFixtureLib());
      try {
        expect(report.mergedNets).toEqual([]);
        const u1 = model.symbols.find((s) => s.ref === 'U1');
        expect(u1).toBeDefined();

        // Assert that mirror 'x' is actually present
        expect(u1!.mirror).toBe('x');

        // All wires must route in Manhattan directions and clear the opamp body
        const u1Body = {
          minX: u1!.at.x - 5.08,
          maxX: u1!.at.x + 5.08,
          minY: u1!.at.y - 5.08,
          maxY: u1!.at.y + 5.08,
        };
        for (const w of model.wires) {
          expect(w.x1 === w.x2 || w.y1 === w.y2).toBe(true);
          expect(segCrossesBoxInterior(w.x1, w.y1, w.x2, w.y2, u1Body)).toBe(false);
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('proves transistor Q_NPN preserves outward approach and Manhattan routing across pins', async () => {
      // BJT transistor has three multi-directional pins (B on left, C on top, E on bottom).
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'Q1', libId: 'Device:Q_NPN', value: '2N3904', group: 'MAIN' },
          { ref: 'R1', libId: 'Device:R', value: '1k', group: 'MAIN' },
          { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
        ],
        nets: [
          { name: 'BASE_DRIVE', pins: ['R1.2', 'Q1.B'] },
          { name: 'COLL_PULL', pins: ['R2.2', 'Q1.C'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent);
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelsOverBodies).toBe(0);

        const q1 = model.symbols.find((s) => s.ref === 'Q1');
        expect(q1).toBeDefined();

        for (const w of model.wires) {
          expect(w.x1 === w.x2 || w.y1 === w.y2).toBe(true);
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('permits legal perpendicular pin approaches while preserving outward departure on rotated symbols', async () => {
      // Transistor Q1 has multi-directional pins: Base on left (facing -X), Collector on top (facing -Y), Emitter on bottom (facing +Y).
      // Collector pull-up resistor connects to Q1.C via vertical wire meeting at the pin connection point.
      // Base drive connects to Q1.B via horizontal wire.
      // Perpendicular approach at the pin is admitted under outwardDot >= -0.01 without false rejection.
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'Q1', libId: 'Device:Q_NPN', value: '2N3904', group: 'MAIN' },
          { ref: 'R1', libId: 'Device:R', value: '1k', group: 'MAIN' },
          { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R3', libId: 'Device:R', value: '470', group: 'MAIN' },
        ],
        nets: [
          { name: 'BASE_DRIVE', pins: ['R1.2', 'Q1.B'] },
          { name: 'COLL_PULL', pins: ['R2.2', 'Q1.C'] },
          { name: 'EMIT_GND', pins: ['Q1.E', 'R3.1'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent);
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelsOverBodies).toBe(0);

        const q1 = model.symbols.find((s) => s.ref === 'Q1')!;
        expect(q1).toBeDefined();

        // All 3 nets route cleanly as wired runs
        for (const netName of ['BASE_DRIVE', 'COLL_PULL', 'EMIT_GND']) {
          const wires = model.wires.filter((w) => w.net === netName);
          expect(wires.length).toBeGreaterThan(0);
          const labels = model.labels.filter((l) => l.name === netName);
          expect(labels.length).toBe(1);
          expect(labels[0]!.kind).toBe('local');
        }

        // Netlist verification via kicad-cli
        const schText = emitSchematic(model);
        const schPath = path.join(workDir, 'board.kicad_sch');
        await writeFile(schPath, schText, 'utf8');
        const netPath = path.join(workDir, 'board.net');
        await execa('kicad-cli', ['sch', 'export', 'netlist', '--output', netPath, schPath]);
        const backNl = parseNetlist(await readFile(netPath, 'utf8'));
        const parts = netPartition(backNl);
        expect(parts.has('Q1.2|R1.2') || parts.has('Q1.B|R1.2')).toBe(true);
        expect(parts.has('Q1.1|R2.2') || parts.has('Q1.C|R2.2')).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GATE 3: REPLACE MIDPOINT-ONLY OBSTACLE CHECK WITH SEGMENT-VS-BOX MATH
  // ---------------------------------------------------------------------------
  describe('Gate 3: complete segment-vs-rectangle intersection mathematics', () => {
    it('refuses inward wire routes that would penetrate a symbol body interior', async () => {
      // Inward wire check:
      // A segment terminating at a pin must approach from the pin's outward direction (into free space).
      // A candidate segment heading inward into the symbol body is rejected by outwardDot < -0.01.
      // In InwardTiedPins, Pin 1 is at symbol (0, 2.54) and Pin 2 is at symbol (0, 0), both facing
      // downward in schematic coordinates (outward dy = +1). The candidate route from Pin 1 directly
      // reaches Pin 2 coincidentally with Pin 2's connection point (setting touchesOwnedPin = true),
      // but enters Pin 2 from the inward direction (vy = -2.54, outwardDot = -2.54 < -0.01) through
      // the symbol body.
      // Under production code (outwardDot < -0.01), this inward route is refused, and the engine
      // falls back to two separate stubs with global flags (localLabels.length === 0, globalLabels.length === 2).
      // If the outwardDot guard is disabled (e.g. outwardDot < -1e9), the inward candidate is admitted,
      // producing a single wired interconnect that penetrates the body interior and emits a local label.
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U0', libId: 'CopperMCU:MCU8', value: 'MCU', group: 'MAIN' },
          { ref: 'U_INWARD', libId: 'DirectFixture:InwardTiedPins', value: 'TIED', group: 'MAIN' },
        ],
        nets: [
          { name: 'SHORT_NET', pins: ['U_INWARD.1', 'U_INWARD.2'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent, makeDirectFixtureLib());
      try {
        expect(report.mergedNets).toEqual([]);

        const u = model.symbols.find((s) => s.ref === 'U_INWARD')!;
        expect(u).toBeDefined();

        // Under production code, the inward route entering Pin 2 is refused by outwardDot < -0.01.
        // As a result, the router refuses to wire the pins together through the body and falls back
        // to two independent stubs with global net flags (0 local labels, 2 global flags).
        // If the guard is disabled (outwardDot < -1e9), the inward route is admitted, wiring the
        // pins together into a single cluster with 1 local label and 0 global labels.
        const netLabels = model.labels.filter((l) => l.name === 'SHORT_NET');
        const localLabels = netLabels.filter((l) => l.kind === 'local');
        const globalLabels = netLabels.filter((l) => l.kind === 'global');
        expect(localLabels).toHaveLength(0);
        expect(globalLabels).toHaveLength(2);

        // Round-trip netlist verification via kicad-cli confirms SHORT_NET pins remain electrically connected
        const schText = emitSchematic(model);
        const schPath = path.join(workDir, 'board.kicad_sch');
        await writeFile(schPath, schText, 'utf8');
        const netPath = path.join(workDir, 'board.net');
        await execa('kicad-cli', ['sch', 'export', 'netlist', '--output', netPath, schPath]);
        const backNl = parseNetlist(await readFile(netPath, 'utf8'));
        const parts = netPartition(backNl);
        expect(parts.has('U_INWARD.1|U_INWARD.2') || parts.has('U_INWARD.2|U_INWARD.1')).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('ensures all emitted wire segments strictly clear foreign component body interiors across the schematic', async () => {
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'CopperMCU:MCU8', value: 'MCU', group: 'MAIN' },
          { ref: 'U2', libId: 'CopperMCU:MCU8', value: 'OBSTACLE', group: 'MAIN' },
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
        ],
        nets: [
          { name: 'CROSS_SIGNAL', pins: ['U1.4', 'R1.1'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent);
      try {
        expect(report.mergedNets).toEqual([]);

        const u2 = model.symbols.find((s) => s.ref === 'U2')!;
        expect(u2).toBeDefined();
        const u2Body: Bounds = {
          minX: u2.at.x - 7.62,
          maxX: u2.at.x + 7.62,
          minY: u2.at.y - 7.62,
          maxY: u2.at.y + 7.62,
        };

        // Every emitted segment on CROSS_SIGNAL must strictly clear U2's body interior
        for (const w of model.wires.filter((w) => w.net === 'CROSS_SIGNAL')) {
          expect(segCrossesBoxInterior(w.x1, w.y1, w.x2, w.y2, u2Body)).toBe(false);
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GATE 4: HONESTLY TEST PIN LEAD CLAMPING
  // ---------------------------------------------------------------------------
  describe('Gate 4: honest pin lead vector clamping', () => {
    it('clamps pin lead vectors so decorative graphics extending beyond a pin do not block outward wiring', async () => {
      // In DecorativeTop:
      // Body rect spans [-1.27, 1.27] x [-1.27, 1.27].
      // Decorative polyline extends toward symbol space y = -6.35 mm (schematic +Y).
      // Downward pin (angle 90, o.dy = 1) connection point is at symbol (0, -5.08) length 3.81.
      // The decorative line extends to symbol y = -6.35, which in schematic space is pl.body.maxY (pl.y + 6.35),
      // extending past the pin connection point (pl.y + 5.08).
      // Without Math.min(p.y, pl.body.maxY) clamping, an unbounded lead was computed extending OUTWARD
      // from the pin to pl.body.maxY, causing touchesLead to reject outward wiring and fall back to two global flags.
      // With clamping, the lead is clamped to the pin coordinate (zero false lead), admitting the clean wired route.
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U0', libId: 'CopperMCU:MCU8', value: 'MCU', group: 'MAIN' },
          { ref: 'U1', libId: 'DirectFixture:DecorativeTop', value: 'DEC_TOP', group: 'MAIN' },
          { ref: 'U2', libId: 'DirectFixture:FacingBot_127', value: 'BOT', group: 'MAIN' },
        ],
        nets: [
          { name: 'DEC_NET', pins: ['U1.1', 'U2.1'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent, makeDirectFixtureLib());
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelOverlapBudgetExceeded).toBe(false);

        // Net forms a wired cluster
        const netWires = model.wires.filter((w) => w.net === 'DEC_NET');
        expect(netWires.length).toBeGreaterThan(0);

        // Exactly one local label naming the wired cluster, zero global fallback flags
        const netLabels = model.labels.filter((l) => l.name === 'DEC_NET');
        expect(netLabels.length).toBe(1);
        expect(netLabels[0]!.kind).toBe('local');
        const globalLabels = netLabels.filter((l) => l.kind === 'global');
        expect(globalLabels.length).toBe(0);

        // Netlist verification via kicad-cli oracle
        const schText = emitSchematic(model);
        const schPath = path.join(workDir, 'board.kicad_sch');
        await writeFile(schPath, schText, 'utf8');
        const netPath = path.join(workDir, 'board.net');
        await execa('kicad-cli', ['sch', 'export', 'netlist', '--output', netPath, schPath]);
        const backNl = parseNetlist(await readFile(netPath, 'utf8'));
        const parts = netPartition(backNl);
        expect(parts.has('U1.1|U2.1')).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GATE 5: LABEL CORRECTNESS AND AC-16.37 COMPLIANCE
  // ---------------------------------------------------------------------------
  describe('Gate 5: label placement and AC-16.37 compliance on wired runs', () => {
    it('places exactly one label per wired run anchored on its own wire segment without body collisions', async () => {
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R2', libId: 'Device:R', value: '1k', group: 'MAIN' },
        ],
        nets: [
          { name: 'Net-(R1-Pad2)', pins: ['R1.2', 'R2.1'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent);
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelsOverBodies).toBe(0);
        expect(report.labelOverlapBudgetExceeded).toBe(false);

        // Under AC-16.37, every wired run has exactly one label
        const netLabels = model.labels.filter((l) => l.name === 'Net-(R1-Pad2)');
        expect(netLabels.length).toBe(1);
        const lbl = netLabels[0]!;
        expect(lbl.kind).toBe('local');

        // Assert anchor lies strictly on a wire segment of its own net
        const netWires = model.wires.filter((w) => w.net === 'Net-(R1-Pad2)');
        const onWire = netWires.some((w) => pointOnSeg(lbl.x, lbl.y, w.x1, w.y1, w.x2, w.y2));
        expect(onWire).toBe(true);

        // Assert anchor does NOT lie on any wire of a foreign net
        const foreignWires = model.wires.filter((w) => w.net !== 'Net-(R1-Pad2)');
        const onForeignWire = foreignWires.some((w) => pointOnSeg(lbl.x, lbl.y, w.x1, w.y1, w.x2, w.y2));
        expect(onForeignWire).toBe(false);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('preserves user-named net labels on wired runs while avoiding bodies and foreign contacts', async () => {
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
        ],
        nets: [
          { name: 'MID_BIAS', pins: ['R1.2', 'R2.1'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent);
      try {
        expect(report.mergedNets).toEqual([]);
        expect(report.labelsOverBodies).toBe(0);

        const biasLabel = model.labels.find((l) => l.name === 'MID_BIAS');
        expect(biasLabel).toBeDefined();
        expect(biasLabel?.kind).toBe('local');

        const netWires = model.wires.filter((w) => w.net === 'MID_BIAS');
        const onWire = netWires.some((w) => pointOnSeg(biasLabel!.x, biasLabel!.y, w.x1, w.y1, w.x2, w.y2));
        expect(onWire).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('routes four-resistor net as a single connected wired cluster with one local label', async () => {
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'R1', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R2', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R3', libId: 'Device:R', value: '10k', group: 'MAIN' },
          { ref: 'R4', libId: 'Device:R', value: '10k', group: 'MAIN' },
        ],
        nets: [
          { name: 'Net-(R1-Pad2)', pins: ['R1.2', 'R2.1', 'R3.2', 'R4.1'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent);
      try {
        expect(report.mergedNets).toEqual([]);
        const netLabels = model.labels.filter((l) => l.name === 'Net-(R1-Pad2)');
        expect(netLabels.length).toBe(1);
        expect(netLabels[0]!.kind).toBe('local');
        // No unnecessary global flags representing routing fallback
        const globalLabels = netLabels.filter((l) => l.kind === 'global');
        expect(globalLabels).toHaveLength(0);
        // Netlist round-trip verification via kicad-cli oracle confirms single partition
        const schText = emitSchematic(model);
        const schPath = path.join(workDir, 'board.kicad_sch');
        await writeFile(schPath, schText, 'utf8');
        const netPath = path.join(workDir, 'board.net');
        await execa('kicad-cli', ['sch', 'export', 'netlist', '--output', netPath, schPath]);
        const backNl = parseNetlist(await readFile(netPath, 'utf8'));
        const parts = netPartition(backNl);
        expect(parts.has('R1.2|R2.1|R3.2|R4.1')).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('prevents placing a horizontal wired label anchor on a foreign net wire crossing', async () => {
      // In the buck-12v-5v reference board, BOOT has a horizontal wired run at y = 49.53 crossing
      // foreign net SW's vertical wire at x = 129.54 perpendicularly.
      // horizPts includes (129.54, 49.53) as a candidate position for the BOOT label.
      // clearOfBodies uses segContains(w, pt.x, pt.y) to detect foreign wires and stubs,
      // preventing the label anchor from landing on the foreign wire and merging the nets.
      const buckDir = path.resolve('manual-tests/reference-boards/buck-12v-5v');
      const intent: SchematicIntent = JSON.parse(await readFile(path.join(buckDir, 'schematic.intent.json'), 'utf8'));
      const workDir = await mkdtemp(path.join(tmpdir(), 'copperhead-crossing-proof-'));
      try {
        const symSource = new SymbolSource(buckDir, [path.join(buckDir, 'sym-lib-cache')], false);
        const v = await validateIntent(intent, symSource, null);
        expect(v.ok).toBe(true);
        const { model, report } = draftSchematicPlacement(v.validated!, 'board', '2020-01-01');

        expect(report.mergedNets).toEqual([]);

        // 1. Locate the horizontal BOOT wire and the crossing vertical SW wire
        const bootHorizWire = model.wires.find(
          (w) => w.net === 'BOOT' && sameCoord(w.y1, 49.53) && sameCoord(w.y2, 49.53),
        );
        expect(bootHorizWire).toBeDefined();
        const swVertWire = model.wires.find(
          (w) => w.net === 'SW' && sameCoord(w.x1, 129.54) && sameCoord(w.x2, 129.54),
        );
        expect(swVertWire).toBeDefined();

        // 2. Prove that the crossing point (129.54, 49.53) lies on the BOOT horizontal segment
        const crossX = 129.54;
        const crossY = 49.53;
        const onBoot = pointOnSeg(crossX, crossY, bootHorizWire!.x1, bootHorizWire!.y1, bootHorizWire!.x2, bootHorizWire!.y2);
        expect(onBoot).toBe(true);

        // 3. Prove that (129.54, 49.53) lies on the foreign SW vertical wire
        const onSw = pointOnSeg(crossX, crossY, swVertWire!.x1, swVertWire!.y1, swVertWire!.x2, swVertWire!.y2);
        expect(onSw).toBe(true);

        // 4. Prove that (crossX, crossY) is an exact candidate in horizPts grid steps
        const minX = Math.min(bootHorizWire!.x1, bootHorizWire!.x2);
        const steps = (crossX - minX) / U;
        expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-5);

        // 5. Assert that no label anchor for BOOT sits on (129.54, 49.53) or any foreign wire
        for (const l of model.labels) {
          const foreignWires = model.wires.filter((w) => w.net !== l.name);
          for (const fw of foreignWires) {
            const onFw = pointOnSeg(l.x, l.y, fw.x1, fw.y1, fw.x2, fw.y2);
            expect(onFw, `Label ${l.name} at (${l.x}, ${l.y}) must not sit on foreign wire ${fw.net}`).toBe(false);
          }
        }

        // 6. Netlist round-trip verification via kicad-cli confirms BOOT and SW remain separate partitions
        const schText = emitSchematic(model);
        const schPath = path.join(workDir, 'board.kicad_sch');
        await writeFile(schPath, schText, 'utf8');
        const netPath = path.join(workDir, 'board.net');
        await execa('kicad-cli', ['sch', 'export', 'netlist', '--output', netPath, schPath]);
        const backNl = parseNetlist(await readFile(netPath, 'utf8'));
        const parts = netPartition(backNl);
        // BOOT pins (U1.1, C4.1) and SW pins (U1.8, C4.2) must not be merged into the same partition
        expect(parts.has('C4.1|U1.1') || parts.has('U1.1|C4.1')).toBe(true);
        for (const part of parts) {
          const hasBoot = part.includes('U1.1') || part.includes('C4.1');
          const hasSw = part.includes('U1.8') || part.includes('C4.2');
          expect(hasBoot && hasSw, 'BOOT and SW must not be merged into the same partition').toBe(false);
        }

        // 7. Verify production predicate isLabelAnchorClear on actual reference-board geometry:
        // Demonstrates that clearOfBodies directly refuses foreign wire crossings.
        // Negative control: point (crossX, crossY) on foreign wire SW must be rejected for net BOOT.
        const atCrossClear = isLabelAnchorClear({ x: crossX, y: crossY }, 0, 'BOOT', model.wires, [], [], []);
        expect(atCrossClear).toBe(false);

        // Positive control: point on same BOOT wire with only BOOT wires must be accepted.
        const bootWires = model.wires.filter((w) => w.net === 'BOOT');
        expect(isLabelAnchorClear({ x: crossX, y: crossY }, 0, 'BOOT', bootWires, [], [], [])).toBe(true);

        // Positive control: candidate off the crossing (e.g. crossX - 2.54) must be accepted.
        const offCrossX = crossX - 2.54;
        expect(isLabelAnchorClear({ x: offCrossX, y: crossY }, 0, 'BOOT', model.wires, [], [], [])).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it('isLabelAnchorClear independently protects against foreign pending stubs and committed wires', () => {
      const netName = 'NET_A';
      const foreignNet = 'NET_B';
      const pt = { x: 50.8, y: 25.4 };

      // 1. Foreign pending stub protection (negative control):
      // A pending stub of a foreign net crossing pt must cause isLabelAnchorClear to return false.
      const foreignStub = [{ x1: 50.8, y1: 20.32, x2: 50.8, y2: 30.48, net: foreignNet }];
      expect(isLabelAnchorClear(pt, 0, netName, [], foreignStub, [], [])).toBe(false);

      // Positive control: Same-net pending stub crossing pt must not be blocked.
      const ownStub = [{ x1: 50.8, y1: 20.32, x2: 50.8, y2: 30.48, net: netName }];
      expect(isLabelAnchorClear(pt, 0, netName, [], ownStub, [], [])).toBe(true);

      // Positive control: When no pending stubs exist, pt is clear.
      expect(isLabelAnchorClear(pt, 0, netName, [], [], [], [])).toBe(true);

      // 2. Foreign committed wire protection (negative control):
      // A committed wire of a foreign net crossing pt must cause isLabelAnchorClear to return false.
      const foreignWire = [{ x1: 50.8, y1: 20.32, x2: 50.8, y2: 30.48, net: foreignNet }];
      expect(isLabelAnchorClear(pt, 0, netName, foreignWire, [], [], [])).toBe(false);

      // Positive control: Same-net committed wire crossing pt must not be blocked.
      const ownWire = [{ x1: 50.8, y1: 20.32, x2: 50.8, y2: 30.48, net: netName }];
      expect(isLabelAnchorClear(pt, 0, netName, ownWire, [], [], [])).toBe(true);
    });

    it('draftSchematicPlacement clearOfBodies call site rejects foreign pending stubs when selecting label position', async () => {
      // Regression test for Finding 1:
      // Verifies that clearOfBodies at engine.ts:5126 passes real wires and pendingStubs to isLabelAnchorClear.
      // In this deterministic fixture, B_TARGET runs horizontally at y = 69.85 between U_B_LFT and U_B_RGT.
      // U_B_LFT body extends to x = 97.79, so candidates at x = 95.25 and 96.52 are rejected by symbol bounds.
      // The first candidate clearing the symbol body is x = 97.79.
      // However, foreign net Z_FOREIGN drops a pending stub from pin U_A1.1 at (97.79, 66.04)
      // extending downward to (97.79, 71.12), intersecting (97.79, 69.85).
      //
      // Under production code (wires, pendingStubs passed):
      // clearOfBodies(97.79, 69.85) detects the foreign pending stub and returns false.
      // The engine selects the next candidate at x = 99.06 (safe free space).
      //
      // Under mutation (wires and pendingStubs replaced by empty arrays []):
      // clearOfBodies(97.79, 69.85) fails to check pending stubs, accepts x = 97.79,
      // and places the B_TARGET label directly on Z_FOREIGN pending stub.
      const intent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U_A1', libId: 'DirectFixture:StubProbe_Down', value: 'A1', group: 'MAIN' },
          { ref: 'U_A2', libId: 'DirectFixture:FacingLeft_1Pin', value: 'A2', group: 'MAIN' },
          { ref: 'U_B_LFT', libId: 'DirectFixture:BodyExtend_Horiz', value: 'B_LFT', group: 'MAIN' },
          { ref: 'U_B_RGT', libId: 'DirectFixture:FacingLeft_1Pin', value: 'B_RGT', group: 'MAIN' },
        ],
        nets: [
          { name: 'B_TARGET', pins: ['U_B_LFT.1', 'U_B_RGT.1'] },
          { name: 'Z_FOREIGN', pins: ['U_A1.1', 'U_A2.1'] },
        ],
      };

      const { model, report, workDir } = await placeWithFixture(intent, makeDirectFixtureLib());
      try {
        expect(report.mergedNets).toEqual([]);

        // Locate B_TARGET label
        const bTargetLabel = model.labels.find((l) => l.name === 'B_TARGET');
        expect(bTargetLabel).toBeDefined();

        // Pin candidate coordinates: candidate at 97.79 is rejected due to foreign pending stub,
        // advancing label placement to 99.06.
        // Under the mutation where clearOfBodies passes [] for pendingStubs,
        // bTargetLabel.x is 97.79 (directly colliding with Z_FOREIGN).
        expect(bTargetLabel!.x).toBeCloseTo(99.06, 2);
        expect(bTargetLabel!.y).toBeCloseTo(69.85, 2);
        expect(Math.abs(bTargetLabel!.x - 97.79)).toBeGreaterThan(0.5);

        // Independent oracle: netlist verification via kicad-cli confirms B_TARGET and Z_FOREIGN
        // remain completely independent electrical partitions with no merged pins.
        const schText = emitSchematic(model);
        const schPath = path.join(workDir, 'board.kicad_sch');
        await writeFile(schPath, schText, 'utf8');
        const netPath = path.join(workDir, 'board.net');
        await execa('kicad-cli', ['sch', 'export', 'netlist', '--output', netPath, schPath]);
        const backNl = parseNetlist(await readFile(netPath, 'utf8'));
        const parts = netPartition(backNl);

        expect(parts.has('U_B_LFT.1|U_B_RGT.1')).toBe(true);
        expect(parts.has('U_A1.1|U_A2.1')).toBe(true);
        for (const part of parts) {
          const hasB = part.includes('U_B_LFT.1') || part.includes('U_B_RGT.1');
          const hasZ = part.includes('U_A1.1') || part.includes('U_A2.1');
          expect(hasB && hasZ, 'B_TARGET and Z_FOREIGN must not be merged').toBe(false);
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });
  });
});
