import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '../src/agent/context.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { HANDLERS } from '../src/capabilities/handlers.js';
import type { CopperheadConfig } from '../src/config.js';
import type { CheckReport } from '../src/kicad/report.js';
import { checkBomReadiness, compareSchematicPcbParity } from '../src/kicad/fab.js';
import type { PinNet, SchematicSymbol } from '../src/kicad/sexp.js';
import { runCheck } from '../src/commands/check.js';

const kicad = vi.hoisted(() => ({
  exportFab: vi.fn(),
  runDrc: vi.fn(),
  runErc: vi.fn(),
}));

vi.mock('../src/kicad/cli.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/kicad/cli.js')>(),
  ...kicad,
}));

const exportOutputs = HANDLERS.find((handler) => handler.schema.name === 'export_outputs')!;
const repos: string[] = [];

beforeEach(() => {
  kicad.exportFab.mockResolvedValue({ produced: ['gerbers', 'drill'], failed: [] });
});

const clean = (source: 'erc' | 'drc'): CheckReport => ({
  ok: true,
  source,
  violations: [],
  ...(source === 'drc' ? { unrouted: 0, intrinsic: [] } : {}),
});

async function context(): Promise<RunContext> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'copperhead-export-preflight-'));
  repos.push(repoRoot);
  await mkdir(path.join(repoRoot, 'docs'));
  await writeFile(path.join(repoRoot, 'board.kicad_sch'), `(kicad_sch
    (lib_symbols
      (symbol "Device:R"
        (pin passive line (at 0 0 0) (length 1)
          (name "~") (number "1"))
        (pin passive line (at 2.54 0 180) (length 1)
          (name "~") (number "2"))))
    (symbol
      (lib_id "Device:R") (at 10 10 0) (unit 1)
      (property "Reference" "R1")
      (property "Value" "10k")
      (property "Footprint" "Resistor_SMD:R_0603_1608Metric")
      (uuid "r1"))
    (label "VCC" (at 10 10 0)))\n`);
  await writeFile(path.join(repoRoot, 'board.kicad_pcb'), `(kicad_pcb
    (footprint "Resistor_SMD:R_0603_1608Metric"
      (property "Reference" "R1")
      (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "VCC"))
      (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu"))))\n`);
  await writeFile(
    path.join(repoRoot, 'docs', 'BOM.md'),
    '| Refdes | Value | Footprint | MPN | Rationale |\n' +
      '|---|---|---|---|---|\n' +
      '| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | verified pull-up |\n',
  );
  const config: CopperheadConfig = {
    schematic: 'board.kicad_sch',
    board: 'board.kicad_pcb',
    docs: 'docs/',
    model: null,
    maxTurns: 40,
    maxRepairCycles: 5,
    budgets: {},
    turnTimeoutMs: 1,
    turnMaxMs: 1,
    heartbeatMs: 1,
    maxStageRetries: 2,
    llmCache: true,
  };
  await mkdir(path.join(repoRoot, '.copperhead'));
  await writeFile(path.join(repoRoot, '.copperhead', 'config.json'), `${JSON.stringify(config)}\n`);
  return {
    repoRoot,
    config,
    filesTouched: new Set<string>(),
    ledger: new ObligationsLedger(),
  } as unknown as RunContext;
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(repos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })));
});

