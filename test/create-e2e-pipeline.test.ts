import { describe, expect, it, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import { tempFixtureRepo } from './helpers.js';
import type { RunOptions, RunResult } from '../src/agent/loop.js';

const mockRunAgentLoop = vi.hoisted(() => vi.fn<(opts: RunOptions) => Promise<RunResult>>());
const mockOpenSpecInit = vi.hoisted(() => vi.fn());

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));
vi.mock('../src/openspec/cli.js', () => ({
  openspecInit: mockOpenSpecInit,
}));
vi.mock('../src/commands/check.js', () => ({
  runCheck: async () => ({ ok: true }),
}));
vi.mock('../src/kicad/cli.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runErc: async () => ({ ok: true, violations: [] }),
  runDrc: async () => ({ ok: true, violations: [] }),
  exportNetlist: async () => '(export (components))',
  exportSvg: async () => undefined,
}));
vi.mock('../src/kicad/footprints.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  missingFootprints: async () => [],
}));
vi.mock('../src/kicad/populate.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  boardFootprints: () => [],
  boardMatchesNetlist: () => ({ ok: true, missing: [], extra: [], changed: [] }),
  padNetMismatches: () => [],
  parseNetlist: () => ({ parts: [] }),
  populateBoard: async () => ({
    unchanged: true,
    placed: [],
    nets: 0,
    outline: { grown: false },
  }),
}));
vi.mock('../src/kicad/sexp.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/kicad/sexp.js')>();
  return {
    ...original,
    listSymbols: async (file: string) => {
      const text = await readFile(file, 'utf8').catch(() => '');
      return text.includes('(symbol') ? [{
        ref: 'R1',
        value: '10k',
        footprint: 'Resistor_SMD:R_0603_1608Metric',
        libId: 'Device:R',
      }] : [];
    },
  };
});
vi.mock('../src/memory/drift.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkDrift: async () => [],
}));
vi.mock('../src/kicad/legibility.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkLegibility: async () => ({
    findings: [],
    counts: { error: 0, advisory: 0 },
    suppressed: [],
    sheets: 1,
    score: null,
  }),
}));
vi.mock('../src/commands/export.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  emitCreateJlcpcbBom: async () => null,
}));

import { runCreate, STAGES } from '../src/commands/create.js';

function successfulRun(): RunResult {
  return {
    outcome: 'success',
    exitPath: 'done',
    summary: 'deterministic replay',
    transcriptDir: '',
    filesTouched: [],
    commit: null,
    stats: {
      exitPath: 'done',
      turnsUsed: 1,
      maxTurns: 40,
      repairCyclesUsed: 0,
      maxRepairCycles: 5,
      tokensIn: 0,
      tokensOut: 0,
      perTurn: [],
      durationMs: 1,
    },
    cacheHits: 1,
  };
}

async function writeStageArtifacts(opts: RunOptions): Promise<void> {
  const docs = path.join(opts.repoRoot, 'docs');
  await mkdir(docs, { recursive: true });
  if (opts.request.includes('spec-seed')) {
    await writeFile(path.join(docs, 'SPEC.md'), '# Soil sensor\n\n## Budgets\n\n- sleep_current_uA: 25\n- active_current_mA: 80\n', 'utf8');
  } else if (opts.request.includes('architecture')) {
    await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# Architecture\n\n## Power\n\nBattery and regulator.\n\n## Sensing\n\nTemperature and humidity.\n', 'utf8');
  } else if (opts.request.includes('part-selection')) {
    await writeFile(
      path.join(docs, 'BOM.md'),
      '# BOM\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | bias |\n',
      'utf8',
    );
  } else if (opts.request.includes('schematic')) {
    const config = JSON.parse(await readFile(path.join(opts.repoRoot, '.copperhead', 'config.json'), 'utf8')) as { schematic: string; board: string };
    const fixture = path.join(process.cwd(), 'test', 'fixtures', 'open-key', 'hardware');
    await copyFile(path.join(fixture, 'open-key.kicad_sch'), path.join(opts.repoRoot, config.schematic));
    await copyFile(path.join(fixture, 'open-key.kicad_pcb'), path.join(opts.repoRoot, config.board));
  } else if (opts.request.includes('layout-draft')) {
    await writeFile(path.join(docs, 'LAYOUT.md'), '# Layout\n\n## Draft quality\n\nPlacement is reviewable; specialist routing remains.\n', 'utf8');
  } else if (opts.request.includes('outputs')) {
    await mkdir(path.join(opts.repoRoot, 'outputs'), { recursive: true });
    await writeFile(path.join(opts.repoRoot, 'outputs', 'board-F_Cu.gbr'), 'deterministic gerber\n', 'utf8');
  } else if (opts.request.includes('firmware')) {
    await mkdir(path.join(opts.repoRoot, 'firmware'), { recursive: true });
    await writeFile(path.join(opts.repoRoot, 'firmware', 'pins.h'), '#pragma once\n#define SENSOR_PIN 4\n', 'utf8');
  } else if (opts.request.includes('devplan')) {
    await writeFile(path.join(docs, 'DEVPLAN.md'), '# Bring-up\n\n1. Measure battery current.\n', 'utf8');
  }
  await execa('git', ['add', '-A'], { cwd: opts.repoRoot });
  await execa('git', ['commit', '-q', '-m', `e2e: ${opts.request}`], { cwd: opts.repoRoot });
}

