/**
 * Layout reuse and attachments (RFC 11 §8.5 stage 3, §8.6; Phase 3 task 5.2):
 * a reference block's relative placement copied around the target anchor
 * with a rigid transform, single attachments placed beside their pin, and
 * both locked before the wrapped placer. Runs needing kicad-cli skip without it.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { specFromDesign, applySpec, LayoutReusePlacer } from '../src/pcb/engines/placers/layout-reuse/adapter.js';
import { AttachPlacer } from '../src/pcb/engines/placers/attach/adapter.js';
import { placeBoard } from '../src/pcb/engines/place.js';
import { defaultRegistry as routerRegistry } from '../src/pcb/engines/route.js';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { makeSnapshot, DEFAULT_LIMITS } from '../src/pcb/ir/snapshot.js';
import { mmToNm } from '../src/pcb/ir/units.js';
import type { PlacementJob } from '../src/pcb/engines/contracts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GOLDEN = path.join(ROOT, 'test', 'fixtures', 'microboards');

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

function job(d: Awaited<ReturnType<typeof design>>, constraints: unknown[] = []): PlacementJob {
  const movable = d.components.filter((c) => !c.attributes.locked).map((c) => c.id);
  const snapshot = makeSnapshot(d, { kind: 'placement', movableComponentIds: movable }, { seed: 0, limits: DEFAULT_LIMITS });
  return { runId: 't', snapshot, movableComponentIds: movable, constraints, objectives: [], seed: 0, limits: snapshot.limits };
}

describe('layout reuse', () => {
  it('reads a block as offsets in the anchor frame and reproduces it around a rotated, moved anchor', async () => {
    // the reference: the completion board as committed (U1 with C1, R1 around it)
    const src = await design('completion');
    const spec = specFromDesign({ id: 'decoupling', source: 'completion', anchor: 'U1', members: ['U1', 'C1', 'R1'] }, src);
    expect(spec.anchor).toBe('U1');
    expect(spec.members.map((m) => m.ref).sort()).toEqual(['C1', 'R1']);
    // the target: the same board with U1 moved and turned 90 degrees
    const tgt = await design('completion');
    const u1 = tgt.components.find((c) => c.reference === 'U1')!;
    u1.at = { x: u1.at.x + mmToNm(5), y: u1.at.y + mmToNm(3) };
    u1.rotation = 90_000;
    const movable = new Set(tgt.components.map((c) => c.id));
    const { placements, skipped } = applySpec(spec, tgt, movable);
    expect(skipped).toEqual([]);
    expect(placements).toHaveLength(2);
    const c1src = src.components.find((c) => c.reference === 'C1')!;
    const u1src = src.components.find((c) => c.reference === 'U1')!;
    const c1 = placements.find((p) => p.id === tgt.components.find((c) => c.reference === 'C1')!.id)!;
    // the relative vector rotates with the anchor: (dx, dy) -> rotated by +90 in KiCad's frame
    const dx = c1src.at.x - u1src.at.x, dy = c1src.at.y - u1src.at.y;
    const dist = Math.hypot(dx, dy);
    expect(Math.hypot(c1.at.x - u1.at.x, c1.at.y - u1.at.y)).toBeCloseTo(dist, -3);
    expect(c1.rotation).toBe(90_000 + c1src.rotation - u1src.rotation);
    // a locked member is skipped and named
    tgt.components.find((c) => c.reference === 'R1')!.attributes.locked = true;
    expect(applySpec(spec, tgt, movable).skipped).toEqual(['R1']);
  });
  it('the placer engine applies every spec once and the attach placer puts a part beside its pin', async () => {
    const d = await design('completion');
    const spec = specFromDesign({ id: 'b', source: 's', anchor: 'U1', members: ['C1'] }, d);
    const res = await new LayoutReusePlacer().place(job(d, [{ kind: 'layout.reuse', spec }, { kind: 'layout.reuse', spec }]), { workDir: '/tmp', boardPath: '', log: () => {} });
    expect(res.placements).toHaveLength(1);
    const y1 = d.components.find((c) => c.reference === 'Y1')!;
    const u1 = d.components.find((c) => c.reference === 'U1')!;
    const at = await new AttachPlacer().place(job(d, [{ kind: 'relative.attached', ref: 'Y1', to: 'U1.1', max_distance_nm: mmToNm(2) }]), { workDir: '/tmp', boardPath: '', log: () => {} });
    expect(at.placements).toHaveLength(1);
    const p = at.placements[0]!;
    expect(p.id).toBe(y1.id);
    const pin1 = u1.pads.find((x) => x.number === '1')!;
    expect(Math.hypot(p.at.x - pin1.at.x, p.at.y - pin1.at.y)).toBeLessThan(mmToNm(4));
    expect(Math.hypot(p.at.x - y1.at.x, p.at.y - y1.at.y)).toBeGreaterThan(mmToNm(2));
  });
});

describe('staged plan stage 3', () => {
  it('locks reused and attached parts before the wrapped placer and the candidate verifies', async () => {
    if (!(await haveKicad())) return;
    const src = await design('completion');
    const spec = specFromDesign({ id: 'decoupling', source: 'completion', anchor: 'U1', members: ['U1', 'C1'] }, src);
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-reuse-'));
    try {
      const res = await placeBoard({ repoRoot: ROOT, boardPath: path.join(GOLDEN, 'completion', 'board.kicad_pcb'), runDir: path.join(dir, 'run'), placers: ['placer-reference'], policy: { network: 'none', allowHarnessEngines: true, denyLicenses: [] }, probe: false, reuse: [spec], attached: [{ ref: 'Y1', to: 'U1.2', max_distance_nm: mmToNm(2) }], limits: { engineSeconds: 60, wallSeconds: 60 } });
      expect(res.outcome.status).toBe('PASS');
      const attach = res.plan!.stages.find((s) => s.name === 'attach')!;
      expect(attach.componentIds).toHaveLength(3); // C1 reused, Y1 attached, and U1 held as their anchor and target
      expect(res.movableIds).toHaveLength(6 - 3);
      const cand = res.candidates[0]!;
      const c1 = cand.design.components.find((c) => c.reference === 'C1')!;
      const u1 = cand.design.components.find((c) => c.reference === 'U1')!;
      const c1src = src.components.find((c) => c.reference === 'C1')!;
      const u1src = src.components.find((c) => c.reference === 'U1')!;
      // U1 is held with its block: C1 keeps exactly its reference offset
      expect(c1.at.x - u1.at.x).toBe(c1src.at.x - u1src.at.x);
      expect(c1.at.y - u1.at.y).toBe(c1src.at.y - u1src.at.y);
      expect(cand.verify.gates.placement.passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('pcb place reads pcb.layoutBlocks from the config', async () => {
    if (!(await haveKicad())) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-reusecli-'));
    try {
      await mkdir(path.join(dir, 'hardware'), { recursive: true });
      await mkdir(path.join(dir, 'refs'), { recursive: true });
      await mkdir(path.join(dir, '.copperhead'), { recursive: true });
      await cp(path.join(GOLDEN, 'completion', 'board.kicad_pcb'), path.join(dir, 'hardware', 'board.kicad_pcb'));
      await cp(path.join(GOLDEN, 'completion', 'board.kicad_pro'), path.join(dir, 'hardware', 'board.kicad_pro'));
      await cp(path.join(GOLDEN, 'completion', 'board.kicad_pcb'), path.join(dir, 'refs', 'ref.kicad_pcb'));
      await writeFile(path.join(dir, '.copperhead', 'config.json'), JSON.stringify({ board: 'hardware/board.kicad_pcb', docs: 'docs/', pcb: { allowHarnessEngines: true, layoutBlocks: [{ id: 'dec', source: 'refs/ref.kicad_pcb', anchor: 'U1', members: ['U1', 'C1', 'R1'] }] } }), 'utf8');
      const out = await execa('npx', ['tsx', path.join(ROOT, 'src', 'cli.ts'), '--json', '--repo', dir, 'pcb', 'place', '--placers', 'placer-reference', '--no-probe', '--run-dir', '.copperhead/runs/p/placement', '--budget-seconds', '60'], { cwd: ROOT, reject: false });
      expect(out.exitCode, out.stderr).toBe(0);
      const j = JSON.parse(out.stdout);
      expect(j.status).toBe('PASS');
      expect(j.plan.stages.find((s: { name: string }) => s.name === 'attach').parts).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
