/**
 * End-to-end test coverage for the copperhead create pipeline (#66 bounty).
 *
 * Tests:
 *  1. All 8 stages complete in order with mocked agents
 *  2. Wedged stage detection (false-green ERC, finish-gate wedge)
 *  3. Final stage not reached → process returns ok=false
 *  4. Resume past already-complete stages
 *  5. Stage contract failures are detected (empty schematic passing ERC)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';

// ── Hoisted mocks ──────────────────────────────────────────────
const mockRunAgentLoop = vi.hoisted(() =>
  vi.fn<(opts: RunOptions) => Promise<RunResult>>(),
);
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
vi.mock('../src/openspec/cli.js', () => ({
  openspecInit: async () => ({ ok: true, output: '' }),
}));
vi.mock('../src/commands/check.js', () => ({
  runCheck: async () => ({ ok: true }),
}));

import { runCreate, STAGES } from '../src/commands/create.js';

// ── Helpers ─────────────────────────────────────────────────────

/** A successful mocked run result. */
function okResult(): RunResult {
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

/** Write the doc artifact that satisfies a given stage's completion contract. */
async function writeStageArtifact(
  repoRoot: string,
  stageName: string,
): Promise<void> {
  const docs = path.join(repoRoot, 'docs');
  await mkdir(docs, { recursive: true });
  await mkdir(path.join(repoRoot, '.copperhead'), { recursive: true });

  switch (stageName) {
    case 'spec-seed':
      await writeFile(
        path.join(docs, 'SPEC.md'),
        '# Spec\n\n## Budgets\n\nPower budget: 500mW\n',
        'utf8',
      );
      break;
    case 'architecture':
      await writeFile(
        path.join(docs, 'SUBSYSTEMS.md'),
        '# Subsystems\n\n## Power\n\n## MCU\n',
        'utf8',
      );
      break;
    case 'part-selection':
      await writeFile(
        path.join(docs, 'BOM.md'),
        '# BOM\n\n| Refdes | Value | Footprint | MPN | Rationale |\n| --- | --- | --- | --- | --- |\n',
        'utf8',
      );
      break;
    case 'schematic':
      await writeFile(
        path.join(repoRoot, '.copperhead', 'config.json'),
        JSON.stringify({
          docs: 'docs/',
          schematic: 'hardware/project.kicad_sch',
          board: 'hardware/project.kicad_pcb',
        }),
        'utf8',
      );
      await mkdir(path.join(repoRoot, 'hardware'), { recursive: true });
      await writeFile(
        path.join(repoRoot, 'hardware', 'project.kicad_sch'),
        '(kicad_sch\n  (version 20231120)\n  (generator "eeschema")\n' +
          '  (lib_symbols\n    (symbol "Device:R" (pin_numbers hide) (pin_names (offset 1.016))' +
          ' (in_bom yes) (on_board yes) (property "Reference" "R1" (at 0 0 0))' +
          ' (property "Value" "10k" (at 0 0 0)) (property "Footprint" "" (at 0 0 0))' +
          ' (symbol "R_0_1" (rectangle (start -2.54 1.27) (end 2.54 -1.27))' +
          ' (pin "1" (uuid ...)) (pin "2" (uuid ...)))))\n' +
          '  (symbol (lib_id "Device:R") (at 10 10 0) (unit 1) (in_bom yes) (on_board yes)' +
          ' (uuid "00000000-0000-0000-0000-000000000001")' +
          ' (property "Reference" "R1" (at 10 10 0))' +
          ' (property "Value" "10k" (at 10 10 0)))\n' +
          ')\n',
        'utf8',
      );
      await writeFile(
        path.join(repoRoot, 'hardware', 'project.kicad_pcb'),
        '(kicad_pcb (version 20240108) (generator "pcbnew"))\n',
        'utf8',
      );
      break;
    case 'layout-draft':
      await writeFile(
        path.join(repoRoot, '.copperhead', 'config.json'),
        JSON.stringify({
          docs: 'docs/',
          schematic: 'hardware/project.kicad_sch',
          board: 'hardware/project.kicad_pcb',
        }),
        'utf8',
      );
      await mkdir(path.join(repoRoot, 'hardware'), { recursive: true });
      await writeFile(
        path.join(repoRoot, 'hardware', 'project.kicad_pcb'),
        '(kicad_pcb (version 20240108) (generator "pcbnew") (footprint "Resistor_SMD:R_0402" ...))\n',
        'utf8',
      );
      await writeFile(
        path.join(docs, 'LAYOUT.md'),
        '# Layout\n\n## Draft quality\n\nGood enough.\n',
        'utf8',
      );
      break;
    case 'outputs':
      await mkdir(path.join(repoRoot, 'outputs'), { recursive: true });
      break;
    case 'firmware':
      await mkdir(path.join(repoRoot, 'firmware'), { recursive: true });
      break;
    case 'devplan':
      await writeFile(
        path.join(docs, 'DEVPLAN.md'),
        '# Dev Plan\n\nBring-up steps.\n',
        'utf8',
      );
      break;
  }
}

/** Seed a repo with the minimal scaffolding that runCreate needs. */
async function seedRepo(repo: string): Promise<string> {
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  const briefPath = path.join(repo, 'brief.md');
  await writeFile(
    briefPath,
    '# USB-C Power Breakout\n\nA simple USB-C PD power breakout board.\n',
    'utf8',
  );
  return briefPath;
}

let prevKey: string | undefined;
beforeEach(() => {
  mockRunAgentLoop.mockReset();
  mockDiagnose.mockReset();
  mockDiagnose.mockResolvedValue({
    verdict: 'abort',
    reason: 'default: stop',
  });
  prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-dummy';
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevKey;
});

// ── Tests ───────────────────────────────────────────────────────

describe('create pipeline e2e coverage (#66)', () => {
  it('all 8 stages complete in order via runCreate (mocked agent + KiCad)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);

      mockRunAgentLoop.mockImplementation(async (opts) => {
        const stage = STAGES.find((s) => opts.stagePrompt?.includes(s.name));
        if (stage) await writeStageArtifact(opts.repoRoot, stage.name);
        return okResult();
      });

      const lines: string[] = [];
      const res = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: (s) => lines.push(s),
      });

      expect(res.completed).toEqual(STAGES.map((s) => s.name));
      expect(res.ok).toBe(true);
      expect(mockRunAgentLoop).toHaveBeenCalledTimes(STAGES.length);

      const callRequests = mockRunAgentLoop.mock.calls.map(([o]) => o.request);
      for (const stage of STAGES) {
        expect(callRequests).toContain(`create pipeline stage: ${stage.name}`);
      }

      const out = lines.join('\n');
      expect(out).toContain('Per-stage cost summary');
      expect(out).toContain('create pipeline complete; all checks green');
    } finally {
      await cleanup();
    }
  });

  it('resume skips already-complete stages and continues from first incomplete', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);

      await writeStageArtifact(repo, 'spec-seed');
      await writeStageArtifact(repo, 'architecture');
      await writeStageArtifact(repo, 'part-selection');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'pre-seeded stages 1-3'], {
        cwd: repo,
      });

      mockRunAgentLoop.mockImplementation(async (opts) => {
        const stage = STAGES.find((s) => opts.stagePrompt?.includes(s.name));
        if (stage) await writeStageArtifact(opts.repoRoot, stage.name);
        return okResult();
      });

      const lines: string[] = [];
      const res = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: (s) => lines.push(s),
      });

      const out = lines.join('\n');
      expect(out).toContain('stage spec-seed: already complete');
      expect(out).toContain('stage architecture: already complete');
      expect(out).toContain('stage part-selection: already complete');
      expect(mockRunAgentLoop).toHaveBeenCalledTimes(5);
      expect(res.completed.length).toBe(STAGES.length);
    } finally {
      await cleanup();
    }
  });

  it('returns ok=false when pipeline stops before devplan stage', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);

      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.stagePrompt?.includes('schematic')) {
          return { ...okResult(), outcome: 'error' as const, exitPath: 'turn-limit' };
        }
        const stage = STAGES.find((s) => opts.stagePrompt?.includes(s.name));
        if (stage) await writeStageArtifact(opts.repoRoot, stage.name);
        return okResult();
      });

      const lines: string[] = [];
      const res = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: (s) => lines.push(s),
      });

      expect(res.completed).toEqual(['spec-seed', 'architecture', 'part-selection']);
      expect(res.ok).toBe(false);

      const out = lines.join('\n');
      expect(out).toContain('stopped at stage 4/8');
      expect(out).toContain('To resume from here');
    } finally {
      await cleanup();
    }
  });

  it('rejects a stage that finishes but has no usable artifact (false-green gate)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);

      let schematicAttempts = 0;
      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.stagePrompt?.includes('schematic')) {
          schematicAttempts++;
          if (schematicAttempts === 1) {
            await mkdir(path.join(opts.repoRoot, 'hardware'), { recursive: true });
            await writeFile(
              path.join(opts.repoRoot, '.copperhead', 'config.json'),
              JSON.stringify({
                docs: 'docs/',
                schematic: 'hardware/project.kicad_sch',
                board: 'hardware/project.kicad_pcb',
              }),
              'utf8',
            );
            await writeFile(
              path.join(opts.repoRoot, 'hardware', 'project.kicad_sch'),
              '(kicad_sch\n  (version 20231120)\n  (generator "eeschema")\n)\n',
              'utf8',
            );
            return okResult();
          }
          return { ...okResult(), outcome: 'error' as const, exitPath: 'turn-limit' };
        }
        const stage = STAGES.find((s) => opts.stagePrompt?.includes(s.name));
        if (stage) await writeStageArtifact(opts.repoRoot, stage.name);
        return okResult();
      });

      mockDiagnose.mockResolvedValueOnce({ verdict: 'abort', reason: 'no symbols on schematic after success' });

      const lines: string[] = [];
      const res = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: (s) => lines.push(s),
      });

      const out = lines.join('\n');
      expect(out).toContain('completion contract is not met');
      expect(res.completed).toEqual(['spec-seed', 'architecture', 'part-selection']);
      expect(res.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('detects a wedged finish gate and does not advance past it', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);

      let schematicCalls = 0;
      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.stagePrompt?.includes('schematic')) {
          schematicCalls++;
          if (schematicCalls <= 3) {
            await mkdir(path.join(opts.repoRoot, 'hardware'), { recursive: true });
            await writeFile(
              path.join(opts.repoRoot, '.copperhead', 'config.json'),
              JSON.stringify({
                docs: 'docs/',
                schematic: 'hardware/project.kicad_sch',
                board: 'hardware/project.kicad_pcb',
              }),
              'utf8',
            );
            await writeFile(
              path.join(opts.repoRoot, 'hardware', 'project.kicad_sch'),
              '(kicad_sch\n  (version 20231120)\n  (generator "eeschema")\n)\n',
              'utf8',
            );
            return okResult();
          }
          return { ...okResult(), outcome: 'error' as const, exitPath: 'turn-limit' };
        }
        const stage = STAGES.find((s) => opts.stagePrompt?.includes(s.name));
        if (stage) await writeStageArtifact(opts.repoRoot, stage.name);
        return okResult();
      });

      mockDiagnose
        .mockResolvedValueOnce({ verdict: 'retry', reason: 'transient' })
        .mockResolvedValueOnce({ verdict: 'retry', reason: 'try again' })
        .mockResolvedValueOnce({ verdict: 'abort', reason: 'wedged at finish gate' });

      const lines: string[] = [];
      const res = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: (s) => lines.push(s),
      });

      const out = lines.join('\n');
      expect(schematicCalls).toBeGreaterThanOrEqual(3);
      expect(out).toContain('exhausted');
      expect(res.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('all stage completion contracts are independently verifiable', () => {
    expect(STAGES).toHaveLength(8);
    expect(STAGES.map((s) => s.name)).toEqual([
      'spec-seed',
      'architecture',
      'part-selection',
      'schematic',
      'layout-draft',
      'outputs',
      'firmware',
      'devplan',
    ]);

    for (const stage of STAGES) {
      expect(stage.name).toBeTruthy();
      expect(typeof stage.isComplete).toBe('function');
      expect(typeof stage.prompt).toBe('function');
    }
  });

  it('writes a cost table and run report on completion', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);

      mockRunAgentLoop.mockImplementation(async (opts) => {
        const stage = STAGES.find((s) => opts.stagePrompt?.includes(s.name));
        if (stage) await writeStageArtifact(opts.repoRoot, stage.name);
        return okResult();
      });

      const lines: string[] = [];
      await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: (s) => lines.push(s),
      });

      const out = lines.join('\n');
      expect(out).toContain('Per-stage cost summary');
      for (const stage of STAGES) {
        expect(out).toContain(stage.name);
      }
      expect(out).toContain('TOTAL');
      expect(out).toContain('pipeline so far');
      expect(out).toContain('create pipeline complete; all checks green');
    } finally {
      await cleanup();
    }
  });

  it('each stage prompt contains stage-specific content', () => {
    const brief = '# Test brief\nA test board.\n';
    for (const stage of STAGES) {
      const prompt = stage.prompt(brief);
      expect(prompt.length).toBeGreaterThan(50);
      expect(
        prompt.includes(stage.name) ||
          prompt.includes(`Stage ${STAGES.findIndex((s) => s.name === stage.name) + 1}`),
      ).toBe(true);
    }
  });
});
