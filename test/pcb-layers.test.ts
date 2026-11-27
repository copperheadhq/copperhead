/**
 * The copper stack (add-multilayer-layout): one order from the layer names under both KiCad numberings,
 * via spans in connectivity, through vias only in geometry, profile and stack pre-flight, layer strategy
 * defaults, the multilayer scoring profiles, and the layer count handed to engines.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copperStack, stackProblems, viaSpan, isThroughVia, outerLayers } from '../src/pcb/ir/layers.js';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { verifyDesign } from '../src/pcb/verify/index.js';
import { checkConnectivity } from '../src/pcb/verify/checkers/connectivity.js';
import { JLCPCB_2LAYER, JLCPCB_4LAYER, JLCPCB_6LAYER, loadProfile, defaultProfileFor } from '../src/pcb/verify/profiles/index.js';
import { DEFAULT_LOW_SPEED_4_LAYER, DEFAULT_LOW_SPEED_6_LAYER, defaultRoutingScoringFor } from '../src/pcb/verify/profiles/scoring/index.js';
import { layerStrategyFor } from '../src/pcb/engines/plan.js';
import { renderSvg } from '../src/pcb/ir/svg.js';
import { KicadToolsRouter } from '../src/pcb/engines/routers/kicad-tools/adapter.js';
import { makeSnapshot } from '../src/pcb/ir/snapshot.js';
import { routeBoard } from '../src/pcb/engines/route.js';
import type { RoutingJob, RunContext } from '../src/pcb/engines/contracts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'fixtures', 'microboards');

async function golden(name: string) {
  const pcb = path.join(GOLDEN, name, 'board.kicad_pcb');
  return { pcb, text: await readFile(pcb, 'utf8'), projectText: await readFile(path.join(GOLDEN, name, 'board.kicad_pro'), 'utf8') };
}
/** The golden two-layer board with inner layers added in one of KiCad's two numberings. */
function withInner(text: string, numbering: 'legacy' | 'kicad10', inner: number): string {
  const names = Array.from({ length: inner }, (_, i) => `In${i + 1}.Cu`);
  if (numbering === 'legacy') return text.replace('(0 "F.Cu" signal)', `(0 "F.Cu" signal)\n${names.map((n, i) => `\t\t(${i + 1} "${n}" signal)`).join('\n')}`);
  // KiCad 10: B.Cu is 2, inner layers 4, 6, 8 …
  return text.replace('(0 "F.Cu" signal)\n\t\t(31 "B.Cu" signal)', `(0 "F.Cu" signal)\n${names.map((n, i) => `\t\t(${4 + 2 * i} "${n}" signal)`).join('\n')}\n\t\t(2 "B.Cu" signal)`);
}

describe('copper stack', () => {
  it('orders copper by name under both numberings and leaves two-layer boards unchanged', async () => {
    const { pcb, text, projectText } = await golden('completion');
    const two = importBoard({ boardText: text, boardPath: pcb, projectText, now: 't' }).design;
    expect(copperStack(two)).toEqual(['F.Cu', 'B.Cu']);
    for (const numbering of ['legacy', 'kicad10'] as const) {
      const four = importBoard({ boardText: withInner(text, numbering, 2), boardPath: pcb, projectText, now: 't' }).design;
      expect(copperStack(four)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
      expect(stackProblems(four)).toEqual([]);
      expect(outerLayers(four)).toEqual(['F.Cu', 'B.Cu']);
      expect(four.board.fabricationProfile).toBe('jlcpcb-4layer');
    }
    const six = importBoard({ boardText: withInner(text, 'kicad10', 4), boardPath: pcb, projectText, now: 't' }).design;
    expect(copperStack(six)).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'B.Cu']);
    expect(six.board.fabricationProfile).toBe('jlcpcb-6layer');
    expect(two.board.fabricationProfile).toBe('jlcpcb-2layer');
  });
  it('names what it cannot stack: a renamed copper layer, eight layers, a gap in the inner numbering', () => {
    const mk = (ids: string[]) => ids.map((id, i) => ({ id, ordinal: i, kind: 'copper' as const }));
    expect(stackProblems(mk(['F.Cu', 'Signal3', 'B.Cu']))[0]).toMatch(/"Signal3" is not/);
    expect(stackProblems(mk(['F.Cu', 'In1.Cu', 'In2.Cu', 'In3.Cu', 'In4.Cu', 'In5.Cu', 'In6.Cu', 'B.Cu']))[0]).toMatch(/8 copper layers/);
    expect(stackProblems(mk(['F.Cu', 'In2.Cu', 'B.Cu']))[0]).toMatch(/not In1.Cu/);
    expect(stackProblems(mk(['F.Cu', 'B.Cu']))).toEqual([]);
  });
  it('via span is the stack slice; a through via reaches the outer layers', () => {
    const stack = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
    expect(viaSpan({ layers: ['F.Cu', 'B.Cu'] }, stack)).toEqual(stack);
    expect(viaSpan({ layers: ['B.Cu', 'F.Cu'] }, stack)).toEqual(stack);
    expect(viaSpan({ layers: ['In1.Cu', 'In2.Cu'] }, stack)).toEqual(['In1.Cu', 'In2.Cu']);
    expect(isThroughVia({ layers: ['F.Cu', 'B.Cu'] }, stack)).toBe(true);
    expect(isThroughVia({ layers: ['F.Cu', 'In2.Cu'] }, stack)).toBe(false);
    expect(isThroughVia({ layers: ['F.Cu', 'F.Cu'] }, stack)).toBe(false);
  });
});

