import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HANDLERS } from '../src/capabilities/handlers.js';
import { STAGES } from '../src/commands/create.js';
import { outputsPackageGap } from '../src/commands/outputs.js';
import { loadConfig } from '../src/config.js';
import { JLC_PROFILE } from '../src/kicad/jlc-profile.js';
import { resetKicadCliCache } from '../src/kicad/cli.js';
import type { RunContext } from '../src/agent/context.js';

const exec = vi.hoisted(() => vi.fn());
vi.mock('execa', async original => ({ ...(await original<typeof import('execa')>()), execa: exec }));
const ok = { failed: false, exitCode: 0, stdout: '', stderr: '' };
const board = '(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user)))';
const bom = '| Refdes | Value | Footprint | MPN |\n|---|---|---|---|\n| R1 | 1k | R_0603 | RC0603 |\n';
async function put(file: string, text: string) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }
async function emit(args: string[], version = '10.0.0') {
  if (args[0] === 'version') return { ...ok, stdout: version };
  const out = args[args.indexOf('--output') + 1]!;
  if (args[2] === 'gerbers') {
    const layers: Record<string, string> = { 'F_Cu': 'Copper,L1,Top', 'B_Cu': 'Copper,L2,Bot', 'Edge_Cuts': 'Profile,NP',
      'F_Mask': 'Soldermask,Top', 'B_Mask': 'Soldermask,Bot', 'F_SilkS': 'Legend,Top', 'B_SilkS': 'Legend,Bot', 'F_Paste': 'Paste,Top', 'B_Paste': 'Paste,Bot' };
    for (const [layer, fn] of Object.entries(layers)) await put(path.join(out, `board-${layer}.gbr`), `%TF.FileFunction,${fn}*%\n%FSLAX46Y46*%\n%MOMM*%\nM02*\n`);
  } else if (args[2] === 'drill') {
    for (const kind of ['PTH', 'NPTH']) await put(path.join(out, `board-${kind}.drl`), `M48\n; FORMAT={-:-/ absolute / metric / decimal}\n; #@! TF.FileFunction,${kind === 'PTH' ? 'Plated' : 'NonPlated'},1,2,${kind}\nMETRIC\nM30\n`);
  } else if (args[2] === 'dxf') await put(path.join(out, 'board-Edge_Cuts.dxf'), '0\nEOF\n');
  else if (args[2] === 'step') await put(out, 'ISO-10303-21;\nEND-ISO-10303-21;\n');
  else if (args[2] === 'svg') await put(args[0] === 'sch' ? path.join(out, 'board.svg') : out, '<svg/>\n');
  return ok;
}

