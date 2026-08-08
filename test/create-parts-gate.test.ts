import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';

// The stage-4 unresolvable-parts checkpoint, wired through runCreate: scripted
// runAgentLoop, no live provider (add-unresolvable-parts-checkpoint 5.3).
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

const LOGIC_LIB = `(kicad_symbol_lib (version 20251024) (generator test)
  (symbol "SN74LVC1G17" (pin_names (offset 1.016))
    (symbol "SN74LVC1G17_1_1"
      (pin input line (at -7.62 0 0) (length 2.54) (name "A") (number "2"))
      (pin output line (at 7.62 0 180) (length 2.54) (name "Y") (number "4"))
    )
  )
)`;

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

/** Complete the three doc stages up front so the pipeline enters the schematic
 * stage directly; the BOM row's ghost MPN is the part under test. */
async function seedDocStages(repo: string, mpn: string): Promise<string> {
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  const docs = path.join(repo, 'docs');
  await mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, 'SPEC.md'), '# s\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
  await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# s\n\n## Power\n\nLDO regulator.\n', 'utf8');
  await writeFile(
    path.join(docs, 'BOM.md'),
    `# b\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| U1 | buffer | SOT-23 | ${mpn} | active part |\n`,
    'utf8',
  );
  const briefPath = path.join(repo, 'brief.md');
  await writeFile(briefPath, '# tiny\n', 'utf8');
  return briefPath;
}

let libDir: string;
beforeAll(async () => {
  libDir = await mkdtemp(path.join(tmpdir(), 'copperhead-createsgate-lib-'));
  await writeFile(path.join(libDir, 'Logic.kicad_sym'), LOGIC_LIB, 'utf8');
});
afterAll(async () => {
  await rm(libDir, { recursive: true, force: true });
});

let prevKey: string | undefined;
beforeEach(() => {
  mockRunAgentLoop.mockReset();
  mockDiagnose.mockReset();
  mockDiagnose.mockResolvedValue({ verdict: 'abort', reason: 'default: stop' });
  prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-dummy';
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevKey;
  vi.unstubAllEnvs();
});

describe('runCreate + the unresolvable-parts checkpoint', () => {
  it("'stop' + a genuinely absent part ends the run before any schematic agent call and writes the JSON report", async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedDocStages(repo, 'XYZQ9999ZZ');
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ docs: 'docs/', unresolvableParts: 'stop' }, null, 2),
        'utf8',
      );
      vi.stubEnv('KICAD_SYMBOL_DIR', libDir);
      mockRunAgentLoop.mockImplementation(async () => ok());

      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });

      expect(res.ok).toBe(false);
      const schematicCalls = mockRunAgentLoop.mock.calls.filter(([o]) => o.request.includes('schematic'));
      expect(schematicCalls).toHaveLength(0);
      const out = lines.join('\n');
      expect(out).toContain('BOM part(s) match no installed symbol');
      expect(out).toContain('U1 (XYZQ9999ZZ)');
      expect(out).toContain('To resume from here, run:');
      const reportPath = path.join(repo, '.copperhead', 'runs', 'unresolved-parts.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
        absent: { query: string; refs: string[] }[];
        resume: string;
      };
      expect(report.absent).toHaveLength(1);
      expect(report.absent[0]!.query).toBe('XYZQ9999ZZ');
      expect(report.resume).toContain('create --brief');
    } finally {
      await cleanup();
    }
  });

  it("'stop' + an unreadable library dir proceeds into the stage with a warning", async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedDocStages(repo, 'XYZQ9999ZZ');
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ docs: 'docs/', unresolvableParts: 'stop' }, null, 2),
        'utf8',
      );
      vi.stubEnv('KICAD_SYMBOL_DIR', path.join(libDir, 'nonexistent'));
      mockRunAgentLoop.mockImplementation(async () => ok());

      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });

      // The gate warned and let the stage run; the mocked agent produces no
      // real schematic, so the pipeline still halts there afterwards.
      expect(lines.join('\n')).toContain('could not be verified');
      const schematicCalls = mockRunAgentLoop.mock.calls.filter(([o]) => o.request.includes('schematic'));
      expect(schematicCalls.length).toBeGreaterThan(0);
      expect(res.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('a provided confirm callback reaches the stage agent loop', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# tiny\n', 'utf8');
      mockRunAgentLoop.mockImplementation(async () => ok()); // spec-seed runs and halts (contract unmet)

      const confirm = async (): Promise<boolean> => true;
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', confirm, log: () => {} });

      expect(mockRunAgentLoop.mock.calls.length).toBeGreaterThan(0);
      for (const [callOpts] of mockRunAgentLoop.mock.calls) {
        expect(callOpts.confirm).toBe(confirm);
      }
    } finally {
      await cleanup();
    }
  });
});
