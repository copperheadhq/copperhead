import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { tempFixtureRepo } from './helpers.js';

const mockRunAgentLoop = vi.hoisted(() => vi.fn());
vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));

vi.mock('../src/kicad/sexp.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listSymbols: async () => [{ ref: 'R1', id: 'Device:R' }],
}));

vi.mock('../src/kicad/cli.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runErc: async () => ({ ok: true, output: '' }),
  runDrc: async () => ({ ok: true, output: '' }),
  exportSvg: async () => true,
}));

vi.mock('../src/kicad/legibility.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkLegibility: async () => ({ counts: { error: 0, warning: 0 }, findings: [] }),
}));

vi.mock('../src/memory/drift.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkDrift: async () => [],
}));

vi.mock('../src/commands/check.js', () => ({
  runCheck: async () => ({ ok: true })
}));

import { runCreate } from '../src/commands/create.js';

describe('create pipeline e2e', () => {
  it('completes all 8 stages cleanly', async () => {
    const { repo } = await tempFixtureRepo();
    await mkdir(path.join(repo, '.copperhead'), { recursive: true });
    await writeFile(path.join(repo, 'brief.md'), '# brief\n', 'utf8');

    mockRunAgentLoop.mockImplementation(async (opts) => {
      const stageName = opts.meta.stage.name;
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      
      if (stageName === 'spec-seed') {
        await writeFile(path.join(docs, 'SPEC.md'), '## Budgets\n\n- a\n', 'utf8');
      } else if (stageName === 'architecture') {
        await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '## Sub\n\ncontent\n', 'utf8');
      } else if (stageName === 'part-selection') {
        await writeFile(path.join(docs, 'BOM.md'), '| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | RC0603 | |', 'utf8');
      } else if (stageName === 'schematic') {
        const { loadConfig } = await import('../src/config.js');
        const config = await loadConfig(repo);
        if (config.schematic) await writeFile(path.join(repo, config.schematic), 'dummy', 'utf8');
      } else if (stageName === 'layout-draft') {
        const { loadConfig } = await import('../src/config.js');
        const config = await loadConfig(repo);
        if (config.board) await writeFile(path.join(repo, config.board), '(footprint', 'utf8');
        await writeFile(path.join(docs, 'LAYOUT.md'), '## Draft quality\n\ncontent\n', 'utf8');
      } else if (stageName === 'outputs') {
        await mkdir(path.join(repo, 'outputs'), { recursive: true });
        await writeFile(path.join(repo, 'outputs', 'board.gbr'), 'dummy', 'utf8');
      } else if (stageName === 'firmware') {
        await mkdir(path.join(repo, 'firmware'), { recursive: true });
        await writeFile(path.join(repo, 'firmware', 'main.c'), 'dummy', 'utf8');
      } else if (stageName === 'devplan') {
        await writeFile(path.join(docs, 'DEVPLAN.md'), '## Plan\n\ncontent\n', 'utf8');
      }

      return {
        outcome: 'success',
        exitPath: 'done',
        summary: 'mock',
        transcriptDir: '',
        filesTouched: [],
        commit: '1234567',
        stats: { turnsUsed: 1 },
        cacheHits: 0,
      };
    });

    const res = await runCreate({
      repoRoot: repo,
      briefPath: path.join(repo, 'brief.md'),
      model: 'mock',
      interactive: false,
      log: () => {},
      meta: { command: 'create', modelSource: 'mock', version: '1', kicadCliVersion: '1' }
    });

    console.log("COMPLETED STAGES: ", res.completed);
    expect(res.ok).toBe(true);
    expect(res.completed).toEqual([
      'spec-seed', 'architecture', 'part-selection', 'schematic',
      'layout-draft', 'outputs', 'firmware', 'devplan'
    ]);
  });
});
