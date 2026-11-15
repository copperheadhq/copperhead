import { writeFile, mkdir } from '../src/util/worktree-ownership.js';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { RunOptions, RunResult } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';
import { renderManifest } from '../src/kicad/parts/render.js';
import { parseManifest } from '../src/kicad/parts/manifest.js';

// structured-part-selection, create-pipeline delta: stage 3 completes on the
// validator's verdict, the finish gate speaks the same gap in-run, and the
// contract-gap message names the refdes. Scripted agent loop, fixture
// symbols, fixture stock footprints.

const mockRunAgentLoop = vi.hoisted(() => vi.fn<(opts: RunOptions) => Promise<RunResult>>());
const mockDiagnose = vi.hoisted(() => vi.fn());
vi.mock('../src/agent/loop.js', async (importOriginal) => ({ ...(await importOriginal<object>()), runAgentLoop: mockRunAgentLoop }));
vi.mock('../src/agent/recovery.js', async (importOriginal) => ({ ...(await importOriginal<object>()), diagnoseStageFailure: mockDiagnose, transcriptExcerpt: async () => '' }));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit: async () => ({ ok: true, output: '' }) }));
vi.mock('../src/commands/check.js', () => ({ runCheck: async () => ({ ok: true }) }));

import { runCreate, STAGES, contractGapDetail } from '../src/commands/create.js';
import { loadConfig } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');
const DOCS = 'docs';

function mod(name: string, pads: string[]): string {
  return `(footprint "${name}" (version 20240108) (generator "test") (layer "F.Cu")\n${pads.map((p) => `  (pad "${p}" smd rect (at 0 0) (size 1 1) (layers "F.Cu"))`).join('\n')}\n)\n`;
}
function ok(): RunResult {
  return { outcome: 'success', exitPath: 'done', summary: 'mock', transcriptDir: '', filesTouched: [], commit: null, cacheHits: 0,
    stats: { exitPath: 'done', turnsUsed: 1, maxTurns: 40, repairCyclesUsed: 0, maxRepairCycles: 5, tokensIn: 10, tokensOut: 10, perTurn: [], durationMs: 1 } };
}