describe('pre-flight on the stack and the profile', () => {
  it('refuses an unnameable copper layer, and a profile for another layer count', async () => {
    const { pcb, text, projectText } = await golden('completion');
    const bad = importBoard({ boardText: text.replace('(31 "B.Cu" signal)', '(31 "B.Cu" signal)\n\t\t(1 "Signal3" signal)'), boardPath: pcb, projectText, now: 't' }).design;
    const v = verifyDesign({ design: bad, profile: JLCPCB_2LAYER });
    expect(v.diagnostics.some((d) => d.code === 'preflight.stack' && /Signal3/.test(d.message))).toBe(true);
    expect(v.gates.preflight.passed).toBe(false);
    const four = importBoard({ boardText: withInner(text, 'kicad10', 2), boardPath: pcb, projectText, now: 't' }).design;
    const wrong = verifyDesign({ design: four, profile: JLCPCB_2LAYER });
    expect(wrong.diagnostics.some((d) => d.code === 'preflight.profile' && /2 copper layers; the board has 4/.test(d.message))).toBe(true);
    expect(wrong.gates.preflight.passed).toBe(false);
    const right = verifyDesign({ design: four, profile: JLCPCB_4LAYER });
    expect(right.diagnostics.filter((d) => d.code.startsWith('preflight.stack') || d.code === 'preflight.profile')).toEqual([]);
  });
  it('the four- and six-layer profiles carry the vendored values and match their JSON', async () => {
    for (const p of [JLCPCB_4LAYER, JLCPCB_6LAYER]) {
      expect(loadProfile(p.id)).toBe(p);
      expect(p).toEqual(JSON.parse(await readFile(path.join(HERE, '..', 'src', 'pcb', 'verify', 'profiles', `${p.id}.json`), 'utf8')));
    }
    expect(JLCPCB_4LAYER.minClearanceNm).toBe(101600);
    expect(JLCPCB_6LAYER.minTrackNm).toBe(88900);
    expect(JLCPCB_4LAYER.minViaDrillNm).toBe(200000);
    expect(defaultProfileFor(2)).toBe('jlcpcb-2layer');
    expect(defaultProfileFor(6)).toBe('jlcpcb-6layer');
  });
});

describe('vias across the stack', () => {
  it('connectivity: copper on In1.Cu reaches its pads through through vias; geometry refuses a buried via', async () => {
    const { pcb, text, projectText } = await golden('completion');
    const four = importBoard({ boardText: withInner(text, 'kicad10', 2), boardPath: pcb, projectText, now: 't' }).design;
    const net = four.nets.find((n) => n.padIds.length === 2)!;
    const pads = four.components.flatMap((c) => c.pads).filter((p) => p.netId === net.id);
    const [a, b] = [pads[0]!.at, pads[1]!.at];
    const w = four.board.rules.trackWidthNm;
    const via = (id: string, at: { x: number; y: number }, layers: [string, string]) => ({ id, netId: net.id, at, size: 600_000, drill: 300_000, layers });
    const routed = { ...four, routing: { ...four.routing, segments: [{ id: 's1', netId: net.id, layer: 'In1.Cu', a, b, width: w }], vias: [via('v1', a, ['F.Cu', 'B.Cu']), via('v2', b, ['F.Cu', 'B.Cu'])] } };
    const c = checkConnectivity(routed, []);
    expect(c.diagnostics.filter((d) => d.code === 'conn.unrouted' && d.entityReferences.includes(net.name))).toEqual([]);
    expect(c.diagnostics.filter((d) => d.code === 'conn.open')).toEqual([]);
    // the same copper with buried vias never reaches the pads, and geometry names the via
    const buried = { ...routed, routing: { ...routed.routing, vias: [via('v1', a, ['In1.Cu', 'In2.Cu']), via('v2', b, ['In1.Cu', 'In2.Cu'])] } };
    const v = verifyDesign({ design: buried, profile: JLCPCB_4LAYER });
    expect(v.diagnostics.filter((d) => d.code === 'geom.via-layers')).toHaveLength(2);
    expect(v.diagnostics.find((d) => d.code === 'geom.via-layers')!.message).toMatch(/only through vias/);
    expect(v.gates.routing.passed).toBe(false);
  });
});

