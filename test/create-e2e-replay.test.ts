/**
 * Deterministic end-to-end replay of a recorded `copperhead create` run.
 *
 * `test/fixtures/create-e2e/` holds a full response cache captured from a real
 * medium-complexity run (all 8 stages, live local model). Replaying it in-
 * process exercises the whole pipeline — stage prompts, tool execution, ERC/DRC
 * gates, drift checks, commits — with zero live provider calls:
 *
 * - `llmCache` keys on {model, baseURL, messages, tool names}. The fixture is
 *   replayed with the recorded model id and baseURL (`http://127.0.0.1:11435`),
 *   a loopback port nothing listens on. A cache hit replays the recorded turn;
 *   ANY miss (prompt drift, tool-result drift, code change altering prompts)
 *   hits the dead endpoint and fails loudly instead of silently skipping.
 * - `Date` is frozen to the recording date: docs embed date-stamped entries
 *   (CHANGELOG) that feed back into the next stage's system prompt.
 * - HOME points at a fixture dir holding the fp-lib-table the run recorded
 *   against (ERC footprint checks consult it); KICAD_SYMBOL_DIR pins the
 *   recorded library set (symbols.txt names the libs, copied from the local
 *   KiCad install) so search_symbols/symbol_pins/dossier results match.
 * - The repo runs at a fixed absolute path because tool error strings (ENOENT)
 *   embed absolute paths into the recorded message stream. The paths are
 *   named `ch-e2e-*`, NOT `copperhead-*`: the I8 startup sweep
 *   (sweepStaleTempDirs) deletes every `copperhead-*` entry in tmpdir and the
 *   tmp-sweep tests exercise it with a synthetic future clock — anything in
 *   its way is deleted mid-suite.
 *
 * Gated behind COPPERHEAD_E2E_REPLAY=1: needs kicad-cli + footprints +
 * openspec CLI (see manifest.json for pinned versions) and writes fixed /tmp
 * paths. To re-record: see `test/fixtures/create-e2e/README.md`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, readdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execa } from 'execa';
import { runCreate, STAGES } from '../src/commands/create.js';
import { bootstrapKicadProject } from '../src/kicad/bootstrap.js';
import { runErc } from '../src/kicad/cli.js';
import { tempFixtureRepo } from './helpers.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'create-e2e');
// Fixed paths: recorded tool-error strings embed these absolute paths into
// message text, so the replay repo must live at the same location. They must
// not match src/util/tmp.ts's TEMP_PREFIX ('copperhead-') — see module comment.
const REPO = '/tmp/ch-e2e-repo';
const REPLAY_HOME = '/tmp/ch-e2e-home';
const REPLAY_SYMS = '/tmp/ch-e2e-symbols';
// The recorded run pinned KICAD_SYMBOL_DIR at a 121-lib subset of the system
// library; the fixture ships just the file names (symbols.txt) and the replay
// copies them from the machine's own KiCad install (same contents — kicad-cli
// version is pinned).
const SYSTEM_SYMS = '/usr/share/kicad/symbols';

interface Manifest {
  recordedAt: string; // ISO date the cache was recorded (Date is frozen to it)
  model: string;
  baseURL: string;
  kicadCliVersion: string;
  openspecVersion: string;
  /** stages that committed during the recording, in order (8 for a full run). */
  expectedStages: string[];
  /** recorded result of the run itself — false when recording stopped early. */
  expectedOk: boolean;
  stageCommitSubjects: string[];
  /** stage whose cache keys are dropped to simulate a wedge (usually the last recorded stage). */
  wedgedStage: string;
  lastStageKeys: string[];
}

const RUN = process.env.COPPERHEAD_E2E_REPLAY === '1' && process.platform === 'linux';

async function cmdStdout(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execa(cmd, args);
  return stdout.trim();
}

/** Refuse the replay if the recorded baseURL is actually reachable: any cache
 * miss must fail, never silently spend tokens on a live model. */
async function assertDeadEndpoint(baseURL: string): Promise<void> {
  const port = Number(new URL(baseURL).port);
  const reachable = await new Promise<boolean>((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
    sock.setTimeout(2000, () => {
      sock.destroy();
      resolve(false);
    });
  });
  if (reachable) {
    throw new Error(
      `e2e replay requires the recorded baseURL ${baseURL} to be dead — ` +
        `something is listening on port ${port}. Stop it so a cache miss fails loudly.`,
    );
  }
}

async function git(repo: string, ...args: string[]): Promise<string> {
  return cmdStdout('git', ['-C', repo, ...args]);
}