describe('fabrication export preflight', () => {
  it('does not create outputs or invoke an exporter when ERC has violations', async () => {
    const ctx = await context();
    kicad.runErc.mockResolvedValue({
      ...clean('erc'),
      ok: false,
      violations: [{
        severity: 'error',
        type: 'pin_not_connected',
        description: 'Input pin is not connected',
        items: [{ description: 'U1 pin 1' }],
      }],
    });
    kicad.runDrc.mockResolvedValue(clean('drc'));

    const result = await exportOutputs.handler(ctx, {});

    expect(result).toMatchObject({ ok: false });
    expect(kicad.runErc).toHaveBeenCalledOnce();
    expect(kicad.exportFab).not.toHaveBeenCalled();
    expect(existsSync(path.join(ctx.repoRoot, 'outputs'))).toBe(false);
  });

  it('does not create outputs or invoke an exporter when DRC has a routed-board violation', async () => {
    const ctx = await context();
    kicad.runErc.mockResolvedValue(clean('erc'));
    kicad.runDrc.mockResolvedValue({
      ...clean('drc'),
      ok: false,
      violations: [{
        severity: 'error',
        type: 'shorting_items',
        description: 'Two nets are shorted',
        items: [{ description: 'Track [GND]' }, { description: 'Track [VBUS]' }],
      }],
    });

    const result = await exportOutputs.handler(ctx, {});

    expect(result).toMatchObject({ ok: false });
    expect(kicad.runDrc).toHaveBeenCalledOnce();
    expect(kicad.exportFab).not.toHaveBeenCalled();
    expect(existsSync(path.join(ctx.repoRoot, 'outputs'))).toBe(false);
  });

  it('does not create outputs or invoke an exporter while connections remain unrouted', async () => {
    const ctx = await context();
    kicad.runErc.mockResolvedValue(clean('erc'));
    kicad.runDrc.mockResolvedValue({
      ...clean('drc'),
      unrouted: 1,
    });

    const result = await exportOutputs.handler(ctx, {});

    expect(result).toMatchObject({ ok: false });
    expect(kicad.runDrc).toHaveBeenCalledOnce();
    expect(kicad.exportFab).not.toHaveBeenCalled();
    expect(existsSync(path.join(ctx.repoRoot, 'outputs'))).toBe(false);
  });

  it('refuses an UNVERIFIED BOM row before invoking an exporter', async () => {
    const ctx = await context();
    await writeFile(
      path.join(ctx.repoRoot, 'docs', 'BOM.md'),
      '| Refdes | Value | Footprint | MPN | Rationale |\n' +
        '|---|---|---|---|---|\n' +
        '| U1 | MCU | Package_QFP:LQFP-48_7x7mm_P0.5mm | STM32F072CBT6 | UNVERIFIED candidate |\n',
    );
    kicad.runErc.mockResolvedValue(clean('erc'));
    kicad.runDrc.mockResolvedValue(clean('drc'));

    const result = await exportOutputs.handler(ctx, {});

    expect(result).toMatchObject({ ok: false });
    expect(typeof result === 'string' ? result : result.text).toContain('U1 is UNVERIFIED');
    expect(kicad.exportFab).not.toHaveBeenCalled();
    expect(existsSync(path.join(ctx.repoRoot, 'outputs'))).toBe(false);
  });

  it('names every missing required BOM field and does not invoke an exporter', async () => {
    const ctx = await context();
    await writeFile(
      path.join(ctx.repoRoot, 'docs', 'BOM.md'),
      '| Refdes | Value | Footprint | MPN | Rationale |\n' +
        '|---|---|---|---|---|\n' +
        '| R1 |  |  |  |  |\n',
    );
    kicad.runErc.mockResolvedValue(clean('erc'));
    kicad.runDrc.mockResolvedValue(clean('drc'));

    const result = await exportOutputs.handler(ctx, {});

    expect(result).toMatchObject({ ok: false });
    const text = typeof result === 'string' ? result : result.text;
    expect(text).toContain('R1 has no value');
    expect(text).toContain('R1 has no footprint');
    expect(text).toContain('R1 has no MPN');
    expect(text).toContain('R1 has no rationale');
    expect(kicad.exportFab).not.toHaveBeenCalled();
    expect(existsSync(path.join(ctx.repoRoot, 'outputs'))).toBe(false);
  });

  it('runs schematic/PCB pad parity before invoking an exporter', async () => {
    const ctx = await context();
    await writeFile(
      path.join(ctx.repoRoot, 'board.kicad_pcb'),
      '(kicad_pcb (footprint "Resistor_SMD:R_0603_1608Metric" (property "Reference" "R1")))\n',
    );
    kicad.runErc.mockResolvedValue(clean('erc'));
    kicad.runDrc.mockResolvedValue(clean('drc'));

    const result = await exportOutputs.handler(ctx, {});

    expect(result).toMatchObject({ ok: false });
    expect(typeof result === 'string' ? result : result.text).toContain('R1.1 is missing from PCB footprint');
    expect(kicad.exportFab).not.toHaveBeenCalled();
    expect(existsSync(path.join(ctx.repoRoot, 'outputs'))).toBe(false);
  });

  it.each([
    ['schematic', 'board.kicad_sch', '(kicad_sch (symbol'],
    ['PCB', 'board.kicad_pcb', '(kicad_pcb (footprint "R_0603"'],
  ])('fails closed when the %s file is truncated', async (_kind, file, malformed) => {
    const ctx = await context();
    await writeFile(path.join(ctx.repoRoot, file), malformed);
    kicad.runErc.mockResolvedValue(clean('erc'));
    kicad.runDrc.mockResolvedValue(clean('drc'));

    const result = await exportOutputs.handler(ctx, {});

    expect(result).toMatchObject({ ok: false });
    expect(typeof result === 'string' ? result : result.text).toContain('unbalanced parentheses');
    expect(kicad.exportFab).not.toHaveBeenCalled();
    expect(existsSync(path.join(ctx.repoRoot, 'outputs'))).toBe(false);
  });

  it('records board-hash and file provenance only after Gerber and drill files exist', async () => {
    const ctx = await context();
    kicad.runErc.mockResolvedValue(clean('erc'));
    kicad.runDrc.mockResolvedValue(clean('drc'));
    kicad.exportFab.mockImplementation(async (_pcb, _sch, outDir) => {
      await mkdir(path.join(outDir, 'gerbers'), { recursive: true });
      await writeFile(path.join(outDir, 'gerbers', 'board-F_Cu.gbr'), 'G04*\n');
      await writeFile(path.join(outDir, 'gerbers', 'board.drl'), 'M48\n');
      return { produced: ['gerbers', 'drill'], failed: [] };
    });

    const result = await exportOutputs.handler(ctx, {});

    expect(result).toMatchObject({ ok: true });
    const saved = JSON.parse(await readFile(path.join(ctx.repoRoot, '.copperhead', 'config.json'), 'utf8')) as CopperheadConfig;
    expect(saved.fabOutputs?.boardSha256).toBe(
      createHash('sha256').update(await readFile(path.join(ctx.repoRoot, 'board.kicad_pcb'))).digest('hex'),
    );
    expect(saved.fabOutputs?.files).toEqual([
      'outputs/gerbers/board-F_Cu.gbr',
      'outputs/gerbers/board.drl',
    ]);
    expect(saved.fabOutputs?.generatedAt).toEqual(expect.any(String));
  });

  it('rejects a nominally successful export that did not create a drill file', async () => {
    const ctx = await context();
    kicad.runErc.mockResolvedValue(clean('erc'));
    kicad.runDrc.mockResolvedValue(clean('drc'));
    kicad.exportFab.mockImplementation(async (_pcb, _sch, outDir) => {
      await mkdir(path.join(outDir, 'gerbers'), { recursive: true });
      await writeFile(path.join(outDir, 'gerbers', 'board-F_Cu.gbr'), 'G04*\n');
      return { produced: ['gerbers', 'drill'], failed: [] };
    });

    const result = await exportOutputs.handler(ctx, {});

    expect(result).toMatchObject({ ok: false });
    expect(typeof result === 'string' ? result : result.text).toContain('drill');
    const saved = JSON.parse(await readFile(path.join(ctx.repoRoot, '.copperhead', 'config.json'), 'utf8')) as CopperheadConfig;
    expect(saved.fabOutputs).toBeUndefined();
  });

  it('does not record provenance for a partial exporter failure', async () => {
    const ctx = await context();
    kicad.runErc.mockResolvedValue(clean('erc'));
    kicad.runDrc.mockResolvedValue(clean('drc'));
    kicad.exportFab.mockResolvedValue({
      produced: ['gerbers'],
      failed: [{ artifact: 'drill', reason: 'kicad-cli exited 1' }],
    });

    const result = await exportOutputs.handler(ctx, {});

    expect(result).toMatchObject({ ok: false });
    const saved = JSON.parse(await readFile(path.join(ctx.repoRoot, '.copperhead', 'config.json'), 'utf8')) as CopperheadConfig;
    expect(saved.fabOutputs).toBeUndefined();
  });
});

