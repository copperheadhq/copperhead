import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dispatchTool, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { draftSchematic } from '../src/kicad/draft/draft.js';
import { STAGES } from '../src/commands/create.js';

/**
 * Agent-tool and pipeline wiring for the drafting engine: draft_schematic,
 * score_schematic, the drafting-mode edit guard, and the stage-4 staleness
 * contract. The fixture symbol libraries stand in for the installed KiCad
 * libraries; after the first draft the vendored cache makes everything
 * hermetic (no installed libs consulted).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');
const DRAFT_FIXTURE = path.join(HERE, 'fixtures', 'draft');

async function draftedRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-drafttools-'));
  await cp(path.join(DRAFT_FIXTURE, 'schematic.intent.json'), path.join(repo, 'schematic.intent.json'));
  await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await writeFile(
    path.join(repo, '.copperhead', 'config.json'),
    JSON.stringify({ schematic: 'board.kicad_sch', docs: 'docs/', origin: 'create' }),
    'utf8',
  );
  // first draft vendors the fixture symbols into sym-lib-cache, after which the
  // repo is hermetic (tools and isComplete resolve from the cache)
  const res = await draftSchematic({
    repoRoot: repo,
    schematic: 'board.kicad_sch',
    intentPath: 'schematic.intent.json',
    docsDir: path.join(repo, 'docs'),
    symbolDirs: [SYMLIB],
  });
  if (!res.ok) throw new Error(res.message);
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

async function makeCtx(repo: string): Promise<RunContext> {
  const { loadConfig } = await import('../src/config.js');
  return {
    repoRoot: repo,
    config: await loadConfig(repo),
    transcript: { event: async () => {} } as never,
    ledger: new ObligationsLedger(),
    runId: 'test',
    interactive: false,
    confirm: async () => true,
    editsUnlocked: true,
    changeId: 'test-change',
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

describe('draft_schematic tool', () => {
  it('re-drafts, embeds checker findings and score, and updates the ledger (AC-16.11)', async () => {
    const { repo, cleanup } = await draftedRepo();
    try {
      const ctx = await makeCtx(repo);
      const out = await dispatchTool(ctx, 'draft_schematic', {});
      expect(out).toContain('drafted: 2 group(s)');
      expect(out).toContain('legibility:'); // embedded checker result
      expect(out).toContain('score:'); // embedded score with breakdown
      expect(ctx.lastScore).not.toBeNull();
      expect(ctx.lastLegibility?.error).toBe(0);
      expect(ctx.ledger.openOfKind('legibility')).toHaveLength(0); // clean draft clears
      expect(ctx.ledger.openOfKind('erc')).toHaveLength(1); // a draft is a mutation: ERC re-verifies
    } finally {
      await cleanup();
    }
  }, 60000);

  it('an invalid inline IR fails without side effects (AC-16.6)', async () => {
    const { repo, cleanup } = await draftedRepo();
    try {
      const before = await readFile(path.join(repo, 'board.kicad_sch'), 'utf8');
      const intentBefore = await readFile(path.join(repo, 'schematic.intent.json'), 'utf8');
      const bad = JSON.parse(intentBefore);
      bad.nets.push({ name: 'X', pins: ['U1.99', 'R1.1'] });
      const ctx = await makeCtx(repo);
      const out = await dispatchTool(ctx, 'draft_schematic', { intent_json: JSON.stringify(bad) });
      expect(out).toContain('U1 has no pin 99');
      expect(await readFile(path.join(repo, 'board.kicad_sch'), 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  }, 60000);

  it('is spec-gated: absent from the tool list until the proposal validates', async () => {
    const { repo, cleanup } = await draftedRepo();
    try {
      const ctx = await makeCtx(repo);
      ctx.editsUnlocked = false;
      const out = await dispatchTool(ctx, 'draft_schematic', {});
      expect(out).toContain('not available');
    } finally {
      await cleanup();
    }
  }, 60000);
});

describe('drafting-mode edit guard (AC-16.23)', () => {
  it('edit_file against an engine-drafted schematic is refused, naming draft_schematic', async () => {
    const { repo, cleanup } = await draftedRepo();
    try {
      const before = await readFile(path.join(repo, 'board.kicad_sch'), 'utf8');
      const ctx = await makeCtx(repo);
      const out = await dispatchTool(ctx, 'edit_file', {
        path: 'board.kicad_sch',
        old_string: '(paper "A5")',
        new_string: '(paper "A3")',
      });
      expect(out).toContain('refused');
      expect(out).toContain('draft_schematic');
      expect(await readFile(path.join(repo, 'board.kicad_sch'), 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  }, 60000);

  it('the intent file itself stays editable — repairs go through the IR', async () => {
    const { repo, cleanup } = await draftedRepo();
    try {
      const ctx = await makeCtx(repo);
      const out = await dispatchTool(ctx, 'edit_file', {
        path: 'schematic.intent.json',
        old_string: '"value": "100n"',
        new_string: '"value": "1u"',
      });
      expect(out).not.toContain('refused');
    } finally {
      await cleanup();
    }
  }, 60000);
});

describe('score_schematic tool', () => {
  it('returns the composite with the per-metric breakdown', async () => {
    const { repo, cleanup } = await draftedRepo();
    try {
      const ctx = await makeCtx(repo);
      const out = await dispatchTool(ctx, 'score_schematic', {});
      expect(out).toMatch(/score: \d+(\.\d+)?\/100/);
      expect(out).toContain('axis-alignment');
      expect(out).toContain('pair-symmetry');
      expect(ctx.lastScore).not.toBeNull();
    } finally {
      await cleanup();
    }
  }, 60000);

  it('says so when no schematic is configured', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-noscore-'));
    try {
      const ctx = await makeCtx(dir);
      expect(await dispatchTool(ctx, 'score_schematic', {})).toContain('no schematic configured');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('stage-4 drafting contract (AC-16.20)', () => {
  it('a stale draft keeps the stage active; a re-draft completes it', async () => {
    const { repo, cleanup } = await draftedRepo();
    try {
      const isComplete = STAGES.find((s) => s.name === 'schematic')!.isComplete;
      expect(await isComplete(repo, 'docs/')).toBe(true);

      // change the intent without re-drafting: the sheet on disk is now stale
      const intentPath = path.join(repo, 'schematic.intent.json');
      const intent = JSON.parse(await readFile(intentPath, 'utf8'));
      intent.nets.find((n: { name: string }) => n.name === 'SIG_IN').name = 'SIG_A';
      await writeFile(intentPath, JSON.stringify(intent, null, 2), 'utf8');
      expect(await isComplete(repo, 'docs/')).toBe(false);

      // re-draft: complete again
      const res = await draftSchematic({
        repoRoot: repo,
        schematic: 'board.kicad_sch',
        intentPath: 'schematic.intent.json',
        docsDir: path.join(repo, 'docs'),
      });
      expect(res.ok).toBe(true);
      expect(await isComplete(repo, 'docs/')).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120000);
});

describe('draft path is LLM-free by construction', () => {
  it('the draft/score module graph never imports a provider or SDK', async () => {
    for (const rel of [
      '../src/kicad/draft/draft.ts',
      '../src/kicad/draft/engine.ts',
      '../src/kicad/draft/ir.ts',
      '../src/kicad/draft/symsource.ts',
      '../src/kicad/emit.ts',
      '../src/kicad/score.ts',
    ]) {
      const src = await readFile(path.join(HERE, rel), 'utf8');
      expect(src, rel).not.toMatch(/providers\/|openai|anthropic|@openai|node:http|fetch\(/i);
    }
  });
});
describe('draft_schematic input guards', () => {
  it('malformed intent_json is refused before anything is written', async () => {
    const { repo, cleanup } = await draftedRepo();
    try {
      const before = await readFile(path.join(repo, 'schematic.intent.json'), 'utf8');
      const schBefore = await readFile(path.join(repo, 'board.kicad_sch'), 'utf8');
      const ctx = await makeCtx(repo);
      const out = await dispatchTool(ctx, 'draft_schematic', { intent_json: '{"version": 1,' });
      expect(out).toContain('intent_json is not valid JSON');
      expect(await readFile(path.join(repo, 'schematic.intent.json'), 'utf8')).toBe(before);
      expect(await readFile(path.join(repo, 'board.kicad_sch'), 'utf8')).toBe(schBefore);
    } finally {
      await cleanup();
    }
  }, 60000);
});

describe('check_legibility without a schematic', () => {
  // Mirrors check_drift's vacuous path: nothing can be illegible, and a stuck
  // obligation here would deadlock any stage that edited a stray .kicad_sch
  // before config wiring. This is the path that clears the ledger.
  it('clears the legibility obligation instead of deadlocking', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-nosch-'));
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ docs: 'docs/', origin: 'create' }),
        'utf8',
      );
      const ctx = await makeCtx(repo);
      ctx.ledger.add('legibility', 'schematic changed; run check_legibility', 'edit_file');
      expect(ctx.ledger.openOfKind('legibility')).toHaveLength(1);
      const out = await dispatchTool(ctx, 'check_legibility', {});
      expect(out).toContain('legibility does not apply yet');
      expect(ctx.ledger.openOfKind('legibility')).toHaveLength(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