/** Rebuild the recorded repo + environment at the fixed replay paths. */
async function setupReplayEnv(manifest: Manifest, dropKeys: Set<string>): Promise<void> {
  await rm(REPO, { recursive: true, force: true });
  await rm(REPLAY_HOME, { recursive: true, force: true });
  await rm(REPLAY_SYMS, { recursive: true, force: true });

  await mkdir(path.join(REPO, '.copperhead'), { recursive: true });
  await cp(path.join(FIXTURE, 'brief.md'), path.join(REPO, 'brief.md'));
  await cp(path.join(FIXTURE, 'config.json'), path.join(REPO, '.copperhead', 'config.json'));
  await writeFile(path.join(REPO, '.gitignore'), '.env\n.copperhead/runs/\n', 'utf8');
  // openspec/ ships pre-initialised: it was created by openspecInit before the
  // first recorded turn, so the tree must exist (byte-identical) before replay.
  if (existsSync(path.join(FIXTURE, 'openspec'))) {
    await cp(path.join(FIXTURE, 'openspec'), path.join(REPO, 'openspec'), { recursive: true });
  }
  const cacheDir = path.join(REPO, '.copperhead', 'llm-cache');
  await mkdir(cacheDir, { recursive: true });
  for (const f of await readdir(path.join(FIXTURE, 'llm-cache'))) {
    if (!f.endsWith('.json') || dropKeys.has(f)) continue;
    await copyFile(path.join(FIXTURE, 'llm-cache', f), path.join(cacheDir, f));
  }
  await cp(path.join(FIXTURE, 'home'), REPLAY_HOME, { recursive: true });
  await mkdir(REPLAY_SYMS, { recursive: true });
  const symFiles = (await readFile(path.join(FIXTURE, 'symbols.txt'), 'utf8'))
    .split('\n')
    .filter((f) => f.endsWith('.kicad_sym'));
  for (const f of symFiles) {
    await copyFile(path.join(SYSTEM_SYMS, f), path.join(REPLAY_SYMS, f));
  }

  await git(REPO, 'init', '-q', '.');
  await git(REPO, 'config', 'user.email', 'e2e-replay@copperhead.local');
  await git(REPO, 'config', 'user.name', 'e2e-replay');
  await git(REPO, 'add', '-A');
  await git(REPO, 'commit', '-qm', 'baseline');

  process.env.HOME = REPLAY_HOME;
  process.env.KICAD_SYMBOL_DIR = REPLAY_SYMS;
  process.env.COPPERHEAD_BASE_URL = manifest.baseURL;
}

async function checkPrereqs(manifest: Manifest): Promise<string[]> {
  const problems: string[] = [];
  for (const f of ['brief.md', 'config.json', 'llm-cache', 'home', 'symbols.txt']) {
    if (!existsSync(path.join(FIXTURE, f))) problems.push(`fixture entry missing: ${f}`);
  }
  if (existsSync(path.join(FIXTURE, 'symbols.txt'))) {
    const wanted = (await readFile(path.join(FIXTURE, 'symbols.txt'), 'utf8'))
      .split('\n')
      .filter((f) => f.endsWith('.kicad_sym'));
    for (const f of wanted) {
      if (!existsSync(path.join(SYSTEM_SYMS, f))) problems.push(`system KiCad symbols missing: ${f}`);
    }
  }
  try {
    const v = await cmdStdout('kicad-cli', ['version']);
    if (v !== manifest.kicadCliVersion)
      problems.push(`kicad-cli ${v} != recorded ${manifest.kicadCliVersion} (ERC/DRC output is version-sensitive)`);
  } catch {
    problems.push('kicad-cli not on PATH');
  }
  try {
    const v = await cmdStdout('openspec', ['--version']);
    if (v !== manifest.openspecVersion)
      problems.push(`openspec ${v} != recorded ${manifest.openspecVersion}`);
  } catch {
    problems.push('openspec CLI not on PATH (validate_change tool calls need it)');
  }
  try {
    await assertDeadEndpoint(manifest.baseURL);
  } catch (e) {
    problems.push((e as Error).message);
  }
  return problems;
}

