import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import type { RunOptions } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';
import { headCommit } from '../src/util/git.js';

const { mockRunErc, mockRunCheck } = vi.hoisted(() => ({
  mockRunErc: vi.fn(async () => ({ ok: true, report: '' })),
  mockRunCheck: vi.fn(async () => ({ ok: true }))
}));

const mockRunAgentLoop = vi.hoisted(() =>
  vi.fn(async (opts: RunOptions) => {
    const { mkdir: mkdirFs, writeFile: writeFileFs, readFile: readFileFs } = await import('node:fs/promises');
    const { default: pathMod } = await import('node:path');
    const docs = pathMod.join(opts.repoRoot, 'docs');
    await mkdirFs(docs, { recursive: true });
    
    let boardFile = 'board.kicad_pcb';
    try {
      const config = JSON.parse(await readFileFs(pathMod.join(opts.repoRoot, '.copperhead', 'config.json'), 'utf8'));
      if (config.board) boardFile = config.board;
    } catch {}
    
    if (opts.request.includes('spec-seed')) {
      await writeFileFs(pathMod.join(docs, 'SPEC.md'), '# spec\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
    }
    if (opts.request.includes('architecture')) {
      await writeFileFs(pathMod.join(docs, 'SUBSYSTEMS.md'), '# subsystems\n\n## Power\n\nLDO regulator 3.3 V, 300 mA.\n', 'utf8');
    }
    if (opts.request.includes('part-selection')) {
      await writeFileFs(pathMod.join(docs, 'BOM.md'), '# bom\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | RC0603FR-0710KL | bias resistor |\n', 'utf8');
    }
    if (opts.request.includes('schematic')) {
      // isComplete checked via mocks
    }
    if (opts.request.includes('layout-draft')) {
      await writeFileFs(pathMod.join(opts.repoRoot, boardFile), '(footprint "R1")', 'utf8');
      await writeFileFs(pathMod.join(docs, 'LAYOUT.md'), '## Draft quality\nGood enough.\n', 'utf8');
    }
    if (opts.request.includes('outputs')) {
      const outDir = pathMod.join(opts.repoRoot, 'outputs');
      await mkdirFs(outDir, { recursive: true });
      await writeFileFs(pathMod.join(outDir, 'board.gbr'), 'G04 Gerber*', 'utf8');
    }
    if (opts.request.includes('firmware')) {
      const fwDir = pathMod.join(opts.repoRoot, 'firmware');
      await mkdirFs(fwDir, { recursive: true });
      await writeFileFs(pathMod.join(fwDir, 'main.c'), 'int main() { return 0; }', 'utf8');
    }
    if (opts.request.includes('devplan')) {
      await writeFileFs(pathMod.join(docs, 'DEVPLAN.md'), '# Plan\n\n## Bring-up\n\n1. Check power.\n', 'utf8');
    }

    const { commitAll } = await import('../src/util/git.js');
    const commitSha = await commitAll(opts.repoRoot, `mock commit for ${opts.request}`);

    return {
      outcome: 'success' as const,
      exitPath: 'done' as const,
      summary: 'mocked',
      transcriptDir: '',
      filesTouched: [],
      commit: commitSha,
      stats: {
        exitPath: 'done' as const,
        turnsUsed: 3,
        maxTurns: 40,
        repairCyclesUsed: 0,
        maxRepairCycles: 5,
        tokensIn: 1000,
        tokensOut: 200,
        perTurn: [],
        durationMs: 1234,
      },
      cacheHits: 1,
    };
  }),
);

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));
vi.mock('../src/openspec/cli.js', () => ({
  openspecInit: async () => ({ ok: true, output: 'mocked' }),
}));
vi.mock('../src/commands/check.js', () => ({
  runCheck: mockRunCheck,
}));

vi.mock('../src/kicad/sexp.js', () => ({
  listSymbols: async () => [{ ref: 'R1', val: '10k', fp: 'R_0603', lib: 'Device:R' }],
}));
vi.mock('../src/memory/drift.js', () => ({
  checkDrift: async () => [],
}));
vi.mock('../src/kicad/cli.js', () => ({
  runErc: mockRunErc,
  exportSvg: async () => {},
}));
vi.mock('../src/commands/export.js', () => ({
  emitCreateJlcpcbBom: async () => 'board-bom.csv',
}));

import { runCreate } from '../src/commands/create.js';

describe('end-to-end create pipeline', () => {
  beforeEach(() => {
    mockRunErc.mockReset();
    mockRunErc.mockResolvedValue({ ok: true, report: '' });
    mockRunCheck.mockReset();
    mockRunCheck.mockResolvedValue({ ok: true });
  });

  it('successfully completes all 8 stages when contracts are met and commits each stage', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ schematic: 'board.kicad_sch', board: 'board.kicad_pcb' }),
        'utf8',
      );
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A tiny device\n', 'utf8');

      const startHead = await headCommit(repo);

      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });
      const out = lines.join('\n');
      if (!res.ok) console.log(out, res.completed);
      expect(res.ok).toBe(true);
      expect(res.completed).toEqual([
        'spec-seed',
        'architecture',
        'part-selection',
        'schematic',
        'layout-draft',
        'outputs',
        'firmware',
        'devplan'
      ]);

      const { stdout: logOut } = await execa('git', ['log', '--oneline', `${startHead}..HEAD`], { cwd: repo });
      const commits = logOut.split('\n').filter(Boolean);
      expect(commits.length).toBe(res.completed.length);

      expect(out).not.toMatch(/wedged/i);
      expect(out).not.toMatch(/false-green/i);
    } finally {
      await cleanup();
    }
  });

  it('halts when a structural gate (ERC) fails without retries', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      mockRunErc.mockResolvedValue({ ok: false, report: 'ERC violations found' });
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ schematic: 'board.kicad_sch', board: 'board.kicad_pcb', maxStageRetries: 0 }),
        'utf8',
      );
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# A tiny device\n', 'utf8');

      const lines: string[] = [];
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (s) => lines.push(s) });
      
      expect(res.ok).toBe(false);
      expect(res.completed).toEqual([
        'spec-seed',
        'architecture',
        'part-selection'
      ]);
      const out = lines.join('\n');
      expect(out).toContain('the run finished but the stage completion contract is not met');
      expect(res.completed).not.toContain('schematic');
    } finally {
      await cleanup();
    }
  });
});
