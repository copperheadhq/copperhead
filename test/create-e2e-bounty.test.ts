import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import type { RunOptions, RunResult } from '../src/agent/loop.js';

const mockRunAgentLoop = vi.hoisted(() => vi.fn<(opts: RunOptions) => Promise<RunResult>>());
const mockDiagnose = vi.hoisted(() => vi.fn());
const mockRunErc = vi.hoisted(() => vi.fn());
const mockListSymbols = vi.hoisted(() => vi.fn());
const mockCheckDrift = vi.hoisted(() => vi.fn());
const mockRunCheck = vi.hoisted(() => vi.fn());
const mockExportSvg = vi.hoisted(() => vi.fn());
const mockEmitCreateJlcpcbBom = vi.hoisted(() => vi.fn());

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runAgentLoop: mockRunAgentLoop,
}));

vi.mock('../src/agent/recovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  diagnoseStageFailure: mockDiagnose,
  transcriptExcerpt: async () => '',
}));

vi.mock('../src/openspec/cli.js', () => ({
  openspecInit: async () => ({ ok: true, output: '' }),
}));

vi.mock('../src/commands/check.js', () => ({
  runCheck: mockRunCheck,
}));

vi.mock('../src/kicad/cli.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runErc: mockRunErc,
  exportSvg: mockExportSvg,
}));

vi.mock('../src/kicad/sexp.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listSymbols: mockListSymbols,
}));

vi.mock('../src/memory/drift.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  checkDrift: mockCheckDrift,
}));

vi.mock('../src/commands/export.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  emitCreateJlcpcbBom: mockEmitCreateJlcpcbBom,
}));

import { loadConfig } from '../src/config.js';
import { runCreate, STAGES } from '../src/commands/create.js';

const STAGE_NAMES = STAGES.map((stage) => stage.name);
const DOCS_DIR = 'docs';
let previousOpenAiKey: string | undefined;

function okResult(transcriptDir: string, turnsUsed = 2, tokensOut = 160): RunResult {
  return {
    outcome: 'success',
    exitPath: 'done',
    summary: 'mock stage complete',
    transcriptDir,
    filesTouched: [],
    commit: null,
    stats: {
      exitPath: 'done',
      turnsUsed,
      maxTurns: 40,
      repairCyclesUsed: 0,
      maxRepairCycles: 5,
      tokensIn: 800,
      tokensOut,
      perTurn: [],
      durationMs: 1200,
    },
    cacheHits: 0,
  };
}

async function tempCreateRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-e2e-'));
  await writeFile(path.join(repo, '.gitignore'), '.env\n.copperhead/runs/\n', 'utf8');
  await writeFile(path.join(repo, 'brief.md'), '# USB-C Power Breakout\n\nA tiny USB-C power breakout board.\n', 'utf8');
  await execa('git', ['init', '-q'], { cwd: repo });
  await execa('git', ['config', 'user.email', 'test@copperhead.local'], { cwd: repo });
  await execa('git', ['config', 'user.name', 'copperhead-test'], { cwd: repo });
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

