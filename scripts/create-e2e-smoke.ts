/** Opt-in live acceptance smoke. Importing this module never starts a model. */
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { child, children, parseSexp, type SexpNode } from '../src/kicad/sexp.js';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STAGE_NAMES = ['spec-seed', 'architecture', 'part-selection', 'schematic', 'layout-draft', 'outputs', 'firmware', 'devplan'] as const;
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object in evidence');
  return value as Record<string, unknown>;
};
function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Ignore ambient Git directory overrides: every command belongs to the fresh sandbox.
function gitEnv(env = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_')));
}
async function git(repo: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd: repo, env: gitEnv(), timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
}

/** No customer paths or links may be followed while inspecting generated evidence. */
export async function sandboxPath(repo: string, relative: unknown): Promise<string> {
  requireThat(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative), 'artifact path must be repo-relative');
  const resolved = path.resolve(repo, relative);
  const rel = path.relative(repo, resolved);
  requireThat(rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`), 'artifact path escapes the sandbox');
  let current = repo;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    requireThat(!stat.isSymbolicLink(), `symlink is not acceptance evidence: ${rel}`);
    requireThat(!stat.isFile() || stat.nlink === 1, `shared hard link is not acceptance evidence: ${rel}`);
  }
  return resolved;
}
async function textFile(repo: string, relative: unknown): Promise<string> {
  const file = await sandboxPath(repo, relative);
  requireThat((await lstat(file)).isFile(), `not a regular artifact: ${String(relative)}`);
  return readFile(file, 'utf8');
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  error?: string;
}

/** POSIX group termination also catches a provider grandchild that ignores SIGTERM. */
export async function runBounded(
  command: string,
  args: string[],
  options: { cwd: string; logPrefix: string; timeoutMs: number; killGraceMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  requireThat(process.platform !== 'win32', 'this smoke runner requires POSIX process groups (macOS or Linux)');
  requireThat(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= 2_147_483_647, 'timeoutMs must be finite and positive');
  const grace = options.killGraceMs ?? 1_000;
  requireThat(Number.isSafeInteger(grace) && grace >= 0 && grace <= 10_000, 'invalid termination grace period');
  const out = await open(`${options.logPrefix}.stdout.log`, 'wx');
  const err = await open(`${options.logPrefix}.stderr.log`, 'wx');
  try {
    if (options.signal?.aborted) return { exitCode: null, signal: null, timedOut: false, aborted: true };
    return await new Promise<ProcessResult>((resolve) => {
      const processGroup = spawn(command, args, { cwd: options.cwd, env: gitEnv(options.env), detached: true, stdio: ['ignore', out.fd, err.fd] });
      let result: ProcessResult = { exitCode: null, signal: null, timedOut: false, aborted: false };
      let closed = false;
      let cleaned = false;
      let terminating = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        if (!closed || !cleaned) return;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        resolve(result);
      };
      const kill = (signal: NodeJS.Signals) => {
        if (!processGroup.pid) return;
        try { process.kill(-processGroup.pid, signal); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') result.error = String(error); }
      };
      const terminate = () => {
        if (terminating) return;
        terminating = true;
        kill('SIGTERM');
        // Do not cancel this when the parent exits: descendants can outlive it.
        setTimeout(() => { kill('SIGKILL'); cleaned = true; finish(); }, grace);
      };
      const abort = () => { result.aborted = true; terminate(); };
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { result.timedOut = true; terminate(); }, options.timeoutMs);
      processGroup.once('error', (error) => { result.error = error.message; });
      processGroup.once('close', (code, signal) => {
        result.exitCode = code;
        result.signal = signal;
        closed = true;
        clearTimeout(timer);
        // A CLI returning normally must not leave a provider running in the background.
        terminate();
        finish();
      });
    });
  } finally {
    await out.close();
    await err.close();
  }
}

export interface EvidenceWindow {
  initialHead: string;
  briefSha256: string;
  startedAtMs: number;
  endedAtMs: number;
  process: ProcessResult;
}

/** Assert actual per-stage terminal events and their reachable Git commits. */
export async function inspectStageEvidence(repo: string, window: EvidenceWindow): Promise<{ name: string; commit: string; transcript: string }[]> {
  requireThat(window.process.exitCode === 0 && !window.process.timedOut && !window.process.aborted && !window.process.error, 'create did not exit successfully within its deadline');
  const report = object(JSON.parse(await textFile(repo, '.copperhead/runs/report.json')));
  requireThat(typeof report.generatedAtMs === 'number' && report.generatedAtMs >= window.startedAtMs && report.generatedAtMs <= window.endedAtMs, 'run report is outside this invocation');
  requireThat(Array.isArray(report.stages) && report.stages.length === STAGE_NAMES.length, 'missing final stage in run report');
  report.stages.forEach((value, index) => {
    const stage = object(value);
    requireThat(stage.name === STAGE_NAMES[index] && stage.resumed === false, 'fresh smoke requires all eight stages in order, without resume');
  });
  const runs = await sandboxPath(repo, '.copperhead/runs');
  const attempts = new Map<string, { start: number; events: Record<string, unknown>[]; transcript: string }[]>();
  for (const entry of await readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const transcript = path.join('.copperhead/runs', entry.name, 'transcript.jsonl');
    const events = (await textFile(repo, transcript)).split('\n').filter(Boolean).map((line) => object(JSON.parse(line)));
    const starts = events.filter((event) => event.type === 'run-start');
    requireThat(starts.length === 1, `invalid run-start count in ${transcript}`);
    const first = object(starts[0]!.data);
    const stage = object(first.stage);
    const brief = object(first.brief);
    const index = STAGE_NAMES.indexOf(stage.name as typeof STAGE_NAMES[number]);
    const start = Date.parse(String(starts[0]!.ts));
    requireThat(first.command === 'create' && index >= 0 && stage.index === index + 1 && stage.total === 8, `unexpected stage in ${transcript}`);
    requireThat(brief.sha256 === window.briefSha256 && start >= window.startedAtMs && start <= window.endedAtMs, `stale or unrelated transcript: ${transcript}`);
    const name = STAGE_NAMES[index]!;
    const list = attempts.get(name) ?? [];
    list.push({ start, events, transcript });
    attempts.set(name, list);
  }
  const stages: { name: string; commit: string; transcript: string }[] = [];
  let previousCommit = window.initialHead;
  let previousStart = -Infinity;
  for (const name of STAGE_NAMES) {
    const attempt = attempts.get(name)?.sort((a, b) => a.start - b.start).at(-1);
    requireThat(attempt, `missing terminal evidence for ${name}`);
    requireThat(attempt.start >= previousStart, 'stage attempts are not ordered');
    const terminal = attempt.events.at(-1)!;
    requireThat(terminal.type === 'run-end' && object(terminal.data).exitPath === 'done', `${name} did not finish done`);
    const end = Date.parse(String(terminal.ts));
    requireThat(end >= attempt.start && end <= window.endedAtMs, `invalid terminal timestamp for ${name}`);
    const committed = attempt.events.filter((event) => event.type === 'run-committed');
    requireThat(committed.length === 1, `missing unique committed event for ${name}`);
    const commit = object(committed[0]!.data).commit;
    requireThat(typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit), `invalid commit for ${name}`);
    requireThat(commit !== previousCommit, `stage ${name} reused an earlier commit`);
    await git(repo, 'merge-base', '--is-ancestor', previousCommit, commit);
    await git(repo, 'merge-base', '--is-ancestor', commit, 'HEAD');
    requireThat(await git(repo, 'show', '-s', '--format=%s', commit) === `copperhead: create pipeline stage: ${name}`, `wrong commit subject for ${name}`);
    stages.push({ name, commit, transcript: attempt.transcript });
    previousCommit = commit;
    previousStart = end;
  }
  return stages;
}

const atom = (node: SexpNode[] | undefined, index: number): string | undefined => typeof node?.[index] === 'string' ? node[index] as string : undefined;
const property = (node: SexpNode[], name: string): string | undefined => atom(children(node, 'property').find((item) => item[1] === name), 2);
const finitePosition = (node: SexpNode[]) => [1, 2].every((index) => {
  const value = atom(child(node, 'at'), index);
  return value !== undefined && value.trim() !== '' && Number.isFinite(Number(value));
});

async function designRoot(repo: string, relative: string, tag: string): Promise<SexpNode[]> {
  const roots = parseSexp(await textFile(repo, relative));
  requireThat(roots.length === 1 && Array.isArray(roots[0]) && roots[0][0] === tag, `invalid ${tag} document: ${relative}`);
  return roots[0];
}

async function listFiles(repo: string, relative: string): Promise<string[]> {
  const directory = await sandboxPath(repo, relative);
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    requireThat(!entry.isSymbolicLink(), `symlink output is not evidence: ${rel}`);
    if (entry.isDirectory()) files.push(...await listFiles(repo, rel));
    else if (entry.isFile() && (await lstat(path.join(repo, rel))).size > 0) files.push(rel);
  }
  return files;
}

export async function inspectArtifacts(repo: string) {
  const config = object(JSON.parse(await textFile(repo, '.copperhead/config.json')));
  requireThat(typeof config.schematic === 'string' && typeof config.board === 'string', 'schematic and board must both be configured');
  requireThat(typeof config.docs === 'string', 'docs path must be configured');
  const visited = new Set<string>();
  let symbolCount = 0;
  async function visitSheet(relative: string): Promise<void> {
    const file = await sandboxPath(repo, relative);
    if (visited.has(file)) return;
    visited.add(file);
    const root = await designRoot(repo, relative, 'kicad_sch');
    symbolCount += children(root, 'symbol').filter((symbol) => {
      const libId = atom(child(symbol, 'lib_id'), 1);
      const ref = property(symbol, 'Reference');
      return libId && !libId.startsWith('power:') && ref && !ref.startsWith('#') && ref !== '?' && atom(child(symbol, 'uuid'), 1) && finitePosition(symbol);
    }).length;
    for (const sheet of children(root, 'sheet')) {
      const childFile = property(sheet, 'Sheetfile');
      requireThat(childFile && !path.isAbsolute(childFile), 'hierarchical Sheetfile must be relative to its parent');
      await visitSheet(path.join(path.dirname(relative), childFile));
    }
  }
  await visitSheet(config.schematic);
  const board = await designRoot(repo, config.board, 'kicad_pcb');
  const footprintCount = children(board, 'footprint').filter((footprint) => {
    const reference = property(footprint, 'Reference') ?? atom(children(footprint, 'fp_text').find((item) => item[1] === 'reference'), 2);
    return atom(footprint, 1) && reference && reference !== '?' && finitePosition(footprint) && children(footprint, 'pad').length > 0;
  }).length;
  requireThat(symbolCount > 0 && footprintCount > 0, 'empty design: real schematic instances and populated board footprints are required');
  const docs = ['SPEC', 'SUBSYSTEMS', 'BOM', 'PINOUT', 'LAYOUT', 'DEVPLAN'].map((name) => path.join(config.docs as string, `${name}.md`));
  for (const relative of docs) {
    const content = (await textFile(repo, relative)).replace(/<!--[\s\S]*?-->/g, '');
    requireThat(content.split('\n').some((line) => line.trim() && !/^\s*#/.test(line)), `missing substantive content in ${relative}`);
  }
  const outputs = await listFiles(repo, 'outputs');
  for (const [label, pattern] of [
    ['Gerber', /\.(gbr|gtl|gbl|gbs|gbo|gbp|gbd|gto|gts|gml)$/i], ['drill', /\.(drl|xln)$/i],
    ['outline', /\.dxf$/i], ['STEP', /\.(step|stp)$/i], ['render', /\.svg$/i], ['ordering BOM', /\.csv$/i],
  ] as const) requireThat(outputs.some((file) => pattern.test(file)), `missing nonempty ${label} export`);
  const firmware = await listFiles(repo, 'firmware');
  requireThat(firmware.some((file) => /\.(c|cpp|py|rs|ino|s)$/i.test(file)) && firmware.some((file) => path.basename(file) === 'pins.h'), 'missing firmware source or pins.h');
  const files = [...visited].map((file) => path.relative(repo, file)).concat(config.board, docs, outputs, firmware);
  const hashes = Object.fromEntries(await Promise.all(files.map(async (relative) => [relative, sha256(await readFile(await sandboxPath(repo, relative)))])));
  return { schematic: config.schematic, board: config.board, symbolCount, footprintCount, hashes };
}

/** Reject absent/malformed checks instead of treating {} as a clean design. */
export function inspectRawReport(raw: unknown, kind: 'erc' | 'drc', input: string): void {
  const report = object(raw);
  requireThat(report.source === path.basename(input), `${kind} source does not match the checked artifact`);
  requireThat(typeof report.kicad_version === 'string' && report.kicad_version.length > 0, `${kind} report has no KiCad version`);
  const severities = report.included_severities;
  requireThat(Array.isArray(severities) && ['error', 'warning'].every((severity) => severities.includes(severity)), `${kind} did not check errors and warnings`);
  let arrays: unknown[];
  if (kind === 'erc') {
    requireThat(Array.isArray(report.sheets) && report.sheets.length > 0, 'ERC report has no checked sheets');
    arrays = report.sheets.map((sheet) => object(sheet).violations);
  } else arrays = [report.violations, report.unconnected_items, report.schematic_parity];
  requireThat(arrays.every((items) => Array.isArray(items) && items.length === 0), `${kind.toUpperCase()} has violations or incomplete report fields`);
}

export function kicadCheckArgs(kind: 'erc' | 'drc', input: string, report: string): string[] {
  return [kind === 'erc' ? 'sch' : 'pcb', kind, '--format', 'json', '--exit-code-violations',
    ...(kind === 'drc' ? ['--schematic-parity'] : []), '--output', report, input];
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const { values } = parseArgs({ args: argv, options: {
    model: { type: 'string' }, brief: { type: 'string' }, 'output-dir': { type: 'string' },
    'timeout-ms': { type: 'string', default: '1800000' }, 'kicad-cli': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('COPPERHEAD_LIVE_CREATE=1 npx tsx scripts/create-e2e-smoke.ts --model codex [--brief synthetic.md] [--timeout-ms 1800000] [--output-dir /tmp] [--kicad-cli /path/to/kicad-cli]');
    return 0;
  }
  if (env.COPPERHEAD_LIVE_CREATE !== '1') {
    console.log('SKIPPED: live create smoke requires COPPERHEAD_LIVE_CREATE=1. No sandbox, CLI, or model was started.');
    return 0;
  }
  const model = values.model;
  requireThat(typeof model === 'string' && model.trim(), '--model is required; this opt-in can consume your provider quota or incur API charges');
  const timeoutMs = Number(values['timeout-ms']);
  requireThat(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 86_400_000, '--timeout-ms must be between 1 and 86400000');
  requireThat(process.platform !== 'win32', 'live smoke requires POSIX process groups');
  const kicadOverride = values['kicad-cli'] ?? env.COPPERHEAD_KICAD_CLI;
  requireThat(kicadOverride === undefined || path.isAbsolute(kicadOverride), '--kicad-cli / COPPERHEAD_KICAD_CLI must be an absolute executable path');
  const childEnv = { ...env, ...(kicadOverride ? { COPPERHEAD_KICAD_CLI: kicadOverride } : {}) };
  const kicad = kicadOverride ?? 'kicad-cli';
  const brief = await readFile(path.resolve(values.brief ?? path.join(ROOT, 'examples/simple/rp2040-blinky.md')));
  requireThat(brief.toString('utf8').trim(), 'brief is empty');
  const directory = await mkdtemp(path.join(path.resolve(values['output-dir'] ?? tmpdir()), 'copperhead-create-smoke-'));
  const repo = path.join(directory, 'project');
  const evidence = path.join(directory, 'evidence');
  await mkdir(repo);
  await mkdir(evidence);
  console.log(`Live smoke artifacts: ${directory}`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const summary: Record<string, unknown> = { mode: 'live', ok: false, repo, briefSha256: sha256(brief), model: values.model, timeoutMs };
  try {
    await mkdir(path.join(repo, '.copperhead'));
    await writeFile(path.join(repo, 'brief.md'), brief);
    await writeFile(path.join(repo, '.gitignore'), '.env\n.copperhead/runs/\n');
    await writeFile(path.join(repo, '.copperhead/config.json'), JSON.stringify({ docs: 'docs', maxTurns: 100, maxStageRetries: 1, maxRepairCycles: 3, turnTimeoutMs: 600_000, turnMaxMs: 600_000 }, null, 2));
    await git(repo, '-c', 'init.templateDir=', 'init', '-q');
    await git(repo, 'config', 'user.name', 'Copperhead smoke');
    await git(repo, 'config', 'user.email', 'smoke@example.invalid');
    await git(repo, 'config', 'commit.gpgsign', 'false');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-q', '-m', 'smoke: initialize synthetic project');
    const initialHead = await git(repo, 'rev-parse', 'HEAD');
    const startedAtMs = Date.now();
    summary.initialHead = initialHead;
    summary.startedAtMs = startedAtMs;
    const result = await runBounded(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(ROOT, 'src/cli.ts'), '--repo', repo, '--plain', 'create', '--brief', 'brief.md', '--model', model], {
      cwd: repo, logPrefix: path.join(evidence, 'create'), timeoutMs, signal: controller.signal, env: childEnv,
    });
    const endedAtMs = Date.now();
    summary.process = result;
    summary.endedAtMs = endedAtMs;
    summary.stages = await inspectStageEvidence(repo, { initialHead, briefSha256: sha256(brief), startedAtMs, endedAtMs, process: result });
    const artifacts = await inspectArtifacts(repo);
    summary.artifacts = artifacts;
    for (const kind of ['erc', 'drc'] as const) {
      const input = await sandboxPath(repo, kind === 'erc' ? artifacts.schematic : artifacts.board);
      const report = path.join(evidence, `${kind}.json`);
      const check = await runBounded(kicad, kicadCheckArgs(kind, input, report), {
        cwd: repo, logPrefix: path.join(evidence, kind), timeoutMs: Math.min(timeoutMs, 120_000), signal: controller.signal, env: childEnv,
      });
      summary[kind] = check;
      requireThat(check.exitCode === 0 && !check.timedOut && !check.aborted && !check.error, `${kind.toUpperCase()} process failed`);
      inspectRawReport(JSON.parse(await readFile(report, 'utf8')), kind, input);
    }
    summary.finalHead = await git(repo, 'rev-parse', 'HEAD');
    summary.ok = true;
    console.log('PASS: eight committed stages, nonempty artifacts, and fresh ERC/DRC reports verified.');
    return 0;
  } catch (error) {
    summary.error = (error as Error).message;
    console.error(`FAIL: ${summary.error}`);
    return 1;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    await writeFile(path.join(evidence, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`Evidence preserved: ${directory}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error: unknown) => { console.error(String(error)); process.exitCode = 1; });
}
