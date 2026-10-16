import { describe, expect, it } from 'vitest';
import { capacitanceOf, checkPlacementText, placementSummary, type PlacementCheckId } from '../src/kicad/placement-checks.js';

interface PadSpec {
  n: string;
  at: [number, number, number?];
  size: [number, number];
  net?: string;
  kind?: 'smd' | 'thru_hole' | 'np_thru_hole';
  shape?: 'rect' | 'roundrect' | 'circle' | 'oval';
  pintype?: string;
}

interface FootprintSpec {
  ref: string;
  lib?: string;
  at: [number, number, number?];
  side?: 'F' | 'B';
  value?: string;
  pads: PadSpec[];
  /** Courtyard rectangle half-extents, or an explicit closed polygon. */
  courtyard?: [number, number] | [number, number][];
  attr?: string;
  zones?: string[];
  silk?: string[];
}

function padText(pad: PadSpec, side: 'F' | 'B'): string {
  const kind = pad.kind ?? 'smd';
  const layers = kind === 'smd' ? `"${side}.Cu" "${side}.Mask"` : '"*.Cu" "*.Mask"';
  const angle = pad.at[2] === undefined ? '' : ` ${pad.at[2]}`;
  const net = pad.net ? ` (net 1 "${pad.net}")` : '';
  const pintype = pad.pintype ? ` (pintype "${pad.pintype}")` : '';
  const drill = kind === 'smd' ? '' : ' (drill 0.8)';
  return `(pad "${pad.n}" ${kind} ${pad.shape ?? 'rect'} (at ${pad.at[0]} ${pad.at[1]}${angle}) (size ${pad.size[0]} ${pad.size[1]})${drill} (layers ${layers})${net}${pintype})`;
}

function courtyardText(spec: FootprintSpec): string {
  const layer = `${spec.side ?? 'F'}.CrtYd`;
  if (!spec.courtyard) return '';
  if (typeof spec.courtyard[0] === 'number') {
    const [w, h] = spec.courtyard as [number, number];
    return `(fp_rect (start ${-w} ${-h}) (end ${w} ${h}) (stroke (width 0.05) (type solid)) (fill none) (layer "${layer}"))`;
  }
  const pts = (spec.courtyard as [number, number][]).map(([x, y]) => `(xy ${x} ${y})`).join(' ');
  return `(fp_poly (pts ${pts}) (stroke (width 0.05) (type solid)) (fill none) (layer "${layer}"))`;
}

function footprint(spec: FootprintSpec): string {
  const side = spec.side ?? 'F';
  const rotation = spec.at[2] === undefined ? '' : ` ${spec.at[2]}`;
  return `
  (footprint "${spec.lib ?? `Test:${spec.ref}`}"
    (layer "${side}.Cu")
    (at ${spec.at[0]} ${spec.at[1]}${rotation})
    (property "Reference" "${spec.ref}" (at 0 0 0) (layer "${side}.SilkS"))
    (property "Value" "${spec.value ?? spec.ref}" (at 0 0 0) (layer "${side}.Fab"))
    ${spec.attr ? `(attr ${spec.attr})` : ''}
    ${courtyardText(spec)}
    ${spec.pads.map((pad) => padText(pad, side)).join('\n    ')}
    ${(spec.silk ?? []).join('\n')}
    ${(spec.zones ?? []).join('\n')}
  )`;
}

function board(footprints: FootprintSpec[], extra = '', outline = '(gr_rect (start 0 0) (end 40 30) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))'): string {
  return `(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  ${outline}
  ${footprints.map(footprint).join('\n')}
  ${extra}
)\n`;
}

/** A 0.5 mm-pitch, 4-pad SON: rotating it without rotating its pads shorts neighbours. */
const son = (ref: string, x: number, y: number, rotation: number, padAngle: number): FootprintSpec => ({
  ref,
  lib: 'Package_SON:Test_SON-4',
  at: [x, y, rotation],
  courtyard: [1.2, 1],
  pads: [-0.75, -0.25, 0.25, 0.75].map((px, i) => ({ n: String(i + 1), at: [px, 0, padAngle], size: [0.25, 0.9], net: `N${i + 1}` })),
});
const resistor = (ref: string, x: number, y: number, a = 'A', b = 'B', rotation = 0): FootprintSpec => ({
  ref,
  lib: 'Resistor_SMD:R_0402_1005Metric',
  at: [x, y, rotation],
  courtyard: [0.93, 0.47],
  pads: [
    { n: '1', at: [-0.51, 0, rotation], size: [0.54, 0.64], net: a },
    { n: '2', at: [0.51, 0, rotation], size: [0.54, 0.64], net: b },
  ],
});