async function stageRunDir(repo: string, stageName: string, attempt = 1): Promise<string> {
  const dir = path.join(repo, '.copperhead', 'runs', `${stageName}-attempt-${attempt}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function commitRepo(repo: string, message: string): Promise<void> {
  await execa('git', ['add', '-A'], { cwd: repo });
  const status = (await execa('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim();
  if (!status) return;
  await execa('git', ['commit', '-q', '-m', message], { cwd: repo });
}

async function gitHead(repo: string): Promise<string> {
  return (await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
}

async function gitNewCommitSubjects(repo: string, startHead: string): Promise<string[]> {
  const stdout = (await execa('git', ['log', '--format=%s', `${startHead}..HEAD`], { cwd: repo })).stdout.trim();
  return stdout ? stdout.split('\n') : [];
}

async function gitStatus(repo: string): Promise<string> {
  return (await execa('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim();
}

async function ensureDocs(repo: string): Promise<string> {
  const docs = path.join(repo, DOCS_DIR);
  await mkdir(docs, { recursive: true });
  return docs;
}

async function appendUnique(filePath: string, marker: string): Promise<void> {
  let text = '';
  try {
    text = await readFile(filePath, 'utf8');
  } catch {
    // created below
  }
  if (!text.includes(marker)) {
    await writeFile(filePath, `${text}${text.endsWith('\n') || text.length === 0 ? '' : '\n'}${marker}\n`, 'utf8');
  }
}

async function writeStageArtifacts(repo: string, stageName: string): Promise<void> {
  const docs = await ensureDocs(repo);
  if (stageName === 'spec-seed') {
    await writeFile(
      path.join(docs, 'SPEC.md'),
      '# USB-C breakout\n\n## Budgets\n\n- sleep_current_uA: 25\n- peak_current_mA: 500\n',
      'utf8',
    );
    return;
  }

  if (stageName === 'architecture') {
    await writeFile(
      path.join(docs, 'SUBSYSTEMS.md'),
      '# Subsystems\n\n## Power\n\nUSB-C input, ESD, and a simple breakout path.\n',
      'utf8',
    );
    return;
  }

  if (stageName === 'part-selection') {
    await writeFile(
      path.join(docs, 'BOM.md'),
      '# Bill of Materials\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| J1 | USB-C | USB_C_Receptacle | TYPE-C-31-M-12 | USB-C receptacle |\n| R1 | 5.1k | R_0603 | RC0603FR-075K1L | CC pull-down |\n',
      'utf8',
    );
    return;
  }

  const config = await loadConfig(repo);

  if (stageName === 'schematic') {
    if (!config.schematic) throw new Error('schematic path missing after bootstrap');
    await appendUnique(path.join(repo, config.schematic), 'SYMBOLS_READY');
    await writeFile(
      path.join(docs, 'PINOUT.md'),
      '# Pinout\n\n## USB-C\n\n- CC1 -> R1\n- CC2 -> R2\n',
      'utf8',
    );
    return;
  }

  if (stageName === 'layout-draft') {
    if (!config.board) throw new Error('board path missing after bootstrap');
    await appendUnique(path.join(repo, config.board), '(footprint "F1")');
    await writeFile(
      path.join(docs, 'LAYOUT.md'),
      '# Layout\n\n## Draft quality\n\nConnectors on edges, ESD near connector, power short and clean.\n',
      'utf8',
    );
    return;
  }

  if (stageName === 'outputs') {
    const outputs = path.join(repo, 'outputs');
    await mkdir(outputs, { recursive: true });
    await writeFile(path.join(outputs, 'board.gtl'), 'gerber\n', 'utf8');
    return;
  }

  if (stageName === 'firmware') {
    const firmware = path.join(repo, 'firmware');
    await mkdir(firmware, { recursive: true });
    await writeFile(path.join(firmware, 'main.c'), 'int main(void) { return 0; }\n', 'utf8');
    return;
  }

  if (stageName === 'devplan') {
    await writeFile(
      path.join(docs, 'DEVPLAN.md'),
      '# Bring-up\n\n## First power-on\n\nCheck VBUS, then confirm CC resistors and connector orientation.\n',
      'utf8',
    );
  }
}

function stageNameFromRequest(request: string): string {
  const match = request.match(/^create pipeline stage:\s+(.+)$/);
  if (!match) throw new Error(`Unexpected stage request: ${request}`);
  return match[1]!;
}

beforeEach(() => {
  mockRunAgentLoop.mockReset();
  mockDiagnose.mockReset();
  mockRunErc.mockReset();
  mockListSymbols.mockReset();
  mockCheckDrift.mockReset();
  mockRunCheck.mockReset();
  mockExportSvg.mockReset();
  mockEmitCreateJlcpcbBom.mockReset();
  previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-dummy';

  mockDiagnose.mockResolvedValue({ verdict: 'abort', reason: 'stop after failed contract' });
  mockRunCheck.mockResolvedValue({ ok: true });
  mockListSymbols.mockImplementation(async (filePath: string) => {
    const text = await readFile(filePath, 'utf8');
    return text.includes('SYMBOLS_READY') ? ['U1'] : [];
  });
  mockRunErc.mockImplementation(async (filePath: string) => {
    const text = await readFile(filePath, 'utf8');
    const failing = text.includes('FORCE_ERC_FAIL') || !text.includes('SYMBOLS_READY');
    return {
      ok: !failing,
      source: 'erc',
      violations: failing
        ? [{ severity: 'error', type: 'erc', description: 'mock ERC failure', items: [] }]
        : [],
    };
  });
  mockCheckDrift.mockImplementation(async (repoRoot: string, docs: string, schematicRel: string) => {
    const schematic = await readFile(path.join(repoRoot, schematicRel), 'utf8');
    const pinoutPath = path.join(repoRoot, docs, 'PINOUT.md');
    try {
      const pinout = await readFile(pinoutPath, 'utf8');
      return schematic.includes('SYMBOLS_READY') && pinout.includes('## USB-C') ? [] : ['drift mismatch'];
    } catch {
      return ['drift mismatch'];
    }
  });
  mockExportSvg.mockImplementation(async (kind: 'sch' | 'pcb', _filePath: string, outDir: string) => {
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, `${kind}.svg`), `<svg>${kind}</svg>\n`, 'utf8');
  });
  mockEmitCreateJlcpcbBom.mockImplementation(async (repoRoot: string) => {
    const out = path.join(repoRoot, 'outputs', 'jlcpcb-bom.csv');
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, 'Comment,Designator,Footprint,LCSC Part #\n', 'utf8');
    return out;
  });
});

afterEach(() => {
  if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAiKey;
});

describe('create pipeline bounty coverage', () => {
  it('drives a clean eight-stage run and commits each stage independently', async () => {
    const { repo, cleanup } = await tempCreateRepo();
    try {
      const startHead = await gitHead(repo);
      const attempts = new Map<string, number>();

      mockRunAgentLoop.mockImplementation(async (opts) => {
        const stageName = stageNameFromRequest(opts.request);
        const attempt = (attempts.get(stageName) ?? 0) + 1;
        attempts.set(stageName, attempt);
        await writeStageArtifacts(opts.repoRoot, stageName);
        await commitRepo(opts.repoRoot, `copperhead: create stage ${stageName}`);
        return okResult(await stageRunDir(opts.repoRoot, stageName, attempt));
      });

      const res = await runCreate({
        repoRoot: repo,
        briefPath: path.join(repo, 'brief.md'),
        model: 'gpt-5',
        log: () => {},
      });

      expect(res.ok).toBe(true);
      expect(res.completed).toEqual(STAGE_NAMES);

      const commits = await gitNewCommitSubjects(repo, startHead);
      expect(commits).toHaveLength(STAGE_NAMES.length);
      for (const stageName of STAGE_NAMES) {
        expect(commits.some((subject) => subject.includes(stageName))).toBe(true);
      }

      const report = await readFile(path.join(repo, '.copperhead', 'runs', 'REPORT.md'), 'utf8');
      expect(report).toContain('Per-stage cost of the create pipeline');
      expect(report).toContain('**Total**');

      const artifacts = path.join(repo, '.copperhead', 'runs', 'outputs-attempt-1', 'artifacts');
      expect(await readFile(path.join(artifacts, 'sch.svg'), 'utf8')).toContain('<svg>');
      expect(await readFile(path.join(repo, 'outputs', 'jlcpcb-bom.csv'), 'utf8')).toContain('Designator');
    } finally {
      await cleanup();
    }
  });

  it('fails loudly on a wedged stage after exhausting retries', async () => {
    const { repo, cleanup } = await tempCreateRepo();
    try {
      const logs: string[] = [];

      mockRunAgentLoop.mockImplementation(async (opts) => {
        const stageName = stageNameFromRequest(opts.request);
        if (stageName === 'spec-seed') {
          await writeStageArtifacts(opts.repoRoot, stageName);
          await commitRepo(opts.repoRoot, `copperhead: create stage ${stageName}`);
          return okResult(await stageRunDir(opts.repoRoot, stageName, 1));
        }
        return okResult(await stageRunDir(opts.repoRoot, stageName, 1), 1, 40);
      });
      mockDiagnose
        .mockResolvedValueOnce({ verdict: 'retry', reason: 'try again with tighter prompt', guidance: 'GUIDANCE-1' })
        .mockResolvedValueOnce({ verdict: 'retry', reason: 'one more retry', guidance: 'GUIDANCE-2' });

      const res = await runCreate({
        repoRoot: repo,
        briefPath: path.join(repo, 'brief.md'),
        model: 'gpt-5',
        log: (line) => logs.push(line),
      });

      expect(res.ok).toBe(false);
      expect(res.completed).toEqual(['spec-seed']);
      expect(logs.join('\n')).toContain('exhausted 2 auto-retry(ies)');

      const architectureCalls = mockRunAgentLoop.mock.calls
        .map(([opts]) => opts)
        .filter((opts) => opts.request === 'create pipeline stage: architecture');
      expect(architectureCalls).toHaveLength(3);
      expect(architectureCalls[1]!.stagePrompt).toContain('GUIDANCE-1');
      expect(architectureCalls[2]!.stagePrompt).toContain('GUIDANCE-2');
    } finally {
      await cleanup();
    }
  });

  it('rejects an ERC-failing schematic even when symbols and docs look complete', async () => {
    const { repo, cleanup } = await tempCreateRepo();
    try {
      const startHead = await gitHead(repo);
      const logs: string[] = [];

      mockRunAgentLoop.mockImplementation(async (opts) => {
        const stageName = stageNameFromRequest(opts.request);
        if (['spec-seed', 'architecture', 'part-selection'].includes(stageName)) {
          await writeStageArtifacts(opts.repoRoot, stageName);
          await commitRepo(opts.repoRoot, `copperhead: create stage ${stageName}`);
        } else if (stageName === 'schematic') {
          await writeStageArtifacts(opts.repoRoot, stageName);
          const config = await loadConfig(opts.repoRoot);
          if (!config.schematic) throw new Error('schematic path missing after bootstrap');
          await appendUnique(path.join(opts.repoRoot, config.schematic), 'FORCE_ERC_FAIL');
        }
        return okResult(await stageRunDir(opts.repoRoot, stageName, 1));
      });

      const res = await runCreate({
        repoRoot: repo,
        briefPath: path.join(repo, 'brief.md'),
        model: 'gpt-5',
        log: (line) => logs.push(line),
      });

      expect(res.ok).toBe(false);
      expect(res.completed).toEqual(['spec-seed', 'architecture', 'part-selection']);
      expect(logs.join('\n')).toContain('completion contract is not met');

      const commits = await gitNewCommitSubjects(repo, startHead);
      expect(commits).toHaveLength(3);
      const status = await gitStatus(repo);
      expect(status).toContain('usb-c-power-breakout.kicad_sch');
      expect(status).toContain('docs/PINOUT.md');
      expect(status).not.toContain('docs/SPEC.md');
      expect(status).not.toContain('docs/SUBSYSTEMS.md');
      expect(status).not.toContain('docs/BOM.md');
    } finally {
      await cleanup();
    }
  });

  it('returns a failed overall result when final DRC-style verification fails', async () => {
    const { repo, cleanup } = await tempCreateRepo();
    try {
      const startHead = await gitHead(repo);

      mockRunAgentLoop.mockImplementation(async (opts) => {
        const stageName = stageNameFromRequest(opts.request);
        await writeStageArtifacts(opts.repoRoot, stageName);
        await commitRepo(opts.repoRoot, `copperhead: create stage ${stageName}`);
        return okResult(await stageRunDir(opts.repoRoot, stageName, 1));
      });
      mockRunCheck.mockResolvedValueOnce({
        ok: false,
        errors: [{ source: 'drc', message: 'mock DRC failure' }],
      });

      const res = await runCreate({
        repoRoot: repo,
        briefPath: path.join(repo, 'brief.md'),
        model: 'gpt-5',
        log: () => {},
      });

      expect(res.ok).toBe(false);
      expect(res.completed).toEqual(STAGE_NAMES);
      expect(await gitStatus(repo)).toBe('');

      const commits = await gitNewCommitSubjects(repo, startHead);
      expect(commits).toHaveLength(STAGE_NAMES.length);
      expect(commits.some((subject) => subject.includes('devplan'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('stops before the final stage, reports the resume command, and resumes by running only devplan', async () => {
    const { repo, cleanup } = await tempCreateRepo();
    try {
      const startHead = await gitHead(repo);
      const firstLogs: string[] = [];

      mockRunAgentLoop.mockImplementation(async (opts) => {
        const stageName = stageNameFromRequest(opts.request);
        if (stageName !== 'devplan') {
          await writeStageArtifacts(opts.repoRoot, stageName);
          await commitRepo(opts.repoRoot, `copperhead: create stage ${stageName}`);
        }
        return okResult(await stageRunDir(opts.repoRoot, stageName, 1));
      });

      const first = await runCreate({
        repoRoot: repo,
        briefPath: path.join(repo, 'brief.md'),
        model: 'gpt-5',
        log: (line) => firstLogs.push(line),
      });

      expect(first.ok).toBe(false);
      expect(first.completed).toEqual(STAGE_NAMES.slice(0, -1));
      const output = firstLogs.join('\n');
      expect(output).toContain('To resume from here, run:');
      expect(output).toContain('create --brief');
      expect(output).toContain('devplan');

      const preResumeCommits = await gitNewCommitSubjects(repo, startHead);
      expect(preResumeCommits).toHaveLength(7);
      expect(await gitStatus(repo)).toBe('');

      mockRunAgentLoop.mockReset();
      const resumeStages: string[] = [];
      mockRunAgentLoop.mockImplementation(async (opts) => {
        const stageName = stageNameFromRequest(opts.request);
        resumeStages.push(stageName);
        await writeStageArtifacts(opts.repoRoot, stageName);
        await commitRepo(opts.repoRoot, `copperhead: create stage ${stageName}`);
        return okResult(await stageRunDir(opts.repoRoot, stageName, 1));
      });

      const resumeLogs: string[] = [];
      const resumed = await runCreate({
        repoRoot: repo,
        briefPath: path.join(repo, 'brief.md'),
        model: 'gpt-5',
        log: (line) => resumeLogs.push(line),
      });

      expect(resumed.ok).toBe(true);
      expect(resumed.completed).toEqual(STAGE_NAMES);
      expect(resumeStages).toEqual(['devplan']);
      expect(resumeLogs.join('\n')).toContain('already complete (resuming past it)');

      const commits = await gitNewCommitSubjects(repo, startHead);
      expect(commits).toHaveLength(STAGE_NAMES.length);
      expect(commits[0]).toContain('devplan');
      expect(await gitStatus(repo)).toBe('');
    } finally {
      await cleanup();
    }
  });
});
