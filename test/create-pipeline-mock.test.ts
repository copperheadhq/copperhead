import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';
import { STAGES } from '../src/commands/create.js';

const mockRunAgentLoop = vi.hoisted(() => vi.fn<(opts: RunOptions) => Promise<RunResult>>());
const mockRunErc = vi.hoisted(() => vi.fn(async () => ({ ok: true, violations: [], rules: {} })));
const mockRunDrc = vi.hoisted(() => vi.fn(async () => ({ ok: true, violations: [], rules: {} })));

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit: async () => ({ ok: true, output: '' }) }));
vi.mock('../src/commands/check.js', () => ({ runCheck: async () => ({ ok: true }) }));
vi.mock('../src/agent/recovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  diagnoseStageFailure: async () => ({ verdict: 'abort', reason: 'mocked' }),
  transcriptExcerpt: async () => '',
}));
// Mock KiCad CLI so the schematic stage contract passes
vi.mock('../src/kicad/cli.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runErc: mockRunErc,
  runDrc: mockRunDrc,
  kicadCliVersion: async () => '8.0.0',
  exportSvg: async () => '/tmp/artifacts',
  kicadLoadError: async () => null,
}));

import { runCreate } from '../src/commands/create.js';

function ok(): RunResult {
  return {
    outcome: 'success', exitPath: 'done', summary: 'mock',
    transcriptDir: '', filesTouched: [], commit: null,
    stats: { exitPath: 'done', turnsUsed: 3, maxTurns: 40,
      repairCyclesUsed: 0, maxRepairCycles: 5,
      tokensIn: 1000, tokensOut: 200, perTurn: [], durationMs: 1000 },
    cacheHits: 0,
  };
}

async function writeStageArtifacts(repoRoot: string, request: string): Promise<void> {
  const docs = path.join(repoRoot, 'docs');
  await mkdir(docs, { recursive: true });
  if (request.includes('spec-seed'))
    await writeFile(path.join(docs, 'SPEC.md'), '# Dev\n\n## Budgets and constraints\nPower budget: 500mA\n', 'utf8');
  else if (request.includes('architecture'))
    await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# Arch\n\n## Subsystems\nPower subsystem regulates 3.3V.\n', 'utf8');
  else if (request.includes('part-selection'))
    await writeFile(path.join(docs, 'BOM.md'), '# BOM\n| Refdes | Value | Footprint | MPN | Rationale |\n| --- | --- | --- | --- | --- |\n| R1 | 10k | Resistor_SMD:R_0402 | RC0402JR-0710KL | Pullup |\n', 'utf8');
  else if (request.includes('schematic')) {
    const configPath = path.join(repoRoot, '.copperhead', 'config.json');
    const configContent = await readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    const hw = path.join(repoRoot, 'hardware');
    await mkdir(hw, { recursive: true });
    const MIN_SCH = `(kicad_sch (version 20231120) (generator "eeschema")
  (lib_symbols (symbol "Device:R" (pin_numbers (pin_count 2) (number_size 50))
    (pin_names (offset 0) (hide)) (in_bom yes) (on_board yes)
    (property "Reference" "R" (at 0 0 0)(effects (font (size 50 50))))
    (property "Value" "R" (at 0 0 0)(effects (font (size 50 50))))
    (symbol "R_0_1"
      (pin passive line (at 0 7.62 270)(length 5.08)(name "~"(effects (font (size 50 50))))(number "1"(effects (font (size 50 50)))))
      (pin passive line (at 0 -7.62 90)(length 5.08)(name "~"(effects (font (size 50 50))))(number "2"(effects (font (size 50 50))))))))
  (symbol (lib_id "Device:R") (at 50.8 50.8 0)
    (property "Reference" "R1" (at 50.8 63.5 0)(effects (font (size 50 50))(justify left)))
    (property "Value" "10k" (at 50.8 38.1 0)(effects (font (size 50 50))(justify left)))
    (property "Footprint" "Resistor_SMD:R_0402" (at 50.8 38.1 0)(effects (font (size 50 50))(justify left) hide))
    (pin "1" (uuid "0001")) (pin "2" (uuid "0002"))
    (instances (project "p" (path "/"(page "1")))))
  (sheet_instances (path "/"(page "1"))))`;
    await writeFile(path.join(repoRoot, config.schematic), MIN_SCH, 'utf8');
    await writeFile(path.join(docs, 'PINOUT.md'), '# PINOUT\n| Refdes | Pin | Net |\n| --- | --- | --- |\n| R1 | 1 | NC |\n| R1 | 2 | NC |\n', 'utf8');
  } else if (request.includes('layout-draft')) {
    const configPath = path.join(repoRoot, '.copperhead', 'config.json');
    const configContent = await readFile(configPath, 'utf8');
    const config = JSON.parse(configContent);
    await writeFile(path.join(repoRoot, config.board), '(kicad_pcb (version 20240108) (footprint "Resistor_SMD:R_0402"))', 'utf8');
    await writeFile(path.join(docs, 'LAYOUT.md'), '# Layout\n\n## Draft quality\nsome draft details here\n', 'utf8');
  } else if (request.includes('outputs')) {
    await mkdir(path.join(repoRoot, 'outputs'), { recursive: true });
    await writeFile(path.join(repoRoot, 'outputs', 'board.gbr'), 'G04 Gerber*', 'utf8');
  } else if (request.includes('firmware')) {
    await mkdir(path.join(repoRoot, 'firmware'), { recursive: true });
    await writeFile(path.join(repoRoot, 'firmware', 'main.c'), '// fw', 'utf8');
  } else if (request.includes('devplan'))
    await writeFile(path.join(docs, 'DEVPLAN.md'), '# Dev plan\n\n## Bring-up\n1. Check power rails.\n', 'utf8');
}

