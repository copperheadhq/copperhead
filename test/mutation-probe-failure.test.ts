import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { dispatchTool, dispatchToolResult, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import { kicadLoadError } from '../src/kicad/cli.js';
import { loadConfig } from '../src/config.js';
import { tempFixtureRepo } from './helpers.js';

// Inject failures at the probe and restoration boundaries, while using the
// actual anchored editor, footprint mover, dispatcher and completion gate.
vi.mock('../src/kicad/cli.js', async (original) => ({
  ...await original<typeof import('../src/kicad/cli.js')>(),
  kicadLoadError: vi.fn(),
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, writeFile: vi.fn(fs.writeFile) };
});

const SCH = 'hardware/open-key.kicad_sch';
const PCB = 'hardware/open-key.kicad_pcb';
const cleanErc = { ok: true, source: 'erc' as const, violations: [] };
const cleanDrc = { ok: true, source: 'drc' as const, violations: [] };
const priorObligation = { kind: 'decision-log' as const, detail: 'prior decision', openedBy: 'decision' };
const cases = [
  { name: 'schematic edit_file', file: SCH, tool: 'edit_file', args: { path: SCH, old_string: '(kicad_sch', new_string: '(kicad_sch (broken' } },
  { name: 'board edit_file', file: PCB, tool: 'edit_file', args: { path: PCB, old_string: '(at 10 20)', new_string: '(at 30 40)' } },
  { name: 'move_footprint', file: PCB, tool: 'move_footprint', args: { ref: 'R1', x: 30, y: 40 } },
];

let ctx: RunContext;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  vi.mocked(kicadLoadError).mockReset().mockResolvedValue(null);
  vi.mocked(writeFile).mockClear();
  const fixture = await tempFixtureRepo();
  cleanup = fixture.cleanup;
  const boardPath = path.join(fixture.repo, PCB);
  const board = await readFile(boardPath, 'utf8');
  await writeFile(boardPath, board.replace(/\)\s*$/, '  (footprint "Test:R" (layer "F.Cu") (at 10 20) (property "Reference" "R1"))\n)\n'), 'utf8');
  const transcript = new Transcript(fixture.repo);
  await transcript.init();
  const ledger = new ObligationsLedger();
  ledger.add(priorObligation.kind, priorObligation.detail, priorObligation.openedBy);
  ctx = {
    repoRoot: fixture.repo, config: { ...await loadConfig(fixture.repo), board: PCB }, transcript, ledger,
    runId: 'probe-failure', interactive: false, confirm: async () => true,
    editsUnlocked: true, changeId: null, proposalValidated: false,
    filesTouched: new Set(['docs/DECISIONS.md']), decisions: [],
    lastErc: cleanErc, lastDrc: cleanDrc, lastLegibility: null, lastScore: null,
    repairCycles: 0, finishRequest: null,
  };
});

afterEach(async () => {
  // A restoration failure must not interfere with fixture cleanup or the next test.
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(writeFile).mockImplementation(fs.writeFile);
  await cleanup?.();
});

function expectTracked(file: string): void {
  expect([...ctx.filesTouched]).toEqual(['docs/DECISIONS.md', file]);
  expect(ctx.ledger.openObligations).toContainEqual(priorObligation);
  expect(ctx.ledger.openOfKind('erc')).toHaveLength(1);
  expect(ctx.ledger.openOfKind('drift')).toHaveLength(1);
  expect(ctx.ledger.openOfKind('changelog')).toHaveLength(1);
  if (file === SCH) {
    expect(ctx.lastErc).toBeNull();
    expect(ctx.lastDrc).toBe(cleanDrc);
    expect(ctx.ledger.openOfKind('legibility')).toHaveLength(1);
  } else {
    expect(ctx.lastErc).toBe(cleanErc);
    expect(ctx.lastDrc).toBeNull();
    expect(ctx.ledger.openOfKind('drc')).toHaveLength(1);
  }
}