const CLEAN = {
  version: 1,
  parts: [
    { ref: 'U1', value: 'MCU8', libId: 'CopperMCU:MCU8', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', mpn: 'MCU8-SOIC', group: 'MCU', rationale: 'controller' },
    { ref: 'R1', value: '10k', package: '0603', group: 'Power' },
    { ref: 'BT1', value: '500mAh Li-Po', mpn: 'LP503035', offBoard: true, group: 'Power' },
  ],
};
const SLIP = { ...CLEAN, parts: [{ ...CLEAN.parts[0], footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.37mm' }, ...CLEAN.parts.slice(1)] };
const UNINSTALLED = { ...CLEAN, parts: [{ ...CLEAN.parts[0], footprint: 'Vendor_QFN:QFN-8_Special' }, ...CLEAN.parts.slice(1)] };
const render = (m: object): string => renderManifest(parseManifest(JSON.stringify(m)).manifest!);

let stock: string;
let kicadCfg: string;
beforeAll(async () => {
  stock = await mkdtemp(path.join(tmpdir(), 'copperhead-stage-stock-'));
  await mkdir(path.join(stock, 'Resistor_SMD.pretty'), { recursive: true });
  await writeFile(path.join(stock, 'Resistor_SMD.pretty', 'R_0603_1608Metric.kicad_mod'), mod('R_0603_1608Metric', ['1', '2']));
  await mkdir(path.join(stock, 'Package_SO.pretty'), { recursive: true });
  await writeFile(path.join(stock, 'Package_SO.pretty', 'SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod'), mod('SOIC-8_3.9x4.9mm_P1.27mm', ['1', '2', '3', '4', '5', '6', '7', '8']));
  kicadCfg = await mkdtemp(path.join(tmpdir(), 'copperhead-stage-cfg-'));
  vi.stubEnv('KICAD_SYMBOL_DIR', SYMLIB);
  vi.stubEnv('KICAD_FOOTPRINT_DIR', stock);
  vi.stubEnv('KICAD_CONFIG_HOME', kicadCfg);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(stock, { recursive: true, force: true });
  await rm(kicadCfg, { recursive: true, force: true });
});

async function tmpRepo(files: Record<string, string>): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'copperhead-stage-'));
  await mkdir(path.join(root, DOCS), { recursive: true });
  await writeFile(path.join(root, DOCS, 'SUBSYSTEMS.md'), '# Subsystems\n\n## Power\n\nrail\n\n## MCU\n\ncore\n');
  for (const [rel, text] of Object.entries(files)) await writeFile(path.join(root, rel), text);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}
const isComplete = STAGES.find((s) => s.name === 'part-selection')!.isComplete;
const prompt = STAGES.find((s) => s.name === 'part-selection')!.prompt('brief', DOCS);

describe('part-selection isComplete with a manifest', () => {
  it('is complete when the manifest validates clean and BOM.md is its render', async () => {
    const r = await tmpRepo({ 'docs/parts.intent.json': JSON.stringify(CLEAN), 'docs/BOM.md': render(CLEAN) });
    try { expect(await isComplete(r.root, DOCS)).toBe(true); } finally { await r.cleanup(); }
  });
  it('is not complete while BOM.md is stale or absent', async () => {
    const stale = await tmpRepo({ 'docs/parts.intent.json': JSON.stringify(CLEAN), 'docs/BOM.md': render(CLEAN).replace('| R1 | 10k |', '| R1 | 4k7 |') });
    try { expect(await isComplete(stale.root, DOCS)).toBe(false); } finally { await stale.cleanup(); }
    const absent = await tmpRepo({ 'docs/parts.intent.json': JSON.stringify(CLEAN) });
    try { expect(await isComplete(absent.root, DOCS)).toBe(false); } finally { await absent.cleanup(); }
  });
  it('is not complete on a model-fixable footprint slip, even with a rendered BOM.md', async () => {
    const r = await tmpRepo({ 'docs/parts.intent.json': JSON.stringify(SLIP), 'docs/BOM.md': render(SLIP) });
    try { expect(await isComplete(r.root, DOCS)).toBe(false); } finally { await r.cleanup(); }
  });
  it('is complete with an uninstalled library (the user stop, not the model gap)', async () => {
    const r = await tmpRepo({ 'docs/parts.intent.json': JSON.stringify(UNINSTALLED), 'docs/BOM.md': render(UNINSTALLED) });
    try { expect(await isComplete(r.root, DOCS)).toBe(true); } finally { await r.cleanup(); }
  });
  it('never reads the MPN column: every MPN unverified still completes', async () => {
    const m = { ...CLEAN, parts: CLEAN.parts.map((p) => ({ ...p, verified: false })) };
    const r = await tmpRepo({ 'docs/parts.intent.json': JSON.stringify(m), 'docs/BOM.md': render(m) });
    try {
      expect(render(m)).toMatch(/MCU8-SOIC \(UNVERIFIED\)/);
      expect(await isComplete(r.root, DOCS)).toBe(true);
    } finally { await r.cleanup(); }
  });
});

describe('an empty parts manifest (AC-19.13)', () => {
  const EMPTY = { version: 1, parts: [] };
  it('does not complete the stage even though the header-only BOM.md is its render', async () => {
    const r = await tmpRepo({ 'docs/parts.intent.json': JSON.stringify(EMPTY), 'docs/BOM.md': render(EMPTY) });
    try {
      expect(await isComplete(r.root, DOCS)).toBe(false);
      expect(await contractGapDetail('part-selection', r.root, await loadConfig(r.root))).toMatch(/the manifest lists no parts/);
    } finally { await r.cleanup(); }
  });
});

describe('part-selection isComplete without a manifest (resume of an older run)', () => {
  const BOM = (fp: string) => `# BOM\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | ${fp} | UNVERIFIED | bias |\n`;
  it('completes on footprints alone, whatever the MPN column says', async () => {
    const r = await tmpRepo({ 'docs/BOM.md': BOM('Resistor_SMD:R_0603_1608Metric') });
    try { expect(await isComplete(r.root, DOCS)).toBe(true); } finally { await r.cleanup(); }
  });
  it('is not complete on a bad id or an empty table', async () => {
    const bad = await tmpRepo({ 'docs/BOM.md': BOM('R_0603') });
    try { expect(await isComplete(bad.root, DOCS)).toBe(false); } finally { await bad.cleanup(); }
    const empty = await tmpRepo({ 'docs/BOM.md': '# BOM\n\nnothing yet\n' });
    try { expect(await isComplete(empty.root, DOCS)).toBe(false); } finally { await empty.cleanup(); }
  });
});

describe('part-selection contractGapDetail', () => {
  it('names the refdes and the installed id for a manifest finding', async () => {
    const r = await tmpRepo({ 'docs/parts.intent.json': JSON.stringify(SLIP) });
    try {
      const d = await contractGapDetail('part-selection', r.root, await loadConfig(r.root));
      expect(d).toMatch(/^the part-selection contract is not met: docs\/parts.intent.json: 1 finding\(s\)/);
      expect(d).toContain('U1: footprint "Package_SO:SOIC-8_3.9x4.9mm_P1.37mm" is not in library "Package_SO"; installed: Package_SO:SOIC-8_3.9x4.9mm_P1.27mm');
    } finally { await r.cleanup(); }
  });
  it('says to render when the manifest is clean but BOM.md is not its render', async () => {
    const r = await tmpRepo({ 'docs/parts.intent.json': JSON.stringify(CLEAN) });
    try {
      expect(await contractGapDetail('part-selection', r.root, await loadConfig(r.root))).toMatch(/BOM.md is not the render of docs\/parts.intent.json; call draft_bom/);
    } finally { await r.cleanup(); }
  });
  it('is specific with neither a manifest nor a BOM table', async () => {
    const r = await tmpRepo({});
    try {
      expect(await contractGapDetail('part-selection', r.root, await loadConfig(r.root))).toMatch(/no docs\/parts.intent.json and no BOM.md table/);
    } finally { await r.cleanup(); }
  });
});

describe('part-selection prompt contract', () => {
  it('states the task and the manifest, not the table format or per-part probing', () => {
    expect(prompt).toContain('parts.intent.json');
    expect(prompt).toContain('draft_bom');
    expect(prompt).toContain('"offBoard": true');
    expect(prompt).toContain('"substitutions"');
    expect(prompt).not.toContain('| Refdes | Value | Footprint | MPN | Rationale |');
    expect(prompt).not.toMatch(/run search_symbols for every/);
    expect(prompt).not.toMatch(/call check_footprints on every/);
  });
});

describe('part-selection finish gate', () => {
  let prevKey: string | undefined;
  beforeEach(() => {
    mockRunAgentLoop.mockReset();
    mockDiagnose.mockReset();
    mockDiagnose.mockResolvedValue({ verdict: 'abort', reason: 'stop' });
    prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-dummy';
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  });

  it('refuses finish until the manifest validates and BOM.md is rendered, naming the gap', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# tiny\n', 'utf8');
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      let gate: (() => Promise<string | null>) | undefined;
      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.request.includes('spec-seed')) await writeFile(path.join(docs, 'SPEC.md'), '# s\n\n## Budgets\n\n- sleep_current_uA: 25\n');
        else if (opts.request.includes('architecture')) await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# s\n\n## Power\n\nrail\n\n## MCU\n\ncore\n');
        else if (opts.request.includes('part-selection')) gate = opts.stageGate;
        return ok();
      });
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      expect(gate).toBeTypeOf('function');
      // no manifest: the gate says what to write
      expect(await gate!()).toMatch(/no docs\/parts.intent.json — write the parts manifest and call draft_bom/);
      // a slip: the gate names the refdes and the installed id
      await writeFile(path.join(docs, 'parts.intent.json'), JSON.stringify(SLIP));
      expect(await gate!()).toMatch(/U1: footprint .* installed: Package_SO:SOIC-8_3.9x4.9mm_P1.27mm/);
      // clean manifest, BOM.md not rendered yet
      await writeFile(path.join(docs, 'parts.intent.json'), JSON.stringify(CLEAN));
      expect(await gate!()).toMatch(/call draft_bom to render it/);
      // rendered: the gate is satisfied
      await writeFile(path.join(docs, 'BOM.md'), render(CLEAN));
      expect(await gate!()).toBeNull();
    } finally {
      await cleanup();
    }
  }, 60000);
});