let prevKey: string | undefined;
beforeEach(() => {
  mockRunAgentLoop.mockReset();
  mockRunErc.mockReset();
  mockRunErc.mockImplementation(async () => ({ ok: true, violations: [], rules: {} }));
  mockRunDrc.mockReset();
  mockRunDrc.mockImplementation(async () => ({ ok: true, violations: [], rules: {} }));
  prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test';
});
afterEach(() => {
  if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prevKey;
});

describe('create pipeline: runCreate integration (mocked agent + KiCad)', () => {
  it('all 8 stages complete in order via runCreate', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      mockRunAgentLoop.mockImplementation(async (opts) => {
        await writeStageArtifacts(opts.repoRoot, opts.request);
        return ok();
      });
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# USB-C power breakout\n', 'utf8');
      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => { lines.push(s); } });
      expect(res.ok).toBe(true);
      expect(res.completed).toEqual(STAGES.map((s) => s.name));
      const out = lines.join('\n');
      expect(out).toContain('create pipeline complete');
      expect(out).toContain('Per-stage cost summary');
    } finally {
      await cleanup();
    }
  });

  it('runCreate stops at schematic when ERC fails (false-green prevention)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // Override runErc to fail specifically for the schematic stage
      mockRunErc.mockImplementation(async (schPath: string) => {
        if (schPath && (schPath.includes('hardware') || schPath.endsWith('.kicad_sch')))
          return { ok: false, violations: ['ERC: unconnected pin'], rules: {} };
        return { ok: true, violations: [], rules: {} };
      });

      // Agent writes artifacts for all stages, including schematic
      mockRunAgentLoop.mockImplementation(async (opts) => {
        await writeStageArtifacts(opts.repoRoot, opts.request);
        return ok();
      });

      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# Test\n', 'utf8');
      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });
      expect(res.ok).toBe(false);
      expect(res.completed).toEqual(['spec-seed', 'architecture', 'part-selection']);
    } finally {
      await cleanup();
    }
  });

  it('runCreate prints cost table and resume command on partial completion', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      let ran = 0;
      mockRunAgentLoop.mockImplementation(async (opts) => {
        ran++;
        if (ran === 1) await writeStageArtifacts(opts.repoRoot, opts.request);
        return ok();
      });
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# Test\n', 'utf8');
      const lines: string[] = [];
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });
      const out = lines.join('\n');
      expect(out).toContain('stopped at stage 2/8');
      expect(out).toMatch(/copperhead .*create --brief/);
      expect(out).toContain('Per-stage cost summary');
    } finally {
      await cleanup();
    }
  });

  it('resume skips completed stages', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      await writeFile(path.join(docs, 'SPEC.md'), '# Dev\n\n## Budgets\nPower: 500mA\n', 'utf8');
      await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# Arch\n\n## Subsystems\nPower subsystem regulates 3.3V.\n', 'utf8');
      await writeFile(path.join(docs, 'BOM.md'), '# BOM\n| Refdes | Value | Footprint | MPN | Rationale |\n| --- | --- | --- | --- | --- |\n| R1 | 10k | Resistor_SMD:R_0402 | RC0402JR-0710KL | Pullup |\n', 'utf8');
      await writeFile(path.join(repo, '.gitignore'), '.env\n', 'utf8');
      const { execa } = await import('execa');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'pre-seed'], { cwd: repo });

      const requests: string[] = [];
      mockRunAgentLoop.mockImplementation(async (opts) => {
        requests.push(opts.request);
        await writeStageArtifacts(opts.repoRoot, opts.request);
        return ok();
      });
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# Test\n', 'utf8');
      await execa('git', ['add', 'brief.md'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'brief'], { cwd: repo });

      const lines: string[] = [];
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });
      const out = lines.join('\n');
      expect(out).toContain('already complete');
      expect(requests).not.toContain('spec-seed');
      expect(requests).not.toContain('architecture');
      expect(requests).not.toContain('part-selection');
    } finally {
      await cleanup();
    }
  });
});
