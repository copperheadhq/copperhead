import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';
import { footprintSearchDirs } from '../src/kicad/footprints.js';

// #314: a BOM footprint that is not installed stops `create` before the
// schematic stage spends a turn (AC-15.32, AC-15.33), and a re-run resumes once
// the library is added (AC-15.35). Scripted runAgentLoop, no live provider.
const mockRunAgentLoop = vi.hoisted(() => vi.fn<(opts: RunOptions) => Promise<RunResult>>());
const mockDiagnose = vi.hoisted(() => vi.fn());

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));
vi.mock('../src/agent/recovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  diagnoseStageFailure: mockDiagnose,
  transcriptExcerpt: async () => '',
}));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit: async () => ({ ok: true, output: '' }) }));
vi.mock('../src/commands/check.js', () => ({ runCheck: async () => ({ ok: true }) }));

import { runCreate } from '../src/commands/create.js';

function ok(): RunResult {
  return {
    outcome: 'success',
    exitPath: 'done',
    summary: 'mock',
    transcriptDir: '',
    filesTouched: [],
    commit: null,
    stats: {
      exitPath: 'done',
      turnsUsed: 1,
      maxTurns: 40,
      repairCyclesUsed: 0,
      maxRepairCycles: 5,
      tokensIn: 10,
      tokensOut: 10,
      perTurn: [],
      durationMs: 1,
    },
    cacheHits: 0,
  };
}

const BOM =
  '# BOM\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n' +
  '| R1 | 10k | `Resistor_SMD:R_0603_1608Metric` | RC0603FR-0710KL | bias |\n' +
  '| U3 | ESP32-C3-MINI-1 | Espressif:ESP32-C3-MINI-1 | ESP32-C3-MINI-1-N4 | module |\n';

async function writeStageDoc(repoRoot: string, request: string): Promise<void> {
  const docs = path.join(repoRoot, 'docs');
  await mkdir(docs, { recursive: true });
  if (request.includes('spec-seed'))
    await writeFile(path.join(docs, 'SPEC.md'), '# s\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
  else if (request.includes('architecture'))
    await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# s\n\n## Power\n\nLDO regulator.\n', 'utf8');
  else if (request.includes('part-selection')) await writeFile(path.join(docs, 'BOM.md'), BOM, 'utf8');
}

let prevKey: string | undefined;
let emptyConfig: string;
beforeEach(async () => {
  mockRunAgentLoop.mockReset();
  mockRunAgentLoop.mockImplementation(async (opts) => {
    await writeStageDoc(opts.repoRoot, opts.request);
    return ok();
  });
  mockDiagnose.mockReset();
  mockDiagnose.mockResolvedValue({ verdict: 'abort', reason: 'stop' });
  prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-dummy';
  // hermetic: the machine's global fp-lib-table (which may well carry an
  // Espressif library) stays out; only the stock install and the project table
  emptyConfig = await mkdtemp(path.join(tmpdir(), 'copperhead-kicadcfg-'));
  vi.stubEnv('KICAD_CONFIG_HOME', emptyConfig);
});
afterEach(async () => {
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevKey;
  vi.unstubAllEnvs();
  await rm(emptyConfig, { recursive: true, force: true });
});

const stagesRun = (): string[] => mockRunAgentLoop.mock.calls.map(([o]) => o.request.replace('create pipeline stage: ', ''));

describe('create stops for an uninstalled footprint (#314)', () => {
  it('stops before the schematic stage with an actionable message, then resumes once the library is installed', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# tiny\n', 'utf8');

      const lines: string[] = [];
      const first = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });
      expect(first.ok).toBe(false);
      expect(stagesRun()).toEqual(['spec-seed', 'architecture', 'part-selection']); // no schematic turn (AC-15.32)
      expect(mockDiagnose).not.toHaveBeenCalled(); // a missing library is not retried
      const log = lines.join('\n');
      expect(log).toContain('create stopped');
      expect(log).toContain('U3');
      expect(log).toContain('no library named "Espressif"');
      expect(log).not.toMatch(/R1\s+Resistor_SMD/); // the installed part is not reported
      expect(log).toContain('resumes at the schematic stage');
      // the stop writes no KiCad file: the scaffold comes only after the gate (AC-15.32)
      expect((await readdir(repo)).filter((f) => /\.kicad_(sch|pcb|pro|dru)$/.test(f))).toEqual([]);

      // the user installs the module's footprint project-locally, then re-runs
      const stock = (await footprintSearchDirs())[0]!;
      await mkdir(path.join(repo, 'lib', 'Espressif.pretty'), { recursive: true });
      await cp(
        path.join(stock, 'RF_Module.pretty', 'ESP32-C3-WROOM-02.kicad_mod'),
        path.join(repo, 'lib', 'Espressif.pretty', 'ESP32-C3-MINI-1.kicad_mod'),
      );
      await writeFile(
        path.join(repo, 'fp-lib-table'),
        '(fp_lib_table\n\t(version 7)\n\t(lib (name "Espressif")(type "KiCad")(uri "${KIPRJMOD}/lib/Espressif.pretty")(options "")(descr ""))\n)\n',
        'utf8',
      );
      mockRunAgentLoop.mockClear();
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      expect(stagesRun()[0]).toBe('schematic'); // earlier stages resumed past; the gate now passes (AC-15.35)
    } finally {
      await cleanup();
    }
  });
});