// These tests mock the KiCad process boundary. They prove dispatch and evidence
// semantics, not that any KiCad version was installed or ran on this machine.
describe('default and explicit output profiles', () => {
  let root: string; let ctx: RunContext;
  const handler = HANDLERS.find(h => h.schema.name === 'export_outputs')!;
  const stage = STAGES.find(s => s.name === 'outputs')!;
  async function configPatch(patch: Record<string, unknown>) {
    await put(path.join(root, '.copperhead/config.json'), JSON.stringify({ ...ctx.config, ...patch }));
    ctx.config = await loadConfig(root);
  }
  async function exported() { return handler.handler(ctx, {}); }
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'output-profiles-'));
    await put(path.join(root, '.copperhead/config.json'), JSON.stringify({ board: 'board.kicad_pcb', schematic: 'board.kicad_sch', docs: 'docs' }));
    await put(path.join(root, 'board.kicad_pcb'), board);
    await put(path.join(root, 'board.kicad_sch'), '(kicad_sch)');
    await put(path.join(root, 'docs/BOM.md'), bom);
    ctx = { repoRoot: root, config: await loadConfig(root), filesTouched: new Set() } as unknown as RunContext;
    resetKicadCliCache(); exec.mockReset(); exec.mockImplementation(async (_bin, args: string[]) => emit(args));
  });
  afterEach(async () => { resetKicadCliCache(); await rm(root, { recursive: true, force: true }); });

  it.each(['8.0.9', '9.0.2', '10.0.0'])('defaults to generic commands on %s without claiming JLC/fill validation', async version => {
    exec.mockImplementation(async (_bin, args: string[]) => emit(args, version));
    expect(await exported()).toMatchObject({ ok: true, text: expect.stringContaining('zone fills: not verified') });
    expect(await stage.isComplete(root, 'docs')).toBe(true);
    const calls = exec.mock.calls.map(c => c[1] as string[]);
    expect(calls.find(c => c[2] === 'gerbers')).not.toContain('--layers');
    expect(calls.find(c => c[2] === 'drill')).not.toContain('--excellon-separate-th');
    expect(calls.flat()).not.toContain('--check-zones');
    expect(calls.flat()).not.toContain('--refill-zones');
    const manifest = JSON.parse(await readFile(path.join(root, 'outputs/export-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ profile: 'generic', profileVerification: 'not-requested', zoneFill: 'not-verified', kicadVersion: version });
  });

  it('excludes identified fabrication-only and explicit DNP rows with warnings, but retains ordering parts', async () => {
    await put(path.join(root, 'docs/BOM.md'), bom + '| H1 | MountingHole | MountingHole:MountingHole_2.2mm | — |\n| TP1 | TestPoint | TestPoint:TestPoint_Pad_D1.0mm | — |\n| C1 | DNP | Capacitor_SMD:C_0603 | — |\n');
    const result = await exported();
    expect(result).toMatchObject({ ok: true, text: expect.stringContaining('H1') });
    expect(result.text).toContain('TP1');
    expect(await readFile(path.join(root, 'outputs/BOM.csv'), 'utf8')).toBe('Refdes,MPN,Qty\r\nR1,RC0603,1\r\n');
    expect(await outputsPackageGap(root, ctx.config)).toBeNull();
  });

  it('names a missing electronic MPN in the Stage6 gap instead of requesting an ineffective re-export', async () => {
    await put(path.join(root, 'docs/BOM.md'), bom.replace('RC0603', '—'));
    await exported();
    expect(await outputsPackageGap(root, ctx.config)).toContain('MPN for R1');
  });

  it('completes generic exports with descriptive references across separate parts tables', async () => {
    await put(path.join(root, 'docs/BOM.md'), `| Refdes | Value | Footprint | MPN |
|---|---|---|---|
| U_MCU | MCU | Module | ESP32-C3-MINI-1-N4X |

| Category | Current |
|---|---|
| Support | 10mA |

| MPN | Reference | Package |
|---|---|---|
| RC0603FR-0710KL | R_GO_T5 | R_0603 |
`);
    expect(await exported()).toMatchObject({ ok: true });
    expect(await readFile(path.join(root, 'outputs/BOM.csv'), 'utf8')).toBe(
      'Refdes,MPN,Qty\r\nU_MCU,ESP32-C3-MINI-1-N4X,1\r\nR_GO_T5,RC0603FR-0710KL,1\r\n');
    expect(await stage.isComplete(root, 'docs')).toBe(true);
  });

  it.each(['R1,R2', 'R1 R2', '=R1', 'R1\nR2'])('rejects grouped or unsafe ordering reference %s', async ref => {
    await put(path.join(root, 'docs/BOM.md'), bom.replace('| R1 |', `| ${ref} |`));
    await exported();
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });

  it('cannot complete an ordering BOM with duplicate descriptive references', async () => {
    await put(path.join(root, 'docs/BOM.md'), bom.replace('R1', 'U_MCU') + '| U_MCU | MCU | Module | ESP32 |\n');
    await exported();
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });

  it('exports a board-only project without schematic or BOM, but cannot complete Stage 6', async () => {
    await configPatch({ schematic: null }); await rm(path.join(root, 'docs/BOM.md'));
    expect(await exported()).toMatchObject({ ok: true });
    expect(exec.mock.calls.some(c => c[1][0] === 'sch')).toBe(false);
    expect(await stage.isComplete(root, 'docs')).toBe(false);
    expect(await outputsPackageGap(root, ctx.config)).toMatch(/board and schematic/);
  });
  it.each(['X2', 'legacy'])('packs only manufacturing layers and drills, retaining inner copper (%s)', async format => {
    const manufacturing: Record<string, string> = {
      'F.Cu': 'Copper,L1,Top', 'In1.Cu': 'Copper,L2,Inr', 'In2.Cu': 'Copper,L3,Inr', 'B.Cu': 'Copper,L4,Bot',
      'F.Mask': 'Soldermask,Top', 'B.Mask': 'Soldermask,Bot', 'F.SilkS': 'Legend,Top', 'B.SilkS': 'Legend,Bot',
      'F.Paste': 'Paste,Top', 'B.Paste': 'Paste,Bot', 'Edge.Cuts': 'Profile,NP',
    };
    const technical = ['F.Fab', 'B.Fab', 'F.CrtYd', 'B.CrtYd', 'Dwgs.User', 'Cmts.User', 'User.1'];
    const layers = [...Object.keys(manufacturing), ...technical];
    await put(path.join(root, 'board.kicad_pcb'), `(kicad_pcb (layers ${layers.map((name, i) => `(${i} "${name}" user)`).join(' ')}))`);
    exec.mockImplementation(async (_bin, args: string[]) => {
      const r = await emit(args);
      const out = args[args.indexOf('--output') + 1]!;
      if (args[2] === 'gerbers') {
        for (const layer of layers) await put(path.join(out, `board-${layer.replaceAll('.', '_')}.gbr`),
          `${format === 'X2' ? `%TF.FileFunction,${manufacturing[layer] ?? `Other,${layer}`}*%\n` : ''}M02*\n`);
        await put(path.join(out, 'board-job.gbrjob'), '{"Header":{}}');
      }
      if (args[2] === 'drill') await put(path.join(out, 'board-drl_map.gbr'), '%TF.FileFunction,Other,Drillmap*%\nM02*\n');
      return r;
    });
    expect(await exported()).toMatchObject({ ok: true });
    expect(await stage.isComplete(root, 'docs')).toBe(true);
    const zip = await readFile(path.join(root, 'outputs/fabrication.zip'));
    let offset = zip.readUInt32LE(zip.length - 6);
    const names: string[] = [];
    for (let i = 0; i < zip.readUInt16LE(zip.length - 12); i++) {
      expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
      const length = zip.readUInt16LE(offset + 28);
      names.push(zip.subarray(offset + 46, offset + 46 + length).toString('utf8'));
      offset += 46 + length + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    }
    expect(names.sort()).toEqual([...Object.keys(manufacturing).map(layer => `board-${layer.replaceAll('.', '_')}.gbr`), 'board-PTH.drl', 'board-NPTH.drl'].sort());
    for (const layer of technical) await expect(readFile(path.join(root, 'outputs/gerbers', `board-${layer.replaceAll('.', '_')}.gbr`))).resolves.toBeInstanceOf(Buffer);
    const manifest = JSON.parse(await readFile(path.join(root, 'outputs/export-manifest.json'), 'utf8'));
    expect(manifest.files.some((file: { path: string }) => file.path.endsWith('board-F_Fab.gbr'))).toBe(true);
  });
  it('exports a configured schematic without inventing an absent ordering BOM', async () => {
    await rm(path.join(root, 'docs/BOM.md'));
    expect(await exported()).toMatchObject({ ok: true });
    expect(await stage.isComplete(root, 'docs')).toBe(false);
    await expect(readFile(path.join(root, 'outputs/BOM.csv'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['(zone (net 1) (layer "F.Cu"))', '(zone (keepout (tracks not_allowed)))', '(footprint "module" (zone (layer "F.Cu")))'])(
    'preserves generic support and board bytes for %s', async zone => {
      const text = board.slice(0, -1) + ` ${zone})`; await put(path.join(root, 'board.kicad_pcb'), text);
      expect(await exported()).toMatchObject({ ok: true });
      expect(await stage.isComplete(root, 'docs')).toBe(true);
      expect(await readFile(path.join(root, 'board.kicad_pcb'), 'utf8')).toBe(text);
    });
  it('keeps generic board exports available with an incomplete BOM, without completing Stage 6', async () => {
    await put(path.join(root, 'docs/BOM.md'), bom.replace('RC0603', 'TBD'));
    expect(await exported()).toMatchObject({ ok: true, text: expect.stringContaining('BOM.csv not exported; create Stage 6 incomplete') });
    expect(await stage.isComplete(root, 'docs')).toBe(false);
    await configPatch({ schematic: null });
    expect(await exported()).toMatchObject({ ok: true });
  });
  it('makes JLC settings explicit and refuses KiCad 10 without generic fallback', async () => {
    await configPatch({ outputProfile: JLC_PROFILE });
    expect(await exported()).toMatchObject({ ok: false, text: expect.stringContaining('only for KiCad 9') });
    expect(exec.mock.calls.some(c => c[1][0] === 'pcb')).toBe(false);
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });
  it('requires fresh export evidence after either profile switch', async () => {
    expect(await exported()).toMatchObject({ ok: true });
    await configPatch({ outputProfile: JLC_PROFILE });
    expect(await stage.isComplete(root, 'docs')).toBe(false);
    exec.mockImplementation(async (_bin, args: string[]) => emit(args, '9.0.2'));
    expect(await exported()).toMatchObject({ ok: true, text: expect.stringContaining('JLC KiCad 9 settings/package checks: passed') });
    expect(await stage.isComplete(root, 'docs')).toBe(true);
    await configPatch({ outputProfile: 'generic' });
    expect(await stage.isComplete(root, 'docs')).toBe(false);
    expect(await exported()).toMatchObject({ ok: true });
    expect(await stage.isComplete(root, 'docs')).toBe(true);
    // Old JLC ZIP is not deleted or claimed as part of the new generic manifest.
    const m = JSON.parse(await readFile(path.join(root, 'outputs/export-manifest.json'), 'utf8'));
    expect(m.files.some((f: { path: string }) => f.path === 'jlcpcb.zip')).toBe(false);
  });
  it('legacy resume is read-only and points to re-export instead of manufacturing a manifest', async () => {
    expect(await exported()).toMatchObject({ ok: true });
    await rm(path.join(root, 'outputs/export-manifest.json'));
    expect(await outputsPackageGap(root, ctx.config)).toMatch(/rerun export_outputs/);
    expect(await stage.isComplete(root, 'docs')).toBe(false);
    await expect(readFile(path.join(root, 'outputs/export-manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['board.kicad_pcb', 'board.kicad_sch', 'docs/BOM.md'])('rejects source changes to %s', async file => {
    expect(await exported()).toMatchObject({ ok: true });
    await put(path.join(root, file), (await readFile(path.join(root, file), 'utf8')) + '\n');
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });
  it('binds child sheets and newly added project settings', async () => {
    await put(path.join(root, 'board.kicad_sch'), '(kicad_sch (sheet (property "Sheetfile" "child.kicad_sch")))');
    await put(path.join(root, 'child.kicad_sch'), '(kicad_sch)');
    expect(await exported()).toMatchObject({ ok: true });
    await put(path.join(root, 'child.kicad_sch'), '(kicad_sch)\n');
    expect(await stage.isComplete(root, 'docs')).toBe(false);
    expect(await exported()).toMatchObject({ ok: true });
    await put(path.join(root, 'board.kicad_pro'), '{}');
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });
  it.each(['gerbers/board-B_Cu.gbr', 'gerbers/board-PTH.drl', 'outline.dxf/board-Edge_Cuts.dxf', 'board.step', 'board.svg', 'renders/board.svg', 'BOM.csv', 'fabrication.zip'])(
    'requires %s after export', async file => {
      expect(await exported()).toMatchObject({ ok: true }); await rm(path.join(root, 'outputs', file));
      expect(await stage.isComplete(root, 'docs')).toBe(false);
    });
  it('rejects a missing copper layer even if every subprocess exits zero', async () => {
    exec.mockImplementation(async (_bin, args: string[]) => { const r = await emit(args);
      if (args[2] === 'gerbers') await rm(path.join(args[args.indexOf('--output') + 1]!, 'board-B_Cu.gbr')); return r; });
    expect(await exported()).toMatchObject({ ok: false, text: expect.stringContaining('required Gerber layer missing: B.Cu') });
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });
  it.each(['empty', 'failure'])('invalidates old success after an %s exporter result', async mode => {
    expect(await exported()).toMatchObject({ ok: true });
    exec.mockImplementation(async (_bin, args: string[]) => args[2] === 'step' ?
      (mode === 'empty' ? ok : { ...ok, failed: true, exitCode: 1, stderr: 'STEP failed' }) : emit(args));
    expect(await exported()).toMatchObject({ ok: false });
    expect(await stage.isComplete(root, 'docs')).toBe(false);
  });
  it('detects source changes during export', async () => {
    exec.mockImplementation(async (_bin, args: string[]) => { const r = await emit(args);
      if (args[2] === 'step') await put(path.join(root, 'board.kicad_pcb'), board + '\n'); return r; });
    expect(await exported()).toMatchObject({ ok: false, text: expect.stringContaining('source changed during export') });
  });
  it.each(['outputs', 'source', 'manifest-path'])('refuses unsafe %s paths', async kind => {
    const external = path.join(root, 'external'); await mkdir(external);
    await put(path.join(external, 'sentinel'), 'untouched');
    if (kind === 'outputs') await symlink(external, path.join(root, 'outputs'));
    if (kind === 'source') { await rm(path.join(root, 'board.kicad_pcb')); await symlink(path.join(external, 'sentinel'), path.join(root, 'board.kicad_pcb')); }
    if (kind === 'manifest-path') {
      expect(await exported()).toMatchObject({ ok: true });
      const p = path.join(root, 'outputs/export-manifest.json'); const m = JSON.parse(await readFile(p, 'utf8'));
      m.files[0].path = '../external/sentinel'; await put(p, JSON.stringify(m));
      expect(await stage.isComplete(root, 'docs')).toBe(false);
    } else expect(await exported()).toMatchObject({ ok: false });
    expect(await readFile(path.join(external, 'sentinel'), 'utf8')).toBe('untouched');
  });
  it('refuses unknown config profiles', async () => {
    await expect(configPatch({ outputProfile: 'typo' })).rejects.toThrow(/unsupported outputProfile/);
  });
});
