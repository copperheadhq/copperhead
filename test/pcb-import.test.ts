import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { contentHash, Identifiers, importKicadBoard, placementDiff, renderDiffText, uuid5, type LayoutInput } from '../src/pcb-ir/index.js';
import { pcbDiff } from '../src/commands/pcb.js';

/**
 * The KiCad import (RFC 11 Section 5.1): a board compiled directly into a
 * layout input, under the same schema and RFC 3 Section 4.2 identifiers.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, 'fixtures/pcb-ir/ldo.kicad_pcb');
const SCHEMAS = path.join(HERE, '../src/pcb-ir/schemas/rfc11');
const board = readFileSync(BOARD, 'utf8');
const imported = (text: string) => importKicadBoard(text, { projectId: 'ldo', path: 'ldo.kicad_pcb' });
const byRef = (li: LayoutInput, ref: string) => Object.entries(li.components).find(([, c]) => c.refdes === ref)!;

/** R1 turned to 180 degrees and moved, its pads turned with it, as KiCad writes them. */
const moveR1 = (text: string) =>
  text
    .replace('\t\t(at 20 7)\n', '\t\t(at 21.5 7.25 180)\n')
    .replace('(pad "1" smd roundrect (at -0.775 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 3 "+3V3"))', '(pad "1" smd roundrect (at -0.775 0 180) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 3 "+3V3"))')
    .replace('(pad "2" smd roundrect (at 0.775 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 4 "LED_K"))', '(pad "2" smd roundrect (at 0.775 0 180) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (net 4 "LED_K"))');

describe('importing a KiCad board into a layout input', () => {
  const li = imported(board);

  it('derives identifiers as RFC 3 Section 4.2 does', () => {
    // The RFC's example board derives PCB-217f1404b81d for board:board in project ldo-board.
    expect(new Identifiers('ldo-board').id('PCB', 'board')).toBe('PCB-217f1404b81d');
    expect(uuid5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('produces a layout input that validates against the RFC 11 schema', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    for (const f of readdirSync(SCHEMAS).filter((n) => n.endsWith('.schema.json'))) {
      ajv.addSchema(JSON.parse(readFileSync(path.join(SCHEMAS, f), 'utf8')));
    }
    const validate = ajv.getSchema('https://github.com/copperheadhq/copperhead-rfcs/schemas/rfc11/2.0/layout-input.schema.json')!;
    expect(validate(li), JSON.stringify(validate.errors)).toBe(true);
  });

  it('keys each footprint definition by its hash, shared by parts that use it', () => {
    for (const [key, def] of Object.entries(li.footprints)) expect(contentHash(def)).toBe(key);
    expect(byRef(li, 'C1')[1].footprint).toBe(byRef(li, 'C2')[1].footprint);
    expect(Object.keys(li.footprints)).toHaveLength(4);
  });

  it('records what it imports and what it could not', () => {
    const [, u1] = byRef(li, 'U1');
    expect(u1).toMatchObject({ pose: { x: 10_780_000, y: 10_000_000, rot: { q: 1 } }, side: 'front', owner: 'import', locked: false });
    expect(byRef(li, 'H1')[1].locked).toBe(true);
    expect(Object.values(li.nets).map((n) => n.name).sort()).toEqual(['+3V3', 'GND', 'LED_K', 'VIN']);
    expect(Object.keys(li.routing.traces)).toHaveLength(2);
    expect(Object.keys(li.routing.vias)).toHaveLength(1);
    expect(Object.values(li.routing.zones)[0]!.definition.startsWith('(zone')).toBe(true);
    expect(li.board.outline).toHaveLength(4);
    expect(li.board.lossy).toContain('the fabrication profile is not in the board file');
    expect(li.parent).toEqual({ imported: [{ path: 'ldo.kicad_pcb', hash: 'sha256:' + contentHashOfBytes(board) }] });
  });

  it("keeps a part's identifier when it is renumbered", () => {
    const renumbered = imported(board.replace('(property "Reference" "R1"', '(property "Reference" "R7"'));
    expect(byRef(renumbered, 'R7')[0]).toBe(byRef(li, 'R1')[0]);
  });

  it('does not depend on the order of the file', () => {
    const start = board.indexOf('\t(footprint "Resistor_SMD');
    const end = board.indexOf('\t(footprint "MountingHole');
    const reordered = board.slice(0, start) + board.slice(end).replace('\t(gr_rect', board.slice(start, end) + '\t(gr_rect');
    const a = { ...li, parent: null };
    const b = { ...imported(reordered), parent: null };
    expect(contentHash(b)).toBe(contentHash(a));
  });
});

describe('diffing two boards', () => {
  it('shows a moved and turned part, owned by the importer', () => {
    const before = imported(board);
    const after = imported(moveR1(board));
    const d = placementDiff(before, { input: after });
    expect(d.components.map((r) => [r.refdes, r.changes, r.owner])).toEqual([['R1', ['moved', 'rotated'], 'import']]);
    expect(renderDiffText(d, { before, after }).split('\n')[1]).toBe(
      '  ~ R1 1k moved 1.520691 mm (20, 7) -> (21.5, 7.25), rotated 0 -> 180',
    );
  });

  it('compares a board with itself at an earlier git revision', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pcb-diff-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(path.join(dir, 'board.kicad_pcb'), board);
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
    writeFileSync(path.join(dir, 'board.kicad_pcb'), moveR1(board));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const res = await pcbDiff('HEAD:board.kicad_pcb', 'board.kicad_pcb');
      expect(res.text.split('\n')[0]).toMatch(/^diff [0-9a-f]{8} -> input [0-9a-f]{8}: 1 changed$/);
      expect(res.diff.components[0]!.refdes).toBe('R1');
    } finally {
      process.chdir(cwd);
    }
  });
});

function contentHashOfBytes(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
