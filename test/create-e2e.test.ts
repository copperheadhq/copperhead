import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';

// End-to-end coverage for the 8-stage `copperhead create` pipeline (issue #66):
// a brief must drive ALL stages — spec-seed → architecture → part-selection →
// schematic → layout-draft → outputs → firmware → devplan — to a committed
// final stage, with the per-stage gates satisfied. The agent loop and every
// KiCad-backed gate are mocked; the pipeline logic itself (stage ordering,
// completion contracts, commits, cost accounting, run report) runs for real.

const mockRunAgentLoop = vi.hoisted(() => vi.fn<(opts: RunOptions) => Promise<RunResult>>());

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));
vi.mock('../src/openspec/cli.js', () => ({
  openspecInit: async () => ({ ok: true, output: 'mocked' }),
}));
vi.mock('../src/commands/check.js', () => ({
  runCheck: async () => ({ ok: true }),
}));

// KiCad-backed gates used by the schematic / layout / outputs stages.
vi.mock('../src/kicad/bootstrap.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  bootstrapKicadProject: async () => 'mock-project.kicad_sch',
}));
vi.mock('../src/kicad/cli.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runErc: async () => ({ ok: true, violations: [] }),
  runDrc: async () => ({ ok: true, violations: [], unrouted: 0 }),
  exportNetlist: async () =>
    '(netlist (components (comp (ref "R1") (footprint "Resistor_SMD:R_0603_1608Metric"))))',
}));
vi.mock('../src/kicad/sexp.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listSymbols: async () => [{ refdes: 'R1', lib: 'Device:R', value: '10k', units: 1 }],
}));
vi.mock('../src/kicad/legibility.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkLegibility: async () => ({
    findings: [], counts: { error: 0, advisory: 0 }, skipped: [], disabled: [], suppressed: [], sheets: 1,
  }),
}));
vi.mock('../src/memory/drift.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkDrift: async () => [],
}));
// The footprint resolver reads the real KiCad library table (absent in CI).
// Mock it as fully-populated: every queried footprint resolves OK.
vi.mock('../src/kicad/footprints.js', async (importOriginal) => {
  const actual = await importOriginal<object>();
  class MockResolver {
    readonly searched = ['mock footprints (1 dir)'];
    static async create() { return new MockResolver(); }
    async resolve(fpId: string) {
      const i = fpId.indexOf(':');
      return i > 0
        ? { ok: true as const, path: `/mock/${fpId.replace(':', '/')}.kicad_mod`, pads: [] }
        : { ok: false as const, why: 'bad-id' as const, near: [] };
    }
    async pads(fpId: string) { return new Map<string, { thermal: boolean }>(); }
  }
  return {
    ...(await importOriginal<object>()),
    FootprintResolver: MockResolver,
    missingFootprints: async () => [],
    formatMissingFootprints: () => '',
  };
});

import { runCreate, STAGES } from '../src/commands/create.js';

function ok(): RunResult {
  return {
    outcome: 'success',
    exitPath: 'done',
    summary: 'mocked',
    transcriptDir: '',
    filesTouched: [],
    commit: null,
    stats: {
      exitPath: 'done',
      turnsUsed: 3,
      maxTurns: 40,
      repairCyclesUsed: 0,
      maxRepairCycles: 5,
      tokensIn: 1000,
      tokensOut: 200,
      perTurn: [],
      durationMs: 1000,
    },
    cacheHits: 0,
  };
}

