/**
 * move_footprint places a part's Reference text by board position (#380).
 * KiCad stores the label relative to the footprint origin in the footprint's
 * rotated frame; the expected local values below were checked against pcbnew
 * 10.0.7 (front and back side, every angle, turning and placing in one call).
 */
import { describe, it, expect } from 'vitest';
import { moveFootprint } from '../src/kicad/populate.js';
import { HANDLERS } from '../src/capabilities/handlers.js';
import { STAGES } from '../src/commands/create.js';

const board = (refText: string): string =>
  [
    '(kicad_pcb',
    '\t(footprint "Resistor_SMD:R_0603_1608Metric"',
    '\t\t(layer "F.Cu")',
    '\t\t(at 100 100)',
    `\t\t${refText}`,
    '\t\t(property "Value" "10k"',
    '\t\t\t(at 0 1.43 0)',
    '\t\t)',
    '\t\t(pad "1" smd roundrect',
    '\t\t\t(at -0.7875 0)',
    '\t\t)',
    '\t)',
    ')',
    '',
  ].join('\n');

const R2 = board('(property "Reference" "R2"\n\t\t\t(at 0 -1.43 0)\n\t\t)');

/** The (at …) of the first child list starting with `head`. */
const atOf = (text: string, head: string): string => {
  const i = text.indexOf(head);
  return /\(at [^)]*\)/.exec(text.slice(i))![0];
};

describe('moveFootprint places the Reference text by board position (#380)', () => {
  it('converts the board point into the rotated frame at every angle', () => {
    // origin (105, 107), label at board (108.25, 103.5): offset (3.25, -3.5)
    const want: Record<number, string> = {
      0: '(at 3.25 -3.5)',
      90: '(at 3.5 3.25 90)',
      180: '(at -3.25 3.5 180)',
      270: '(at -3.5 -3.25 270)',
    };
    for (const rot of [0, 90, 180, 270]) {
      const moved = moveFootprint(R2, 'R2', 105, 107, rot, { x: 108.25, y: 103.5 });
      expect(atOf(moved, '(property "Reference"'), `at ${rot}°`).toBe(want[rot]);
      // the Value text turns with the part but keeps its own place
      expect(atOf(moved, '(property "Value"'), `at ${rot}°`).toBe(`(at 0 1.43 ${rot})`);
    }
  });

  it('uses the new angle when the part was already turned and is turned again in the same call', () => {
    const turned = moveFootprint(R2, 'R2', 105, 107, 90);
    const moved = moveFootprint(turned, 'R2', 111, 104, 270, { x: 109, y: 102.8 });
    // offset (-2, -1.2) at 270°: local (dy, -dx) = (-1.2, 2)
    expect(atOf(moved, '(property "Reference"')).toBe('(at -1.2 2 270)');
  });

  it('places only the label when the origin and angle are kept', () => {
    const placed = moveFootprint(R2, 'R2', 100, 100, undefined, { x: 98, y: 100 });
    expect(atOf(placed, '(property "Reference"')).toBe('(at -2 0)');
    expect(atOf(placed, '(pad "1"')).toBe('(at -0.7875 0)');
  });

  // a footprint-owned zone, spelled the way KiCad writes it
  const ZONED = R2.replace(
    '\t\t(pad "1"',
    '\t\t(zone (net 0) (net_name "")\n\t\t\t(polygon (pts (xy 100.000000 99.000000) (xy 101.000000 99.000000) (xy 101.000000 100.000000)))\n\t\t)\n\t\t(pad "1"',
  );

  it('a label-only call changes only the Reference text, byte for byte (owned zone kept as written)', () => {
    const placed = moveFootprint(ZONED, 'R2', 100, 100, undefined, { x: 98, y: 100 });
    expect(placed).toBe(ZONED.replace('(property "Reference" "R2"\n\t\t\t(at 0 -1.43 0)', '(property "Reference" "R2"\n\t\t\t(at -2 0)'));
    // the same, with the current angle passed explicitly
    expect(moveFootprint(ZONED, 'R2', 100, 100, 0, { x: 98, y: 100 })).toBe(placed);
  });

  it('returns the board unchanged when neither the placement nor the label changes', () => {
    expect(moveFootprint(ZONED, 'R2', 100, 100)).toBe(ZONED);
    expect(moveFootprint(ZONED, 'R2', 100, 100, 0)).toBe(ZONED);
    // a label asked to go where it already is keeps its own spelling
    expect(moveFootprint(ZONED, 'R2', 100, 100, undefined, { x: 100, y: 98.57 })).toBe(ZONED);
  });

  it('a real move still moves the owned zone with the part', () => {
    const moved = moveFootprint(ZONED, 'R2', 110, 100);
    expect(moved).toContain('(at 110 100)');
    expect(moved).toContain('(xy 110 99) (xy 111 99) (xy 111 100)');
  });

  it('places a KiCad 6 fp_text reference and keeps its unlocked flag', () => {
    const old = board('(fp_text reference "R2" (at 0 -1.43 0 unlocked) (layer "F.SilkS"))');
    const placed = moveFootprint(old, 'R2', 100, 100, 90, { x: 100, y: 98 });
    expect(atOf(placed, '(fp_text reference')).toBe('(at 2 0 90 unlocked)');
  });

  it('leaves the board as before when no label is given', () => {
    expect(moveFootprint(R2, 'R2', 105, 107, 90)).toBe(moveFootprint(R2, 'R2', 105, 107, 90, undefined));
    expect(atOf(moveFootprint(R2, 'R2', 105, 107, 90), '(property "Reference"')).toBe('(at 0 -1.43 90)');
  });
});

describe('the move_footprint tool and the stage-5 prompt offer label placement (#380)', () => {
  const tool = HANDLERS.find((h) => h.schema.name === 'move_footprint')!;

  it('the schema takes label_x and label_y in board coordinates', () => {
    const props = (tool.schema.parameters as { properties: Record<string, { description: string }> }).properties;
    expect(props.label_x?.description).toMatch(/board coordinates/);
    expect(props.label_y?.description).toMatch(/board coordinates/);
  });

  it('refuses one label coordinate without the other, before touching the board', async () => {
    const ctx = { config: { board: 'x.kicad_pcb' }, repoRoot: '/nonexistent' } as never;
    expect(await tool.handler(ctx, { ref: 'R2', x: 1, y: 1, label_x: 2 })).toMatch(/label_x and label_y together/);
    expect(await tool.handler(ctx, { ref: 'R2', x: 1, y: 1, label_x: 'a', label_y: 2 })).toMatch(/must be numbers/);
  });

  it('the layout-draft prompt sends refdes label fixes to move_footprint, not edit_file', () => {
    const prompt = STAGES.find((s) => s.name === 'layout-draft')!.prompt('brief', 'docs/');
    expect(prompt).toContain('give move_footprint label_x and label_y');
    expect(prompt).not.toContain("inside a part's Reference or Value property");
  });
});
