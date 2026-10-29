import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import { runCreate } from '../src/commands/create.js';
import { loadPartVerificationCache, parsePartVerificationRows, isVerifiedPart } from '../src/util/part-cache.js';
import { tempFixtureRepo } from './helpers.js';

const mockAgentRun = vi.hoisted(() => vi.fn());
const mockDiagnosis = vi.hoisted(() => vi.fn());
const mockMakeProvider = vi.hoisted(() => vi.fn());

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockAgentRun,
  makeProvider: mockMakeProvider,
}));
vi.mock('../src/agent/recovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  diagnoseStageFailure: mockDiagnosis,
}));
vi.mock('../src/openspec/cli.js', () => ({
  openspecInit: async () => ({ ok: true, output: 'mocked' }),
}));
vi.mock('../src/commands/check.js', () => ({
  runCheck: async () => ({ ok: true }),
}));
vi.mock('../src/kicad/bootstrap.js', () => ({
  bootstrapKicadProject: async () => null,
  markCreateOrigin: async () => {},
}));

const BOM = `| Refdes | Value | Footprint | MPN | Rationale |
|---|---|---|---|---|
| U1 | ESP32 module | RF_Module:ESP32-S3-WROOM-1 | ESP32-S3-WROOM-1-N8 | Wi-Fi and BLE |`;
const pinResult = 'RF_Module:ESP32-S3-WROOM-1 — 40 pin(s), 1 unit(s):\n  1: GND · power_in';

function result(
  outcome: RunResult['outcome'],
  summary: string,
  turnsUsed: number,
  transcriptDir = '',
): RunResult {
  const exitPath = outcome === 'success' ? 'done' : outcome === 'refused' ? 'refused' : 'provider-error';
  return {
    outcome,
    exitPath,
    summary,
    transcriptDir,
    filesTouched: [],
    commit: null,
    stats: {
      exitPath,
      turnsUsed,
      maxTurns: 40,
      repairCyclesUsed: 0,
      maxRepairCycles: 5,
      tokensIn: 100,
      tokensOut: 20,
      perTurn: [],
      durationMs: 1,
    },
    cacheHits: 0,
  };
}

describe('issue #446 part-selection retry integration', () => {
  it('reuses verified rows on attempt two and spends fewer turns after attempt one refuses', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      await writeFile(path.join(repo, 'brief.md'), '# Wi-Fi controller\n', 'utf8');
      await writeFile(path.join(docs, 'SPEC.md'), '# Spec\n\n## Budgets\n\n- current: 100 mA\n', 'utf8');
      await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# Architecture\n\n## Radio\n\nESP32 module.\n', 'utf8');
      await writeFile(
        path.join(docs, 'BOM.md'),
        BOM.replace('ESP32-S3-WROOM-1-N8', 'UNVERIFIED: choose a module'),
        'utf8',
      );
      await writeFile(
        path.join(repo, '.gitignore'),
        '.env\n.copperhead/runs/\n.copperhead/part-cache.json\n',
        'utf8',
      );
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'integration setup'], { cwd: repo });

      const partSelectionCalls: Array<Pick<RunOptions, 'stagePrompt' | 'maxTurns'> & { turnsUsed: number }> = [];
      mockAgentRun.mockReset();
      mockDiagnosis.mockReset();
      mockMakeProvider.mockReset();
      mockMakeProvider.mockResolvedValue({ name: 'mock-provider', chat: async () => ({}) });
      mockDiagnosis.mockImplementation(async (_provider: unknown, input: { stageName: string }) =>
        input.stageName === 'part-selection'
          ? { verdict: 'retry', reason: 'cache should allow the next attempt to finish', guidance: 'Continue.' }
          : { verdict: 'abort', reason: 'stop after part-selection test' },
      );
      mockAgentRun.mockImplementation(async (opts: RunOptions) => {
        if (opts.request.includes('part-selection')) {
          if (partSelectionCalls.length === 0) {
            partSelectionCalls.push({ stagePrompt: opts.stagePrompt, maxTurns: opts.maxTurns, turnsUsed: 5 });
            const transcriptDir = path.join(repo, '.copperhead', 'runs', 'mock-part-selection');
            await mkdir(transcriptDir, { recursive: true });
            await writeFile(path.join(transcriptDir, 'transcript.jsonl'), '', 'utf8');
            await writeFile(path.join(docs, 'BOM.md'), BOM, 'utf8');
            await opts.onToolResult?.(
              'search_symbols',
              { query: 'ESP32-S3-WROOM-1-N8' },
              'installed symbols matching ESP32-S3-WROOM-1-N8:\n  - RF_Module:ESP32-S3-WROOM-1',
              true,
            );
            await opts.onToolResult?.(
              'symbol_pins',
              { lib_id: 'RF_Module:ESP32-S3-WROOM-1' },
              pinResult,
              true,
            );
            await opts.onToolResult?.(
              'check_footprints',
              { footprints: ['RF_Module:ESP32-S3-WROOM-1'] },
              'OK RF_Module:ESP32-S3-WROOM-1',
              true,
            );
            return result('refused', "can't finish the valid BOM in the turns left", 5, transcriptDir);
          }
          partSelectionCalls.push({ stagePrompt: opts.stagePrompt, maxTurns: opts.maxTurns, turnsUsed: 2 });
          return result('success', 'finished from cached part verification', 2);
        }
        return result('failure', 'stop after part selection', 1);
      });

      await runCreate({
        repoRoot: repo,
        briefPath: path.join(repo, 'brief.md'),
        model: 'gpt-5',
        log: () => {},
      });

      expect(partSelectionCalls).toHaveLength(2);
      expect(partSelectionCalls[0]!.maxTurns).toBe(40);
      expect(partSelectionCalls[1]!.maxTurns).toBe(40);
      expect(partSelectionCalls[1]!.stagePrompt).toContain('fully verified');
      expect(partSelectionCalls[1]!.stagePrompt).toContain(pinResult);
      expect(partSelectionCalls[1]!.turnsUsed).toBeLessThan(partSelectionCalls[0]!.turnsUsed);
      const [row] = parsePartVerificationRows(BOM);
      expect(isVerifiedPart(row!, await loadPartVerificationCache(repo))).toBe(true);
    } finally {
      await cleanup();
    }
  }, 60_000);
});