/** Write the artifact that satisfies the named stage's completion contract. */
async function satisfyStage(stage: string, repoRoot: string): Promise<void> {
  const docs = path.join(repoRoot, 'docs');
  await mkdir(docs, { recursive: true });
  const write = (p: string, c: string) => writeFile(path.join(repoRoot, p), c, 'utf8');
  switch (stage) {
    case 'spec-seed':
      await write('docs/SPEC.md', '# spec\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
      break;
    case 'architecture':
      await write('docs/SUBSYSTEMS.md', '# subsystems\n\n## Power\n\nLDO regulator 3.3 V.\n', 'utf8');
      break;
    case 'part-selection':
      await write(
        'docs/BOM.md',
        '# bom\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | bias |\n',
        'utf8',
      );
      break;
    case 'schematic':
      // bootstrapKicadProject is mocked to report a project; the completion
      // contract additionally needs config wiring, symbols (mocked non-empty),
      // drift-clean (mocked), ERC-clean (mocked), legibility-clean (mocked).
      // Wire the schematic path into config so isComplete finds the file.
      {
        const cfgPath = path.join(repoRoot, '.copperhead', 'config.json');
        const cfg = existsSync(cfgPath)
          ? JSON.parse(await readFile(cfgPath, 'utf8'))
          : {};
        cfg.schematic = 'mock-project.kicad_sch';
        await write(cfg.schematic, '(kicad_sch (version 20231120))\n', 'utf8');

        cfg.board = 'mock-project.kicad_pcb';
        await write(cfg.board,
          '(kicad_pcb (version 20231120) (footprint "Resistor_SMD:R_0603_1608Metric" (at 0 0) (property "Reference" "R1"))',
          'utf8');
        await writeFile(cfgPath, JSON.stringify(cfg), 'utf8');
      }
      break;
    case 'layout-draft': {
      // Layout gate: needs config.schematic + run_drc clean (mocked). The
      // layout doc with "## Draft quality" section is part of the contract.
      const cfgPath = path.join(repoRoot, '.copperhead', 'config.json');
      const cfg = existsSync(cfgPath) ? JSON.parse(await readFile(cfgPath, 'utf8')) : {};
      cfg.schematic = 'mock-project.kicad_sch';
      await writeFile(cfgPath, JSON.stringify(cfg), 'utf8');
      await write('docs/LAYOUT.md', '# layout\n\n## Draft quality\n\nAll fine.\n', 'utf8');
      break;
    }
    case 'outputs':
      await mkdir(path.join(repoRoot, 'outputs'), { recursive: true });
      await write('outputs/pcb.gbr', '%FSLAX46Y46*%\n', 'utf8');
      break;
    case 'firmware':
      await mkdir(path.join(repoRoot, 'firmware'), { recursive: true });
      await write('firmware/main.c', 'int main(void) { return 0; }\n', 'utf8');
      break;
    case 'devplan':
      await write(
        'docs/DEVPLAN.md',
        '# dev plan\n\n## Bring-up\n\n1. Power first.\n\nMeasure the 3V3 rail before flashing.\n',
        'utf8',
      );
      break;
  }
}

let prevKey: string | undefined;
beforeEach(() => {
  mockRunAgentLoop.mockReset();
  // The mocked loop satisfies the stage contract in-flight, like the real
  // agent would: each call completes its stage's artifact, then succeeds.
  mockRunAgentLoop.mockImplementation(async (opts) => {
    for (const stage of STAGES) {
      if (opts.request.includes(stage.name)) await satisfyStage(stage.name, opts.repoRoot);
    }
    return ok();
  });
  prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'mock-key-for-provider-construction';
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevKey;
});

describe('create pipeline end-to-end (brief → clean full run, issue #66)', () => {
  it(
    'drives ALL 8 stages from a brief to a committed final stage: ' +
      'every stage runs in order, completes, and the run reports ok',
    async () => {
      const { repo, cleanup } = await tempFixtureRepo();
      try {
        await mkdir(path.join(repo, '.copperhead'), { recursive: true });
        const briefPath = path.join(repo, 'brief.md');
        await writeFile(briefPath, '# A tiny USB-C device\n', 'utf8');

        const lines: string[] = [];
        const res = await runCreate({
          repoRoot: repo,
          briefPath,
          model: 'gpt-5',
          log: (s) => lines.push(s),
        });

        // The full pipeline completed.
        expect(res.ok).toBe(true);
        expect(res.completed).toEqual(STAGES.map((s) => s.name));

        // Every stage invoked the agent exactly once (clean run, no retries).
        expect(mockRunAgentLoop).toHaveBeenCalledTimes(STAGES.length);
        const requests = mockRunAgentLoop.mock.calls.map(([o]) => o.request);
        for (const s of STAGES) {
          expect(requests.some((r) => r.includes(s.name))).toBe(true);
        }

        // All 8 stage artifacts exist on disk.
        expect(existsSync(path.join(repo, 'docs', 'SPEC.md'))).toBe(true);
        expect(existsSync(path.join(repo, 'docs', 'SUBSYSTEMS.md'))).toBe(true);
        expect(existsSync(path.join(repo, 'docs', 'BOM.md'))).toBe(true);
        expect(existsSync(path.join(repo, 'outputs', 'pcb.gbr'))).toBe(true);
        expect(existsSync(path.join(repo, 'firmware', 'main.c'))).toBe(true);
        expect(existsSync(path.join(repo, 'docs', 'DEVPLAN.md'))).toBe(true);

        // The final run report exists and lists every stage (writeRunReport).
        const report = await readFile(path.join(repo, '.copperhead', 'runs', 'REPORT.md'), 'utf8');
        for (const s of STAGES) expect(report).toContain(s.name);
      } finally {
        await cleanup();
      }
    },
    120_000,
  );

  it(
    'a mid-pipeline stage whose contract stays unmet halts the pipeline with ' +
      'completed stages preserved and the run still recoverable',
    async () => {
      const { repo, cleanup } = await tempFixtureRepo();
      try {
        await mkdir(path.join(repo, '.copperhead'), { recursive: true });
        const briefPath = path.join(repo, 'brief.md');
        await writeFile(briefPath, '# A tiny device\n', 'utf8');

        // The agent never produces the firmware artifact: pipeline must halt
        // cleanly after everything up to outputs, without a devplan.
        mockRunAgentLoop.mockImplementation(async (opts) => {
          for (const stage of STAGES) {
            if (stage.name === 'firmware') continue;
            if (opts.request.includes(stage.name)) await satisfyStage(stage.name, opts.repoRoot);
          }
          return ok();
        });

        const res = await runCreate({
          repoRoot: repo,
          briefPath,
          model: 'gpt-5',
          log: () => {},
        });

        expect(res.ok).toBe(false);
        expect(res.completed).toEqual([
          'spec-seed',
          'architecture',
          'part-selection',
          'schematic',
          'layout-draft',
          'outputs',
        ]);
        // The devplan stage never ran: the halt happened before it.
        expect(existsSync(path.join(repo, 'docs', 'DEVPLAN.md'))).toBe(false);
      } finally {
        await cleanup();
      }
    },
    120_000,
  );
});