import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { scoreSchematic } from '../src/kicad/score.js';

/** Hand-computed metric values against constructed geometry (task 8.4). */

function sch(body: string): string {
  return `(kicad_sch (version 20231120) (uuid "5c0e0000-0000-4000-8000-000000000001") (paper "A4")
  (title_block (title "t") (date "d") (rev "r"))
  (lib_symbols)
  ${body}
  (sheet_instances (path "/" (page "1")))
)`;
}

async function scored(body: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-score-'));
  const file = path.join(dir, 'x.kicad_sch');
  await writeFile(file, sch(body), 'utf8');
  const report = await scoreSchematic(file);
  await rm(dir, { recursive: true, force: true });
  return report;
}

const metric = (r: Awaited<ReturnType<typeof scored>>, name: string) => r.metrics.find((m) => m.name === name)!;

describe('scorer metrics: hand-computed values', () => {
  it('counts one proper crossing and zero for a shared-endpoint join', async () => {
    const crossing = await scored(`
      (wire (pts (xy 50 100) (xy 100 100)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w001"))
      (wire (pts (xy 75 80) (xy 75 120)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w002"))`);
    expect(metric(crossing, 'wire-crossings').raw).toBe(1);
    expect(metric(crossing, 'wire-crossings').score).toBe(0.5); // 1/(1+1)

    const joined = await scored(`
      (wire (pts (xy 50 100) (xy 75 100)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w001"))
      (wire (pts (xy 75 100) (xy 75 120)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w002"))`);
    expect(metric(joined, 'wire-crossings').raw).toBe(0);
  });

  it('counts a bend where two segments of different orientation meet', async () => {
    const r = await scored(`
      (wire (pts (xy 50 100) (xy 75 100)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w001"))
      (wire (pts (xy 75 100) (xy 75 120)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w002"))`);
    expect(metric(r, 'wire-bends').raw).toBe(1);
    expect(metric(r, 'wire-length').raw).toBeCloseTo(45, 5); // 25 + 20
    expect(metric(r, 'straight-wire-ratio').raw).toBe(0.5); // 1 bend / 2 segments
  });

  it('measures label alignment as the horizontal fraction', async () => {
    const r = await scored(`
      (label "A" (at 50 100 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l001"))
      (label "B" (at 60 100 90) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l002"))`);
    expect(metric(r, 'label-alignment').raw).toBe(0.5);
  });

  it('group cohesion degrades with same-net label separation', async () => {
    const near = await scored(`
      (label "N" (at 50 100 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l001"))
      (label "N" (at 60 100 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l002"))`);
    const far = await scored(`
      (label "N" (at 20 20 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l001"))
      (label "N" (at 280 190 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l002"))`);
    expect(metric(near, 'group-cohesion').raw).toBeCloseTo(10, 5);
    expect(metric(far, 'group-cohesion').score).toBeLessThan(metric(near, 'group-cohesion').score);
  });

  it('the composite is the weighted contribution sum, reproducibly (AC-16.14)', async () => {
    // grid-true coordinates: an off-grid error would cap the composite and
    // decouple it from the contribution sum
    const body = `
      (label "A" (at 50.8 101.6 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l001"))
      (label "A" (at 60.96 101.6 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l002"))`;
    const a = await scored(body);
    const b = await scored(body);
    expect(a.cap).toBeNull();
    expect(a.composite).toBe(b.composite);
    expect(a.composite).toBeCloseTo(
      a.metrics.reduce((s, m) => s + m.contribution, 0),
      2,
    );
    expect(a.metrics.map((m) => m.name).sort()).toEqual(b.metrics.map((m) => m.name).sort());
  });

  it('reads wrapped group rows in reading order, not left-to-right across rows', async () => {
    // four groups on two rows; the net joins the two groups of the SECOND row,
    // which are adjacent in reading order. Ordering every box by minX alone
    // interleaves the rows (A, C, B, D) and reports that adjacency as a
    // two-group hop against the flow.
    const box = (x: number, y: number) =>
      `(rectangle (start ${x} ${y}) (end ${x + 60} ${y + 30}) (stroke (width 0) (type solid)) (fill (type none)) (uuid "5c0e0000-0000-4000-8000-0000000r${x}${y}"))`;
    const r = await scored(`
      ${box(20, 20)} ${box(90, 20)} ${box(25, 60)} ${box(95, 60)}
      (label "X" (at 50 70 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l001"))
      (label "X" (at 120 70 0) (effects (font (size 1.27 1.27))) (uuid "5c0e0000-0000-4000-8000-00000000l002"))`);
    expect(metric(r, 'flow-direction').raw).toBe(0);
    expect(metric(r, 'flow-direction').score).toBe(1);
  });

  it('does not read a column across a row break', async () => {
    // three evenly spaced symbols in the first row's group, one more at the
    // same x a row below. The lone symbol belongs to the row below, not to the
    // column above: counting it as a fourth entry turns the row gap into a
    // wild "spacing" outlier.
    const sym = (ref: string, x: number, y: number) =>
      `(symbol (lib_id "Device:R") (at ${x} ${y} 0) (unit 1) (uuid "5c0e0000-0000-4000-8000-0000000s${ref}")
         (property "Reference" "${ref}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27))))
         (property "Value" "10k" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)))))`;
    const rects = `
      (rectangle (start 20 20) (end 80 50) (stroke (width 0) (type solid)) (fill (type none)) (uuid "5c0e0000-0000-4000-8000-00000000rc01"))
      (rectangle (start 20 60) (end 80 90) (stroke (width 0) (type solid)) (fill (type none)) (uuid "5c0e0000-0000-4000-8000-00000000rc02"))`;
    const r = await scored(`${rects}
      ${sym('R1', 50, 25)} ${sym('R2', 50, 35)} ${sym('R3', 50, 45)} ${sym('R4', 50, 75)}`);
    // the first row's three symbols are perfectly even, and the fourth is in
    // its own row's column of one (too short to score)
    expect(metric(r, 'spacing-uniformity').raw).toBe(1);
  });

  it('weights are configurable and zeroing one removes its contribution', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-scorew-'));
    const file = path.join(dir, 'x.kicad_sch');
    await writeFile(
      file,
      sch(`(wire (pts (xy 50 100) (xy 100 100)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w001"))
      (wire (pts (xy 75 80) (xy 75 120)) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w002"))`),
      'utf8',
    );
    const tuned = await scoreSchematic(file, { config: { score: { weights: { 'wire-crossings': 0 } } } });
    await rm(dir, { recursive: true, force: true });
    expect(tuned.metrics.find((m) => m.name === 'wire-crossings')!.contribution).toBe(0);
  });
});
describe('score config sanitization', () => {
  // A configured floor of 0 (or a non-number) used to flow raw into the error
  // cap min(ERROR_CAP, floor - 1), reporting a -1/100 or NaN/100 composite.
  const offGrid = `
      (label "X" (at 50.1 100 0)
        (effects (font (size 1.27 1.27)))
        (uuid "5c0e0000-0000-4000-8000-00000000l001")
      )`;

  it('a floor of 0 falls back to the default instead of going negative', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-floor-'));
    try {
      const file = path.join(dir, 'x.kicad_sch');
      await writeFile(file, sch(offGrid), 'utf8');
      const report = await scoreSchematic(file, { config: { score: { floor: 0 } } });
      expect(report.composite).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(report.composite)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a non-numeric floor falls back to the default instead of NaN', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-floor-nan-'));
    try {
      const file = path.join(dir, 'x.kicad_sch');
      await writeFile(file, sch(offGrid), 'utf8');
      const report = await scoreSchematic(file, { config: { score: { floor: 'high' as unknown as number } } });
      expect(Number.isFinite(report.composite)).toBe(true);
      expect(report.composite).toBeGreaterThanOrEqual(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A sheet with real pins: one 3-pin IC and two-pin parts, so the wiring-style
 * metrics have something to follow. Pins are declared in lib_symbols the way
 * KiCad writes them; placed symbols are unrotated so a pin's sheet position is
 * the symbol origin plus its symbol-space offset (y flipped). */
function pinnedSch(body: string): string {
  return `(kicad_sch (version 20231120) (uuid "5c0e0000-0000-4000-8000-000000000002") (paper "A4")
  (title_block (title "t") (date "d") (rev "r"))
  (lib_symbols
    (symbol "T:IC3" (pin_names (offset 1.016)) (in_bom yes) (on_board yes)
      (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (property "Value" "IC3" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (symbol "IC3_1_1"
        (rectangle (start -5.08 5.08) (end 5.08 -5.08) (stroke (width 0.254) (type default)) (fill (type background)))
        (pin input line (at -7.62 2.54 0) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin input line (at -7.62 -2.54 0) (length 2.54) (name "B" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))
        (pin output line (at 7.62 0 180) (length 2.54) (name "Y" (effects (font (size 1.27 1.27)))) (number "3" (effects (font (size 1.27 1.27)))))))
    (symbol "T:R2" (pin_names (offset 0)) (in_bom yes) (on_board yes)
      (property "Reference" "R" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (property "Value" "R2" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (symbol "R2_1_1"
        (rectangle (start -1.016 2.54) (end 1.016 -2.54) (stroke (width 0.254) (type default)) (fill (type none)))
        (pin passive line (at -3.81 0 0) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 3.81 0 180) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))
    (symbol "power:VCC" (power) (pin_names (offset 0)) (in_bom yes) (on_board yes)
      (property "Reference" "#PWR" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
      (property "Value" "VCC" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (symbol "VCC_1_1"
        (polyline (pts (xy -1.27 1.27) (xy 1.27 1.27)) (stroke (width 0.254) (type default)) (fill (type none)))
        (pin power_in line (at 0 0 90) (length 0) (name "VCC" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))))
  ${body}
  (sheet_instances (path "/" (page "1")))
)`;
}
const place = (lib: string, ref: string, value: string, x: number, y: number, n: number): string => `
  (symbol (lib_id "${lib}") (at ${x} ${y} 0) (unit 1) (in_bom yes) (on_board yes) (uuid "5c0e0000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}")
    (property "Reference" "${ref}" (at ${x} ${y - 6} 0) (effects (font (size 1.27 1.27))))
    (property "Value" "${value}" (at ${x} ${y + 6} 0) (effects (font (size 1.27 1.27))))
    (instances (project "x" (path "/5c0e0000-0000-4000-8000-000000000002" (reference "${ref}") (unit 1)))))`;
const wire = (x1: number, y1: number, x2: number, y2: number, n: number): string =>
  `(wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2})) (stroke (width 0) (type default)) (uuid "5c0e0000-0000-4000-8000-00000000w0${String(n).padStart(2, '0')}"))`;

async function scoredPinned(body: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-score-'));
  const file = path.join(dir, 'x.kicad_sch');
  await writeFile(file, pinnedSch(body), 'utf8');
  const report = await scoreSchematic(file);
  await rm(dir, { recursive: true, force: true });
  return report;
}

describe('wiring-style metrics: how the parts connect', () => {
  // U1 at (100,100): pin 1 at (92.38, 97.46), pin 2 at (92.38, 102.54), pin 3 at (107.62, 100)
  // R1 at (80,97.46): pin 1 at (76.19, 97.46), pin 2 at (83.81, 97.46)
  it('a resistor wired straight to an IC pin is attached; one hung on labels is an island', async () => {
    const attached = await scoredPinned(`
      ${place('T:IC3', 'U1', 'IC3', 100, 100, 1)}
      ${place('T:R2', 'R1', '10k', 80, 97.46, 2)}
      ${wire(83.81, 97.46, 92.38, 97.46, 1)}`);
    expect(metric(attached, 'pin-attachment').raw).toBe(1);
    expect(metric(attached, 'island-parts').raw).toBe(0);

    const island = await scoredPinned(`
      ${place('T:IC3', 'U1', 'IC3', 100, 100, 1)}
      ${place('T:R2', 'R1', '10k', 80, 120, 2)}
      ${wire(83.81, 120, 86.35, 120, 1)}
      (label "NET_A" (at 86.35 120 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "5c0e0000-0000-4000-8000-00000000l001"))
      ${wire(92.38, 97.46, 89.84, 97.46, 2)}
      (label "NET_A" (at 89.84 97.46 0) (effects (font (size 1.27 1.27)) (justify right bottom)) (uuid "5c0e0000-0000-4000-8000-00000000l002"))`);
    expect(metric(island, 'pin-attachment').raw).toBe(0);
    expect(metric(island, 'island-parts').raw).toBe(1);
    expect(metric(island, 'pin-attachment').score).toBeLessThan(metric(attached, 'pin-attachment').score);
  });

  it('follows a T junction onto a wire interior the way KiCad joins it', async () => {
    // the resistor's pin lands on the middle of a wire that reaches the IC
    const r = await scoredPinned(`
      ${place('T:IC3', 'U1', 'IC3', 100, 100, 1)}
      ${place('T:R2', 'R1', '10k', 80, 97.46, 2)}
      ${wire(83.81, 90, 83.81, 105, 1)}
      ${wire(83.81, 97.46, 92.38, 97.46, 2)}`);
    expect(metric(r, 'pin-attachment').raw).toBe(1);
  });

  it('counts power symbols per part and labels per part', async () => {
    const r = await scoredPinned(`
      ${place('T:IC3', 'U1', 'IC3', 100, 100, 1)}
      ${place('T:R2', 'R1', '10k', 80, 97.46, 2)}
      ${place('power:VCC', '#PWR01', 'VCC', 76.19, 97.46, 3)}
      ${place('power:VCC', '#PWR02', 'VCC', 92.38, 102.54, 4)}
      ${wire(83.81, 97.46, 92.38, 97.46, 1)}`);
    // these two live in the style composite only
    const style = (name: string) => r.style.metrics.find((m) => m.name === name)!;
    expect(style('power-symbol-economy').raw).toBe(1); // 2 symbols / 2 parts
    expect(style('labels-per-part').raw).toBe(0);
  });

  it('reports a convention-free style composite that no legibility cap touches', async () => {
    // no group box: the gated composite is capped by ungrouped-symbol errors,
    // the style composite still reflects the fully attached wiring
    const r = await scoredPinned(`
      ${place('T:IC3', 'U1', 'IC3', 100, 100, 1)}
      ${place('T:R2', 'R1', '10k', 80, 97.46, 2)}
      ${wire(83.81, 97.46, 92.38, 97.46, 1)}`);
    expect(r.cap).not.toBeNull();
    expect(r.style.composite).toBeGreaterThan(r.composite);
    expect(r.style.metrics.map((m) => m.name)).toContain('pin-attachment');
    expect(r.style.metrics.find((m) => m.name === 'pin-attachment')!.score).toBe(1);
  });
});
