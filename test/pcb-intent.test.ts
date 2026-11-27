/**
 * The intent layer, deterministic parts (RFC 11 §7.3, §7.5, §10.2; Phase 4
 * tasks 6.1, 6.2, 6.5): the intent language parser, ECAD ingestion, and the
 * intent checker on the golden boards that carry intent.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { parseIntent, intentToRegistry } from '../src/pcb/intent/language.js';
import { ecadConstraints, mergeEcad } from '../src/pcb/intent/ecad.js';
import { loadConstraints } from '../src/pcb/intent/load.js';
import { checkIntent } from '../src/pcb/verify/checkers/intent.js';
import { verifyDesign } from '../src/pcb/verify/index.js';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { mmToNm } from '../src/pcb/ir/units.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GOLDEN = path.join(ROOT, 'test', 'fixtures', 'microboards');

async function design(caseName: string) {
  const p = path.join(GOLDEN, caseName, 'board.kicad_pcb');
  return { p, design: importBoard({ boardText: await readFile(p, 'utf8'), boardPath: p, projectText: await readFile(p.replace(/\.kicad_pcb$/, '.kicad_pro'), 'utf8'), now: 't' }).design };
}

describe('intent language', () => {
  it('parses the RFC example into registry entries with units in the keys', () => {
    const yaml = `placement:\n  fixed:\n    - component: J1\n      edge: north\n      orientation: outward\n    - component: H1\n      at: [10, 20.5]\n      rotation_deg: 90\n  attachments:\n    - component: C12\n      target: { component: U1, pins: [VDD, GND] }\n      max_distance_mm: 2.0\n      priority: critical\n  groups:\n    - id: ldo_stage\n      components: [U2, C5, C6]\n      topology: datasheet_reference\n  separation:\n    - groups: [analog_frontend, digital]\n      minimum_mm: 10\n  keepouts:\n    - region: mounting_hole_ring\n      prohibit: [components, copper]\nrouting:\n  priorities:\n    - [3V3, GND]\n    - [remaining]\n`;
    const parsed = parseIntent(yaml);
    expect(parsed.unknown).toEqual([]);
    expect(parsed.errors).toEqual([]);
    const reg = intentToRegistry(parsed);
    expect(Object.keys(reg).sort()).toEqual(['layout.functional.group.ldo_stage', 'layout.functional.separation.analog_frontend-digital', 'layout.manufacturing.keepout.mounting_hole_ring', 'layout.mechanical.edge.J1', 'layout.mechanical.fixed.H1', 'layout.relative.attached.C12', 'layout.routing.priority']);
    expect(reg['layout.mechanical.edge.J1']).toMatchObject({ class: 'mechanical', severity: 'hard', scope: { refs: ['J1'] }, parameters: { edge: 'north', orientation: 'outward' } });
    expect(reg['layout.mechanical.fixed.H1']!.parameters).toEqual({ x_nm: 10_000_000, y_nm: 20_500_000, rotation_mdeg: 90_000 });
    expect(reg['layout.relative.attached.C12']).toMatchObject({ severity: 'hard', scope: { refs: ['C12', 'U1'] }, parameters: { target: 'U1', pins: ['VDD', 'GND'], max_distance_nm: 2_000_000, priority: 'critical' } });
    expect(reg['layout.functional.separation.analog_frontend-digital']!.parameters).toEqual({ groups: ['analog_frontend', 'digital'], min_nm: 10_000_000 });
    expect(JSON.parse(reg['layout.routing.priority']!.parameters!.order as string)).toEqual([['3V3', 'GND'], ['remaining']]);
  });
  it('reports unknown keys and malformed entries instead of ignoring them', () => {
    const parsed = parseIntent('placement:\n  fixed:\n    - component: J1\n      side: left\n    - edge: west\n  cooling: []\nfoo: 1\n');
    expect(parsed.unknown).toEqual(['foo', 'placement.cooling', 'placement.fixed[0].side']);
    expect(parsed.errors).toEqual(['placement.fixed[0]: J1 needs an edge or an at', 'placement.fixed[1]: no component']);
  });
});

describe('ECAD ingestion', () => {
  it('derives routing classes, locked parts, and keepout areas; a contradicting hand entry is reported', async () => {
    const { design: d } = await design('keepout');
    // a KiCad rule area on the board (the golden keepout carries its ring as intent instead)
    d.board.keepouts.push({ id: 'ra1', polygon: { outer: [{ x: 102e6, y: 102e6 }, { x: 112e6, y: 102e6 }, { x: 112e6, y: 112e6 }, { x: 102e6, y: 112e6 }], holes: [] }, layers: ['F.Cu', 'B.Cu'], prohibits: ['tracks', 'vias', 'pads', 'footprints', 'copper'] });
    const ecad = ecadConstraints(d);
    expect(ecad['layout.routing.class.Default.width']).toMatchObject({ source: 'ecad_rules', class: 'routing', severity: 'hard', parameters: { width_nm: d.board.rules.trackWidthNm } });
    const keep = Object.entries(ecad).filter(([k]) => k.startsWith('layout.manufacturing.keepout.'));
    expect(keep).toHaveLength(1);
    expect(keep[0]![1].parameters!.prohibit).toContain('footprints');
    d.components[0]!.attributes.locked = true;
    expect(ecadConstraints(d)[`layout.mechanical.fixed.${d.components[0]!.reference}`]).toBeDefined();
    const hand = { 'layout.routing.class.Default.width': { source: 'intent', affects: ['board'], class: 'routing' as const, severity: 'hard' as const, scope: {}, parameters: { width_nm: 1 }, priority: 1, confidence: 1 } };
    const merged = mergeEcad(hand, ecad);
    expect(merged.contradictions).toEqual([{ key: 'layout.routing.class.Default.width', theirs: 'intent' }]);
    expect(merged.registry['layout.routing.class.Default.width']!.parameters!.width_nm).toBe(1);
  });
});

describe('intent checker on the golden boards', () => {
  it('fixed-connector: J1 constrained to the west edge sits mid-board', async () => {
    const { p, design: d } = await design('fixed-connector');
    const { registry, intentPath } = await loadConstraints(d, p);
    expect(intentPath).toMatch(/intent\.yaml$/);
    const r = checkIntent(d, registry);
    const edge = r.diagnostics.filter((x) => x.code === 'intent.mechanical.edge');
    expect(edge).toHaveLength(1);
    expect(edge[0]!).toMatchObject({ severity: 'error', entityReferences: ['J1'] });
    expect(edge[0]!.measured!.value).toBeGreaterThan(mmToNm(3));
    expect(r.diagnostics.some((x) => x.code === 'intent.mechanical.orientation' && x.severity === 'info')).toBe(true);
    const v = verifyDesign({ design: d, constraints: registry });
    expect(v.gates.placement.passed).toBe(false);
    expect(v.metrics.intent_hard_violations).toBe(1);
    // moved onto the edge, it passes
    const j1 = d.components.find((c) => c.reference === 'J1')!;
    const ob = d.board.outline.outer;
    const minX = Math.min(...ob.map((q) => q.x));
    const pads = j1.pads.map((q) => q.copper.outer.map((pt) => pt.x)).flat();
    const shift = Math.min(...pads) - minX - mmToNm(1);
    for (const pad of j1.pads) {
      pad.at = { x: pad.at.x - shift, y: pad.at.y };
      pad.copper = { outer: pad.copper.outer.map((pt) => ({ x: pt.x - shift, y: pt.y })), holes: [] };
    }
    if (j1.footprint.courtyard) j1.footprint.courtyard = { outer: j1.footprint.courtyard.outer.map((pt) => ({ x: pt.x - shift, y: pt.y })), holes: [] };
    j1.at = { x: j1.at.x - shift, y: j1.at.y };
    expect(checkIntent(d, registry).diagnostics.filter((x) => x.code === 'intent.mechanical.edge')).toEqual([]);
  });
  it('decoupling-far: C1 must sit within 2 mm of U1 pins 8 and 4 and is 20 mm away', async () => {
    const { p, design: d } = await design('decoupling-far');
    const { registry } = await loadConstraints(d, p);
    const r = checkIntent(d, registry);
    const att = r.diagnostics.filter((x) => x.code === 'intent.relative.attached');
    expect(att).toHaveLength(1);
    expect(att[0]!.entityReferences).toEqual(['C1', 'U1']);
    expect(att[0]!.measured!.value).toBeGreaterThan(mmToNm(10));
    expect(att[0]!.allowed).toEqual({ value: 2_000_000, unit: 'nm', relation: '<=' });
  });
  it('keepout: R2 lies in the 3.5 mm ring around H1 declared in intent.yaml', async () => {
    const { p, design: d } = await design('keepout');
    const { registry, intentPath } = await loadConstraints(d, p);
    expect(intentPath).toMatch(/intent\.yaml$/);
    expect(registry['layout.manufacturing.keepout.mounting_hole_ring']!.parameters!.radius_nm).toBe(3_500_000);
    const r = checkIntent(d, registry);
    const k = r.diagnostics.filter((x) => x.code === 'intent.manufacturing.keepout');
    expect(k.map((x) => x.entityReferences[0])).toEqual(['R2']);
    expect(verifyDesign({ design: d, constraints: registry }).gates.placement.passed).toBe(false);
  });
  it('functional group spread and region, and separation', async () => {
    const { design: d } = await design('completion');
    const reg = intentToRegistry(parseIntent('placement:\n  groups:\n    - id: mcu\n      components: [U1, C1, Y1]\n      max_spread_mm: 1\n    - id: io\n      components: [J1, R2]\n  separation:\n    - groups: [mcu, io]\n      minimum_mm: 30\n'));
    const r = checkIntent(d, reg);
    expect(r.diagnostics.find((x) => x.code === 'intent.functional.group.spread')).toMatchObject({ severity: 'warning' });
    expect(r.diagnostics.find((x) => x.code === 'intent.functional.separation')).toMatchObject({ severity: 'error' });
    expect(r.metrics.intent_soft_violations).toBe(1);
    expect(r.metrics.intent_hard_violations).toBe(1);
  });
});

describe('copperhead pcb verify with intent', () => {
  it('refuses decoupling-far on the attachment and names the intent file', async () => {
    const out = await execa('npx', ['tsx', 'src/cli.ts', '--json', '--repo', ROOT, 'pcb', 'verify', path.join(GOLDEN, 'decoupling-far', 'board.kicad_pcb'), '--no-kicad'], { cwd: ROOT, reject: false });
    const j = JSON.parse(out.stdout);
    expect(j.status).toBe('REFUSE');
    expect(j.intent).toBe('test/fixtures/microboards/decoupling-far/intent.yaml');
    expect(j.diagnostics.some((x: { code: string }) => x.code === 'intent.relative.attached')).toBe(true);
  }, 120_000);
});
