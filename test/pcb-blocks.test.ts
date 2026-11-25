/**
 * Functional blocks and the staged placement plan (RFC 11 §7.7, §8.5; Phase 3
 * task 5.2a): deterministic derivation from SUBSYSTEMS.md and the schematic
 * intent, anchors at region centroids before the wrapped placer, and the
 * registry entries. The staged run uses the harness placer and skips without kicad-cli.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { deriveBlocks, blocksToConstraints, subsystemHeadings, slugify, connectorEdgeConstraints, wantsBoardEdge } from '../src/pcb/intent/blocks.js';
import { placeBoard } from '../src/pcb/engines/place.js';
import { defaultRegistry as routerRegistry } from '../src/pcb/engines/route.js';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { centroid, bbox } from '../src/pcb/ir/geometry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GOLDEN = path.join(ROOT, 'test', 'fixtures', 'microboards');
const SUBSYSTEMS = '# Subsystems\n\n## Power\n\nRegulator and its capacitor.\n\n## MCU\n\nThe controller and its crystal.\n';
const INTENT = { version: 1, parts: [{ ref: 'U1', libId: 'x', value: 'x', group: 'MCU' }, { ref: 'Y1', libId: 'x', value: 'x', group: 'MCU' }, { ref: 'C1', libId: 'x', value: 'x', group: 'Power' }, { ref: 'R1', libId: 'x', value: 'x', group: 'Power' }], nets: [] };

async function haveKicad(): Promise<boolean> {
  try {
    await execa('kicad-cli', ['version']);
    return true;
  } catch {
    return false;
  }
}

async function completion() {
  const p = path.join(GOLDEN, 'completion', 'board.kicad_pcb');
  return { p, design: importBoard({ boardText: await readFile(p, 'utf8'), boardPath: p, now: 't' }).design };
}

describe('deriveBlocks', () => {
  it('reads headings, maps parts by group, picks the IC as anchor, and leaves the rest unassigned with a note', async () => {
    const { design } = await completion();
    expect(subsystemHeadings(SUBSYSTEMS)).toEqual(['Power', 'MCU']);
    expect(slugify(' USB / Power! ')).toBe('usb-power');
    const blocks = deriveBlocks({ design, subsystemsMd: SUBSYSTEMS, schematicIntent: INTENT });
    const ref = (id: string | null) => design.components.find((c) => c.id === id)?.reference;
    expect(blocks.map((b) => b.id)).toEqual(['power', 'mcu', 'unassigned']);
    const mcu = blocks.find((b) => b.id === 'mcu')!;
    expect(ref(mcu.anchor)).toBe('U1'); // the only part with >= 8 pads
    expect(mcu.members.map(ref).sort()).toEqual(['U1', 'Y1']);
    expect(mcu.spreadBudgetNm).toBeGreaterThan(0);
    const power = blocks.find((b) => b.id === 'power')!;
    expect(power.notes[0]).toMatch(/no IC in the block/);
    expect(['C1', 'R1']).toContain(ref(power.anchor));
    const un = blocks.find((b) => b.id === 'unassigned')!;
    expect(un.members.map(ref).sort()).toEqual(['J1', 'R2']);
    expect(un.notes.some((n) => /name no subsystem/.test(n))).toBe(true);
    // J1 sits on the east edge: every named block gets a signal-flow slot; unassigned never does
    expect(mcu.region).not.toBeNull();
    expect(power.region).not.toBeNull();
    expect(un.region).toBeNull();
    expect(centroid(mcu.region!).x).not.toBe(centroid(power.region!).x);
    // deterministic
    expect(deriveBlocks({ design, subsystemsMd: SUBSYSTEMS, schematicIntent: INTENT })).toEqual(blocks);
  });
  it('without an edge connector no region is assigned, and without intent everything is unassigned', async () => {
    const { design } = await completion();
    const j1 = design.components.find((c) => c.reference === 'J1')!;
    j1.reference = 'U9'; // no longer a connector by refdes...
    j1.footprint.libId = 'Package_SO:Whatever'; // ...nor by footprint
    const blocks = deriveBlocks({ design, subsystemsMd: SUBSYSTEMS, schematicIntent: INTENT });
    expect(blocks.every((b) => b.region === null)).toBe(true);
    expect(blocks[0]!.notes.some((n) => /no edge connector/.test(n))).toBe(true);
    const none = deriveBlocks({ design, subsystemsMd: null, schematicIntent: null });
    expect(none.map((b) => b.id)).toEqual(['unassigned']);
    expect(none[0]!.members).toHaveLength(6);
  });
  it('emits one soft functional.group constraint per named block with refdes scope', async () => {
    const { design } = await completion();
    const blocks = deriveBlocks({ design, subsystemsMd: SUBSYSTEMS, schematicIntent: INTENT });
    const reg = blocksToConstraints(blocks, design);
    expect(Object.keys(reg).sort()).toEqual(['layout.functional.group.mcu', 'layout.functional.group.power']);
    const mcu = reg['layout.functional.group.mcu']!;
    expect(mcu).toMatchObject({ class: 'functional', severity: 'soft', affects: ['board'], confidence: 1 });
    expect(mcu.scope!.refs!.sort()).toEqual(['U1', 'Y1']);
    expect(mcu.parameters!.anchor).toBe('U1');
    expect(typeof mcu.parameters!.region).toBe('string');
    expect(JSON.parse(mcu.parameters!.region as string)).toHaveLength(4);
  });
});

describe('connectorEdgeConstraints', () => {
  // the fixture's J1 names no subsystem, so give it one: the rule reads the
  // block regions, and only a named block ever gets a region
  const WITH_J1 = { ...INTENT, parts: [...INTENT.parts, { ref: 'J1', libId: 'x', value: 'x', group: 'Power' }] };
  it('gives every connector the edge its block region is nearest, with the region centre along it', async () => {
    const { design } = await completion();
    const blocks = deriveBlocks({ design, subsystemsMd: SUBSYSTEMS, schematicIntent: WITH_J1 });
    const reg = connectorEdgeConstraints(blocks, design);
    const ob = bbox(design.board.outline);
    expect(Object.keys(reg).length).toBeGreaterThan(0);
    for (const [key, c] of Object.entries(reg)) {
      expect(key).toMatch(/^layout\.mechanical\.edge\./);
      expect(c).toMatchObject({ class: 'mechanical', severity: 'hard', approvedBy: 'rule' });
      expect(['north', 'south', 'east', 'west']).toContain(c.parameters!.edge);
      // the along-edge coordinate is a real board coordinate on the free axis
      const along = c.parameters!.along_nm as number;
      const horizontal = c.parameters!.edge === 'west' || c.parameters!.edge === 'east';
      expect(along).toBeGreaterThanOrEqual(horizontal ? ob.minY : ob.minX);
      expect(along).toBeLessThanOrEqual(horizontal ? ob.maxY : ob.maxX);
    }
    expect(connectorEdgeConstraints(blocks, design)).toEqual(reg); // deterministic
  });
  it('leaves a stated edge or fixed position alone, and never claims a switch, hole or test point', async () => {
    const { design } = await completion();
    const blocks = deriveBlocks({ design, subsystemsMd: SUBSYSTEMS, schematicIntent: INTENT });
    const conn = design.components.find((c) => wantsBoardEdge(c))!;
    expect(conn.reference).toBe('J1');
    const blocksJ1 = deriveBlocks({ design, subsystemsMd: SUBSYSTEMS, schematicIntent: WITH_J1 });
    expect(Object.keys(connectorEdgeConstraints(blocksJ1, design))).toEqual(['layout.mechanical.edge.J1']);
    // user intent wins, by either key
    expect(connectorEdgeConstraints(blocksJ1, design, { [`layout.mechanical.edge.${conn.reference}`]: { source: 'intent', affects: ['board'], class: 'mechanical', severity: 'hard', scope: { refs: [conn.reference] }, parameters: { edge: 'north' }, priority: 90, confidence: 1, approvedBy: 'user' } })).toEqual({});
    expect(connectorEdgeConstraints(blocksJ1, design, { [`layout.mechanical.fixed.${conn.reference}`]: { source: 'intent', affects: ['board'], class: 'mechanical', severity: 'hard', scope: { refs: [conn.reference] }, parameters: { x_nm: 1, y_nm: 2 }, priority: 100, confidence: 1, approvedBy: 'user' } })).toEqual({});
    // a button is `mechanical` to the classifier and a connector to the refdes
    // pattern, but it belongs beside the IC it interrupts, not on the perimeter
    for (const [ref, lib] of [['SW1', 'Button_Switch_SMD:SW_Push'], ['H1', 'MountingHole:MountingHole_3.2mm'], ['TP1', 'TestPoint:TestPoint_Pad_D1.0mm']] as const) {
      const c = { ...conn, reference: ref, footprint: { ...conn.footprint, libId: lib }, semanticRoles: [] };
      expect(wantsBoardEdge(c)).toBe(false);
    }
  });
  it('yields nothing when the blocks have no regions', async () => {
    const { design } = await completion();
    const blocks = deriveBlocks({ design, subsystemsMd: SUBSYSTEMS, schematicIntent: WITH_J1 }).map((b) => ({ ...b, region: null }));
    expect(connectorEdgeConstraints(blocks, design)).toEqual({});
  });
  it('says nothing about a connector that names no subsystem: `unassigned` never gets a region', async () => {
    const { design } = await completion();
    // the documented limit of the rule, not an oversight: the edge comes from
    // the block region, and a part in no subsystem is in no region
    const blocks = deriveBlocks({ design, subsystemsMd: SUBSYSTEMS, schematicIntent: INTENT });
    expect(blocks.find((b) => b.id === 'unassigned')!.members.map((id) => design.components.find((c) => c.id === id)!.reference)).toContain('J1');
    expect(connectorEdgeConstraints(blocks, design)).toEqual({});
  });
});

describe('staged placement plan', () => {
  it('places each anchor at its region centroid and locks it before the wrapped placer runs', async () => {
    if (!(await haveKicad())) return;
    const { design } = await completion();
    const blocks = deriveBlocks({ design, subsystemsMd: SUBSYSTEMS, schematicIntent: INTENT });
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-staged-place-'));
    try {
      const res = await placeBoard({ repoRoot: ROOT, boardPath: path.join(GOLDEN, 'completion', 'board.kicad_pcb'), runDir: path.join(dir, 'run'), placers: ['placer-reference'], policy: { network: 'none', allowHarnessEngines: true, denyLicenses: [] }, probe: { routerId: 'router-reference', registry: routerRegistry(ROOT) }, blocks, limits: { engineSeconds: 120, wallSeconds: 120 } });
      expect(res.outcome.status).toBe('PASS');
      expect(res.plan!.stages.map((s) => s.name)).toEqual(['fixed', 'anchors', 'attach', 'bulk']);
      const anchors = res.plan!.stages[1]!.componentIds;
      expect(anchors).toHaveLength(2); // U1 for mcu, the power anchor
      expect(res.movableIds).not.toContain(anchors[0]);
      expect(existsSync(path.join(res.runDir, 'plan.json'))).toBe(true);
      const cand = res.candidates[0]!;
      const mcu = blocks.find((b) => b.id === 'mcu')!;
      const u1 = cand.design.components.find((c) => c.id === mcu.anchor)!;
      const want = centroid(mcu.region!);
      expect(Math.abs(u1.at.x - want.x)).toBeLessThan(2000);
      expect(Math.abs(u1.at.y - want.y)).toBeLessThan(2000);
      expect(cand.verify.gates.placement.passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('copperhead pcb place --blocks derives the blocks from the repo docs', async () => {
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-blockscli-'));
    try {
      await mkdir(path.join(dir, 'hardware'), { recursive: true });
      await mkdir(path.join(dir, 'docs'), { recursive: true });
      await mkdir(path.join(dir, '.copperhead'), { recursive: true });
      await cp(path.join(GOLDEN, 'completion', 'board.kicad_pcb'), path.join(dir, 'hardware', 'board.kicad_pcb'));
      await cp(path.join(GOLDEN, 'completion', 'board.kicad_pro'), path.join(dir, 'hardware', 'board.kicad_pro'));
      await writeFile(path.join(dir, 'hardware', 'schematic.intent.json'), JSON.stringify(INTENT), 'utf8');
      await writeFile(path.join(dir, 'docs', 'SUBSYSTEMS.md'), SUBSYSTEMS, 'utf8');
      await writeFile(path.join(dir, '.copperhead', 'config.json'), JSON.stringify({ board: 'hardware/board.kicad_pcb', schematic: 'hardware/board.kicad_sch', docs: 'docs/', pcb: { allowHarnessEngines: true } }), 'utf8');
      const out = await execa('npx', ['tsx', path.join(ROOT, 'src', 'cli.ts'), '--json', '--repo', dir, 'pcb', 'place', '--placers', 'placer-reference', '--blocks', '--probe-router', 'router-reference', '--run-dir', '.copperhead/runs/p/placement', '--budget-seconds', '120'], { cwd: ROOT, reject: false });
      expect(out.exitCode, out.stderr).toBe(0);
      const j = JSON.parse(out.stdout);
      expect(j.status).toBe('PASS');
      expect(j.plan.blocks.map((b: { id: string }) => b.id)).toEqual(['power', 'mcu', 'unassigned']);
      expect(j.plan.stages[1]).toMatchObject({ name: 'anchors', parts: 2 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