describe.skipIf(!RUN)('copperhead create — recorded e2e replay', () => {
  let manifest: Manifest;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const manifestPath = path.join(FIXTURE, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error(
        `e2e replay fixture missing (${FIXTURE}). It is recorded once per pipeline-change set — see test/fixtures/create-e2e/README.md`,
      );
    }
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
    for (const k of ['HOME', 'KICAD_SYMBOL_DIR', 'COPPERHEAD_BASE_URL']) savedEnv[k] = process.env[k];
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    vi.setSystemTime(new Date(manifest.recordedAt));
  }, 60_000);

  afterAll(() => {
    vi.useRealTimers();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('replay environment matches the recording', async () => {
    const problems = await checkPrereqs(manifest);
    expect(problems).toEqual([]);
  });

  it(
    'replays the recorded run from cache to the recorded result',
    { timeout: 20 * 60_000 },
    async () => {
      await setupReplayEnv(manifest, new Set());
      const lines: string[] = [];
      const res = await runCreate({
        repoRoot: REPO,
        briefPath: path.join(REPO, 'brief.md'),
        model: manifest.model,
        log: (s) => {
          lines.push(s);
        },
      });

      // The recorded stages complete in order; the result matches the recording
      // (a full recording ends ok, a partial one ends on the first cache miss).
      expect(res.completed).toEqual(manifest.expectedStages);
      expect(res.ok).toBe(manifest.expectedOk);

      // Every provider turn was served from the recorded cache.
      const replays = lines.filter((l) => l.includes('llm-cache: replayed'));
      expect(replays.length).toBeGreaterThan(0);
      const misses = lines.filter((l) => /provider-error|ECONNREFUSED/.test(l));
      // A partial recording ends on a cache miss — that miss must NOT be a
      // provider error swallowed silently; it surfaces as a stage failure.
      if (manifest.expectedOk) expect(misses).toEqual([]);

      // Each recorded stage produced its commit.
      const subjects = (await git(REPO, 'log', '--format=%s')).split('\n');
      for (const subject of manifest.stageCommitSubjects) {
        expect(subjects).toContain(subject);
      }

      const config = JSON.parse(await readFile(path.join(REPO, '.copperhead', 'config.json'), 'utf8')) as {
        schematic: string | null;
        board: string | null;
        docs: string;
      };

      if (manifest.expectedStages.includes('schematic')) {
        // The recorded design is real, not an empty-sheet pass: the false-green
        // regression class is a schematic that commits with zero symbols.
        const sch = await readFile(path.join(REPO, config.schematic!), 'utf8');
        const symbolCount = (sch.match(/\(lib_id "/g) ?? []).length;
        expect(symbolCount).toBeGreaterThan(0);
      }

      // Contracts hold for every stage the recording completed.
      for (const stage of STAGES) {
        if (!manifest.expectedStages.includes(stage.name)) continue;
        expect(await stage.isComplete(REPO, config.docs), `stage ${stage.name} contract`).toBe(true);
      }
      if (manifest.expectedStages.includes('outputs')) {
        expect(existsSync(path.join(REPO, 'outputs'))).toBe(true);
      }
    },
  );

  it(
    'fails loudly when the last recorded stage is missing from the cache (wedged stage)',
    { timeout: 10 * 60_000 },
    async () => {
      const wedged = manifest.wedgedStage;
      await setupReplayEnv(manifest, new Set(manifest.lastStageKeys));
      const lines: string[] = [];
      const res = await runCreate({
        repoRoot: REPO,
        briefPath: path.join(REPO, 'brief.md'),
        model: manifest.model,
        log: (s) => {
          lines.push(s);
        },
      });
      expect(res.ok).toBe(false);
      expect(res.completed).toEqual(manifest.expectedStages.filter((s) => s !== wedged));
      // The failure surfaced on the stage that lost its cache, not earlier or later.
      const failLines = lines.filter((l) => l.includes(wedged) && /fail|error|abort|exhausted/i.test(l));
      expect(failLines.length).toBeGreaterThan(0);
      // Nothing from the unmet stage was committed.
      const subjects = (await git(REPO, 'log', '--format=%s')).split('\n');
      expect(subjects.some((s) => s.includes(`stage: ${wedged}`))).toBe(false);
    },
  );

  it('an ERC-clean schematic with no symbols does not satisfy stage 4', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = await bootstrapKicadProject(repo, 'empty board probe');
      expect(sch).not.toBeNull();
      const stage = STAGES.find((s) => s.name === 'schematic')!;
      // An empty sheet passes ERC — the contract must still say "not done",
      // or a wedge after bootstrap would skip stage 4 on resume.
      const erc = await runErc(path.join(repo, sch!));
      expect(erc.ok).toBe(true);
      expect(await stage.isComplete(repo, 'docs/')).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
