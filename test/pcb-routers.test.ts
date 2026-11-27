/**
 * Router wrappers (ADR 0008; RFC 11 §9.2). DSN emission follows KiCad's
 * exporter conventions (verified against pcbnew when COPPERHEAD_TEST_PCBNEW=1),
 * the session parser is pinned to a real Freerouting 2.4.1 session captured
 * on the completion golden board, every failure kind is named, and the live
 * runs need the tools from scripts/tools.sh.
 */
import { describe, it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp, mkdir, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { importBoard } from '../src/pcb/ir/kicad/import.js';
import { makeSnapshot } from '../src/pcb/ir/snapshot.js';
import { emitDsn } from '../src/pcb/engines/routers/freerouting/dsn.js';
import { parseSes } from '../src/pcb/engines/routers/freerouting/ses.js';
import { FreeroutingRouter, resolveJar, resolveJava } from '../src/pcb/engines/routers/freerouting/adapter.js';
import { KicadToolsRouter, resolveKct, toCodeDialect } from '../src/pcb/engines/routers/kicad-tools/adapter.js';
import { OrthorouteRouter, ORTHOROUTE_MANIFEST, resolveOrthoroute } from '../src/pcb/engines/routers/orthoroute/adapter.js';
import { buildOrp, encodeOrp, parseOrs } from '../src/pcb/engines/routers/orthoroute/orp.js';
import { eligible } from '../src/pcb/engines/registry.js';
import { gzipSync } from 'node:zlib';
import { EngineError } from '../src/pcb/ir/status.js';
import { mmToNm } from '../src/pcb/ir/units.js';
import type { RoutingJob, RunContext } from '../src/pcb/engines/contracts.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GOLDEN = path.join(ROOT, 'test', 'fixtures', 'microboards');
const FIX = path.join(HERE, 'fixtures', 'pcb');
const mm = mmToNm;

async function completion() {
  const pcb = path.join(GOLDEN, 'completion', 'board.kicad_pcb');
  const text = await readFile(pcb, 'utf8');
  const projectText = await readFile(path.join(GOLDEN, 'completion', 'board.kicad_pro'), 'utf8');
  return { pcb, text, projectText, design: importBoard({ boardText: text, boardPath: pcb, projectText, now: 't' }).design };
}

const job = (design: Awaited<ReturnType<typeof completion>>['design'], extra: Partial<RoutingJob> = {}): RoutingJob => ({
  runId: 'r', snapshot: makeSnapshot(design, { kind: 'routing', netIds: null, region: null, preserveExistingRoutes: false }),
  scope: { netIds: null, region: null, preserveExistingRoutes: false }, strategy: {}, hardConstraints: [], objectives: [], seed: 1, limits: { engineSeconds: 120, wallSeconds: 120, memoryMb: 1024 }, ...extra,
});

const ctxIn = (workDir: string, boardPath: string): RunContext => ({ workDir, boardPath, log: () => {} });

describe('DSN emission', () => {
  it('follows the KiCad exporter conventions', async () => {
    const { design } = await completion();
    const dsn = emitDsn(design, { boardName: 'completion', edgeClearanceNm: mm(0.3) });
    expect(dsn).toContain('(resolution um 10)');
    expect(dsn).toContain('(layer F.Cu');
    expect(dsn).toContain('(layer B.Cu');
    // U1 at (116, 113) front, rotation 0 -> um, Y negated
    expect(dsn).toMatch(/\(place U1 116000 -113000 front 0/);
    // every pad is a pin in some image; images are deduped per footprint geometry
    const pins = (dsn.match(/\(pin /g) ?? []).length;
    const images = (dsn.match(/\(image /g) ?? []).length;
    expect(images).toBe(new Set(design.components.map((c) => c.footprint.libId)).size);
    expect(pins).toBe(design.components.filter((c, i, a) => a.findIndex((x) => x.footprint.libId === c.footprint.libId) === i).reduce((s, c) => s + c.pads.length, 0));
    // boundary is inset by the edge clearance: 100..136 x 100..126 mm becomes 100.3..135.7
    expect(dsn).toMatch(/\(boundary\s+\(path pcb 0 100300 -100300/);
    for (const n of design.nets.filter((n) => n.padIds.length >= 2)) expect(dsn).toContain(`(net ${n.name}`);
    expect(dsn).toContain('(pins U1-8');
    expect(dsn).toContain('(class kicad_default');
    expect(dsn).toContain('(wiring\n  )'); // nothing preserved
  });

  it('places back-side parts with 180 + rotation and quotes odd names', async () => {
    const { design } = await completion();
    const u1 = design.components.find((c) => c.reference === 'U1')!;
    u1.attributes.side = 'back';
    u1.rotation = 45_000;
    u1.reference = 'U 1';
    const dsn = emitDsn(design, { boardName: 'x', edgeClearanceNm: 0 });
    expect(dsn).toMatch(/\(place "U 1" 116000 -113000 back 225/);
  });

  it('matches pcbnew\'s own Specctra export on placement (COPPERHEAD_TEST_PCBNEW=1)', async () => {
    if (process.env.COPPERHEAD_TEST_PCBNEW !== '1') return;
    const { pcb, design } = await completion();
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-dsn-'));
    try {
      const py = process.env.COPPERHEAD_PCBNEW_PYTHON ?? '/usr/bin/python3';
      const out = path.join(dir, 'kicad.dsn');
      await execa(py, ['-c', `import pcbnew; b=pcbnew.LoadBoard(${JSON.stringify(pcb)}); pcbnew.ExportSpecctraDSN(b, ${JSON.stringify(out)})`], { env: { ...process.env, PYTHONPATH: process.env.COPPERHEAD_PCBNEW_PYTHONPATH ?? '/usr/lib/python3/dist-packages' } });
      const kicad = await readFile(out, 'utf8');
      const ours = emitDsn(design, { boardName: 'completion', edgeClearanceNm: 0 });
      const places = (t: string) => [...t.matchAll(/\(place (\S+) (-?[\d.]+) (-?[\d.]+) (front|back) (-?[\d.]+)/g)].map((m) => `${m[1]} ${Math.round(Number(m[2]))} ${Math.round(Number(m[3]))} ${m[4]} ${Number(m[5])}`).sort();
      expect(places(ours)).toEqual(places(kicad));
      const pinsOf = (t: string) => (t.match(/\(pin /g) ?? []).length;
      expect(pinsOf(ours)).toBe(pinsOf(kicad));
      const netPins = (t: string) => [...t.matchAll(/\(net (\S+)\s+\(pins ([^)]+)\)/g)].map((m) => `${m[1]}:${m[2].trim().split(/\s+/).sort().join(' ')}`).sort();
      expect(netPins(ours)).toEqual(netPins(kicad));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('SES import', () => {
  it('reads the captured Freerouting 2.4.1 session at resolution-unit scale', async () => {
    const { design } = await completion();
    const ses = await readFile(path.join(FIX, 'completion-freerouting.ses'), 'utf8');
    const r = parseSes(ses, { copperLayers: ['F.Cu', 'B.Cu'], netIdByName: new Map(design.nets.map((n) => [n.name, n.id])), rules: design.board.rules, namespace: 'test' });
    expect(r.nets.sort()).toEqual(['GND', 'SIG1', 'SIG2', 'VCC', 'XI', 'XO']);
    const paths = (ses.match(/\(path /g) ?? []).length;
    expect(paths).toBe(21);
    expect(r.segments.length).toBeGreaterThanOrEqual(paths);
    const widths = new Set(r.segments.map((s) => s.width));
    expect(widths).toEqual(new Set([mm(0.25), mm(0.1874)]));
    expect(r.vias).toHaveLength(3);
    expect(r.vias[0]!.size).toBe(mm(0.6));
    expect(r.vias[0]!.drill).toBe(mm(0.3));
    for (const s of r.segments) expect(['F.Cu', 'B.Cu']).toContain(s.layer);
    // coordinates land on the board (100..136 x 100..126 mm) and Y is negated back
    for (const s of r.segments) {
      expect(s.a.x).toBeGreaterThan(mm(100));
      expect(s.a.x).toBeLessThan(mm(136));
      expect(s.a.y).toBeGreaterThan(mm(100));
      expect(s.a.y).toBeLessThan(mm(126));
    }
    // deterministic ids
    const again = parseSes(ses, { copperLayers: ['F.Cu', 'B.Cu'], netIdByName: new Map(design.nets.map((n) => [n.name, n.id])), rules: design.board.rules, namespace: 'test' });
    expect(again.segments.map((s) => s.id)).toEqual(r.segments.map((s) => s.id));
  });

  it('refuses an unknown layer', async () => {
    const { design } = await completion();
    const ses = (await readFile(path.join(FIX, 'completion-freerouting.ses'), 'utf8')).replace('(path B.Cu', '(path In1.Cu');
    expect(() => parseSes(ses, { copperLayers: ['F.Cu', 'B.Cu'], netIdByName: new Map(design.nets.map((n) => [n.name, n.id])), rules: design.board.rules, namespace: 't' })).toThrow(/In1\.Cu/);
  });
});

describe('Freerouting failure kinds are named', () => {
  it('no-binary, no-runtime, runtime-too-old', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-fr-'));
    try {
      const { pcb, design } = await completion();
      await expect(resolveJar('/nowhere/freerouting.jar', {})).rejects.toMatchObject({ kind: 'no-binary' });
      expect(resolveJava({ COPPERHEAD_JAVA: '/x/java' })).toBe('/x/java');
      const jar = path.join(dir, 'freerouting-9.9.9.jar');
      await writeFile(jar, '', 'utf8');
      const missing = new FreeroutingRouter({ jar, java: path.join(dir, 'no-such-java') });
      await expect(missing.route(job(design), ctxIn(dir, pcb))).rejects.toMatchObject({ kind: 'no-runtime' });
      const oldJava = path.join(dir, 'java');
      await writeFile(oldJava, '#!/bin/sh\necho "Error: LinkageError occurred while loading main class app.freerouting.Freerouting" >&2\necho "java.lang.UnsupportedClassVersionError: app/freerouting/Freerouting has been compiled by a more recent version of the Java Runtime (class file version 69.0)" >&2\nexit 1\n', 'utf8');
      await chmod(oldJava, 0o755);
      const old = new FreeroutingRouter({ jar, java: oldJava });
      await expect(old.route(job(design), ctxIn(dir, pcb))).rejects.toMatchObject({ kind: 'runtime-too-old' });
      const silent = path.join(dir, 'java-silent');
      await writeFile(silent, '#!/bin/sh\nexit 0\n', 'utf8');
      await chmod(silent, 0o755);
      await expect(new FreeroutingRouter({ jar, java: silent }).route(job(design), ctxIn(dir, pcb))).rejects.toMatchObject({ kind: 'no-output' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('kicad-tools failure kinds are named', () => {
  it('a grid refusal on the router\'s own safety rule is "declined", not a crash', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-kct-'));
    try {
      const { pcb, design } = await completion();
      const fake = path.join(dir, 'kct');
      await writeFile(fake, '#!/bin/sh\necho "Error: Auto-grid selected 0.127mm > clearance/2 (0.1mm) because the memory budget cap (max_cells=500,000) forced a coarser grid." >&2\necho "The router\'s own safety rule rejects this grid; routing WILL produce clearance-violating vias/segments (DRC shorts)." >&2\nexit 1\n', 'utf8');
      await chmod(fake, 0o755);
      await expect(new KicadToolsRouter({ kct: fake }).route(job(design), ctxIn(dir, pcb))).rejects.toMatchObject({ kind: 'declined', message: expect.stringMatching(/kct declines the board.*0\.127mm/) });
      const crash = path.join(dir, 'kct-crash');
      await writeFile(crash, '#!/bin/sh\necho "Traceback (most recent call last): KeyError" >&2\nexit 1\n', 'utf8');
      await chmod(crash, 0o755);
      await expect(new KicadToolsRouter({ kct: crash }).route(job(design), ctxIn(dir, pcb))).rejects.toMatchObject({ kind: 'process-failed' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('router-orthoroute (ADR 0010)', () => {
  it('writes an ORP from the IR: millimetres, y up, pads named ref@number with their nets, rules and layers carried', async () => {
    const { design } = await completion();
    const orp = buildOrp(design, { boardName: 'b', netIds: null }) as { board: { bounds: Record<string, number>; layer_count: number }; layers: { name: string }[]; pads: Record<string, unknown>[]; nets: { name: string }[]; drc_rules: { default: Record<string, number> } };
    expect(orp.board.layer_count).toBe(2);
    expect(orp.layers.map((l) => l.name)).toEqual(['F.Cu', 'B.Cu']);
    expect(orp.board.bounds.y_max).toBeGreaterThan(orp.board.bounds.y_min);
    expect(orp.drc_rules.default.clearance).toBeCloseTo(design.board.rules.clearanceNm / 1e6, 6);
    const pad = orp.pads.find((p) => p.component_ref === 'U1')!;
    expect(String(pad.id)).toMatch(/^U1@/);
    const u1 = design.components.find((c) => c.reference === 'U1')!;
    const first = u1.pads.find((q) => `U1@${q.number}` === pad.id)!;
    expect((pad.position as { x: number; y: number }).y).toBeCloseTo(-first.at.y / 1e6, 6);
    expect(orp.nets.length).toBe(design.nets.filter((n) => n.padIds.length >= 2).length);
    // only pads on routable nets are exported; every exported pad's net is in the net list
    const names = new Set(orp.nets.map((n) => n.name));
    for (const p of orp.pads) expect(names.has(String(p.net_name))).toBe(true);
    expect(encodeOrp(orp).length).toBeGreaterThan(20);
  });
  it('reads an ORS back into IR copper: y flipped, layers by name or index, widths floored at the rule', async () => {
    const { design } = await completion();
    const copperLayers = ['F.Cu', 'B.Cu'];
    const net = design.nets.find((n) => n.padIds.length >= 2)!;
    const ors = { format_version: '1.0', metadata: { converged: true, total_iterations: 3 }, geometry: { all_tracks: [
      { net_id: net.name, layer: 'F.Cu', start: { x: 1, y: 2 }, end: { x: 5, y: 2 }, width: 0.05 },
      { net_id: net.name, layer: 1, start: { x: 5, y: 2 }, end: { x: 5, y: 6 }, width: 0.3 },
      { net_id: 'no-such-net', layer: 'F.Cu', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, width: 0.3 },
    ], all_vias: [{ net_id: net.name, position: { x: 5, y: 2 }, from_layer: 0, to_layer: 1, diameter: 0.6, drill: 0.3 }] } };
    for (const data of [Buffer.from(JSON.stringify(ors)), gzipSync(Buffer.from(JSON.stringify(ors)))]) {
      const r = parseOrs(data, { copperLayers, netIdByName: new Map(design.nets.map((n) => [n.name, n.id])), rules: design.board.rules, namespace: 'ns' });
      expect(r.segments).toHaveLength(2);
      expect(r.segments[0]).toMatchObject({ netId: net.id, layer: 'F.Cu', a: { x: 1_000_000, y: -2_000_000 }, b: { x: 5_000_000, y: -2_000_000 }, width: design.board.rules.trackWidthNm });
      expect(r.segments[1]!.layer).toBe('B.Cu');
      expect(r.vias[0]).toMatchObject({ netId: net.id, at: { x: 5_000_000, y: -2_000_000 }, layers: ['F.Cu', 'B.Cu'], size: 600_000, drill: 300_000 });
      expect(r.nets).toEqual([net.name]);
      expect(r.converged).toBe(true);
    }
  });
  it('is not offered a two-layer board: the manifest needs four copper layers, and the reason says so', () => {
    const policy = { network: 'none' as const, allowHarnessEngines: false, denyLicenses: [] };
    const two = eligible({ plugin: null as never, manifest: ORTHOROUTE_MANIFEST }, { kind: 'router', hardConstraintKinds: [], copperLayers: 2 }, policy);
    expect(two.ok).toBe(false);
    expect(two.reasons.join(' ')).toMatch(/needs at least 4 copper layers, board has 2/);
    expect(eligible({ plugin: null as never, manifest: ORTHOROUTE_MANIFEST }, { kind: 'router', hardConstraintKinds: [], copperLayers: 4 }, policy).ok).toBe(true);
  });
  it('runs the headless entry point and names its failures: a solution with no copper is "failed" with the reason, a crash is process-failed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-orthoroute-'));
    try {
      const { pcb, design } = await completion();
      await writeFile(path.join(dir, 'main.py'), '', 'utf8');
      // a fake interpreter that writes an empty solution
      const empty = path.join(dir, 'python-empty');
      await writeFile(empty, '#!/bin/sh\nout=""; while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done\nprintf \'{"format_version":"1.0","metadata":{"converged":false,"total_iterations":0},"geometry":{"all_tracks":[],"all_vias":[]}}\' > "$out"\n', 'utf8');
      await chmod(empty, 0o755);
      const r = await new OrthorouteRouter({ paths: { dir, python: empty } }).route(job(design), ctxIn(dir, pcb));
      expect(r.status).toBe('failed');
      expect(r.unroutedNetIds.length).toBe(design.nets.filter((n) => n.padIds.length >= 2).length);
      expect(r.diagnostics[0]!.message).toMatch(/routes on inner layers only/);
      expect(existsSync(path.join(dir, 'board.ORP'))).toBe(true);
      const crash = path.join(dir, 'python-crash');
      await writeFile(crash, '#!/bin/sh\necho "Traceback: boom" >&2\nexit 1\n', 'utf8');
      await chmod(crash, 0o755);
      // same work directory on purpose: the earlier run's solution must not be read as this one's
      await expect(new OrthorouteRouter({ paths: { dir, python: crash } }).route(job(design), ctxIn(dir, pcb))).rejects.toMatchObject({ kind: 'process-failed' });
      expect(() => resolveOrthoroute({ COPPERHEAD_ORTHOROUTE: '/nowhere' }, dir)).toThrow(/checkout not found/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('live: on a two-layer board OrthoRoute routes nothing, on the same board with two inner layers it routes (COPPERHEAD_TEST_ORTHOROUTE=1)', async () => {
    if (process.env.COPPERHEAD_TEST_ORTHOROUTE !== '1') return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-orthoroute-live-'));
    try {
      const { pcb, text, projectText, design } = await completion();
      const paths = resolveOrthoroute(process.env, ROOT);
      const two = await new OrthorouteRouter({ paths }).route(job(design, { limits: { engineSeconds: 240, wallSeconds: 240, memoryMb: 2048 }, strategy: { iterations: 20 } }), ctxIn(dir, pcb));
      // what comes back on two layers is pad-escape stubs on the outer layer (every piece under 4 mm) and their vias, never a finished net
      expect(two.status).not.toBe('complete');
      expect(two.segments.length).toBeGreaterThan(0);
      expect(two.segments.every((s) => s.layer === 'F.Cu' && Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) < 4_000_000)).toBe(true);
      const four = importBoard({ boardText: text.replace('(0 "F.Cu" signal)', '(0 "F.Cu" signal)\n\t\t(1 "In1.Cu" signal)\n\t\t(2 "In2.Cu" signal)'), boardPath: pcb, projectText, now: 't' }).design;
      expect(four.board.layers.filter((l) => l.kind === 'copper')).toHaveLength(4);
      const dir4 = path.join(dir, 'four');
      await mkdir(dir4, { recursive: true });
      const r = await new OrthorouteRouter({ paths }).route(job(four, { limits: { engineSeconds: 240, wallSeconds: 240, memoryMb: 2048 }, strategy: { iterations: 40 } }), ctxIn(dir4, pcb));
      expect(r.segments.length).toBeGreaterThan(0);
      expect(r.segments.some((s) => s.layer === 'In1.Cu' || s.layer === 'In2.Cu')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
});

describe('live engines (scripts/tools.sh)', () => {
  const tools = path.join(ROOT, 'vendor', 'tools');
  it('Freerouting routes the completion board (COPPERHEAD_TEST_FREEROUTING=1)', async () => {
    if (process.env.COPPERHEAD_TEST_FREEROUTING !== '1' || !existsSync(path.join(tools, 'jre25', 'bin', 'java'))) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-fr-live-'));
    try {
      const { pcb, design } = await completion();
      const r = await new FreeroutingRouter({ repoRoot: ROOT, passes: 10 }).route(job(design), ctxIn(dir, pcb));
      expect(r.status).toBe('complete');
      expect(r.unroutedNetIds).toEqual([]);
      expect(r.segments.length).toBeGreaterThan(10);
      expect(r.provenance.invocation?.binary).toContain('java');
      expect(existsSync(path.join(dir, 'board.dsn'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('kicad-tools routes the completion board (COPPERHEAD_TEST_KICAD_TOOLS=1)', async () => {
    if (process.env.COPPERHEAD_TEST_KICAD_TOOLS !== '1' || !existsSync(resolveKct(process.env, ROOT))) return;
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-kct-live-'));
    try {
      const { pcb, text, design } = await completion();
      const boardCopy = path.join(dir, 'board.kicad_pcb');
      await writeFile(boardCopy, text, 'utf8');
      const r = await new KicadToolsRouter({ repoRoot: ROOT }).route(job(design, { strategy: { strategy: 'basic' }, limits: { engineSeconds: 240, wallSeconds: 240, memoryMb: 2048 } }), ctxIn(dir, boardCopy));
      expect(['complete', 'partial']).toContain(r.status);
      expect(r.segments.length).toBeGreaterThan(0);
      expect(r.segments.every((s) => design.nets.some((n) => n.id === s.netId))).toBe(true);
      void pcb;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
});

describe('real-world board dialects', () => {
  // spisolator (PCBench, MIT): a KiCad 4 board with a back-side SOIC, upgraded by kicad-cli to the KiCad 10 format
  const fixture = path.join(HERE, 'fixtures', 'pcb', 'spisolator.kicad_pcb');
  it('presents back-side images from the top view like KiCad\'s exporter (pins mirrored, [T] padstacks, place back rot+180)', async () => {
    const { design } = importBoard({ boardText: await readFile(fixture, 'utf8'), boardPath: fixture, now: 't' });
    const u1 = design.components.find((c) => c.reference === 'U1')!;
    expect(u1.attributes.side).toBe('back');
    const dsn = emitDsn(design, { boardName: 'spisolator', edgeClearanceNm: 0 });
    // numbers from pcbnew.ExportSpecctraDSN on the same board
    expect(dsn).toMatch(/\(place U1 148590 -114935 back 180 /);
    const image = /\(image "?SMD_Packages:SOIC-14_N"?[\s\S]*?\n    \)/.exec(dsn)![0];
    expect(image).toMatch(/\(pin "?Rect\[T\]Pad_508x1343_um_0_\w+"? 1 -3810 -3402\)/);
    expect(image).toMatch(/\(pin "?Rect\[T\]Pad_508x1343_um_\d+_\w+"? 8 3810 3148\)/);
    expect(image).not.toMatch(/\[B\]/);
  });
  it('rewrites the KiCad 10 net dialect into net codes for kct without touching anything else', async () => {
    const text = await readFile(fixture, 'utf8');
    const { design } = importBoard({ boardText: text, boardPath: fixture, now: 't' });
    expect(design.source.netDialect).toBe('name');
    const out = toCodeDialect(text, design);
    expect(out).toMatch(/\n\t\(net 0 ""\)\n\t\(net \d+ "GND"\)/);
    expect(out).not.toMatch(/\(net "[^"]*"\)/);
    expect((out.match(/\(net \d+ "\/BUFEN"\)/g) ?? []).length).toBeGreaterThan(1);
    const back = importBoard({ boardText: out, boardPath: fixture, now: 't' }).design;
    expect(back.source.netDialect).toBe('code');
    expect(back.nets.map((n) => n.name).sort()).toEqual(design.nets.map((n) => n.name).sort());
    expect(back.components.flatMap((c) => c.pads.map((p) => p.netId && back.nets.find((n) => n.id === p.netId)!.name))).toEqual(design.components.flatMap((c) => c.pads.map((p) => p.netId && design.nets.find((n) => n.id === p.netId)!.name)));
  });
});
