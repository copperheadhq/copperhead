import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { CopperheadConfig } from '../src/config.js';
import type { CheckReport } from '../src/kicad/report.js';
import type { RunContext } from '../src/agent/context.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { HANDLERS } from '../src/capabilities/handlers.js';
import {
  checkBomReadiness,
  checkOutputFreshness,
  checkRoutingCompleteness,
  checkSchematicPcbMatch,
  recordFabOutputs,
} from '../src/kicad/fab.js';

const exportFab = vi.hoisted(() => vi.fn());
vi.mock('../src/kicad/cli.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/kicad/cli.js')>(),
  exportFab,
}));

const cleanDrc = (): CheckReport => ({
  ok: true, source: 'drc', violations: [], unrouted: 0, unconnected: [], intrinsic: [],
});

describe('fabrication release checks', () => {
  it('refuses export before invoking KiCad when schematic/PCB footprints differ', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-fab-preflight-'));
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'board.kicad_sch'), `(kicad_sch (symbol (lib_id "Device:R") (at 10 10 0) (unit 1) (property "Reference" "R1") (property "Value" "5.1k") (property "Footprint" "Resistor_SMD:R_0603_1608Metric") (uuid "r1")))`);
      await writeFile(path.join(repo, 'board.kicad_pcb'), `(kicad_pcb (footprint "R_0603_DRAFT" (layer "F.Cu") (property "Reference" "R1")))`);
      await writeFile(path.join(repo, 'docs', 'BOM.md'), `| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| R1 | 5.1k | Resistor_SMD:R_0603_1608Metric | RC0603FR-075K1L | CC resistor |
`);
      await writeFile(path.join(repo, 'docs', 'LAYOUT.md'), '# Layout\n\n## Draft quality\n\nReviewed.\n');
      const config: CopperheadConfig = {
        schematic: 'board.kicad_sch', board: 'board.kicad_pcb', docs: 'docs/', model: null,
        maxTurns: 40, maxRepairCycles: 5, budgets: {}, turnTimeoutMs: 1,
        turnMaxMs: 1, heartbeatMs: 1, maxStageRetries: 2, llmCache: true,
      };
      await writeFile(path.join(repo, '.copperhead', 'config.json'), `${JSON.stringify(config)}\n`);
      const ctx = {
        repoRoot: repo, config, filesTouched: new Set<string>(), ledger: new ObligationsLedger(),
        lastDrc: cleanDrc(),
      } as unknown as RunContext;
      const handler = HANDLERS.find((h) => h.schema.name === 'export_outputs')!;

      exportFab.mockClear();
      const result = await handler.handler(ctx, {});

      expect(result).toMatchObject({ ok: false });
      expect(typeof result === 'string' ? result : result.text).toContain('R1 footprint is R_0603_DRAFT');
      expect(exportFab).not.toHaveBeenCalled();
      expect(existsSync(path.join(repo, 'outputs'))).toBe(false);
      expect(JSON.parse(await readFile(path.join(repo, '.copperhead', 'config.json'), 'utf8'))).not.toHaveProperty('fabOutputs');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('exports after a clean preflight and records hash-backed Gerber/drill provenance', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-fab-export-'));
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      const footprint = 'Resistor_SMD:R_0603_1608Metric';
      await writeFile(path.join(repo, 'board.kicad_sch'), `(kicad_sch (symbol (lib_id "Device:R") (at 10 10 0) (unit 1) (property "Reference" "R1") (property "Value" "5.1k") (property "Footprint" "${footprint}") (uuid "r1")))`);
      await writeFile(path.join(repo, 'board.kicad_pcb'), `(kicad_pcb (footprint "${footprint}" (layer "F.Cu") (property "Reference" "R1")))`);
      await writeFile(path.join(repo, 'docs', 'BOM.md'), `| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| R1 | 5.1k | ${footprint} | RC0603FR-075K1L | CC resistor |
`);
      await writeFile(path.join(repo, 'docs', 'LAYOUT.md'), '# Layout\n\n## Draft quality\n\nReviewed.\n');
      const config: CopperheadConfig = {
        schematic: 'board.kicad_sch', board: 'board.kicad_pcb', docs: 'docs/', model: null,
        maxTurns: 40, maxRepairCycles: 5, budgets: {}, turnTimeoutMs: 1,
        turnMaxMs: 1, heartbeatMs: 1, maxStageRetries: 2, llmCache: true,
      };
      await writeFile(path.join(repo, '.copperhead', 'config.json'), `${JSON.stringify(config)}\n`);
      const ctx = {
        repoRoot: repo, config, filesTouched: new Set<string>(), ledger: new ObligationsLedger(),
        lastDrc: cleanDrc(),
      } as unknown as RunContext;
      const handler = HANDLERS.find((h) => h.schema.name === 'export_outputs')!;
      exportFab.mockReset();
      exportFab.mockImplementation(async (_pcbPath, _schPath, outDir) => {
        await mkdir(path.join(outDir, 'gerbers'), { recursive: true });
        await writeFile(path.join(outDir, 'gerbers', 'board-F_Cu.gbr'), 'G04*\n');
        await writeFile(path.join(outDir, 'gerbers', 'board.drl'), 'M48\n');
        return { produced: ['gerbers', 'drill'], failed: [] };
      });

      const result = await handler.handler(ctx, {});

      expect(result).toMatchObject({ ok: true });
      expect(exportFab).toHaveBeenCalledOnce();
      const recorded = JSON.parse(await readFile(path.join(repo, '.copperhead', 'config.json'), 'utf8')) as CopperheadConfig;
      expect(recorded.fabOutputs?.files).toEqual([
        'outputs/gerbers/board-F_Cu.gbr',
        'outputs/gerbers/board.drl',
      ]);
      expect((await checkOutputFreshness(repo, recorded)).status).toBe('pass');
      expect(ctx.filesTouched).toEqual(new Set(['outputs/', '.copperhead/config.json']));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('refuses autonomous export while a BOM part is UNVERIFIED', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-fab-unverified-'));
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      const footprint = 'Resistor_SMD:R_0603_1608Metric';
      await writeFile(path.join(repo, 'board.kicad_sch'), `(kicad_sch (symbol (lib_id "Device:R") (at 10 10 0) (unit 1) (property "Reference" "R1") (property "Value" "5.1k") (property "Footprint" "${footprint}") (uuid "r1")))`);
      await writeFile(path.join(repo, 'board.kicad_pcb'), `(kicad_pcb (footprint "${footprint}" (layer "F.Cu") (property "Reference" "R1")))`);
      await writeFile(path.join(repo, 'docs', 'BOM.md'), `| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| R1 | 5.1k | ${footprint} | RC0603FR-075K1L (UNVERIFIED) | candidate |
`);
      await writeFile(path.join(repo, 'docs', 'LAYOUT.md'), '# Layout\n\n## Draft quality\n\nReviewed.\n');
      const config: CopperheadConfig = {
        schematic: 'board.kicad_sch', board: 'board.kicad_pcb', docs: 'docs/', model: null,
        maxTurns: 40, maxRepairCycles: 5, budgets: {}, turnTimeoutMs: 1,
        turnMaxMs: 1, heartbeatMs: 1, maxStageRetries: 2, llmCache: true,
      };
      await writeFile(path.join(repo, '.copperhead', 'config.json'), `${JSON.stringify(config)}\n`);
      const ctx = {
        repoRoot: repo, config, filesTouched: new Set<string>(), ledger: new ObligationsLedger(),
        lastDrc: cleanDrc(),
      } as unknown as RunContext;
      const handler = HANDLERS.find((h) => h.schema.name === 'export_outputs')!;
      exportFab.mockClear();

      const result = await handler.handler(ctx, {});

      expect(result).toMatchObject({ ok: false });
      expect(typeof result === 'string' ? result : result.text).toContain('R1 is UNVERIFIED');
      expect(exportFab).not.toHaveBeenCalled();
      expect(existsSync(path.join(repo, 'outputs'))).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('fails and names every unrouted connection retained from DRC', () => {
    const drc: CheckReport = {
      ...cleanDrc(),
      unrouted: 1,
      unconnected: [{
        severity: 'error', type: 'unconnected_items', description: 'Unconnected items',
        items: [{ description: 'Pad 1 [KEY_DAH] of J1', x: 12.5, y: 7.5 }],
      }],
    };
    expect(checkRoutingCompleteness(drc)).toEqual({
      status: 'fail',
      violations: [{ claim: 'fully routed', actual: 'unrouted connection on KEY_DAH', location: '(12.5, 7.5)' }],
    });
    expect(checkRoutingCompleteness(cleanDrc()).status).toBe('pass');
  });

  it('fails missing BOM fields and escalates UNVERIFIED only in strict mode', () => {
    const bom = `| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603 | ok |
| R2 | 10k |  |  | missing |
| J1 | USB-C | Connector_USB:USB_C | USB4105 (UNVERIFIED) | candidate |
`;
    const normal = checkBomReadiness(bom);
    expect(normal.status).toBe('fail');
    expect(normal.violations.map((v) => v.actual)).toEqual(expect.arrayContaining([
      'R2 has no MPN', 'R2 has no footprint', 'J1 is UNVERIFIED',
    ]));
    const onlyUnverified = bom.replace('| R2 | 10k |  |  | missing |\n', '');
    expect(checkBomReadiness(onlyUnverified).status).toBe('warn');
    expect(checkBomReadiness(onlyUnverified, true).status).toBe('fail');
  });

  it('catches the usbc5v failure: a library footprint replaced by *_DRAFT geometry', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-fab-match-'));
    try {
      const sch = path.join(dir, 'board.kicad_sch');
      const pcb = path.join(dir, 'board.kicad_pcb');
      await writeFile(sch, `(kicad_sch (symbol (lib_id "Connector:USB_C_Receptacle_USB2.0_16P") (at 10 10 0) (unit 1) (property "Reference" "J1") (property "Value" "USB") (property "Footprint" "Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal") (uuid "j1")))`);
      await writeFile(pcb, `(kicad_pcb (footprint "USB_C_Receptacle_USB4105_DRAFT" (layer "F.Cu") (property "Reference" "J1")))`);
      const result = await checkSchematicPcbMatch(sch, pcb);
      expect(result.status).toBe('fail');
      expect(result.violations[0]?.actual).toContain('USB_C_Receptacle_USB4105_DRAFT');
      expect(result.violations[0]?.actual).toContain('Connector_USB:USB_C_Receptacle_GCT_USB4105');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('records content provenance, passes current outputs, and rejects stale or missing outputs', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-fab-output-'));
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await mkdir(path.join(repo, 'outputs', 'gerbers'), { recursive: true });
      await writeFile(path.join(repo, 'board.kicad_pcb'), '(kicad_pcb)\n');
      await writeFile(path.join(repo, 'outputs', 'gerbers', 'board-F_Cu.gbr'), 'G04*\n');
      await writeFile(path.join(repo, 'outputs', 'gerbers', 'board.drl'), 'M48\n');
      const config: CopperheadConfig = {
        schematic: null, board: 'board.kicad_pcb', docs: 'docs/', model: null,
        maxTurns: 40, maxRepairCycles: 5, budgets: {}, turnTimeoutMs: 1,
        turnMaxMs: 1, heartbeatMs: 1, maxStageRetries: 2, llmCache: true,
      };
      await writeFile(path.join(repo, '.copperhead', 'config.json'), `${JSON.stringify(config)}\n`);
      expect((await checkOutputFreshness(repo, config)).status).toBe('fail');
      await recordFabOutputs(repo, config);
      const recorded = JSON.parse(await readFile(path.join(repo, '.copperhead', 'config.json'), 'utf8')) as CopperheadConfig;
      expect((await checkOutputFreshness(repo, recorded)).status).toBe('pass');
      await writeFile(path.join(repo, 'board.kicad_pcb'), '(kicad_pcb (version 1))\n');
      expect((await checkOutputFreshness(repo, recorded)).violations.some((v) => v.actual.includes('stale'))).toBe(true);
      await rm(path.join(repo, 'outputs', 'gerbers', 'board.drl'));
      expect((await checkOutputFreshness(repo, recorded)).violations.some((v) => v.actual.includes('drill package missing'))).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
