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

  it('keeps the identifier of a part placed only on the board when it is renumbered', () => {
    const renumbered = imported(board.replace('(property "Reference" "H1"', '(property "Reference" "H2"'));
    expect(byRef(renumbered, 'H2')[0]).toBe(byRef(li, 'H1')[0]);
  });

  it('does not depend on the order of the file', () => {
    const start = board.indexOf('\t(footprint "Resistor_SMD');
    const end = board.indexOf('\t(footprint "MountingHole');
    const reordered = board.slice(0, start) + board.slice(end).replace('\t(gr_rect', board.slice(start, end) + '\t(gr_rect');
    const a = { ...li, parent: null };
    const b = { ...imported(reordered), parent: null };
    expect(contentHash(b)).toBe(contentHash(a));
  });

  it('draws the same outline whatever order and direction its edges are in', () => {
    const rect = board.slice(board.indexOf('\t(gr_rect'), board.indexOf('\t(segment'));
    const line = (a: string, b: string) => `\t(gr_line (start ${a}) (end ${b}) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))\n`;
    const one = board.replace(rect, line('0 0', '30 0') + line('30 0', '30 20') + line('30 20', '0 20') + line('0 20', '0 0'));
    const other = board.replace(rect, line('0 20', '30 20') + line('0 0', '0 20') + line('30 0', '30 20') + line('30 0', '0 0'));
    expect(imported(one).board.outline).toEqual(li.board.outline);
    expect(imported(other).board.outline).toEqual(li.board.outline);
    expect(li.board.outline[0]).toEqual({ x: 0, y: 0 });
  });

  it('knows routing by its KiCad identifier, or else by its content, never by file order', () => {
    const lines = board.split('\n');
    const s1 = lines.find((l) => l.startsWith('\t(segment (start 19.225 7)'))!;
    const s2 = lines.find((l) => l.startsWith('\t(segment (start 9.9 8.6)'))!;
    // Each identifier with the segment it names, so swapped identifiers show.
    const traceIds = (text: string) =>
      Object.entries(imported(text).routing.traces)
        .map(([id, t]) => `${id} ${t.start.x},${t.start.y}`)
        .sort();
    const kicad5 = (s: string) => s.replace('(uuid', '(tstamp');
    const anonymous = (s: string) => s.replace(/ \(uuid "[^"]+"\)/, '');
    for (const variant of [kicad5, anonymous]) {
      const [v1, v2] = [variant(s1), variant(s2)];
      const text = board.replace(s1, v1).replace(s2, v2);
      const swapped = text.replace(`${v1}\n${v2}`, `${v2}\n${v1}`);
      expect(swapped).not.toBe(text);
      expect(traceIds(text)).toHaveLength(2);
      expect(traceIds(swapped)).toEqual(traceIds(text));
    }
  });

  it('says that it leaves out copper on no net', () => {
    const stray = '\t(segment (start 1 1) (end 2 1) (width 0.25) (layer "F.Cu") (net 0) (uuid "6f1d4a6e-1b2c-4d3e-9f40-5a6b7c8d9e69"))\n';
    const withStray = imported(board.replace('\t(via', stray + '\t(via'));
    expect(Object.keys(withStray.routing.traces)).toHaveLength(2);
    expect(withStray.board.lossy).toContain('traces and vias on no net are not imported');
    expect(li.board.lossy).not.toContain('traces and vias on no net are not imported');
  });

  it('keeps a zone fill out of the zone, so a refill changes nothing', () => {
    const fill = '\t\t(filled_polygon (layer "B.Cu") (pts (xy 0.5 0.5) (xy 29.5 0.5) (xy 29.5 19.5)))\n';
    const anchor = '\t\t(polygon\n\t\t\t(pts (xy 0 0) (xy 30 0) (xy 30 20) (xy 0 20))\n\t\t)\n';
    expect(board).toContain(anchor);
    const refilled = imported(board.replace(anchor, anchor + fill));
    expect(refilled.routing.zones).toEqual(li.routing.zones);
    expect(placementDiff(li, { input: refilled }).copper).toBeUndefined();
  });

  it('says that it leaves out edge cuts drawn inside footprints', () => {
    const edge = '\t\t(fp_circle (center 0 0) (end 1.6 0) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))\n';
    const withEdge = imported(board.replace('\t\t(property "Reference" "H1"', edge + '\t\t(property "Reference" "H1"'));
    expect(withEdge.board.lossy).toContain('edge cuts drawn inside footprints are not part of the imported outline or cutouts');
  });

  it('bounds a circular courtyard by its whole circle', () => {
    const circle = '\t\t(fp_circle (center 0 0) (end 3.45 0) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))\n';
    const withCircle = imported(board.replace('\t\t(property "Reference" "H1"', circle + '\t\t(property "Reference" "H1"'));
    const def = withCircle.footprints[byRef(withCircle, 'H1')[1].footprint]!;
    const ring = JSON.stringify(def.courtyard);
    for (const v of [-3_450_000, 3_450_000]) expect(ring).toContain(String(v));
  });

  it('says that it leaves out zones inside footprints', () => {
    const zone = '\t\t(zone (net 0) (net_name "") (layer "F.Cu") (hatch edge 0.5) (keepout (tracks not_allowed)) (polygon (pts (xy 2 2) (xy 4 2) (xy 4 4))))\n';
    const withZone = imported(board.replace('\t\t(property "Reference" "H1"', zone + '\t\t(property "Reference" "H1"'));
    expect(withZone.board.lossy).toContain('zones inside footprints, keepouts among them, are not imported');
    expect(li.board.lossy).not.toContain('zones inside footprints, keepouts among them, are not imported');
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

  it('imports two differently named boards under one project, and says what neither could represent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pcb-diff-'));
    writeFileSync(path.join(dir, 'old.kicad_pcb'), board);
    writeFileSync(path.join(dir, 'new.kicad_pcb'), moveR1(board));
    const res = await pcbDiff(path.join(dir, 'old.kicad_pcb'), path.join(dir, 'new.kicad_pcb'));
    expect(res.diff.components.map((r) => [r.refdes, r.changes])).toEqual([['R1', ['moved', 'rotated']]]);
    expect(res.text.split('\n')[0]).toMatch(/: 1 changed$/);
    expect(res.notes).toContain('the fabrication profile is not in the board file');
  });
});

function contentHashOfBytes(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
