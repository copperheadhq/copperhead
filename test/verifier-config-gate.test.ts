import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { runInit } from '../src/memory/scaffold.js';
import { loadConfig } from '../src/config.js';
import { dispatchTool, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger, DRC_AFTER_BOARD_EDIT, DRC_AFTER_RULES_EDIT } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import { markTouched } from '../src/capabilities/helpers.js';
import { tempFixtureRepo } from './helpers.js';

async function unlockedCtx(repo: string): Promise<RunContext> {
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
    editsUnlocked: true,
    changeId: 'c',
    proposalValidated: true,
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

/**
 * DRC reads more than the .kicad_pcb: the board's design rules and rule
 * severities live in the .kicad_pro, custom rules in a .kicad_dru beside it.
 * An edit to either changes what DRC says about an unchanged board, so it is
 * a board edit for the verification gate (invariant 2).
 */
describe('files that configure DRC are verified like the board', () => {
  it('a .kicad_pro or .kicad_dru edit opens the DRC obligation', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      for (const f of ['hardware/open-key.kicad_pro', 'hardware/open-key.kicad_dru']) {
        const ctx = await unlockedCtx(repo);
        ctx.lastDrc = { ok: true, source: 'drc', violations: [] };
        markTouched(ctx, f);
        expect(ctx.ledger.openOfKind('drc').map((o) => o.detail), f).toEqual([DRC_AFTER_RULES_EDIT]);
        // the earlier passing DRC no longer describes the board under the new rules
        expect(ctx.lastDrc, f).toBeNull();
      }
    } finally {
      await cleanup();
    }
  });

  it('finish wants a DRC since the last design-rules edit, not only since the last board edit', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await unlockedCtx(repo);
      // a run that tightened a clearance in the project file and passed ERC
      markTouched(ctx, 'hardware/open-key.kicad_pro');
      ctx.lastErc = { ok: true, source: 'erc', violations: [] };
      const res = await dispatchTool(ctx, 'finish', { outcome: 'done', summary: 'raised the clearance to 0.3 mm' });
      expect(res).toMatch(/cannot finish yet/);
      expect(res).toMatch(/DRC has not passed/);
      expect(ctx.finishRequest).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('write_file refuses to create a custom DRC rules file, like the other KiCad files', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await unlockedCtx(repo);
      const res = await dispatchTool(ctx, 'write_file', {
        path: 'hardware/open-key.kicad_dru',
        content: '(version 1)\n(rule "anything goes" (constraint clearance (min 0mm)))\n',
      });
      expect(res).toMatch(/refuses KiCad files/);
      expect(existsSync(path.join(repo, 'hardware', 'open-key.kicad_dru'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  // with no board in .copperhead/config.json, run_drc has nothing to check. that
  // waives a design-rules edit, but must not waive an edit to a real .kicad_pcb.
  it('with no board configured, a .kicad_pcb edit still cannot finish without DRC', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await unlockedCtx(repo);
      ctx.config = { ...ctx.config, board: null };
      markTouched(ctx, 'hardware/open-key.kicad_pcb');
      expect(ctx.ledger.openOfKind('drc').map((o) => o.detail)).toEqual([DRC_AFTER_BOARD_EDIT]);
      ctx.lastErc = { ok: true, source: 'erc', violations: [] };
      ctx.ledger.clear('erc');
      ctx.ledger.clear('drift');
      const drc = await dispatchTool(ctx, 'run_drc', {});
      expect(drc).toMatch(/a \.kicad_pcb was edited/);
      expect(ctx.ledger.openOfKind('drc').map((o) => o.detail)).toEqual([DRC_AFTER_BOARD_EDIT]);
      const res = await dispatchTool(ctx, 'finish', { outcome: 'done', summary: 'widened a trace' });
      expect(res).toMatch(/cannot finish yet/);
      expect(ctx.finishRequest).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('with no board configured, a design-rules-only edit finishes after run_drc', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const ctx = await unlockedCtx(repo);
      ctx.config = { ...ctx.config, board: null };
      markTouched(ctx, 'hardware/open-key.kicad_pro');
      ctx.lastErc = { ok: true, source: 'erc', violations: [] };
      ctx.ledger.clear('erc');
      ctx.ledger.clear('drift');
      const drc = await dispatchTool(ctx, 'run_drc', {});
      expect(drc).toMatch(/DRC does not apply yet/);
      expect(ctx.ledger.openOfKind('drc')).toEqual([]);
      const res = await dispatchTool(ctx, 'finish', { outcome: 'done', summary: 'set a clearance for later' });
      expect(res).toMatch(/all gates satisfied/);
    } finally {
      await cleanup();
    }
  });
});
