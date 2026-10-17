import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { RunContext } from '../src/agent/context.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { HANDLERS } from '../src/capabilities/handlers.js';
import type { CopperheadConfig } from '../src/config.js';
import type { CheckReport } from '../src/kicad/report.js';

const mocks = vi.hoisted(() => ({
  runDrc: vi.fn(),
  kicadLoadError: vi.fn(),
}));

vi.mock('../src/kicad/cli.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/kicad/cli.js')>(),
  runDrc: mocks.runDrc,
  kicadLoadError: mocks.kicadLoadError,
}));

const cleanDrc = (unrouted = 2): CheckReport => ({
  ok: true,
  source: 'drc',
  violations: [],
  unrouted,
  unconnected: [],
  intrinsic: [],
});

const failedDrc = (): CheckReport => ({
  ok: false,
  source: 'drc',
  violations: [{ severity: 'error', type: 'clearance', description: 'candidate clearance failure', items: [] }],
  unrouted: 2,
  unconnected: [],
  intrinsic: [],
});

const silkDrc = (ref: string): CheckReport => ({
  ok: false,
  source: 'drc',
  violations: [{
    severity: 'warning',
    type: 'silk_overlap',
    description: 'Silkscreen overlap',
    items: [{ description: `Reference field of ${ref}` }],
  }],
  unrouted: 2,
  unconnected: [],
  intrinsic: [],
});

function footprint(ref: string, x: number, net1: string, net2: string): string {
  return `(footprint "Resistor_SMD:R_0402_1005Metric"
    (layer "F.Cu")
    (at ${x} 10)
    (property "Reference" "${ref}" (at 0 -1 0) (layer "F.SilkS"))
    (property "Value" "1k" (at 0 1 0) (layer "F.Fab"))
    (fp_rect (start -0.8 -0.6) (end 0.8 0.6) (stroke (width 0.05) (type solid)) (fill none) (layer "F.CrtYd"))
    (pad "1" smd rect (at -0.5 0) (size 0.4 0.5) (layers "F.Cu" "F.Mask") (net 1 "${net1}"))
    (pad "2" smd rect (at 0.5 0) (size 0.4 0.5) (layers "F.Cu" "F.Mask") (net 2 "${net2}"))
  )`;
}

function board(routed = false): string {
  return `(kicad_pcb
  (version 20241229)
  (generator "pcbnew")
  (gr_rect (start 0 0) (end 50 30) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
  ${footprint('R1', 8, 'A', 'N1')}
  ${footprint('R2', 28, 'N1', 'N2')}
  ${footprint('R3', 40, 'N2', 'B')}
  ${routed ? '(segment (start 8.5 10) (end 27.5 10) (width 0.2) (layer "F.Cu") (net 2))' : ''}
)
`;
}

function context(repoRoot: string): RunContext {
  const config: CopperheadConfig = {
    schematic: null,
    board: 'board.kicad_pcb',
    docs: 'docs/',
    model: null,
    maxTurns: 40,
    maxRepairCycles: 5,
    budgets: {},
    turnTimeoutMs: 1,
    turnMaxMs: 1,
    heartbeatMs: 1,
    maxStageRetries: 2,
    llmCache: true,
  };
  return {
    repoRoot,
    config,
    filesTouched: new Set<string>(),
    ledger: new ObligationsLedger(),
    lastErc: null,
    lastDrc: cleanDrc(),
  } as unknown as RunContext;
}

const optimize = HANDLERS.find((handler) => handler.schema.name === 'optimize_placement')!;

