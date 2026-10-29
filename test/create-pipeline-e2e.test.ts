import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import type { Provider, Turn } from '../src/agent/types.js';
import { tempFixtureRepo } from './helpers.js';

const mockRunAgentLoop = vi.hoisted(() => vi.fn<(opts: RunOptions) => Promise<RunResult>>());
const mockMakeProvider = vi.hoisted(() =>
  vi.fn(async () => ({
    name: 'scripted-diagnosis',
    chat: async () => ({ text: null, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } }),
  })),
);
const mockListSymbols = vi.hoisted(() => vi.fn());
const mockRunErc = vi.hoisted(() => vi.fn());
const mockCheckDrift = vi.hoisted(() => vi.fn());
const mockCheckLegibility = vi.hoisted(() => vi.fn());

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
  makeProvider: mockMakeProvider,
}));
vi.mock('../src/agent/recovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  diagnoseStageFailure: vi.fn(async () => ({ verdict: 'abort', reason: 'deterministic test stop' })),
  transcriptExcerpt: vi.fn(async () => ''),
  symbolAvailabilityFacts: vi.fn(async () => ''),
}));
vi.mock('../src/kicad/sexp.js', async (importOriginal) => ({ ...(await importOriginal<object>()), listSymbols: mockListSymbols }));
vi.mock('../src/kicad/cli.js', async (importOriginal) => ({ ...(await importOriginal<object>()), runErc: mockRunErc }));
vi.mock('../src/memory/drift.js', async (importOriginal) => ({ ...(await importOriginal<object>()), checkDrift: mockCheckDrift }));
vi.mock('../src/kicad/legibility.js', async (importOriginal) => ({ ...(await importOriginal<object>()), checkLegibility: mockCheckLegibility }));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit: async () => ({ ok: true, output: '' }) }));
vi.mock('../src/commands/check.js', () => ({ runCheck: async () => ({ ok: true }) }));
vi.mock('../src/commands/export.js', async (importOriginal) => ({ ...(await importOriginal<object>()), emitCreateJlcpcbBom: async () => null }));

import { runCreate } from '../src/commands/create.js';

function ok(): RunResult {
  return { outcome: 'success', exitPath: 'done', summary: 'deterministic replay', transcriptDir: '', filesTouched: [], commit: null,
    stats: { exitPath: 'done', turnsUsed: 1, maxTurns: 40, repairCyclesUsed: 0, maxRepairCycles: 5, tokensIn: 0, tokensOut: 0, perTurn: [], durationMs: 1 }, cacheHits: 1 };
}

async function seedRepo(repo: string): Promise<string> {
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  const briefPath = path.join(repo, 'brief.md');
  await writeFile(briefPath, '# USB-C power breakout\n\nExpose VBUS and GND with a protected 5 V output.\n', 'utf8');
  return briefPath;
}

async function satisfyStage(repo: string, request: string, includeDevplan = true): Promise<void> {
  const docs = path.join(repo, 'docs');
  await mkdir(docs, { recursive: true });
  const stage = request.match(/create pipeline stage:\s*([\w-]+)/)?.[1];

  if (stage === 'spec-seed') {
    await writeFile(path.join(docs, 'SPEC.md'), '# USB-C breakout\n\n## Budgets\n\n- input_voltage: 5 V\n- output_current: 500 mA\n', 'utf8');
  } else if (stage === 'architecture') {
    await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# Subsystems\n\n## Power\n\nUSB-C VBUS feeds a protected 5 V output.\n', 'utf8');
  } else if (stage === 'part-selection') {
    await writeFile(path.join(docs, 'BOM.md'), '# BOM\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 5.1k | R_0603 | RC0603FR-075K1L | CC pull-down |\n', 'utf8');
  } else if (stage === 'schematic') {
    await writeFile(path.join(repo, 'usb-c-power-breakout.kicad_sch'), '(kicad_sch (version 20231120) (generator "test"))\n', 'utf8');
    mockListSymbols.mockResolvedValue([{ ref: 'R1' }]);
  } else if (stage === 'layout-draft') {
    await writeFile(path.join(repo, 'usb-c-power-breakout.kicad_pcb'), '(kicad_pcb (version 20240108) (footprint "Connector_USB:USB_C"))\n', 'utf8');
    await writeFile(path.join(docs, 'LAYOUT.md'), '# Layout\n\n## Draft quality\n\nConnector is edge-aligned; routing is intentionally minimal.\n', 'utf8');
  } else if (stage === 'outputs') {
    await mkdir(path.join(repo, 'outputs'), { recursive: true });
    await writeFile(path.join(repo, 'outputs', 'usb-c-power-breakout-F_Cu.gbr'), 'G04 replay fixture*\n', 'utf8');
  } else if (stage === 'firmware') {
    await mkdir(path.join(repo, 'firmware'), { recursive: true });
    await writeFile(path.join(repo, 'firmware', 'main.c'), 'int main(void) { return 0; }\n', 'utf8');
  } else if (stage === 'devplan' && includeDevplan) {
    await writeFile(path.join(docs, 'DEVPLAN.md'), '# Development plan\n\n## Bring-up\n\n1. Verify 5 V and ground before attaching a load.\n', 'utf8');
  }
}