describe('schematic-to-PCB fabrication parity', () => {
  const symbol = (ref: string, footprint: string): SchematicSymbol => ({
    ref,
    footprint,
    value: 'part',
    libId: 'Device:R',
    sheet: '/',
    at: { x: 0, y: 0, rot: 0 },
    uuid: ref,
    unit: 1,
  });
  const pin = (ref: string, pinNumber: string, net: string | null): PinNet => ({
    ref,
    pinNumber,
    pinName: pinNumber,
    net,
  });

  it('passes matching references, footprints, pad numbers, and nets', () => {
    expect(compareSchematicPcbParity(
      [symbol('R1', 'Resistor_SMD:R_0603_1608Metric')],
      [pin('R1', '1', 'VCC'), pin('R1', '2', 'GND')],
      [{ ref: 'R1', footprint: 'Resistor_SMD:R_0603_1608Metric' }],
      [{ ref: 'R1', pad: '1', net: 'VCC' }, { ref: 'R1', pad: '2', net: 'GND' }],
    ).status).toBe('pass');
  });

  it('accepts KiCad root-sheet and synthetic unconnected PCB net names', () => {
    expect(compareSchematicPcbParity(
      [symbol('J1', 'Connector:USB_C')],
      [pin('J1', 'A5', 'USB_CC1'), pin('J1', 'A6', null)],
      [{ ref: 'J1', footprint: 'Connector:USB_C' }],
      [
        { ref: 'J1', pad: 'A5', net: '/USB_CC1' },
        { ref: 'J1', pad: 'A6', net: 'unconnected-(J1-D+-PadA6)' },
      ],
    ).status).toBe('pass');
  });

  it('does not erase hierarchy or accept a genuinely different root net', () => {
    const result = compareSchematicPcbParity(
      [symbol('R1', 'Resistor:R')],
      [pin('R1', '1', 'SIGNAL'), pin('R1', '2', '/child/SIGNAL')],
      [{ ref: 'R1', footprint: 'Resistor:R' }],
      [
        { ref: 'R1', pad: '1', net: '/OTHER' },
        { ref: 'R1', pad: '2', net: 'SIGNAL' },
      ],
    );
    expect(result.status).toBe('fail');
    expect(result.violations).toHaveLength(2);
  });

  it('fails closed when both design files contain no components', () => {
    const result = compareSchematicPcbParity([], [], [], []);
    expect(result.status).toBe('fail');
    expect(result.violations[0]?.actual).toContain('no components');
  });

  it('reports missing and extra component references', () => {
    const result = compareSchematicPcbParity(
      [symbol('R1', 'R_0603')],
      [],
      [{ ref: 'C1', footprint: 'C_0603' }],
      [],
    );
    expect(result.status).toBe('fail');
    expect(result.violations.map((item) => item.actual)).toEqual(expect.arrayContaining([
      'R1 is missing from PCB',
      'C1 is absent from schematic',
    ]));
  });

  it('reports an exact footprint mismatch', () => {
    const result = compareSchematicPcbParity(
      [symbol('R1', 'Resistor_SMD:R_0603_1608Metric')],
      [],
      [{ ref: 'R1', footprint: 'R_0603_DRAFT' }],
      [],
    );
    expect(result.status).toBe('fail');
    expect(result.violations[0]?.actual).toContain('R_0603_DRAFT');
    expect(result.violations[0]?.actual).toContain('Resistor_SMD:R_0603_1608Metric');
  });

  it('reports missing, extra, and incorrectly netted pads', () => {
    const result = compareSchematicPcbParity(
      [symbol('U1', 'Package_SO:SOIC-8')],
      [pin('U1', '1', 'VCC'), pin('U1', '2', 'GND')],
      [{ ref: 'U1', footprint: 'Package_SO:SOIC-8' }],
      [{ ref: 'U1', pad: '1', net: 'GND' }, { ref: 'U1', pad: '3', net: 'SIG' }],
    );
    expect(result.status).toBe('fail');
    expect(result.violations.map((item) => item.actual)).toEqual(expect.arrayContaining([
      'U1.1 is on GND on PCB, VCC in schematic',
      'U1.2 is missing from PCB footprint',
      'U1.3 has no matching schematic pin',
    ]));
  });
});

describe('check --fab inspection', () => {
  it('adds the five stable fab sections without changing plain check output', async () => {
    const ctx = await context();
    kicad.runErc.mockResolvedValue(clean('erc'));
    kicad.runDrc.mockResolvedValue(clean('drc'));

    const plain = await runCheck(ctx.repoRoot, () => {});
    const inspected = await runCheck(ctx.repoRoot, () => {}, { fab: true });

    expect(plain).not.toHaveProperty('fab');
    expect(inspected.fab).toBeDefined();
    expect(Object.keys(inspected.fab!)).toEqual(['routing', 'bom', 'schPcbMatch', 'outputs', 'docs']);
    expect(kicad.runDrc).toHaveBeenCalledTimes(2);
  });

  it('warns for UNVERIFIED in normal inspection and fails it in strict mode', () => {
    const bom = '| Refdes | Value | Footprint | MPN | Rationale |\n' +
      '|---|---|---|---|---|\n' +
      '| R1 | 10k | R_0603 | RC0603 | UNVERIFIED candidate |\n';
    expect(checkBomReadiness(bom, false).status).toBe('warn');
    expect(checkBomReadiness(bom, true).status).toBe('fail');
  });
});