describe('layer-aware plan, scoring, engines, renderer', () => {
  it('inner layers alternate directions by default and the intent overrides one', async () => {
    const { pcb, text, projectText } = await golden('completion');
    const four = importBoard({ boardText: withInner(text, 'kicad10', 2), boardPath: pcb, projectText, now: 't' }).design;
    expect(layerStrategyFor(four, undefined)).toEqual({ 'In1.Cu': { active: true, preferredDirection: 'horizontal' }, 'In2.Cu': { active: true, preferredDirection: 'vertical' } });
    expect(layerStrategyFor(four, [{ layerId: 'In1.Cu', mode: 'vertical' }])!['In1.Cu']).toEqual({ active: true, preferredDirection: 'vertical' });
    const two = importBoard({ boardText: text, boardPath: pcb, projectText, now: 't' }).design;
    expect(layerStrategyFor(two, undefined)).toBeUndefined();
  });
  it('the multilayer scoring profiles drop the return-path terms and still sum to one', () => {
    for (const p of [DEFAULT_LOW_SPEED_4_LAYER, DEFAULT_LOW_SPEED_6_LAYER]) {
      expect(p.weights.bottom_signal_length_nm).toBeUndefined();
      expect(p.weights.pour_largest_share).toBeUndefined();
      expect(Math.abs(Object.values(p.weights).reduce((s, w) => s + w, 0) - 1)).toBeLessThan(0.001);
      expect(p.higherIsBetter).toEqual(['completion_rate']);
    }
    expect(defaultRoutingScoringFor(2)).toBe('default-low-speed-2-layer');
    expect(defaultRoutingScoringFor(4)).toBe('default-low-speed-4-layer');
    expect(defaultRoutingScoringFor(6)).toBe('default-low-speed-6-layer');
  });
  it('kicad-tools is told the board\'s layer count', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-layers-'));
    try {
      const { pcb, text, projectText } = await golden('completion');
      const six = importBoard({ boardText: withInner(text, 'kicad10', 4), boardPath: pcb, projectText, now: 't' }).design;
      const fake = path.join(dir, 'kct');
      await writeFile(fake, '#!/bin/sh\necho "$@" > "$(dirname "$0")/args.txt"\nexit 1\n', 'utf8');
      await chmod(fake, 0o755);
      const job: RoutingJob = { runId: 'r', snapshot: makeSnapshot(six, { kind: 'routing', netIds: null, region: null, preserveExistingRoutes: false }), scope: { netIds: null, region: null, preserveExistingRoutes: false }, strategy: {}, hardConstraints: [], objectives: [], seed: 1, limits: { engineSeconds: 30, wallSeconds: 30, memoryMb: 512 } };
      const ctx: RunContext = { workDir: dir, boardPath: pcb, log: () => {} };
      await expect(new KicadToolsRouter({ kct: fake }).route(job, ctx)).rejects.toMatchObject({ kind: 'process-failed' });
      expect(await readFile(path.join(dir, 'args.txt'), 'utf8')).toMatch(/--layers 6/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('live: Freerouting routes the four-layer golden and the verifier reads it complete (COPPERHEAD_TEST_FREEROUTING=1)', async () => {
    if (process.env.COPPERHEAD_TEST_FREEROUTING !== '1') return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-four-layer-'));
    try {
      const res = await routeBoard({ repoRoot: path.join(HERE, '..'), boardPath: path.join(GOLDEN, 'four-layer', 'board.kicad_pcb'), runDir: path.join(dir, 'run'), routers: ['router-freerouting'], mode: 'single', policy: { network: 'none', allowHarnessEngines: false, denyLicenses: [] }, limits: { engineSeconds: 240, wallSeconds: 240 } });
      expect(res.outcome.status).toBe('PASS');
      const c = res.candidates[0]!;
      expect(c.verify.metrics.completion_rate).toBe(1);
      expect(c.verify.metrics.unrouted_count).toBe(0);
      expect(c.verify.gates.routing.passed).toBe(true);
      // the inner layers were used, and every via is a through via
      expect(c.design.routing.segments.some((s) => s.layer === 'In1.Cu' || s.layer === 'In2.Cu')).toBe(true);
      expect(c.design.routing.vias.every((v) => new Set(v.layers).size === 2 && v.layers.includes('F.Cu') && v.layers.includes('B.Cu'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
  it('the renderer draws inner copper in its own colour and legend', async () => {
    const { pcb, text, projectText } = await golden('completion');
    const four = importBoard({ boardText: withInner(text, 'kicad10', 2), boardPath: pcb, projectText, now: 't' }).design;
    const net = four.nets.find((n) => n.padIds.length === 2)!;
    const routed = { ...four, routing: { ...four.routing, segments: [{ id: 's1', netId: net.id, layer: 'In1.Cu', a: { x: 105e6, y: 105e6 }, b: { x: 115e6, y: 105e6 }, width: 250_000 }] } };
    const svg = renderSvg(routed);
    expect(svg).toContain('stroke="#3c9a5a"');
  });
});
