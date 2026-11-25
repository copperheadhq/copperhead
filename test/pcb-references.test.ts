/**
 * Reference layout retrieval, local sources (RFC 11 §8.6; Phase 3 task 5.2b):
 * blocks cut from a source board around a similar part, scored, cached under
 * .copperhead/layout-refs, held for approval when the license requires it,
 * applied as stage-3 inputs. The teardown source reads RFC 1 pattern files.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { LocalDesignSource, TeardownSource, findReferences, applicable, toStageInputs, readCache, approveReference, cutBlock, localBoards } from '../src/pcb/intent/references.js';
import { needsApproval, normalizeLicense } from '../src/pcb/intent/licenses.js';
import { deriveBlocks } from '../src/pcb/intent/blocks.js';
import { importBoard } from '../src/pcb/ir/kicad/import.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GOLDEN = path.join(ROOT, 'test', 'fixtures', 'microboards');
const SUBSYSTEMS = '# Subsystems\n\n## MCU\n\n## Power\n';
const INTENT = { version: 1, parts: [{ ref: 'U1', libId: 'x', value: 'x', group: 'MCU' }, { ref: 'C1', libId: 'x', value: 'x', group: 'MCU' }, { ref: 'R1', libId: 'x', value: 'x', group: 'MCU' }, { ref: 'Y1', libId: 'x', value: 'x', group: 'MCU' }, { ref: 'R2', libId: 'x', value: 'x', group: 'Power' }], nets: [] };

async function haveKicad(): Promise<boolean> {
  try {
    await execa('kicad-cli', ['version']);
    return true;
  } catch {
    return false;
  }
}

async function design(caseName: string) {
  const p = path.join(GOLDEN, caseName, 'board.kicad_pcb');
  return importBoard({ boardText: await readFile(p, 'utf8'), boardPath: p, now: 't' }).design;
}

describe('license policy', () => {
  it('permissive licenses apply; copyleft, share-alike, and unknown need an approver', () => {
    for (const l of ['MIT', 'mit', 'Apache-2.0', 'BSD-3-Clause', 'CC0-1.0', 'CERN-OHL-P-2.0']) expect(needsApproval(l), l).toBe(false);
    for (const l of ['GPL-3.0-only', 'CC-BY-SA-4.0', 'CERN-OHL-S-2.0', 'unknown', '']) expect(needsApproval(l), l).toBe(true);
    expect(normalizeLicense('apache-2.0')).toBe('Apache-2.0');
  });
});

describe('design source', () => {
  it('cuts the block around a matching part, maps members, scores it, and caches it with the license', async () => {
    const d = await design('completion');
    const blocks = deriveBlocks({ design: d, subsystemsMd: SUBSYSTEMS, schematicIntent: INTENT });
    const mcu = blocks.find((b) => b.id === 'mcu')!;
    const u1 = d.components.find((c) => c.id === mcu.anchor)!;
    const cut = cutBlock(d, u1);
    expect(cut.members.map((m) => m.reference).sort()).toEqual(['C1', 'R1', 'R2', 'Y1']); // everything within 15 mm sharing a net (J1 sits farther)
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-refs-'));
    try {
      const src = new LocalDesignSource([{ path: path.join(GOLDEN, 'completion', 'board.kicad_pcb'), license: 'MIT' }], 'now');
      const res = await findReferences(d, blocks, { repoRoot: dir, sources: [src] });
      expect(res.searched).toBe(2); // mcu and power anchors
      const hit = res.blocks.find((b) => b.target.anchorRef === 'U1')!;
      expect(hit.similarity.footprint).toBe(true);
      expect(hit.similarity.score).toBeGreaterThanOrEqual(0.5);
      expect(hit.members.map((m) => m.ref).sort()).toEqual(['C1', 'R1', 'Y1']); // the block's own members, mapped by footprint and value
      expect(hit.target.memberRefs).toEqual({ C1: 'C1', R1: 'R1', Y1: 'Y1' });
      expect(hit.source).toMatchObject({ kind: 'design', license: 'MIT' });
      expect(res.holds).toEqual([]);
      expect(existsSync(path.join(dir, '.copperhead', 'layout-refs', `${hit.id}.json`))).toBe(true);
      const index = JSON.parse(await readFile(path.join(dir, '.copperhead', 'layout-refs', 'index.json'), 'utf8'));
      expect(index.find((r: { id: string }) => r.id === hit.id)).toMatchObject({ anchor: 'U1', license: 'MIT', approvedBy: null });
      // second call reads the cache
      const again = await findReferences(d, blocks, { repoRoot: dir, sources: [src] });
      expect(again.searched).toBe(1); // the power anchor had no hit and nothing cached, so it is searched again
      expect(again.fromCache).toBe(res.blocks.length);
      // application: a reuse spec around U1 with the reference offsets, plus attachments at 110 % of the distance
      const inputs = toStageInputs(applicable(again.blocks).find((b) => b.target.anchorRef === 'U1')!);
      expect(inputs.reuse.anchor).toBe('U1');
      expect(inputs.reuse.members).toHaveLength(3);
      expect(inputs.attached.find((a) => a.ref === 'C1')!.max_distance_nm).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('an unknown license is cached on hold, approval is recorded and survives a refresh', async () => {
    const d = await design('completion');
    const blocks = deriveBlocks({ design: d, subsystemsMd: SUBSYSTEMS, schematicIntent: INTENT });
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-refs-'));
    try {
      const src = new LocalDesignSource([{ path: path.join(GOLDEN, 'completion', 'board.kicad_pcb'), license: 'unknown' }], 'now');
      const res = await findReferences(d, blocks, { repoRoot: dir, sources: [src] });
      expect(res.holds.length).toBe(res.blocks.length);
      expect(applicable(res.blocks)).toEqual([]);
      const held = res.holds.find((b) => b.target.anchorRef === 'U1')!;
      const ok = await approveReference(dir, held.id, 'animesh');
      expect(ok!.approvedBy).toBe('animesh');
      expect(applicable(await readCache(dir)).map((b) => b.id)).toEqual([held.id]);
      const refreshed = await findReferences(d, blocks, { repoRoot: dir, sources: [src], refresh: true });
      expect(refreshed.blocks.find((b) => b.id === held.id)!.approvedBy).toBe('animesh');
      expect(await approveReference(dir, 'nope', 'x')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("the user's own boards apply without approval and PCBench boards carry the suite's license", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-refs-'));
    try {
      await mkdir(path.join(dir, 'mine'), { recursive: true });
      await cp(path.join(GOLDEN, 'completion', 'board.kicad_pcb'), path.join(dir, 'mine', 'a.kicad_pcb'));
      const boards = await localBoards(dir, { referenceDesigns: ['mine'], pcbenchLicenses: { x: 'mit' } });
      expect(boards.find((b) => b.path.endsWith('mine/a.kicad_pcb'))).toMatchObject({ license: 'user', approvedBy: 'user' });
      const all = await localBoards(ROOT, { pcbenchLicenses: { spisolator_spisolator: 'mit' } });
      const spis = all.find((b) => b.path.endsWith('spisolator_spisolator.kicad_pcb'));
      if (spis) expect(spis.license).toBe('mit');
      expect(all.every((b) => b.path.endsWith('.kicad_pcb'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('teardown source', () => {
  it('reads an RFC 1 pattern file (JSON or YAML) and maps its members and rules onto the block', async () => {
    const d = await design('completion');
    const blocks = deriveBlocks({ design: d, subsystemsMd: SUBSYSTEMS, schematicIntent: INTENT });
    const u1 = d.components.find((c) => c.reference === 'U1')!;
    const c1 = d.components.find((c) => c.reference === 'C1')!;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-teardown-'));
    try {
      await mkdir(path.join(dir, 't1', 'pcb'), { recursive: true });
      await writeFile(path.join(dir, 't1', 'pcb', 'placement-analysis.yaml'), `patterns:\n  - id: decoupling\n    license: CC-BY-4.0\n    anchor:\n      role: mcu\n      footprint: "${u1.footprint.libId}"\n      mpn: "${u1.value}"\n    members:\n      - role: c_dec\n        footprint: "${c1.footprint.libId}"\n        rel_mm: [0, -3.5]\n    rules:\n      - text: decoupling within 2 mm of VDD\n        ref: c_dec\n        to: mcu.8\n        max_distance_mm: 2\n`, 'utf8');
      const src = new TeardownSource([dir], 'now');
      const res = await findReferences(d, blocks, { repoRoot: dir, sources: [src] });
      const hit = res.blocks.find((b) => b.target.anchorRef === 'U1')!;
      expect(hit.source.kind).toBe('teardown');
      expect(hit.source.license).toBe('CC-BY-4.0');
      expect(hit.similarity.footprint).toBe(true);
      expect(hit.members).toHaveLength(1);
      expect(hit.target.memberRefs).toEqual({ c_dec: 'C1' });
      expect(hit.members[0]!.rel).toEqual({ x: 0, y: -3_500_000, rotation: 0 });
      expect(hit.rules[0]).toEqual({ text: 'decoupling within 2 mm of VDD', ref: 'C1', to: 'U1.8', max_distance_nm: 2_000_000 });
      expect(applicable(res.blocks).map((b) => b.id)).toContain(hit.id);
      const inputs = toStageInputs(hit);
      expect(inputs.attached).toContainEqual({ ref: 'C1', to: 'U1.8', max_distance_nm: 2_000_000 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('copperhead pcb references / place --references', () => {
  it('lists blocks with their licenses, holds the unknown ones, and place applies the approved block', async () => {
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-refscli-'));
    try {
      await mkdir(path.join(dir, 'hardware'), { recursive: true });
      await mkdir(path.join(dir, 'docs'), { recursive: true });
      await mkdir(path.join(dir, 'refs'), { recursive: true });
      await mkdir(path.join(dir, '.copperhead'), { recursive: true });
      await cp(path.join(GOLDEN, 'completion', 'board.kicad_pcb'), path.join(dir, 'hardware', 'board.kicad_pcb'));
      await cp(path.join(GOLDEN, 'completion', 'board.kicad_pro'), path.join(dir, 'hardware', 'board.kicad_pro'));
      await cp(path.join(GOLDEN, 'completion', 'board.kicad_pcb'), path.join(dir, 'refs', 'ref.kicad_pcb'));
      await writeFile(path.join(dir, 'hardware', 'schematic.intent.json'), JSON.stringify(INTENT), 'utf8');
      await writeFile(path.join(dir, 'docs', 'SUBSYSTEMS.md'), SUBSYSTEMS, 'utf8');
      await writeFile(path.join(dir, '.copperhead', 'config.json'), JSON.stringify({ board: 'hardware/board.kicad_pcb', schematic: 'hardware/board.kicad_sch', docs: 'docs/', pcb: { allowHarnessEngines: true, referenceDesigns: ['refs'] } }), 'utf8');
      const cli = ['tsx', path.join(ROOT, 'src', 'cli.ts'), '--json', '--repo', dir];
      const list = await execa('npx', [...cli, 'pcb', 'references'], { cwd: ROOT, reject: false });
      expect(list.exitCode, list.stderr).toBe(0);
      const j = JSON.parse(list.stdout);
      const mine = j.blocks.find((b: { source: string; anchor: string }) => b.source.endsWith('refs/ref.kicad_pcb') && b.anchor === 'U1');
      expect(mine).toMatchObject({ license: 'user', approvedBy: 'user', applicable: true });
      const place = await execa('npx', [...cli, 'pcb', 'place', '--placers', 'placer-reference', '--references', '--no-probe', '--run-dir', '.copperhead/runs/p/placement', '--budget-seconds', '60'], { cwd: ROOT, reject: false });
      expect(place.exitCode, place.stderr).toBe(0);
      const p = JSON.parse(place.stdout);
      expect(p.status).toBe('PASS');
      expect(p.plan.stages.find((s: { name: string }) => s.name === 'attach').parts).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
