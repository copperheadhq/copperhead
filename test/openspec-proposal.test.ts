import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { availableTools, dispatchTool, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { Transcript } from '../src/agent/transcript.js';
import { openspecInit } from '../src/openspec/cli.js';

const delta = `## ADDED Requirements

### Requirement: USB power budget
The sensor board SHALL draw no more than 100 mA from USB before configuration.

#### Scenario: Device is not configured
- **WHEN** USB power is connected before configuration
- **THEN** the board draws no more than 100 mA
`;
const proposal = {
  id: 'seed-power-budget',
  why: 'Specify the USB power requirement before implementing the board.',
  what_changes: '- Document the pre-configuration current budget.',
  tasks: '- [ ] Record the power budget in the design specification.',
  spec_deltas: [{ capability: 'usb-power', content: delta }],
};

let repo: string;
let outside: string;
let ctx: RunContext;
beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'copperhead-proposal-'));
  outside = await mkdtemp(path.join(tmpdir(), 'copperhead-proposal-outside-'));
  const transcript = new Transcript(repo);
  await transcript.init();
  ctx = {
    repoRoot: repo,
    config: await loadConfig(repo),
    transcript,
    ledger: new ObligationsLedger(),
    runId: 'proposal-test',
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
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const names = (): string[] => availableTools(ctx).map((tool) => tool.name);

describe('proposal capability deltas', () => {
  it('writes capability specs through the locked proposal tool, without unlocking file edits', async () => {
    const result = await dispatchTool(ctx, 'propose_change', proposal);
    expect(result).toContain('proposal written');
    expect(await readFile(path.join(repo, 'openspec/changes/seed-power-budget/specs/usb-power/spec.md'), 'utf8')).toBe(delta);
    expect(names()).not.toContain('write_file');
    expect(names()).not.toContain('edit_file');
  });

  it('requires a nonempty delta list in an initialized workspace', async () => {
    await mkdir(path.join(repo, 'openspec'));
    await writeFile(path.join(repo, 'openspec/config.yaml'), 'schema: spec-driven\n');
    const { spec_deltas: _deltas, ...withoutDeltas } = proposal;
    for (const args of [withoutDeltas, { ...proposal, spec_deltas: [] }]) {
      expect(await dispatchTool(ctx, 'propose_change', args)).toContain('spec_deltas');
      expect(ctx.editsUnlocked).toBe(false);
      expect(existsSync(path.join(repo, 'openspec/changes'))).toBe(false);
    }
  });

  it.each(['../outside', '../../docs', '/tmp/elsewhere', 'x/y', 'x\\y', '', 'Bad Name'])(
    'rejects an unsafe change id before writing: %s',
    async (id) => {
      expect(await dispatchTool(ctx, 'propose_change', { ...proposal, id })).toContain('error:');
      expect(existsSync(path.join(repo, 'openspec'))).toBe(false);
      expect(ctx.changeId).toBeNull();
    },
  );

  it.each(['../outside', '/tmp/elsewhere', 'x/y', 'x\\y', '', 'Bad Name'])(
    'rejects an unsafe capability before writing: %s',
    async (capability) => {
      expect(await dispatchTool(ctx, 'propose_change', { ...proposal, spec_deltas: [{ capability, content: delta }] })).toContain('error:');
      expect(existsSync(path.join(repo, 'openspec'))).toBe(false);
    },
  );

  it('rejects duplicate capabilities and malformed content before writing any files', async () => {
    for (const spec_deltas of [[...proposal.spec_deltas, ...proposal.spec_deltas], [{ capability: 'usb-power', content: '  ' }], [null]]) {
      expect(await dispatchTool(ctx, 'propose_change', { ...proposal, spec_deltas })).toContain('error:');
      expect(existsSync(path.join(repo, 'openspec'))).toBe(false);
    }
  });

  it.each(['openspec', 'openspec/changes', 'openspec/changes/seed-power-budget/specs'])('rejects a symlinked ancestor: %s', async (relative) => {
    const link = path.join(repo, relative);
    await mkdir(path.dirname(link), { recursive: true });
    await writeFile(path.join(outside, 'sentinel'), 'unchanged');
    await symlink(outside, link, 'dir');
    expect(await dispatchTool(ctx, 'propose_change', proposal)).toContain('symlink');
    expect(await readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
    expect(existsSync(path.join(outside, 'proposal.md'))).toBe(false);
    expect(existsSync(path.join(outside, 'usb-power'))).toBe(false);
  });

  it('rejects a symlinked destination without changing its target or another proposal file', async () => {
    const dir = path.join(repo, 'openspec/changes/seed-power-budget');
    await mkdir(path.join(dir, 'specs/usb-power'), { recursive: true });
    const victim = path.join(outside, 'private.md');
    await writeFile(victim, 'unchanged');
    await writeFile(path.join(dir, 'proposal.md'), 'existing proposal');
    await symlink(victim, path.join(dir, 'specs/usb-power/spec.md'));
    expect(await dispatchTool(ctx, 'propose_change', proposal)).toContain('symlink');
    expect(await readFile(victim, 'utf8')).toBe('unchanged');
    expect(await readFile(path.join(dir, 'proposal.md'), 'utf8')).toBe('existing proposal');
    expect(ctx.editsUnlocked).toBe(false);
  });
});

// Opt in with a real OpenSpec executable on PATH. No model/provider is used.
describe.skipIf(process.env.COPPERHEAD_TEST_OPENSPEC !== '1')('real OpenSpec proposal validation', () => {
  beforeEach(async () => {
    expect((await openspecInit(repo)).ok).toBe(true);
  });

  it('validates a real capability delta before exposing edit tools', async () => {
    expect(await dispatchTool(ctx, 'propose_change', proposal)).toContain('proposal written');
    expect(names()).not.toContain('write_file');
    expect(await dispatchTool(ctx, 'validate_change', {})).toContain('validation passed');
    expect(ctx.proposalValidated).toBe(true);
    expect(names()).toContain('write_file');
  });

  it('relocks after revising an approved proposal and keeps invalid deltas locked', async () => {
    await dispatchTool(ctx, 'propose_change', proposal);
    expect(await dispatchTool(ctx, 'validate_change', {})).toContain('validation passed');
    await dispatchTool(ctx, 'propose_change', { ...proposal, spec_deltas: [{ capability: 'usb-power', content: '# Missing requirement and scenario\n' }] });
    expect(ctx.proposalValidated).toBe(false);
    expect(names()).not.toContain('edit_file');
    expect(await dispatchTool(ctx, 'validate_change', {})).toContain('validation FAILED');
    expect(ctx.editsUnlocked).toBe(false);
    expect(names()).not.toContain('write_file');
  });

  it('keeps edits locked when the human declines a valid proposal', async () => {
    ctx.interactive = true;
    ctx.confirm = async () => false;
    await dispatchTool(ctx, 'propose_change', proposal);
    expect(await dispatchTool(ctx, 'validate_change', {})).toContain('human declined');
    expect(ctx.proposalValidated).toBe(false);
    expect(ctx.editsUnlocked).toBe(false);
    expect(names()).not.toContain('write_file');
  });
});
