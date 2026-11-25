import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { generate, OUTPUT, SCHEMA_DIR } from '../scripts/gen-pcb-ir-types.js';
import {
  boardText,
  canonical,
  contentHash,
  DiffInputError,
  encodeNumber,
  NotCanonicalizable,
  placementDiff,
  renderDiffText,
  type BlockLayout,
  type Candidate,
  type LayoutInput,
  type PlacementDiff,
} from '../src/pcb-ir/index.js';

/**
 * pcb-ir against RFC 11 version 1.4 and RFC 3 version 1.6
 * (copperheadhq/copperhead-rfcs#15). The RFC's example records, vendored in
 * test/fixtures/rfc11/, cite one another by content hash; the encoder here
 * must reproduce every one, as the kernel's does (copperheadhq/fang#22).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RFC11 = path.join(HERE, 'fixtures/rfc11');
const read = <T = unknown>(name: string): T => JSON.parse(readFileSync(path.join(RFC11, name), 'utf8')) as T;
const examples = readdirSync(RFC11).filter((f) => f.endsWith('.json') || f.endsWith('.jsonl'));
const recordsOf = (name: string): unknown[] =>
  name.endsWith('.jsonl')
    ? readFileSync(path.join(RFC11, name), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [read(name)];

function cited(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((v) => cited(v, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (['input', 'layout', 'candidate'].includes(k) && typeof v === 'string' && v.startsWith('sha256:')) out.push(v);
      else cited(v, out);
    }
  }
  return out;
}

describe('the RFC 11 schemas and their examples', () => {
  it('every example validates against its schema', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const ids = new Map<string, string>();
    for (const f of readdirSync(SCHEMA_DIR).filter((name) => name.endsWith('.schema.json'))) {
      const schema = JSON.parse(readFileSync(path.join(SCHEMA_DIR, f), 'utf8'));
      ajv.addSchema(schema);
      ids.set(f.replace('.schema.json', ''), schema.$id);
    }
    for (const name of examples) {
      const validate = ajv.getSchema(ids.get(name.split('.')[0]!)!)!;
      for (const record of recordsOf(name)) {
        expect(validate(record), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true);
      }
    }
  });

  it('the generated types are current with the vendored schemas', async () => {
    expect(await generate()).toBe(readFileSync(OUTPUT, 'utf8'));
  });

  it('every example type-checks against its generated type', () => {
    const typeOf: Record<string, string> = {
      footprint: 'FootprintDefinition',
      physical: 'PhysicalDesignRecord',
      'layout-input': 'LayoutInput',
      snapshot: 'BoardSnapshot',
      'block-layout': 'BlockLayout',
      candidate: 'Candidate',
      'placement-diff': 'PlacementDiff',
      'layout-ops': 'LayoutOperations',
      intent: 'IntentFile',
    };
    const virtual = path.join(HERE, '__examples_typecheck__.ts');
    const lines = [`import type * as T from '../src/pcb-ir/types.generated.js';`];
    examples.forEach((name, i) => {
      const type = typeOf[name.split('.')[0]!];
      expect(type, name).toBeDefined();
      recordsOf(name).forEach((record, j) => lines.push(`export const v${i}_${j}: T.${type} = ${JSON.stringify(record)};`));
    });
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
      types: [],
    };
    const host = ts.createCompilerHost(options);
    const source = lines.join('\n');
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, lang, ...rest) =>
      path.resolve(file) === virtual ? ts.createSourceFile(file, source, lang) : getSourceFile(file, lang, ...rest);
    const fileExists = host.fileExists.bind(host);
    host.fileExists = (file) => path.resolve(file) === virtual || fileExists(file);
    const program = ts.createProgram([virtual], options, host);
    const problems = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .filter(Boolean);
    expect(problems).toEqual([]);
  });
});

describe('canonical form and content hashes (RFC 3 Section 17.1)', () => {
  it('reproduces every hash the examples cite to one another', () => {
    const hashes = new Set(examples.filter((n) => n.endsWith('.json')).map((n) => contentHash(read(n))));
    const citations = examples.flatMap((n) => recordsOf(n).flatMap((r) => cited(r)));
    expect(citations.length).toBeGreaterThanOrEqual(8);
    for (const h of citations) expect(hashes.has(h), h).toBe(true);
    for (const name of ['layout-input.ldo-board.json', 'layout-input.ldo-placed.json']) {
      for (const [key, footprint] of Object.entries(read<LayoutInput>(name).footprints)) {
        expect(contentHash(footprint)).toBe(key);
      }
    }
  });

  it('sorts an item without an identifier by its whole serialization', () => {
    const a = { code: 'PLC-0001', message: 'b' };
    const b = { code: 'PLC-0001', message: 'a' };
    expect(canonical({ findings: [a, b] })).toBe(canonical({ findings: [b, a] }));
    expect(canonical([{ id: 'CMP-b', name: 'a' }, { id: 'CMP-a', name: 'z' }]).indexOf('CMP-a')).toBeLessThan(
      canonical([{ id: 'CMP-b', name: 'a' }, { id: 'CMP-a', name: 'z' }]).indexOf('CMP-b'),
    );
  });

  it('writes a bare number positionally, as the kernel does', () => {
    expect([2.0, 0.5, 0.1, -0, 1e-7, 1e16, -2.5e-5, 1.25, 1e21].map(encodeNumber)).toEqual([
      '2',
      '0.5',
      '0.1',
      '0',
      '0.0000001',
      '10000000000000000',
      '-0.000025',
      '1.25',
      '1000000000000000000000',
    ]);
    expect(() => canonical({ m: Infinity })).toThrow(NotCanonicalizable);
    expect(() => canonical({ m: NaN })).toThrow(NotCanonicalizable);
  });

  it('keeps the order of the declared ordered collections only', () => {
    for (const key of ['outline', 'layers', 'preserved', 'provenance', 'args']) {
      expect(canonical({ [key]: [{ r: 2 }, { r: 1 }] })).toBe(`{"${key}":[{"r":2},{"r":1}]}`);
    }
    expect(canonical({ members: ['b', 'a'] })).toBe('{"members":["a","b"]}');
  });

  it('sorts keys by Unicode code point, not UTF-16 unit', () => {
    expect(canonical({ '\u{1F600}': 1, '￿': 2 })).toBe('{"￿":2,"\u{1F600}":1}');
  });
});

describe('the placement diff (RFC 11 Section 6.11)', () => {
  const input = read<LayoutInput>('layout-input.ldo-board.json');
  const candidate = read<Candidate>('candidate.ldo-board.json');
  const block = read<BlockLayout>('block-layout.ldo-3v3.json');
  const after = Object.fromEntries(block.results.map((r) => [r.constraint, r.state]));
  const before = Object.fromEntries(Object.keys(after).map((c) => [c, 'UNKNOWN' as const]));
  const diff = placementDiff(input, { candidate, blockLayouts: [block] }, { constraints: { before, after } });

  it('equals the diff the RFC publishes for its candidate', () => {
    expect(diff).toEqual(read<PlacementDiff>('placement-diff.ldo-board.json'));
    expect(contentHash(diff)).toBe(contentHash(read('placement-diff.ldo-board.json')));
  });

  it('renders as the text view of RFC 11 Section 14.4', () => {
    expect(renderDiffText(diff, { before: input })).toBe(
      [
        'diff 14fd4352 -> candidate b9974acb: 4 changed, 1 needs approval',
        '! ~ R1 1k          moved 5.09902 mm (25, 6) -> (20, 7)   packed',
        '  + C1 1uF         placed (13.7, 11.4) 270   CKT-963fa1bea581',
        '  + C2 1uF         placed (7.9, 11.4) 90     CKT-963fa1bea581',
        '  + U1 AP2112K-3.3 placed (10.78, 10) 90     CKT-963fa1bea581',
        '    RULE-8a4fc38a167e  UNKNOWN -> PASS',
        '    RULE-9b1140645ad7  UNKNOWN -> PASS',
        '',
      ].join('\n'),
    );
  });

  it('compares two layout inputs, with no approval class', () => {
    const placed = read<LayoutInput>('layout-input.ldo-placed.json');
    const d = placementDiff(input, { input: placed });
    expect(d.after).toEqual({ input: contentHash(placed) });
    expect(d.components.map((r) => [r.refdes, r.changes, r.approval])).toEqual([
      ['C1', ['placed'], undefined],
      ['C2', ['placed'], undefined],
      ['R1', ['moved'], undefined],
      ['U1', ['placed'], undefined],
    ]);
    expect(d.copper).toEqual({ added: ['TRC-a82a9d7ddee6'], removed: [] });
    expect(renderDiffText(d, { before: input, after: placed }).split('\n')[0]).toBe(
      `diff 14fd4352 -> input ${contentHash(placed).slice(7, 15)}: 4 changed, copper +1 -0`,
    );
  });

  it('refuses a candidate produced against another layout input', () => {
    const placed = read<LayoutInput>('layout-input.ldo-placed.json');
    expect(() => placementDiff(placed, { candidate, blockLayouts: [block] })).toThrow(DiffInputError);
  });

  it("lists a routing candidate's copper as added and removed", () => {
    const placed = read<LayoutInput>('layout-input.ldo-placed.json');
    const route = read<Candidate>('candidate.ldo-route.json');
    const d = placementDiff(placed, { candidate: route, blockLayouts: [] });
    expect(d.components).toEqual([]);
    expect(d.copper).toEqual({ added: ['TRC-12c3997d7bf3', 'VIA-6d6e9c5aa3b8'], removed: ['TRC-a82a9d7ddee6'] });
    const text = renderDiffText(d, { before: placed }).split('\n');
    expect(text[0]).toMatch(/: 0 changed, copper \+2 -1$/);
    expect(text).toContain('    copper - TRC-a82a9d7ddee6');
  });

  it('marks a change to a locked placement as refused', () => {
    const locked = structuredClone(input);
    const r1 = Object.values(locked.components).find((c) => c.refdes === 'R1')!;
    r1.locked = true;
    const lockedCandidate = { ...candidate, input: contentHash(locked) };
    const d = placementDiff(locked, { candidate: lockedCandidate, blockLayouts: [block] });
    expect(d.components.find((r) => r.refdes === 'R1')!.approval).toBe('refused');
  });
});

describe('copperhead pcb diff', () => {
  it('diffs a layout input against a candidate, finding block layouts beside it', async () => {
    const { pcbDiff } = await import('../src/commands/pcb.js');
    const res = await pcbDiff(path.join(RFC11, 'layout-input.ldo-board.json'), path.join(RFC11, 'candidate.ldo-board.json'));
    expect(res.text.split('\n')[0]).toBe('diff 14fd4352 -> candidate b9974acb: 4 changed, 1 needs approval');
    expect(res.diff.components).toHaveLength(4);
  });

  it('says a KiCad board must be imported first', async () => {
    const { pcbDiff, PcbCommandError } = await import('../src/commands/pcb.js');
    await expect(pcbDiff(path.join(HERE, 'fixtures/pcb-ir/ldo.kicad_pcb'), path.join(RFC11, 'candidate.ldo-board.json'))).rejects.toThrow(
      PcbCommandError,
    );
  });
});

describe('the board text (RFC 11 Section 14.4)', () => {
  const board = readFileSync(path.join(HERE, 'fixtures/pcb-ir/ldo.kicad_pcb'), 'utf8');

  it('prints one fact per line in a fixed order', () => {
    expect(boardText(board)).toBe(
      [
        'board outline (0, 0) to (30, 20) layers F.Cu B.Cu',
        'footprint C1 1uF Capacitor_SMD:C_0603_1608Metric (13.7, 11.4) 270 front',
        'footprint C2 1uF Capacitor_SMD:C_0603_1608Metric (7.9, 11.4) 90 front',
        'footprint H1 MountingHole MountingHole:MountingHole_3.2mm_M3 (3, 3) 0 front locked',
        'footprint R1 1k Resistor_SMD:R_0603_1608Metric (20, 7) 0 front',
        'footprint U1 AP2112K-3.3 Package_TO_SOT_SMD:SOT-23-5 (10.78, 10) 90 front',
        'net +3V3 layers F.Cu segments 2 length 9.53127 vias 0 digest 864440eb',
        'net GND layers - segments 0 length 0 vias 1 digest 7b74b2a3',
        'zone GND B.Cu priority 0 vertices 4 digest 91f9bdb4',
        '',
      ].join('\n'),
    );
  });

  it('shows a moved footprint as one changed line', () => {
    const moved = board.replace('(at 20 7)\n', '(at 21.5 7.25 180)\n');
    const a = boardText(board).split('\n');
    const b = boardText(moved).split('\n');
    const changed = a.filter((line, i) => line !== b[i]);
    expect(changed).toEqual(['footprint R1 1k Resistor_SMD:R_0603_1608Metric (20, 7) 0 front']);
    expect(b).toContain('footprint R1 1k Resistor_SMD:R_0603_1608Metric (21.5, 7.25) 180 front');
  });

  it("changes a net's line when a trace width or a via changes, though no count does", () => {
    const before = boardText(board).split('\n');
    const diffLines = (edited: string) => {
      const after = boardText(edited).split('\n');
      return before.filter((line, i) => line !== after[i]).map((line) => line.split(' ').slice(0, 2).join(' '));
    };
    expect(diffLines(board.replace('(end 9.9 8.6) (width 0.25)', '(end 9.9 8.6) (width 0.3)'))).toEqual(['net +3V3']);
    expect(diffLines(board.replace('(via (at 12 13)', '(via (at 12.5 13)'))).toEqual(['net GND']);
    expect(diffLines(board.replace('(drill 0.3)', '(drill 0.4)'))).toEqual(['net GND']);
    expect(diffLines(board.replace('(xy 30 20) (xy 0 20)', '(xy 30 19) (xy 0 20)'))).toEqual(['zone GND']);
  });

  it('measures curved edge cuts at their extremes', () => {
    const outline = (cut: string) => boardText(`(kicad_pcb (layers (0 "F.Cu" signal)) ${cut})`).split('\n')[0];
    expect(outline('(gr_circle (center 54 64) (end 56 64) (layer "Edge.Cuts"))')).toBe(
      'board outline (52, 62) to (56, 66) layers F.Cu',
    );
    expect(outline('(gr_arc (start 0 10) (mid 10 0) (end 20 10) (layer "Edge.Cuts"))')).toBe(
      'board outline (0, 0) to (20, 10) layers F.Cu',
    );
  });

  it('does not depend on the order footprints appear in the file', () => {
    const start = board.indexOf('\t(footprint "Resistor_SMD');
    const end = board.indexOf('\t(footprint "MountingHole');
    const r1 = board.slice(start, end);
    const reordered = board.slice(0, start) + board.slice(end).replace('\t(gr_rect', r1 + '\t(gr_rect');
    expect(boardText(reordered)).toBe(boardText(board));
  });
});
