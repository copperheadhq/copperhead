import { describe, expect, it } from 'vitest';
import { checkPlacementText, placementSummary } from '../src/kicad/placement-checks.js';
import { optimizePlacementText } from '../src/kicad/placement-feedback.js';

function footprint(ref: string, x: number, y: number, leftNet: string, rightNet: string, lib = 'Resistor_SMD:R_0402_1005Metric'): string {
  return `(footprint "${lib}"
    (layer "F.Cu")
    (at ${x} ${y})
    (property "Reference" "${ref}" (at 0 -1 0) (layer "F.SilkS"))
    (property "Value" "1k" (at 0 1 0) (layer "F.Fab"))
    (fp_rect (start -0.8 -0.6) (end 0.8 0.6) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))
    (pad "1" smd rect (at -0.5 0) (size 0.4 0.5) (layers "F.Cu" "F.Mask") (net 1 "${leftNet}"))
    (pad "2" smd rect (at 0.5 0) (size 0.4 0.5) (layers "F.Cu" "F.Mask") (net 2 "${rightNet}"))
  )`;
}

function board(parts: string[]): string {
  return `(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  (gr_rect (start 0 0) (end 50 30) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
  ${parts.join('\n  ')}
)
`;
}

describe('feedback placement optimizer', () => {
  it('continues from measured accepted checkpoints and lowers HPWL', () => {
    const input = board([
      footprint('R1', 8, 10, 'A', 'N1'),
      footprint('R2', 28, 10, 'N1', 'N2'),
      footprint('R3', 40, 10, 'N2', 'B'),
    ]);
    const before = checkPlacementText(input);
    const result = optimizePlacementText(input, {
      evaluationBudget: 160,
      stepScheduleMm: [2, 1, 0.5],
      allowRotations: false,
    });
    const after = checkPlacementText(result.boardText);

    expect(result.report.changed).toBe(true);
    expect(result.report.accepted).toBeGreaterThan(1);
    expect(result.report.exactEvaluated).toBeGreaterThanOrEqual(result.report.accepted);
    expect(result.report.exactEvaluated).toBeLessThanOrEqual(result.report.evaluated);
    expect(after.metrics.hpwlMm).toBeLessThan(before.metrics.hpwlMm);
    expect(after.errors.map((finding) => `${finding.id}:${finding.refs.join(',')}`)).toEqual(
      before.errors.map((finding) => `${finding.id}:${finding.refs.join(',')}`),
    );
    expect(result.report.moves[1]?.before).toEqual(result.report.moves[0]?.after);
  });

  it('locks inferred mechanical parts while moving connected electrical parts', () => {
    const input = board([
      footprint('J1', 3, 10, 'A', 'SIG', 'Connector_Generic:Conn_01x02'),
      footprint('R1', 30, 10, 'SIG', 'B'),
    ]);
    const result = optimizePlacementText(input, { evaluationBudget: 60, stepScheduleMm: [2], allowRotations: false });
    const parts = new Map(placementSummary(result.boardText).parts.map((part) => [part.ref, part]));

    expect(result.report.lockedRefs).toContain('J1');
    expect(parts.get('J1')).toMatchObject({ x: 3, y: 10 });
    expect(parts.get('R1')!.x).toBeLessThan(30);
  });

  it('returns byte-identical input when no proposal is a strict non-regression', () => {
    const input = board([
      footprint('J1', 3, 10, 'A', 'SIG', 'Connector_Generic:Conn_01x02'),
      footprint('J2', 47, 10, 'SIG', 'B', 'Connector_Generic:Conn_01x02'),
    ]);
    const result = optimizePlacementText(input, { evaluationBudget: 20, stepScheduleMm: [1] });
    expect(result.boardText).toBe(input);
    expect(result.report).toMatchObject({ changed: false, accepted: 0, stopReason: 'no-movable-parts' });
  });

  it('refuses routed boards before evaluating a move', () => {
    const input = board([
      footprint('R1', 8, 10, 'A', 'N1'),
      footprint('R2', 28, 10, 'N1', 'B'),
    ]).replace(
      '\n)\n',
      '\n  (segment (start 8.5 10) (end 27.5 10) (width 0.2) (layer "F.Cu") (net 2))\n)\n',
    );

    expect(() => optimizePlacementText(input)).toThrow(/only supports unrouted boards; found 1 segments/);
  });

  it('is byte-identical for identical input and options and stops on the evaluation count', () => {
    const input = board([
      footprint('R1', 8, 10, 'A', 'N1'),
      footprint('R2', 28, 10, 'N1', 'N2'),
      footprint('R3', 40, 10, 'N2', 'B'),
    ]);
    const options = { evaluationBudget: 7, stepScheduleMm: [2, 1], allowRotations: true } as const;
    const runs = Array.from({ length: 10 }, () => optimizePlacementText(input, options));
    const a = runs[0]!;
    for (const repeat of runs.slice(1)) expect(repeat).toEqual(a);
    expect(a.report.evaluated).toBe(7);
    expect(a.report.stopReason).toBe('evaluation-budget');
  });

  it('rejects an aggregate improvement when any protected net regresses', () => {
    const input = board([
      footprint('R1', 5, 10, 'A', 'N1'),
      footprint('R2', 30, 10, 'N1', 'N2'),
      footprint('R3', 40, 10, 'N2', 'B'),
    ]);
    const before = placementSummary(input).netHpwlMm;
    const result = optimizePlacementText(input, {
      evaluationBudget: 40,
      stepScheduleMm: [2],
      criticalNets: ['N1', 'N2'],
      allowRotations: false,
    });
    const after = placementSummary(result.boardText).netHpwlMm;

    expect(result.report.rejectionCounts).toContainEqual(expect.objectContaining({ reason: 'critical-net-regression' }));
    expect(after.N1).toBeLessThanOrEqual(before.N1!);
    expect(after.N2).toBeLessThanOrEqual(before.N2!);
  });

  it('rejects moves that worsen an existing decoupling distance', () => {
    const controller = `(footprint "Package_QFN:Test"
      (layer "F.Cu")
      (at 10 10)
      (property "Reference" "U1" (at 0 -2 0) (layer "F.SilkS"))
      (property "Value" "IC" (at 0 2 0) (layer "F.Fab"))
      (fp_rect (start -1.5 -1.5) (end 1.5 1.5) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))
      (pad "1" smd rect (at -1 0) (size 0.4 0.5) (layers "F.Cu" "F.Mask") (net 1 "+3V3") (pintype "power_in"))
      (pad "2" smd rect (at 1 -0.5) (size 0.4 0.5) (layers "F.Cu" "F.Mask") (net 2 "N1"))
      (pad "3" smd rect (at 1 0.5) (size 0.4 0.5) (layers "F.Cu" "F.Mask") (net 3 "N2"))
    )`;
    const input = board([
      controller,
      footprint('C1', 7, 10, '+3V3', 'GND'),
      footprint('R1', 30, 9.5, 'N1', 'A'),
      footprint('R2', 30, 10.5, 'N2', 'B'),
    ]);
    const before = checkPlacementText(input).metrics.decoupling.find((entry) => entry.ref === 'C1')!;
    const result = optimizePlacementText(input, { evaluationBudget: 50, stepScheduleMm: [2], allowRotations: false });
    const after = checkPlacementText(result.boardText).metrics.decoupling.find((entry) => entry.ref === 'C1')!;

    expect(result.report.rejectionCounts).toContainEqual(expect.objectContaining({ reason: 'decoupling-distance-regression' }));
    expect(after.distanceMm).toBeLessThanOrEqual(before.distanceMm!);
  });

  it('validates explicit evaluation and step budgets', () => {
    const input = board([footprint('R1', 8, 10, 'A', 'B')]);
    expect(() => optimizePlacementText(input, { evaluationBudget: 0 })).toThrow(/evaluationBudget/);
    expect(() => optimizePlacementText(input, { stepScheduleMm: [] })).toThrow(/stepScheduleMm/);
  });
});
