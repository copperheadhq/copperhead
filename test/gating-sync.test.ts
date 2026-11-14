import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { runInit } from '../src/memory/scaffold.js';
import { loadConfig } from '../src/config.js';
import { availableTools, dispatchTool, dispatchToolResult, registry, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import {
  saveConstraint,
  loadConstraints,
  classifyAffectsTarget,
  reopenDeferredAffects,
} from '../src/memory/constraints.js';
import { syncVerify } from '../src/commands/sync.js';
import { tempFixtureRepo } from './helpers.js';

async function makeCtx(repo: string): Promise<RunContext> {
  const transcript = new Transcript(repo);
  await transcript.init();
  return {
    repoRoot: repo,
    config: await loadConfig(repo),
    transcript,
    ledger: new ObligationsLedger(),
    runId: 'test-run',
    interactive: false,
    confirm: async () => true,
    editsUnlocked: false,
    changeId: null,
    proposalValidated: false,
    filesTouched: new Set(),
    decisions: [],
    lastErc: null,
    lastDrc: null,
    lastLegibility: null,
    lastScore: null,
    repairCycles: 0,
    finishRequest: null,
  };
}

describe('spec gating: structural edit lock (invariant 1)', () => {
  it('edit tools are absent until the proposal validates, then present', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const names = (): string[] => availableTools(ctx).map((t) => t.schema.name);
      expect(names()).not.toContain('edit_file');
      expect(names()).not.toContain('write_file');
      expect(registry.list(ctx).map((e) => e.name)).not.toContain('edit_file');
      expect(registry.list(ctx).map((e) => e.name)).not.toContain('write_file');
      expect(names()).toContain('read_file');
      expect(names()).toContain('propose_change');
      expect(names()).toContain('generate_report');

      const denied = await dispatchTool(ctx, 'edit_file', { path: 'docs/BOM.md', old_string: 'a', new_string: 'b' });
      expect(denied).toContain('not available');
      expect(denied).toContain('unlock');
      const deniedEnv = await dispatchToolResult(ctx, 'edit_file', { path: 'docs/BOM.md', old_string: 'a', new_string: 'b' });
      expect(deniedEnv.error?.kind).toBe('unavailable');

      await dispatchTool(ctx, 'propose_change', {
        id: 'test-change',
        why: 'testing',
        what_changes: '- nothing real',
        tasks: '- [ ] test',
      });
      const validated = await dispatchTool(ctx, 'validate_change', {});
      expect(validated).toContain('unlocked');
      expect(ctx.editsUnlocked).toBe(true);
      expect(names()).toContain('edit_file');
      expect(names()).toContain('write_file');
    } finally {
      await cleanup();
    }
  });

  it('finish blocks on open obligations and unverified ERC', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      ctx.editsUnlocked = true;

      // touch the schematic via edit_file: opens erc/drift/changelog obligations
      const sch = 'hardware/open-key.kicad_sch';
      const text = await readFile(path.join(repo, sch), 'utf8');
      expect(text).toContain('"Value" "1k"');
      await dispatchTool(ctx, 'edit_file', { path: sch, old_string: '"Value" "1k"', new_string: '"Value" "2.2k"' });

      const blocked = await dispatchTool(ctx, 'finish', { outcome: 'done', summary: 'done' });
      expect(blocked).toContain('cannot finish yet');
      expect(blocked).toContain('ERC');
      expect(ctx.finishRequest).toBeNull();

      // satisfy the gates: ERC + drift (BOM must be updated to match)
      await dispatchTool(ctx, 'run_erc', {});
      const bom = await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8');
      await writeFile(path.join(repo, 'docs', 'BOM.md'), bom.replace('| R2 | 1k |', '| R2 | 2.2k |'), 'utf8');
      const driftRes = await dispatchTool(ctx, 'check_drift', {});
      expect(driftRes).toBe('drift: clean');
      // the fixture's group caption must name a documented subsystem
      const subs = await readFile(path.join(repo, 'docs', 'SUBSYSTEMS.md'), 'utf8');
      await writeFile(path.join(repo, 'docs', 'SUBSYSTEMS.md'), subs + '\n## Keyer\n\nKey input block.\n', 'utf8');
      const legRes = await dispatchTool(ctx, 'check_legibility', {});
      expect(legRes).toContain('0 error'); // advisories inform but never block finish

      const done = await dispatchTool(ctx, 'finish', { outcome: 'done', summary: 'done' });
      expect(done).toContain('all gates satisfied');
      expect(ctx.finishRequest).toEqual({ outcome: 'done', summary: 'done' });
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('refuse outcome needs no gates (AC-3.4 mechanism)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const res = await dispatchTool(ctx, 'finish', {
        outcome: 'refuse',
        summary: 'would violate sleep_current_uA budget from SPEC.md',
      });
      expect(res).toContain('refusal recorded');
      expect(ctx.finishRequest!.outcome).toBe('refuse');
    } finally {
      await cleanup();
    }
  });

  it('check_drift clears the drift obligation when no schematic exists yet', async () => {
    // Regression: the create pipeline's first three stages are docs-only and run
    // before a schematic exists. check_drift used to early-return without
    // clearing, and since it is the only tool that clears drift, a doc edit
    // opened an obligation that could never close and finish refused forever.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      ctx.config = { ...ctx.config, schematic: null };
      ctx.ledger.onDocEdit('docs/SPEC.md');
      expect(ctx.ledger.openObligations.some((o) => o.kind === 'drift')).toBe(true);

      const res = await dispatchTool(ctx, 'check_drift', {});
      expect(res).toContain('vacuously clean');
      expect(ctx.ledger.openObligations.some((o) => o.kind === 'drift')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('record_constraint opens affects-revisit obligations; resolve_affected clears them', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      ctx.editsUnlocked = true;
      await dispatchTool(ctx, 'record_constraint', {
        key: 'power.sleep_current_uA',
        max: 25,
        source: 'docs/SPEC.md#budgets',
        affects: ['R1'],
      });
      expect(ctx.ledger.openObligations.some((o) => o.kind === 'affects-revisit')).toBe(true);
      await dispatchTool(ctx, 'resolve_affected', {
        constraint_key: 'power.sleep_current_uA',
        item: 'R1',
        resolution: 'no change needed: R1 is on EN, not a leakage path in sleep',
      });
      expect(ctx.ledger.openObligations.some((o) => o.kind === 'affects-revisit')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('resolve_affected reports a miss instead of silently succeeding', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      ctx.editsUnlocked = true;
      await dispatchTool(ctx, 'record_constraint', {
        key: 'power.cc_rd_ohms',
        max: 5100,
        source: 'docs/SPEC.md#budgets',
        affects: ['CC1', 'CC2'],
      });
      // Both items in one call matches neither obligation.
      const res = await dispatchTool(ctx, 'resolve_affected', {
        constraint_key: 'power.cc_rd_ohms',
        item: 'CC1/CC2',
        resolution: 'changed: 5.1k',
      });
      expect(res).toMatch(/^error:/);
      expect(res).toContain('power.cc_rd_ohms affects CC1');
      expect(res).toContain('power.cc_rd_ohms affects CC2');
      // The obligations stay open, and no decision is logged for a failed resolve.
      expect(ctx.ledger.openOfKind('affects-revisit')).toHaveLength(2);
      expect(ctx.decisions.some((d) => d.includes('CC1/CC2'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('record_constraint defers affects items whose artifact does not exist yet', async () => {
    // Regression: during the docs-only create stages every affects item that
    // targets the future schematic/board opened an obligation the model could
    // only close with a ceremonial "no change needed: not yet created" call —
    // 13 of them burned ~25 turns in a live spec-seed run.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      ctx.editsUnlocked = true;
      ctx.config = { ...ctx.config, schematic: null, board: null };
      const res = await dispatchTool(ctx, 'record_constraint', {
        key: 'manufacturing.copper_weight_oz',
        value: '1',
        source: 'brief',
        affects: ['layout', 'stackup', 'R1'],
      });
      // R1 names a concrete part: opens now. layout/stackup wait for the board.
      const open = ctx.ledger.openOfKind('affects-revisit').map((o) => o.detail);
      expect(open).toEqual(['manufacturing.copper_weight_oz affects R1']);
      expect(res).toContain('deferred until the target artifact exists');
      expect(res).toContain('layout, stackup');
      const registry = await loadConstraints(repo);
      expect(registry['manufacturing.copper_weight_oz']!.deferred).toEqual(['layout', 'stackup']);
      // the full affects list is preserved for propagation regardless
      expect(registry['manufacturing.copper_weight_oz']!.affects).toEqual(['layout', 'stackup', 'R1']);
    } finally {
      await cleanup();
    }
  });

  it('deferred revisits re-open once their artifact exists, exactly once', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      ctx.editsUnlocked = true;
      ctx.config = { ...ctx.config, schematic: null, board: null };
      await dispatchTool(ctx, 'record_constraint', {
        key: 'mechanical.mounting_holes',
        value: '24mm pitch',
        source: 'brief',
        affects: ['layout'],
      });
      expect(ctx.ledger.openOfKind('affects-revisit')).toHaveLength(0);

      // board still absent: nothing re-opens, marker stays
      const none = await reopenDeferredAffects(repo, ctx.config, () => {
        throw new Error('should not open anything');
      });
      expect(none).toEqual([]);

      // a later run has the board configured: the revisit re-opens in its ledger
      const laterConfig = { ...ctx.config, board: 'hardware/x.kicad_pcb' };
      const ledger = new ObligationsLedger();
      const reopened = await reopenDeferredAffects(repo, laterConfig, (key, item) =>
        ledger.add('affects-revisit', `${key} affects ${item}`, key),
      );
      expect(reopened).toEqual([{ key: 'mechanical.mounting_holes', item: 'layout' }]);
      expect(ledger.openOfKind('affects-revisit').map((o) => o.detail)).toEqual([
        'mechanical.mounting_holes affects layout',
      ]);
      // the marker is consumed: a third run re-opens nothing
      expect((await loadConstraints(repo))['mechanical.mounting_holes']!.deferred).toBeUndefined();
      expect(await reopenDeferredAffects(repo, laterConfig, () => {})).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('classifies affects items by target artifact', () => {
    expect(classifyAffectsTarget('layout')).toBe('board');
    expect(classifyAffectsTarget('stackup')).toBe('board');
    expect(classifyAffectsTarget('current-carrying traces')).toBe('board');
    expect(classifyAffectsTarget('thermal')).toBe('board');
    expect(classifyAffectsTarget('schematic')).toBe('schematic');
    expect(classifyAffectsTarget('pin assignment')).toBe('schematic');
    expect(classifyAffectsTarget('BOM')).toBe('bom');
    // concrete refdes/nets are never deferrable
    expect(classifyAffectsTarget('R1')).toBeNull();
    expect(classifyAffectsTarget('U2 EN pullup')).toBeNull();
  });

  it('search rejects an empty pattern with a corrective message', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      const res = await dispatchTool(ctx, 'search', { pattern: '' });
      expect(res).toMatch(/^error:/);
      expect(res).toContain('non-empty regex');
    } finally {
      await cleanup();
    }
  });

  it('run_erc without a schematic says ERC does not apply yet', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      ctx.config = { ...ctx.config, schematic: null, board: null };
      expect(await dispatchTool(ctx, 'run_erc', {})).toContain('does not apply yet');
      expect(await dispatchTool(ctx, 'run_drc', {})).toContain('does not apply yet');
    } finally {
      await cleanup();
    }
  });

  it('record_decision appends to DECISIONS.md append-only', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await makeCtx(repo);
      ctx.editsUnlocked = true;
      await dispatchTool(ctx, 'record_decision', {
        decision: 'kept R1 at 10k',
        rationale: 'EN pullup, no sleep leakage path',
        affects: 'R1',
      });
      const log = await readFile(path.join(repo, 'docs', 'DECISIONS.md'), 'utf8');
      expect(log).toContain('kept R1 at 10k | why: EN pullup');
      expect(log.startsWith('# Decision log')).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe('copperhead sync verify phase (AC-7)', () => {
  it('clean repo: no inconsistencies, idempotent (AC-7.5)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      expect((await syncVerify(repo)).resolvable).toEqual([]);
      expect((await syncVerify(repo)).resolvable).toEqual([]); // second run: still nothing
    } finally {
      await cleanup();
    }
  });

  it('doc drift becomes a resolvable item with proposed resolution (AC-7.1 verify side)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      const bom = await readFile(bomPath, 'utf8');
      await writeFile(bomPath, bom.replace('| R1 | 10k |', '| R1 | 47k |'), 'utf8');
      const report = await syncVerify(repo);
      expect(report.resolvable).toHaveLength(1);
      expect(report.resolvable[0]!.kind).toBe('drift');
      expect(report.resolvable[0]!.resolution).toContain('as-built');
      expect(report.violations).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('registry entry with no doc mention is a dual-write gap (AC-7.2 verify side)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await saveConstraint(repo, 'rf.antenna_keepout_mm', {
        min: 5,
        source: 'docs/LAYOUT.md',
        affects: ['zone:top'],
      });
      const report = await syncVerify(repo);
      expect(report.resolvable.some((i) => i.kind === 'dual-write')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('forbidden-pin use is a requirement violation: flagged, never resolvable (AC-7.3)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      // GPIO14 carries KEY_DAH in the fixture; forbid it and sync must flag, not fix
      await saveConstraint(repo, 'pins.forbidden_gpio14', {
        forbidden: ['GPIO14'],
        source: 'esp32-s3 datasheet',
        affects: ['U1'],
      });
      const report = await syncVerify(repo);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0]!.description).toContain('GPIO14');
      expect(report.violations[0]!.governedBy).toBe('esp32-s3 datasheet');
    } finally {
      await cleanup();
    }
  });
});
