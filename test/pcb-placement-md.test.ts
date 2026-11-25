import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importKicadBoard, placementDiff, renderDiffText } from '../src/pcb-ir/index.js';
import { placementMarkdown, type PlacementDocInput } from '../src/pcb-ir/placement-md.js';

/** placement.md (RFC 11 Section 12.6): a function of the run's records. */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const board = readFileSync(path.join(HERE, 'fixtures/pcb-ir/ldo.kicad_pcb'), 'utf8');
const before = importKicadBoard(board, { projectId: 'ldo', path: 'ldo.kicad_pcb' });
const moved = board.replace('\t\t(at 20 7)\n', '\t\t(at 21.5 7.25)\n');
const after = importKicadBoard(moved, { projectId: 'ldo', path: 'variants/a/board.kicad_pcb' });
const diff = placementDiff(before, { input: after });

const planTime: PlacementDocInput = {
  title: 'pcb reuse of ldo.kicad_pcb against reference.kicad_pcb',
  input: before,
  fabricationProfile: 'jlcpcb-2layer',
  plan: {
    source: 'rules',
    blocks: [{ id: 'ldo', members: ['U1', 'C1', 'C2'], anchor: 'U1', region: { id: 'left', x: 0, y: 0, w: 15_000_000, h: 20_000_000 }, flow: 'VIN -> +3V3' }],
    phases: [{ kind: 'anchors', parts: ['U1'] }, { kind: 'support', parts: ['C1', 'C2'] }],
    rationale: [],
  },
  critical: [{ kind: 'supply-decoupling', refs: ['U1', 'C2'], limit: 'within 2 mm' }],
  candidates: null,
  changes: null,
  remains: { unplaced: [], held: [], unknown: [], deviations: [], lossy: before.board.lossy ?? [] },
};

const ended: PlacementDocInput = {
  ...planTime,
  critical: [{ ...planTime.critical[0]!, result: 'no violation found' }],
  candidates: [
    { id: 'copy', rank: 2, selected: false, reason: 'routability 95%', metrics: { routability_completion: 0.95 } },
    { id: 'b0', rank: 1, selected: true, reason: 'routability 100%', metrics: { routability_completion: 1, critical_completion: 1, loop_area_mm2: 11.2, hpwl_nm: 586_800_000 } },
  ],
  changes: { diff, text: renderDiffText(diff, { before, after }) },
};

describe('placement.md', () => {
  it('has the six sections of RFC 11 Section 12.6, in order', () => {
    const md = placementMarkdown(ended);
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toEqual(['## 1. The board', '## 2. The plan', '## 3. Critical constraints', '## 4. Candidates offered', '## 5. The changes', '## 6. What remains']);
  });

  it('says at plan time that nothing has been measured yet', () => {
    const md = placementMarkdown(planTime);
    expect(md).toContain('The plan has been validated; the run is still going.');
    expect(md).toContain('Nothing has been measured yet; these are what will be checked.');
    expect(md).toContain('| supply-decoupling | U1, C2 | within 2 mm | not yet measured |');
    expect(md).not.toContain('```text');
  });

  it('shows the selected candidate first by rank and its placement diff when the run ends', () => {
    const md = placementMarkdown(ended);
    expect(md).toContain('| 1 (selected) | b0 | 100 % | 11.2 mm2 | 100 % | 586.8 mm | routability 100% |');
    expect(md.indexOf('| 1 (selected) | b0')).toBeLessThan(md.indexOf('| 2 | copy'));
    expect(md).toContain('~ R1 1k moved 1.520691 mm (20, 7) -> (21.5, 7.25)');
    expect(md).toContain('| supply-decoupling | U1, C2 | within 2 mm | no violation found |');
  });

  it('describes the board from its layout input', () => {
    const md = placementMarkdown(ended);
    expect(md).toContain('- Outline: 30.0 x 20.0 mm, 4 vertices');
    expect(md).toContain('- Copper layers, top to bottom: F.Cu, B.Cu');
    expect(md).toContain('- Fabrication profile: jlcpcb-2layer');
  });

  it('is the same bytes for the same records, and marks what a model wrote', () => {
    expect(placementMarkdown(ended)).toBe(placementMarkdown(structuredClone(ended)));
    const byModel = placementMarkdown({ ...ended, plan: { ...ended.plan, source: 'model', rationale: ['Keep the LDO near the input connector.'] } });
    expect(byModel).toContain('Written by a model, then validated.');
    expect(byModel).toContain('Rationale, written by a model:\n\n> Keep the LDO near the input connector.');
  });
});

describe('a reuse option as an RFC 11 candidate', () => {
  it('validates, and its diff marks a move of an imported part as needing approval', async () => {
    const { candidateOf } = await import('../src/commands/pcb-reuse.js');
    const Ajv2020 = (await import('ajv/dist/2020.js')).default;
    const { readdirSync } = await import('node:fs');
    const candidate = candidateOf('b0', 'placer-reuse-b0', before, after, {
      verified: true,
      findings: [],
      metrics: { hpwl_nm: 1, missing: undefined },
    });
    const SCHEMAS = path.join(HERE, '../src/pcb-ir/schemas/rfc11');
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    for (const f of readdirSync(SCHEMAS).filter((n) => n.endsWith('.schema.json'))) ajv.addSchema(JSON.parse(readFileSync(path.join(SCHEMAS, f), 'utf8')));
    const valid = ajv.getSchema('https://github.com/copperheadhq/copperhead-rfcs/schemas/rfc11/2.0/candidate.schema.json')!;
    expect(valid(candidate), JSON.stringify(valid.errors)).toBe(true);
    expect(candidate.loose.every((l) => l.basis === 'packed')).toBe(true);
    expect(candidateOf('copy', 'placer-reuse-copy', before, after, { verified: true, findings: [], metrics: {} }).loose[0]!.basis).toBe('golden-adapted');

    const d = placementDiff(before, { candidate, blockLayouts: [] });
    expect(d.components.map((r) => [r.refdes, r.changes, r.approval])).toEqual([['R1', ['moved'], 'required']]);
    expect(renderDiffText(d, { before }).split("\n")[1]).toMatch(/^! ~ R1 1k moved/);
  });
});