describe('safe optimize_placement handler', () => {
  it('is spec-gated like every KiCad mutation tool', () => {
    expect(optimize.requiresUnlock).toBe(true);
  });

  it('refuses a failing baseline DRC without changing the board', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-placement-handler-'));
    try {
      const input = board();
      await writeFile(path.join(repo, 'board.kicad_pcb'), input);
      mocks.runDrc.mockReset().mockResolvedValueOnce(failedDrc());
      mocks.kicadLoadError.mockReset().mockResolvedValue(null);

      const result = await optimize.handler(context(repo), {});

      expect(result).toMatchObject({ ok: false });
      expect(typeof result === 'string' ? result : result.text).toContain('input board must be DRC-clean');
      expect(await readFile(path.join(repo, 'board.kicad_pcb'), 'utf8')).toBe(input);
      expect(mocks.runDrc).toHaveBeenCalledTimes(1);
      expect(mocks.kicadLoadError).not.toHaveBeenCalled();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('writes a measured improvement only after clean baseline and final DRC', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-placement-handler-'));
    try {
      const input = board();
      await writeFile(path.join(repo, 'board.kicad_pcb'), input);
      mocks.runDrc.mockReset().mockResolvedValueOnce(cleanDrc()).mockResolvedValueOnce(cleanDrc());
      mocks.kicadLoadError.mockReset().mockResolvedValue(null);
      const ctx = context(repo);

      const result = await optimize.handler(ctx, { evaluation_budget: 160, step_schedule_mm: [2, 1, 0.5], allow_rotations: false });

      expect(result, typeof result === 'string' ? result : result.text).toMatchObject({ ok: true });
      expect(await readFile(path.join(repo, 'board.kicad_pcb'), 'utf8')).not.toBe(input);
      expect(ctx.filesTouched).toEqual(new Set(['board.kicad_pcb']));
      expect(mocks.runDrc).toHaveBeenCalledTimes(2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('uses exact DRC feedback to lock an implicated moved part and retry', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-placement-handler-'));
    try {
      const input = board();
      await writeFile(path.join(repo, 'board.kicad_pcb'), input);
      mocks.runDrc.mockReset()
        .mockResolvedValueOnce(cleanDrc())
        .mockResolvedValueOnce(silkDrc('R1'))
        .mockResolvedValueOnce(cleanDrc());
      mocks.kicadLoadError.mockReset().mockResolvedValue(null);

      const result = await optimize.handler(context(repo), {
        evaluation_budget: 400,
        step_schedule_mm: [2, 1, 0.5],
        allow_rotations: false,
      });

      expect(result, typeof result === 'string' ? result : result.text).toMatchObject({ ok: true });
      expect(typeof result === 'string' ? result : result.text).toContain('2 DRC pass(es)');
      expect(typeof result === 'string' ? result : result.text).toContain('feedback locks R1');
      expect(typeof result === 'string' ? result : result.text).toMatch(/global search: 29\d\/400 total candidate evaluations/);
      expect(await readFile(path.join(repo, 'board.kicad_pcb'), 'utf8')).not.toBe(input);
      expect(mocks.runDrc).toHaveBeenCalledTimes(3);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('gives the first pass the whole evaluation budget', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-placement-handler-'));
    try {
      await writeFile(path.join(repo, 'board.kicad_pcb'), board());
      mocks.runDrc.mockReset().mockResolvedValueOnce(cleanDrc()).mockResolvedValueOnce(cleanDrc());
      mocks.kicadLoadError.mockReset().mockResolvedValue(null);

      const result = await optimize.handler(context(repo), { evaluation_budget: 10, allow_rotations: false });

      expect(result, typeof result === 'string' ? result : result.text).toMatchObject({ ok: true });
      expect(typeof result === 'string' ? result : result.text).toContain('global search: 10/10 total candidate evaluations');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reverts when DRC feedback needs a retry but the budget is spent', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-placement-handler-'));
    try {
      const input = board();
      await writeFile(path.join(repo, 'board.kicad_pcb'), input);
      mocks.runDrc.mockReset().mockResolvedValueOnce(cleanDrc()).mockResolvedValueOnce(silkDrc('R1'));
      mocks.kicadLoadError.mockReset().mockResolvedValue(null);
      const ctx = context(repo);

      const result = await optimize.handler(ctx, { evaluation_budget: 10, allow_rotations: false });

      expect(result).toMatchObject({ ok: false });
      expect(typeof result === 'string' ? result : result.text).toContain('REVERTED');
      expect(await readFile(path.join(repo, 'board.kicad_pcb'), 'utf8')).toBe(input);
      expect(ctx.filesTouched).toEqual(new Set());
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('restores the exact input when final DRC fails', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-placement-handler-'));
    try {
      const input = board();
      await writeFile(path.join(repo, 'board.kicad_pcb'), input);
      mocks.runDrc.mockReset().mockResolvedValueOnce(cleanDrc()).mockResolvedValueOnce(failedDrc());
      mocks.kicadLoadError.mockReset().mockResolvedValue(null);
      const ctx = context(repo);

      const result = await optimize.handler(ctx, { evaluation_budget: 160, allow_rotations: false });

      expect(result).toMatchObject({ ok: false });
      expect(typeof result === 'string' ? result : result.text).toContain('REVERTED');
      expect(await readFile(path.join(repo, 'board.kicad_pcb'), 'utf8')).toBe(input);
      expect(ctx.filesTouched).toEqual(new Set());
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('restores the exact input bytes, even ones that are not valid UTF-8', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-placement-handler-'));
    try {
      const file = path.join(repo, 'board.kicad_pcb');
      const text = board().replace('(property "Value" "1k"', '(property "Value" "1kMARK"');
      const input = Buffer.concat(text.split('MARK').flatMap((part, i) => (i ? [Buffer.from([0xb5]), Buffer.from(part)] : [Buffer.from(part)])));
      await writeFile(file, input);
      mocks.runDrc.mockReset().mockResolvedValueOnce(cleanDrc()).mockResolvedValueOnce(failedDrc());
      mocks.kicadLoadError.mockReset().mockResolvedValue(null);

      const result = await optimize.handler(context(repo), { evaluation_budget: 400, allow_rotations: false });

      expect(result).toMatchObject({ ok: false });
      expect((await readFile(file)).equals(input)).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('puts the original back if the process exits while a candidate is being verified', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-placement-handler-'));
    try {
      const file = path.join(repo, 'board.kicad_pcb');
      const input = board();
      await writeFile(file, input);
      const exitListeners = process.listeners('exit');
      let onDiskDuringDrc = '';
      let afterExit = '';
      mocks.runDrc.mockReset()
        .mockResolvedValueOnce(cleanDrc())
        .mockImplementationOnce(async () => {
          onDiskDuringDrc = await readFile(file, 'utf8');
          // what process.exit would run: every exit listener the handler added
          for (const listener of process.listeners('exit')) if (!exitListeners.includes(listener)) (listener as () => void)();
          afterExit = await readFile(file, 'utf8');
          return cleanDrc();
        });
      mocks.kicadLoadError.mockReset().mockResolvedValue(null);

      const result = await optimize.handler(context(repo), { evaluation_budget: 400, allow_rotations: false });

      expect(result).toMatchObject({ ok: true });
      expect(onDiskDuringDrc).not.toBe(input);
      expect(afterExit).toBe(input);
      expect(process.listeners('exit')).toEqual(exitListeners);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('restores the exact input when the candidate load check throws', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-placement-handler-'));
    try {
      const input = board();
      await writeFile(path.join(repo, 'board.kicad_pcb'), input);
      mocks.runDrc.mockReset().mockResolvedValueOnce(cleanDrc());
      mocks.kicadLoadError.mockReset().mockRejectedValueOnce(new Error('probe unavailable'));
      const ctx = context(repo);

      const result = await optimize.handler(ctx, { evaluation_budget: 160, allow_rotations: false });

      expect(result).toMatchObject({ ok: false });
      expect(typeof result === 'string' ? result : result.text).toContain('candidate load check could not run');
      expect(await readFile(path.join(repo, 'board.kicad_pcb'), 'utf8')).toBe(input);
      expect(ctx.filesTouched).toEqual(new Set());
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('restores the exact input when the unrouted count changes', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-placement-handler-'));
    try {
      const input = board();
      await writeFile(path.join(repo, 'board.kicad_pcb'), input);
      mocks.runDrc.mockReset().mockResolvedValueOnce(cleanDrc(2)).mockResolvedValueOnce(cleanDrc(3));
      mocks.kicadLoadError.mockReset().mockResolvedValue(null);

      const result = await optimize.handler(context(repo), { evaluation_budget: 160, allow_rotations: false });

      expect(result).toMatchObject({ ok: false });
      expect(typeof result === 'string' ? result : result.text).toContain('unrouted connections changed 2 → 3');
      expect(await readFile(path.join(repo, 'board.kicad_pcb'), 'utf8')).toBe(input);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('refuses routed input without writing a candidate', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-placement-handler-'));
    try {
      const input = board(true);
      await writeFile(path.join(repo, 'board.kicad_pcb'), input);
      mocks.runDrc.mockReset().mockResolvedValueOnce(cleanDrc());
      mocks.kicadLoadError.mockReset().mockResolvedValue(null);

      const result = await optimize.handler(context(repo), {});

      expect(result).toMatchObject({ ok: false });
      expect(typeof result === 'string' ? result : result.text).toContain('only supports unrouted boards');
      expect(await readFile(path.join(repo, 'board.kicad_pcb'), 'utf8')).toBe(input);
      expect(mocks.runDrc).toHaveBeenCalledTimes(1);
      expect(mocks.kicadLoadError).not.toHaveBeenCalled();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('refuses a non-numeric evaluation budget before running DRC', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-placement-handler-'));
    try {
      const input = board();
      await writeFile(path.join(repo, 'board.kicad_pcb'), input);
      mocks.runDrc.mockReset();
      mocks.kicadLoadError.mockReset();

      const result = await optimize.handler(context(repo), { evaluation_budget: '160' });

      expect(result).toMatchObject({ ok: false });
      expect(typeof result === 'string' ? result : result.text).toContain('evaluation_budget must be a number');
      expect(await readFile(path.join(repo, 'board.kicad_pcb'), 'utf8')).toBe(input);
      expect(mocks.runDrc).not.toHaveBeenCalled();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('does not reset an exhausted global budget for DRC feedback', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-placement-handler-'));
    try {
      const input = board().replace(footprint('R3', 40, 'N2', 'B'), '');
      await writeFile(path.join(repo, 'board.kicad_pcb'), input);
      mocks.runDrc.mockReset().mockResolvedValueOnce(cleanDrc()).mockResolvedValueOnce(silkDrc('R1'));
      mocks.kicadLoadError.mockReset().mockResolvedValue(null);

      const result = await optimize.handler(context(repo), {
        evaluation_budget: 1,
        step_schedule_mm: [2],
        allow_rotations: false,
      });

      expect(result).toMatchObject({ ok: false });
      expect(typeof result === 'string' ? result : result.text).toContain('1/1 total candidate evaluations');
      expect(await readFile(path.join(repo, 'board.kicad_pcb'), 'utf8')).toBe(input);
      expect(mocks.runDrc).toHaveBeenCalledTimes(2);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
