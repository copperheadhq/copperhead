import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { commitAll } from '../src/util/git.js';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';
const mocks = vi.hoisted(() => ({ run: vi.fn(), gap: vi.fn(), diagnose: vi.fn() }));
vi.mock('../src/agent/loop.js', async original => ({ ...await original<object>(), runAgentLoop: mocks.run }));
vi.mock('../src/commands/firmware-build.js', async original => ({ ...await original<object>(), firmwareBuildGap: mocks.gap }));
vi.mock('../src/agent/recovery.js', async original => ({ ...await original<object>(), diagnoseStageFailure: mocks.diagnose, transcriptExcerpt: async () => '' }));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit: async () => ({ ok: true, output: '' }) }));
vi.mock('../src/commands/check.js', () => ({ runCheck: async () => ({ ok: true }) }));
import { runCreate, STAGES } from '../src/commands/create.js';

afterEach(() => { vi.restoreAllMocks(); mocks.run.mockReset(); mocks.gap.mockReset(); mocks.diagnose.mockReset(); });
const success: RunResult = { outcome: 'success', exitPath: 'done', summary: 'mock run', transcriptDir: '',
  filesTouched: [], commit: null, stats: { exitPath: 'done', turnsUsed: 1, maxTurns: 16, repairCyclesUsed: 0, maxRepairCycles: 5,
    tokensIn: 1, tokensOut: 1, perTurn: [], durationMs: 1 }, cacheHits: 0 };

describe('create explicit build gate (scripted agent, no real model)', () => {
  it('re-enters firmware with source but no successful build, blocks finish/advance and retains resume flags', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      for (const stage of STAGES.slice(0, 6)) vi.spyOn(stage, 'isComplete').mockResolvedValue(true);
      const firmware = STAGES.find(s => s.name === 'firmware')!;
      vi.spyOn(firmware, 'isComplete').mockResolvedValue(true);
      await mkdir(path.join(repo, 'firmware'), { recursive: true });
      await writeFile(path.join(repo, 'firmware/main.c'), 'void app_main(void) {}\n');
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs/BOM.md'), '# BOM\n');
      await writeFile(path.join(repo, 'brief.md'), '# Reproducible ESP32 firmware\n');
      const toolchain = { idfRoot: '/installed SDK', toolsRoot: '/installed tools', reproducible: true };
      mocks.gap.mockResolvedValue('No current successful ESP-IDF build evidence. Call build_firmware.');
      mocks.diagnose.mockResolvedValue({ action: 'abort', reason: 'stop test', retryable: false });
      mocks.run.mockImplementation(async (opts: RunOptions) => {
        expect(opts.request).toBe('create pipeline stage: firmware');
        expect(opts.firmwareToolchain).toEqual(toolchain);
        expect(opts.stagePrompt).toContain('Two independent builds must produce identical ELF/bin');
        expect(await opts.stageGate!()).toContain('Call build_firmware');
        return success;
      });
      const lines: string[] = [];
      const result = await runCreate({ repoRoot: repo, briefPath: path.join(repo, 'brief.md'), model: 'gpt-5', firmwareToolchain: toolchain, log: line => lines.push(line) });
      expect(result.ok).toBe(false);
      expect(result.completed).not.toContain('firmware');
      expect(mocks.run).toHaveBeenCalledTimes(1);
      expect(lines.join('\n')).toContain("--firmware-idf '/installed SDK'");
      expect(lines.join('\n')).toContain('--firmware-reproducible');
    } finally { await cleanup(); }
  });

  it('keeps existing source-based default resume behavior when no SDK was selected', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      for (const stage of STAGES) vi.spyOn(stage, 'isComplete').mockResolvedValue(true);
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(path.join(repo, 'docs/BOM.md'), '# BOM\n');
      await writeFile(path.join(repo, 'brief.md'), '# Existing project\n');
      await writeFile(path.join(repo, 'docs/DEVPLAN.md'), '# Development plan\nExisting reviewed plan.\n');
      await commitAll(repo, 'copperhead: create pipeline stage: devplan');
      const result = await runCreate({ repoRoot: repo, briefPath: path.join(repo, 'brief.md'), model: 'gpt-5', log: () => {} });
      expect(result.ok).toBe(true);
      expect(result.completed).toHaveLength(8);
      expect(mocks.run).not.toHaveBeenCalled();
      expect(mocks.gap).not.toHaveBeenCalled();
    } finally { await cleanup(); }
  });
});