describe('create pipeline deterministic end-to-end contract', () => {
  beforeEach(() => {
    mockOpenSpecInit.mockReset();
    mockOpenSpecInit.mockResolvedValue({ ok: true, output: '' });
    mockRunAgentLoop.mockReset();
    mockRunAgentLoop.mockImplementation(async (opts) => {
      await writeStageArtifacts(opts);
      return successfulRun();
    });
  });

  it('fails before any agent turn when OpenSpec initialization fails', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const brief = path.join(repo, 'brief.md');
      await writeFile(brief, '# ESP32 soil sensor\n', 'utf8');
      mockOpenSpecInit.mockResolvedValue({ ok: false, output: 'openspec CLI not found on PATH' });
      await expect(runCreate({ repoRoot: repo, briefPath: brief, model: 'codex', log: () => {} }))
        .rejects.toThrow('OpenSpec initialization failed before starting the create pipeline: openspec CLI not found on PATH');
      expect(mockRunAgentLoop).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });

  it('reaches and commits all eight stages from a medium-complexity brief', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const brief = path.join(repo, 'brief.md');
      await writeFile(
        brief,
        '# ESP32 soil sensor\n\nUSB-C power, Li-ion battery, deep sleep, ESP32-C3, I2C sensor, OLED, and battery ADC.\n',
        'utf8',
      );
      const result = await runCreate({ repoRoot: repo, briefPath: brief, model: 'codex', log: () => {} });
      expect(result).toEqual({ ok: true, completed: STAGES.map((stage) => stage.name) });
      expect(mockRunAgentLoop).toHaveBeenCalledTimes(8);
      expect((await execa('git', ['log', '--format=%s', '-n', '8'], { cwd: repo })).stdout)
        .toContain('e2e: create pipeline stage: devplan');
      expect((await readFile(path.join(repo, 'outputs', 'board-F_Cu.gbr'), 'utf8')).trim()).toBe('deterministic gerber');
      expect((await readFile(path.join(repo, 'firmware', 'pins.h'), 'utf8')).trim()).toContain('SENSOR_PIN');
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('resumes without rerunning already-completed stages', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const brief = path.join(repo, 'brief.md');
      await writeFile(brief, '# medium board\n\nPower, MCU, sensor, display, and battery monitoring.\n', 'utf8');
      const first = await runCreate({ repoRoot: repo, briefPath: brief, model: 'codex', log: () => {} });
      expect(first.ok).toBe(true);
      mockRunAgentLoop.mockClear();
      const second = await runCreate({ repoRoot: repo, briefPath: brief, model: 'codex', log: () => {} });
      expect(second).toEqual({ ok: true, completed: STAGES.map((stage) => stage.name) });
      expect(mockRunAgentLoop).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('does not treat an empty schematic as an ERC-clean completed stage', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ schematic: 'empty.kicad_sch', board: null }),
        'utf8',
      );
      await writeFile(path.join(repo, 'empty.kicad_sch'), '(kicad_sch (version 20231120))\n', 'utf8');
      const schematic = STAGES.find((stage) => stage.name === 'schematic')!;
      expect(await schematic.isComplete(repo, 'docs/')).toBe(false);
    } finally {
      await cleanup();
    }
  }, 60_000);
});