describe('part-selection end to end through the pipeline (AC-19.3, AC-19.6)', () => {
  let prevKey: string | undefined;
  beforeEach(() => {
    mockRunAgentLoop.mockReset();
    mockDiagnose.mockReset();
    mockDiagnose.mockResolvedValue({ verdict: 'abort', reason: 'stop' });
    prevKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-dummy';
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  });

  it('refuses finish on the slip, completes after the fix, and hands stage 4 the recorded lib_ids', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# tiny\n', 'utf8');
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      const gateAnswers: (string | null)[] = [];
      let schematicPrompt = '';
      mockRunAgentLoop.mockImplementation(async (opts) => {
        if (opts.request.includes('spec-seed')) await writeFile(path.join(docs, 'SPEC.md'), '# s\n\n## Budgets\n\n- sleep_current_uA: 25\n');
        else if (opts.request.includes('architecture')) await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# s\n\n## Power\n\nrail\n\n## MCU\n\ncore\n');
        else if (opts.request.includes('part-selection')) {
          // the scripted agent: a first manifest with a slipped footprint, finish refused; the fix, finish accepted
          await writeFile(path.join(docs, 'parts.intent.json'), JSON.stringify(SLIP));
          gateAnswers.push(await opts.stageGate!());
          await writeFile(path.join(docs, 'parts.intent.json'), JSON.stringify(CLEAN));
          await writeFile(path.join(docs, 'BOM.md'), render(CLEAN));
          gateAnswers.push(await opts.stageGate!());
        } else if (opts.request.includes('schematic')) schematicPrompt = opts.stagePrompt ?? '';
        return ok();
      });
      await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: () => {} });
      expect(gateAnswers[0]).toMatch(/U1: footprint .* installed: Package_SO:SOIC-8_3.9x4.9mm_P1.27mm/);
      expect(gateAnswers[1]).toBeNull();
      const stages = mockRunAgentLoop.mock.calls.map(([o]) => o.request.replace('create pipeline stage: ', ''));
      expect(stages.slice(0, 4)).toEqual(['spec-seed', 'architecture', 'part-selection', 'schematic']); // stage 3 completed on the first attempt
      // BOM.md on disk is the render, and stage 4 entered with the manifest's exact symbol in its dossier
      expect(await readFile(path.join(docs, 'BOM.md'), 'utf8')).toBe(render(CLEAN));
      expect(schematicPrompt).toContain('- U1 (MCU8-SOIC): CopperMCU:MCU8 — 8 pin(s):');
      expect(schematicPrompt).not.toMatch(/\bBT1\b.*pin\(s\)/);
    } finally {
      await cleanup();
    }
  }, 90000);
});