const ids = (report: ReturnType<typeof checkPlacementText>, severity: 'error' | 'warning' = 'error'): PlacementCheckId[] =>
  (severity === 'error' ? report.errors : report.warnings).map((finding) => finding.id);

describe('universal placement checks', () => {
  it('passes a clean board and measures it', () => {
    const report = checkPlacementText(board([resistor('R1', 10, 10), resistor('R2', 20, 10, 'B', 'C')]));
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.metrics.components).toBe(2);
    expect(report.metrics.outline).toMatchObject({ widthMm: 40, heightMm: 30, areaMm2: 1200 });
    // net B joins R1.2 (10.51, 10) and R2.1 (19.49, 10)
    expect(report.metrics.hpwlMm).toBeCloseTo(8.98, 6);
  });

  it('catches a footprint rotated without its pads (the rp2040 U4 failure) and accepts a proper rotation', () => {
    const corrupt = checkPlacementText(board([son('U4', 20, 15, 270, 0)]));
    expect(ids(corrupt)).toContain('pad-overlap');
    expect(corrupt.errors.find((f) => f.id === 'pad-overlap')?.detail).toMatch(/U4 pads 1 \(N1\) and 2 \(N2\) overlap/);

    const rotated = checkPlacementText(board([son('U4', 20, 15, 270, 270)]));
    expect(rotated.ok).toBe(true);
  });

  it('flags courtyard overlap on the same side only, using exact courtyard polygons', () => {
    expect(ids(checkPlacementText(board([resistor('R1', 10, 10), resistor('R2', 11.7, 10, 'C', 'D')])))).toEqual(['courtyard-overlap']);
    // touching courtyards are legal
    expect(checkPlacementText(board([resistor('R1', 10, 10), resistor('R2', 11.86, 10, 'C', 'D')])).errors).toEqual([]);
    // opposite sides never overlap
    const under = { ...resistor('R2', 10.5, 10, 'C', 'D'), side: 'B' as const };
    expect(checkPlacementText(board([resistor('R1', 10, 10), under])).ok).toBe(true);

    // an L-shaped courtyard: bounding boxes overlap, polygons do not (the stepped QFN case)
    const ell: FootprintSpec = {
      ref: 'U1',
      at: [10, 10],
      courtyard: [
        [-2, -2],
        [2, -2],
        [2, 0],
        [0, 0],
        [0, 2],
        [-2, 2],
      ],
      pads: [{ n: '1', at: [-1, -1], size: [1, 1], net: 'A' }],
    };
    expect(checkPlacementText(board([ell, resistor('R1', 11.2, 11.2, 'C', 'D')])).ok).toBe(true);
    expect(ids(checkPlacementText(board([ell, resistor('R1', 10.5, 9, 'C', 'D')])))).toEqual(['courtyard-overlap']);
  });

  it('reports new cross-footprint silkscreen envelope overlaps', () => {
    const a = resistor('R1', 10, 10);
    a.silk = ['(fp_line (start 0 1) (end 3 1) (stroke (width 0.2) (type solid)) (layer "F.SilkS"))'];
    const report = checkPlacementText(board([a, resistor('R2', 12.5, 11, 'C', 'D')]));

    expect(ids(report, 'warning')).toContain('silkscreen-overlap');
    expect(report.warnings.find((finding) => finding.id === 'silkscreen-overlap')?.refs).toEqual(['R1', 'R2']);
  });

  it('keeps pads inside the outline and connectors at an edge', () => {
    const off = checkPlacementText(board([resistor('R1', 39.8, 10)]));
    expect(ids(off)).toContain('outline-containment');

    const usb = (y: number): FootprintSpec => ({
      ref: 'J1',
      lib: 'Connector_USB:USB_C_Receptacle_Test',
      at: [20, y],
      courtyard: [4.5, 3.5],
      pads: [{ n: 'A1', at: [-3, -1], size: [0.6, 1.2], net: 'VBUS' }],
    });
    expect(ids(checkPlacementText(board([usb(15)])))).toEqual(['edge-connector']);
    expect(checkPlacementText(board([usb(3.5)])).ok).toBe(true);
    // a mouth that overhangs the edge is fine for a connector
    expect(checkPlacementText(board([usb(2)])).ok).toBe(true);
  });

  it('warns when a non-connector courtyard overhangs the outline', () => {
    const report = checkPlacementText(board([resistor('R1', 39.1, 10)]));
    expect(report.ok).toBe(true);
    expect(ids(report, 'warning')).toContain('courtyard-overhang');
  });

  it('honours footprint-embedded keepouts and wants antenna keepouts at an edge', () => {
    const keepout = (x0: number, x1: number): string =>
      `(zone (net 0) (net_name "") (layers "*.Cu") (name "Antenna") (hatch full 0.5)
        (keepout (tracks not_allowed) (vias not_allowed) (pads not_allowed) (copperpour not_allowed) (footprints not_allowed))
        (polygon (pts (xy ${x0} 2) (xy ${x1} 2) (xy ${x1} 12) (xy ${x0} 12))))`;
    const module = (x0: number, x1: number): FootprintSpec => ({
      ref: 'U1',
      lib: 'RF_Module:Test_Module',
      at: [20, 7],
      courtyard: [10, 5],
      pads: [{ n: '1', at: [0, 4], size: [1, 1], net: 'A' }],
      zones: [keepout(x0, x1)],
    });
    const intruder = checkPlacementText(board([module(10, 16), resistor('R1', 13, 5, 'C', 'D')]));
    expect(ids(intruder)).toContain('footprint-keepout');

    expect(ids(checkPlacementText(board([module(10, 16)])), 'warning')).toContain('antenna-edge');
    expect(ids(checkPlacementText(board([module(0, 6)])), 'warning')).not.toContain('antenna-edge');
  });

  it('measures decoupling against IC supply pins only', () => {
    const ic: FootprintSpec = {
      ref: 'U1',
      at: [20, 15],
      courtyard: [3, 3],
      pads: [
        { n: '1', at: [-2, -2], size: [0.5, 0.5], net: '+3V3', pintype: 'power_in' },
        { n: '2', at: [2, 2], size: [0.5, 0.5], net: 'GND', pintype: 'power_in' },
        { n: '3', at: [-2, 2], size: [0.5, 0.5], net: 'XIN', pintype: 'input' },
      ],
    };
    const cap = (ref: string, x: number, rail: string, value = '100n'): FootprintSpec => ({ ...resistor(ref, x, 13, rail, 'GND'), value });
    const report = checkPlacementText(board([ic, cap('C1', 16.5, '+3V3'), cap('C2', 5, '+3V3'), cap('C3', 15, 'XIN', '22p')]));
    expect(report.metrics.decoupling.map((d) => [d.ref, d.ic])).toEqual([
      ['C1', 'U1'],
      ['C2', 'U1'],
    ]);
    expect(report.warnings.filter((f) => f.id === 'decoupling-distance').map((f) => f.refs)).toEqual([['C2', 'U1']]);
    expect(capacitanceOf('4.7uF')).toBeCloseTo(4.7e-6, 12);
    expect(capacitanceOf('4u7')).toBeCloseTo(4.7e-6, 12);
    expect(capacitanceOf('100n')).toBeCloseTo(1e-7, 12);
  });

  it('warns when the outline is far larger than the parts', () => {
    const report = checkPlacementText(board([resistor('R1', 10, 10)]));
    expect(ids(report, 'warning')).toContain('utilization');
    expect(report.metrics.utilization).toBeLessThan(0.01);
  });

  it('reads stitched line-and-arc outlines', () => {
    const outline = [
      '(gr_line (start 2 0) (end 38 0) (layer "Edge.Cuts"))',
      '(gr_arc (start 38 0) (mid 39.414 0.586) (end 40 2) (layer "Edge.Cuts"))',
      '(gr_line (start 40 2) (end 40 30) (layer "Edge.Cuts"))',
      '(gr_line (start 40 30) (end 0 30) (layer "Edge.Cuts"))',
      '(gr_line (start 0 30) (end 0 2) (layer "Edge.Cuts"))',
      '(gr_arc (start 0 2) (mid 0.586 0.586) (end 2 0) (layer "Edge.Cuts"))',
    ].join('\n');
    const report = checkPlacementText(board([resistor('R1', 10, 10)], '', outline));
    expect(report.metrics.outline).toMatchObject({ widthMm: 40, heightMm: 30, loops: 1 });
    expect(ids(checkPlacementText(board([resistor('R1', 39.6, 0.5)], '', outline)))).toContain('outline-containment');
  });

  it('summarizes placed parts and per-net HPWL for comparisons', () => {
    const summary = placementSummary(board([resistor('R1', 10, 10, 'A', 'B', 90), resistor('R2', 20, 10, 'B', 'C')]));
    expect(summary.parts.map((part) => [part.ref, part.x, part.y, part.rotation])).toEqual([
      ['R1', 10, 10, 90],
      ['R2', 20, 10, 0],
    ]);
    // R1 at 90°: pad 2 local (0.51, 0) -> board (10, 9.49); R2 pad 1 -> (19.49, 10)
    expect(summary.netHpwlMm.B).toBeCloseTo(9.49 + 0.51, 6);
  });

});