describe.each(cases)('$name post-write loadability checks', ({ file, tool, args }) => {
  it('restores the original bytes and blocks completion when the probe throws', async () => {
    const abs = path.join(ctx.repoRoot, file);
    const before = await readFile(abs);
    vi.mocked(kicadLoadError).mockRejectedValueOnce(new Error('probe tempdir failed'));
    const result = await dispatchToolResult(ctx, tool, args);
    expect(result.ok).toBe(false);
    expect(await readFile(abs)).toEqual(before);
    expect(result.error?.kind).toBe('exception');
    expect(result.error?.message).toContain('probe tempdir failed');
    expect(result.error?.message).toContain('REVERTED');
    expectTracked(file);
    // Even with unrelated obligations cleared, the stale verification cannot finish.
    for (const obligation of [...ctx.ledger.openObligations]) ctx.ledger.clear(obligation.kind);
    expect(await dispatchTool(ctx, 'finish', { outcome: 'done', summary: 'done' })).toContain('cannot finish yet');
    expect(ctx.finishRequest).toBeNull();
  });

  it('tracks retained bytes and reports both errors when restoration fails', async () => {
    const abs = path.join(ctx.repoRoot, file);
    const before = await readFile(abs, 'utf8');
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(writeFile).mockImplementation(async (...writeArgs) => {
      if (writeArgs[0] === abs && writeArgs[1] === before) throw new Error('restore denied');
      return fs.writeFile(...writeArgs);
    });
    vi.mocked(kicadLoadError).mockRejectedValueOnce(new Error('probe cleanup failed'));
    const result = await dispatchToolResult(ctx, tool, args);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('probe cleanup failed');
    expect(result.error?.message).toContain('restore denied');
    expect(result.error?.message).not.toContain('REVERTED');
    expect(await readFile(abs, 'utf8')).not.toBe(before);
    expectTracked(file);
  });

  it('normally reverts an unloadable change without disturbing earlier state', async () => {
    const abs = path.join(ctx.repoRoot, file);
    const before = await readFile(abs);
    const obligations = [...ctx.ledger.openObligations];
    vi.mocked(kicadLoadError).mockResolvedValueOnce('invalid edited syntax');
    expect(await dispatchTool(ctx, tool, args)).toContain('REVERTED');
    expect(await readFile(abs)).toEqual(before);
    expect([...ctx.filesTouched]).toEqual(['docs/DECISIONS.md']);
    expect(ctx.ledger.openObligations).toEqual(obligations);
    expect(ctx.lastErc).toBe(cleanErc);
    expect(ctx.lastDrc).toBe(cleanDrc);
  });

  it('preserves a prior edit and its obligations during normal rollback', async () => {
    const abs = path.join(ctx.repoRoot, file);
    const before = await readFile(abs);
    ctx.filesTouched.add(file);
    ctx.ledger.onKicadEdit(file);
    const obligations = [...ctx.ledger.openObligations];
    vi.mocked(kicadLoadError).mockResolvedValueOnce('invalid edited syntax');
    expect(await dispatchTool(ctx, tool, args)).toContain('REVERTED');
    expect(await readFile(abs)).toEqual(before);
    expect([...ctx.filesTouched]).toEqual(['docs/DECISIONS.md', file]);
    expect(ctx.ledger.openObligations).toEqual(obligations);
    expect(ctx.lastErc).toBe(cleanErc);
    expect(ctx.lastDrc).toBe(cleanDrc);
  });

  it('tracks the mutation when a normal rejection cannot restore it', async () => {
    const abs = path.join(ctx.repoRoot, file);
    const before = await readFile(abs, 'utf8');
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(writeFile).mockImplementation(async (...writeArgs) => {
      if (writeArgs[0] === abs && writeArgs[1] === before) throw new Error('restore denied');
      return fs.writeFile(...writeArgs);
    });
    vi.mocked(kicadLoadError).mockResolvedValueOnce('invalid edited syntax');
    const result = await dispatchToolResult(ctx, tool, args);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('rollback failed: restore denied');
    expect(result.error?.message).not.toContain('REVERTED');
    expect(await readFile(abs, 'utf8')).not.toBe(before);
    expectTracked(file);
  });

  it('registers a successful mutation and invalidates its old check', async () => {
    const abs = path.join(ctx.repoRoot, file);
    const before = await readFile(abs);
    const result = await dispatchToolResult(ctx, tool, args);
    expect(result.ok).toBe(true);
    expect(await readFile(abs)).not.toEqual(before);
    expectTracked(file);
  });
});

describe('edit_file incremental repair', () => {
  const args = { path: SCH, old_string: '(kicad_sch', new_string: '(kicad_sch (partial-repair' };

  it('keeps a partial repair when the original file is also unloadable', async () => {
    vi.mocked(kicadLoadError).mockResolvedValueOnce('edited file still broken').mockResolvedValueOnce('original file broken');
    expect(await dispatchTool(ctx, 'edit_file', args)).toContain('already unloadable');
    expect(await readFile(path.join(ctx.repoRoot, SCH), 'utf8')).toContain('(partial-repair');
    expectTracked(SCH);
  });

  it('does not infer that the original was unloadable when its probe throws', async () => {
    const before = await readFile(path.join(ctx.repoRoot, SCH));
    vi.mocked(kicadLoadError).mockResolvedValueOnce('edited file broken').mockRejectedValueOnce(new Error('baseline probe failed'));
    const result = await dispatchToolResult(ctx, 'edit_file', args);
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('baseline probe failed');
    expect(result.error?.message).not.toContain('already unloadable');
    expect(await readFile(path.join(ctx.repoRoot, SCH))).toEqual(before);
    expectTracked(SCH);
  });
});