function scriptedProvider(turns: Partial<Turn>[]): Provider {
  let i = 0;
  return {
    name: 'scripted',
    async chat(): Promise<Turn> {
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      return {
        text: t.text ?? null,
        toolCalls: (t.toolCalls ?? []).map((c, j) => ({ ...c, id: `call-${i}-${j}` })),
        usage: t.usage ?? { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}

beforeEach(() => {
  mockRunAgentLoop.mockReset(); mockMakeProvider.mockClear(); mockListSymbols.mockReset(); mockRunErc.mockReset(); mockCheckDrift.mockReset(); mockCheckLegibility.mockReset();
  mockListSymbols.mockResolvedValue([]);
  mockRunErc.mockResolvedValue({ ok: true, output: '' });
  mockCheckDrift.mockResolvedValue([]);
  mockCheckLegibility.mockResolvedValue({ counts: { error: 0, warning: 0, info: 0 }, findings: [] });
});

describe('create pipeline deterministic end-to-end replay (#66)', () => {
  it('reaches the final 8th stage from a non-trivial brief', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      mockRunAgentLoop.mockImplementation(async (opts) => {
        await satisfyStage(opts.repoRoot, opts.request);
        return ok();
      });
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      expect(res.ok).toBe(true);
      expect(res.completed).toEqual(['spec-seed','architecture','part-selection','schematic','layout-draft','outputs','firmware','devplan']);
      expect(mockRunAgentLoop).toHaveBeenCalledTimes(8);
    } finally { await cleanup(); }
  });

  it('rejects a false-green schematic with no symbols even when ERC reports clean', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.request.includes('create pipeline stage: schematic')) {
          await writeFile(path.join(opts.repoRoot, 'usb-c-power-breakout.kicad_sch'), '(kicad_sch (version 20231120) (generator "test"))\n', 'utf8');
        } else {
          await satisfyStage(opts.repoRoot, opts.request);
        }
        return ok();
      });
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {}, maxStageRetries: 0 });
      expect(res.ok).toBe(false);
      expect(res.completed).toEqual(['spec-seed','architecture','part-selection']);
      expect(mockRunErc).not.toHaveBeenCalled();
      expect(mockMakeProvider).toHaveBeenCalledTimes(0);
    } finally { await cleanup(); }
  });

  it('fails loudly when the final stage is not produced', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = await seedRepo(repo);
      mockRunAgentLoop.mockImplementation(async (opts) => { await satisfyStage(opts.repoRoot, opts.request, false); return ok(); });
      const res = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {}, maxStageRetries: 0 });
      expect(res.ok).toBe(false);
      expect(res.completed).toEqual(['spec-seed','architecture','part-selection','schematic','layout-draft','outputs','firmware']);
      expect(mockMakeProvider).toHaveBeenCalledTimes(0);
    } finally { await cleanup(); }
  });

  it('uses the real agent loop for the production commit path', async () => {
    const { runAgentLoop: realRunAgentLoop } = await vi.importActual<typeof import('../src/agent/loop.js')>('../src/agent/loop.js');
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const { stdout: before } = await execa('git', ['rev-list', '--count', 'HEAD'], { cwd: repo });
      const provider = scriptedProvider([
        { toolCalls: [
          { name: 'propose_change', args: { id: 'e2e-commit-proof', why: 'exercise the real production commit path', what_changes: '- add deterministic proof note', tasks: '- [x] add note' } },
          { name: 'validate_change', args: {} },
        ] },
        { toolCalls: [{ name: 'write_file', args: { path: 'E2E-COMMIT-PROOF.md', content: '# E2E commit proof\n\nProduced through the real agent loop.\n' } }] },
        { toolCalls: [{ name: 'check_drift', args: {} }] },
        { toolCalls: [{ name: 'finish', args: { outcome: 'done', summary: 'production loop commit proof complete' } }] },
      ]);
      const res = await realRunAgentLoop({
        repoRoot: repo,
        request: 'write deterministic E2E commit proof',
        model: 'gpt-5',
        provider,
        maxTurns: 5,
        log: () => {},
      });
      const { stdout: after } = await execa('git', ['rev-list', '--count', 'HEAD'], { cwd: repo });
      expect(res.outcome).toBe('success');
      expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(Number(after) - Number(before)).toBe(1);
    } finally { await cleanup(); }
  });
});