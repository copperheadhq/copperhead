import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { availableTools, dispatchTool, type RunContext } from '../src/agent/tools.js';
import { loadConfig } from '../src/config.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';

const delta = '# Power\n\n## ADDED Requirements\n\n### Requirement: Sleep budget\nThe sensor SHALL draw less than 20 uA in sleep.\n\n#### Scenario: Idle\n- **WHEN** the sensor sleeps\n- **THEN** current is less than 20 uA\n';
const proposal = { id: 'sensor-power', why: 'Seed the power requirement', what_changes: '- Add sleep budget', tasks: '- [ ] Record budget' };

async function fixture() {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-proposal-'));
  const transcript = new Transcript(repo);
  await transcript.init();
  const ctx: RunContext = {
    repoRoot: repo, config: await loadConfig(repo), transcript,
    ledger: new ObligationsLedger(), runId: 'test', interactive: false,
    confirm: async () => true, editsUnlocked: false, changeId: null,
    proposalValidated: false, filesTouched: new Set(), decisions: [],
    lastErc: null, lastDrc: null, lastLegibility: null, lastScore: null,
    repairCycles: 0, finishRequest: null,
  };
  return { repo, ctx, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

describe('OpenSpec proposal deltas', () => {
  it('writes deltas only inside the proposal without unlocking edits', async () => {
    const { repo, ctx, cleanup } = await fixture();
    try {
      await dispatchTool(ctx, 'propose_change', { ...proposal, specs: [{ capability: 'power', content: delta }] });
      expect(await readFile(path.join(repo, 'openspec/changes/sensor-power/specs/power/spec.md'), 'utf8')).toBe(delta);
      expect(ctx.editsUnlocked).toBe(false);
      expect(availableTools(ctx).map((t) => t.schema.name)).not.toContain('write_file');
      ctx.editsUnlocked = true;
      ctx.proposalValidated = true;
      await dispatchTool(ctx, 'propose_change', proposal);
      expect(ctx.editsUnlocked).toBe(false);
      expect(ctx.proposalValidated).toBe(false);
    } finally { await cleanup(); }
  });

  it.each(['../escape', 'power/../../escape', 'C:\\escape', 'power:stream'])(
    'rejects capability path %s before writing a proposal', async (capability) => {
      const { repo, ctx, cleanup } = await fixture();
      try {
        const result = await dispatchTool(ctx, 'propose_change', { ...proposal, specs: [{ capability, content: delta }] });
        expect(result).toContain('kebab-case');
        expect(existsSync(path.join(repo, 'openspec'))).toBe(false);
        expect(ctx.editsUnlocked).toBe(false);
      } finally { await cleanup(); }
    },
  );

  it.skipIf(process.env.COPPERHEAD_TEST_OPENSPEC !== '1')('unlocks only after the real OpenSpec CLI accepts a delta', async () => {
    const { repo, ctx, cleanup } = await fixture();
    try {
      await mkdir(path.join(repo, 'openspec'), { recursive: true });
      await writeFile(path.join(repo, 'openspec/config.yaml'), 'schema: spec-driven\n', 'utf8');
      await dispatchTool(ctx, 'propose_change', proposal);
      expect(await dispatchTool(ctx, 'validate_change', {})).toContain('FAILED');
      expect(ctx.editsUnlocked).toBe(false);
      await dispatchTool(ctx, 'propose_change', { ...proposal, specs: [{ capability: 'power', content: delta }] });
      expect(await dispatchTool(ctx, 'validate_change', {})).toContain('unlocked');
      expect(ctx.editsUnlocked).toBe(true);
    } finally { await cleanup(); }
  });
});
