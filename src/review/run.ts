/**
 * `copperhead review`: a grounded design review (RFC 17 over RFC 13).
 *
 *   1. sweep    copperhead-tools review: every applicable deterministic check, no model
 *   2. bundle   copperhead-tools review-bundle: the closed context, every input by hash
 *   3. passes   one model pass per domain, read-only queries, proposals pre-checked as they come
 *   4. verify   copperhead-tools review-verify over every pass's sample: the report is rendered
 *               from what the verifiers decided, never from the model's prose
 *   5. record   samples, passes, verifications, report and a lockfile; `--replay` re-verifies the
 *               stored samples without a model and must reproduce the report byte for byte
 *
 * Nothing here writes the design: the design directory is an input, the record goes to --out.
 */
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Provider } from '../agent/types.js';
import { DOMAINS, digest, domainTask, sha256, systemPrompt, TEMPLATE_VERSION, RULES } from './prompts.js';
import { CancelledError, type PassProvenance, type PassRecord, PASS_TOOLS, runPass } from './pass.js';
import { resolveTools, type ToolsClient } from './tools-client.js';
import { redactSecrets } from '../util/redact.js';

export interface ReviewOptions {
  design: string;
  out: string;
  sources: string[];
  model: string;
  domains: string[];
  maxTurns: number;
  maxMinutes: number;
  parallel: number;
  label?: string;
  sweep?: string;
  /** Fabrication outputs (Gerber and drill directories or zips, BOM and placement files): swept, and retained as sources. */
  fab?: string[];
  /** A manufacturer capability profile for fab-rules. */
  fabProfile?: string;
  tools?: string;
  /** Continue a record a killed run left: reuse its sweep and bundle, keep every pass that ended, rerun the rest. */
  resume?: boolean;
  /** A copperhead-tools client to use instead of resolving one (tests). */
  client?: ToolsClient;
  makeProvider: (model: string) => Promise<Provider>;
  /**
   * Progress, one line per call, redacted. These formats are an interface (an editor extension
   * parses them); change them only with the test that pins them:
   *   sweep: <json summary>                     after the sweep ran, or
   *   sweep: using the record at <dir>          with --sweep
   *   bundle: <json summary>                    after the bundle was built
   *   [<domain>] pass starts (<title>)
   *   [<domain>] turn <n>: <tool> <args or "(<n> held)">
   *   [<domain>] pass ends: <outcome> after <n> turns, <n> proposals, <n> s[ (<error>)]
   *   [<domain>] resume: keeping the pass that ended <outcome> after <n> turns
   *   [<domain>] resume: rerunning the pass, which ran with another model, prompt or budget
   */
  log: (line: string) => void;
  /** Paths given relative resolve against it, and the lockfile records paths inside it relative to it (default: the process's cwd). */
  cwd?: string;
  /** Aborting it stops the run: passes are torn down, copperhead-tools processes stopped, and the run rejects with CancelledError. */
  signal?: AbortSignal;
}

export interface ReviewOutcome {
  out: string;
  report: string;
  summary: Record<string, unknown>;
  passes: { domain: string; outcome: string; turns: number; proposals: number; seconds: number; error: string | null }[];
}

/** Outcomes of a pass that ran to an end; any other sample is a pass a killed run interrupted. */
const ENDED = new Set(['submitted', 'turns-exhausted', 'time-exhausted', 'stalled']);

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function emptyOrAbsent(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch {
    return true;
  }
}

/**
 * Refuse a record that holds a symbolic link, or a file with another hard link, anywhere: a review
 * writes only its own files under the record, and a linked component (`model/samples` pointing into
 * the design, say, or a `report.md` sharing an input's inode) would carry those writes into an input.
 */
async function refuseLinks(dir: string): Promise<void> {
  const walk = async (d: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = path.join(d, name);
      const st = await lstat(p);
      if (st.isSymbolicLink()) throw new Error(`${dir} holds a symbolic link at ${path.relative(dir, p)}; a review record holds none, so nothing is written through it`);
      if (st.isFile() && st.nlink > 1) throw new Error(`${dir} holds a file with another hard link at ${path.relative(dir, p)}; a review record holds none, so nothing is written through it`);
      if (st.isDirectory()) await walk(p);
    }
  };
  await walk(dir);
}

/** Whether `dir` holds nothing but the empty `model/samples` a run creates before anything else. */
async function onlySkeleton(dir: string): Promise<boolean> {
  try {
    const top = await readdir(dir);
    const model = await readdir(path.join(dir, 'model'));
    return top.length === 1 && top[0] === 'model' && model.length === 1 && model[0] === 'samples' && (await readdir(path.join(dir, 'model', 'samples'))).length === 0;
  } catch {
    return false;
  }
}

/** The real path of `p`, through symbolic links, for a path whose tail does not exist yet too. */
async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    const parent = path.dirname(p);
    return parent === p ? p : path.join(await canonical(parent), path.basename(p));
  }
}

/** Whether `child` is `parent` or lies under it (lexically: canonicalize first where links matter). */
function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Written whole or not at all: a run killed mid-write leaves the previous sample, never a truncated one. */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

function positive(name: string, v: number, integer: boolean): void {
  if (!Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v))) throw new Error(`${name} must be a positive ${integer ? 'whole number' : 'number'}, not ${v}`);
}

/**
 * Every copperhead-tools call of a review runs in one working directory. A version 2 bundle names
 * a file inside it relative to it, and queries, verification and replay resolve those paths against
 * it, so a record replays from the directory its review ran in (a repository's root).
 */
function runningIn(cwd: string, client: ToolsClient): ToolsClient {
  return { command: client.command, run: (tool, inputs, opts = {}) => client.run(tool, inputs, { cwd, ...opts }) };
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

async function verify(tools: ToolsClient, bundle: string, proposals: string, outDir: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const r = await tools.run('review-verify', { bundle, proposals, out: outDir }, signal ? { signal } : {});
  return r.summary ?? {};
}

async function parses(file: string): Promise<boolean> {
  try {
    JSON.parse(await readFile(file, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

export async function runReview(o: ReviewOptions): Promise<ReviewOutcome> {
  const cwd = path.resolve(o.cwd ?? process.cwd());
  const abs = (p: string) => path.resolve(cwd, p);
  // The record is committed beside the design, so it names a path inside the working directory
  // relative to it: no home directory in it, and the same bytes on every machine.
  const shown = (p: string) => (within(p, cwd) ? path.relative(cwd, p).split(path.sep).join('/') || '.' : p);
  const log = (line: string) => o.log(redactSecrets(line));
  const out = abs(o.out);
  const design = abs(o.design);
  const fab = (o.fab ?? []).map(abs);
  const domains = [...new Set(o.domains)];
  if (!domains.length) throw new Error(`--domains names no domain; domains are ${Object.keys(DOMAINS).join(', ')}`);
  for (const d of domains) if (!DOMAINS[d]) throw new Error(`unknown domain "${d}"; domains are ${Object.keys(DOMAINS).join(', ')}`);
  positive('--max-turns', o.maxTurns, true);
  positive('--max-minutes', o.maxMinutes, false);
  positive('--parallel', o.parallel, true);
  if (!o.resume && !(await emptyOrAbsent(out))) throw new Error(`--out ${out} is not empty; give a new directory for the review record, or --resume it`);
  // Compared through symbolic links: a link outside the design that points into it is inside it.
  const realOut = await canonical(out);
  if (within(realOut, await canonical(design))) throw new Error('--out must lie outside the design directory: a review never writes into the design');
  for (const input of [...o.sources.map(abs), ...fab, ...(o.sweep ? [abs(o.sweep)] : [])]) {
    if (within(realOut, await canonical(input))) throw new Error(`--out must lie outside every input; it is inside ${input}`);
  }
  // What the record reviews, as this run names it. A resumed run must name the same: the bundle and
  // every kept pass were made from these inputs, and the lockfile it writes names them.
  const inputs = {
    design: shown(design),
    sources: o.sources.map((p) => shown(abs(p))),
    fab: fab.map(shown),
    fabProfile: o.fabProfile ? shown(abs(o.fabProfile)) : null,
    sweep: o.sweep ? shown(abs(o.sweep)) : null,
    label: o.label ?? null,
  };
  const inputsPath = path.join(out, 'inputs.json');
  if (o.resume) {
    await refuseLinks(out);
    let text: string | null = null;
    try {
      text = await readFile(inputsPath, 'utf8');
    } catch {
      // absent: only a record a run left before it wrote anything can be resumed without it
    }
    if (text === null) {
      if (!(await emptyOrAbsent(out)) && !(await onlySkeleton(out))) throw new Error(`--resume: ${out} holds no inputs.json, so it is not a review record this run can resume; give a new --out`);
    } else {
      let was: unknown;
      try {
        was = JSON.parse(text);
      } catch {
        throw new Error(`--resume: the record's inputs.json does not parse, so its inputs cannot be checked; start a new record`);
      }
      if (JSON.stringify(was) !== JSON.stringify(inputs)) throw new Error(`--resume must name the record's inputs, from the directory its review ran in: the record has ${JSON.stringify(was)}, this run names ${JSON.stringify(inputs)}`);
    }
  }
  await mkdir(path.join(out, 'model', 'samples'), { recursive: true });
  if (!(await exists(inputsPath))) await writeAtomic(inputsPath, `${JSON.stringify(inputs, null, 1)}\n`);
  const tools = runningIn(cwd, o.client ?? (await resolveTools(o.tools)));
  const signal = o.signal;
  const sig = signal ? { signal } : {};
  const started = new Date();

  // A bundle a killed run left half-written is rebuilt; no pass can have read it.
  const resumable = o.resume && (await parses(path.join(out, 'bundle.json')));
  if (o.resume && !resumable) log('resume: no bundle in the record; starting from the sweep');

  // 1. sweep
  let sweepDir: string;
  if (resumable) {
    sweepDir = (await exists(path.join(out, 'sweep', 'review.json'))) ? path.join(out, 'sweep') : abs(o.sweep ?? path.join(out, 'sweep'));
    log(`resume: reusing the sweep at ${sweepDir}`);
  } else if (o.sweep) {
    sweepDir = abs(o.sweep);
    log(`sweep: using the record at ${sweepDir}`);
  } else {
    sweepDir = path.join(out, 'sweep');
    log('sweep: copperhead-tools review (every applicable deterministic check)');
    const r = await tools.run('review', { input: [design, ...fab], 'out-dir': sweepDir, ...(o.fabProfile ? { profile: abs(o.fabProfile) } : {}) }, sig);
    log(`sweep: ${JSON.stringify(r.summary)}`);
  }

  // 2. bundle
  const bundlePath = path.join(out, 'bundle.json');
  const sources = [...o.sources.map(abs), ...fab];
  if (!resumable) {
    const b = await tools.run('review-bundle', { drop: design, sweep: sweepDir, sources, ...(o.label ? { label: o.label } : {}), out: bundlePath }, sig);
    log(`bundle: ${JSON.stringify(b.summary)}`);
  }
  // Hashed from the bytes on disk, the bytes every query, verification and replay reads.
  const bundleText = await readFile(bundlePath, 'utf8');
  const bundleSha = sha256(bundleText);
  if (resumable) log(`resume: reusing the bundle (sha256 ${bundleSha.slice(0, 12)})`);
  const bundle = JSON.parse(bundleText) as Parameters<typeof digest>[0];
  const system = systemPrompt(digest(bundle));

  // 3. passes
  // A kept pass must have asked what this run would ask, of the same bundle, or the lockfile's single
  // model, prompt hashes, budgets and bundle would claim it ran under settings it never saw.
  const provenance = (domain: string): PassProvenance => ({
    templateVersion: TEMPLATE_VERSION,
    rules: sha256(RULES),
    tools: sha256(JSON.stringify(PASS_TOOLS)),
    task: sha256(domainTask(domain, o.maxTurns)),
    maxTurns: o.maxTurns,
    maxMinutes: o.maxMinutes,
    bundle: bundleSha,
  });
  const sameRun = (prior: PassRecord, domain: string) => {
    const want = provenance(domain);
    return prior.model === o.model && !!prior.provenance && (Object.keys(want) as (keyof PassProvenance)[]).every((k) => prior.provenance![k] === want[k]);
  };
  const passes: (PassRecord | null)[] = await pool(domains, o.parallel, async (domain) => {
    if (signal?.aborted) return null;
    const sample = path.join(out, 'model', 'samples', `${domain}.json`);
    if (resumable && (await exists(sample))) {
      let prior: PassRecord | null = null;
      try {
        prior = JSON.parse(await readFile(sample, 'utf8')) as PassRecord;
      } catch {
        // unreadable: the pass is rerun, and the file kept aside below
      }
      if (prior && ENDED.has(prior.outcome) && prior.turns > 0) {
        if (sameRun(prior, domain)) {
          log(`[${domain}] resume: keeping the pass that ended ${prior.outcome} after ${prior.turns} turns`);
          return prior;
        }
        log(`[${domain}] resume: rerunning the pass, which ran with another model, prompt or budget`);
      }
      await copyFile(sample, `${sample}.interrupted-${Date.now()}`);
    }
    // Samples hold model text and tool results, so they are redacted at write time like transcripts (AC-4.1).
    const save = (r: PassRecord) => writeAtomic(sample, redactSecrets(`${JSON.stringify({ ...r, provenance: provenance(domain) }, null, 1)}\n`));
    const ends = (r: PassRecord) => log(`[${domain}] pass ends: ${r.outcome} after ${r.turns} turns, ${r.proposals.length} proposals, ${r.seconds} s${r.error ? ` (${r.error})` : ''}`);
    log(`[${domain}] pass starts (${DOMAINS[domain]!.title})`);
    let provider: Provider;
    try {
      provider = await o.makeProvider(o.model);
    } catch (e) {
      const failed = { domain, model: o.model, turns: 0, outcome: 'failed', error: (e as Error).message, inputTokens: 0, outputTokens: 0, startedAt: new Date().toISOString(), seconds: 0, proposals: [], calls: [], transcript: [], summary: null } satisfies PassRecord;
      await save(failed);
      ends(failed);
      return failed;
    }
    const rec = await runPass({ domain, model: o.model, provider, tools, bundlePath, system, task: domainTask(domain, o.maxTurns), maxTurns: o.maxTurns, maxSeconds: o.maxMinutes * 60, turnTimeoutMs: 10 * 60_000, log, onTurn: save, ...sig });
    await save(rec);
    ends(rec);
    return rec;
  });
  if (signal?.aborted) throw new CancelledError();
  const ran = passes.filter((p): p is PassRecord => p !== null);

  // 4. verify
  const proposals = ran.flatMap((p) => p.proposals);
  const proposalsPath = path.join(out, 'model', 'proposals.json');
  await writeFile(proposalsPath, redactSecrets(`${JSON.stringify({ format: 'copperhead-review-proposals', version: 1, proposals }, null, 1)}\n`));
  const summary = await verify(tools, bundlePath, proposalsPath, path.join(out, 'verify'), signal);
  await copyFile(path.join(out, 'verify', 'report.md'), path.join(out, 'report.md'));

  // 5. record
  const toolsManifest = await tools.run('review-query', { bundle: bundlePath, op: 'calculators' }, sig).then((r) => r.package ?? null).catch(() => null);
  // The lookup is best effort, but a cancellation during it is still a cancellation.
  if (signal?.aborted) throw new CancelledError();
  const templates = { rules: sha256(RULES), tools: sha256(JSON.stringify(PASS_TOOLS)), ...Object.fromEntries(domains.map((d) => [`task-${d}`, sha256(domainTask(d, o.maxTurns))])) };
  // A submit summary is model text like any other, so it is redacted too.
  await writeFile(
    path.join(out, 'model', 'passes.json'),
    redactSecrets(`${JSON.stringify(ran.map((p) => ({ domain: p.domain, model: p.model, outcome: p.outcome, error: p.error, turns: p.turns, proposals: p.proposals.length, inputTokens: p.inputTokens, outputTokens: p.outputTokens, startedAt: p.startedAt, seconds: p.seconds, summary: p.summary })), null, 1)}\n`),
  );
  const lock = {
    format: 'copperhead-review-lock',
    version: 1,
    startedAt: started.toISOString(),
    design: shown(design),
    bundle: { path: 'bundle.json', sha256: bundleSha },
    sweep: within(sweepDir, out) ? path.relative(out, sweepDir).split(path.sep).join('/') : shown(sweepDir),
    tools: { command: tools.command.map((c) => (path.isAbsolute(c) ? shown(c) : c)), package: toolsManifest },
    model: { id: o.model, decoding: 'provider default (not pinnable through this provider)', samplesPerPass: 1 },
    templates: { version: TEMPLATE_VERSION, sha256: templates },
    domains,
    fab: fab.map(shown),
    fabProfile: o.fabProfile ? shown(abs(o.fabProfile)) : null,
    budgets: { maxTurns: o.maxTurns, maxMinutes: o.maxMinutes, parallel: o.parallel },
    proposals: { path: 'model/proposals.json', sha256: sha256(await readFile(proposalsPath, 'utf8')) },
    report: { path: 'report.md', sha256: sha256(await readFile(path.join(out, 'report.md'), 'utf8')) },
  };
  await writeFile(path.join(out, 'review.lock.json'), `${JSON.stringify(lock, null, 1)}\n`);
  return {
    out,
    report: path.join(out, 'report.md'),
    summary,
    passes: ran.map((p) => ({ domain: p.domain, outcome: p.outcome, turns: p.turns, proposals: p.proposals.length, seconds: p.seconds, error: p.error })),
  };
}

export interface ReplayOptions {
  /** `--tools`: copperhead-tools cli.js or executable. */
  tools?: string;
  log: (line: string) => void;
  /** The directory the review ran in, which a version 2 bundle's relative paths resolve against (default: the process's cwd). */
  cwd?: string;
  /** A copperhead-tools client to use instead of resolving one (tests). */
  client?: ToolsClient;
  signal?: AbortSignal;
}

/**
 * Re-verify a record's stored samples with no model, and compare the report with the recorded one.
 * It runs from the directory the review ran in, wherever the record has been copied since.
 */
export async function replayReview(record: string, o: ReplayOptions): Promise<{ identical: boolean; report: string; replayReport: string }> {
  const cwd = path.resolve(o.cwd ?? process.cwd());
  const dir = path.resolve(cwd, record);
  const log = o.log;
  const signal = o.signal;
  const lock = JSON.parse(await readFile(path.join(dir, 'review.lock.json'), 'utf8')) as { bundle: { sha256: string }; proposals: { sha256: string }; report: { sha256: string } };
  const tools = runningIn(cwd, o.client ?? (await resolveTools(o.tools)));
  const bundlePath = path.join(dir, 'bundle.json');
  const proposalsPath = path.join(dir, 'model', 'proposals.json');
  await refuseLinks(dir);
  if (sha256(await readFile(bundlePath, 'utf8')) !== lock.bundle.sha256) throw new Error('bundle.json differs from the lockfile: the bundle was changed');
  if (sha256(await readFile(proposalsPath, 'utf8')) !== lock.proposals.sha256) throw new Error('model/proposals.json differs from the lockfile: the stored samples were changed');
  const replayDir = path.join(dir, 'replay');
  // Replay writes replay/ beneath the record, so the record must lie outside what it reviewed, as
  // runReview requires of --out: the inputs as the record names them, from the directory it ran in.
  const named = await readFile(path.join(dir, 'inputs.json'), 'utf8').then((t) => JSON.parse(t) as { design: string; sources: string[]; fab: string[]; sweep: string | null }).catch(() => null);
  const reviewed = named ? [named.design, ...named.sources, ...named.fab, ...(named.sweep ? [named.sweep] : [])] : [(lock as { design?: string }).design ?? ''].filter(Boolean);
  const realReplay = await canonical(replayDir);
  for (const input of reviewed) {
    if (within(realReplay, await canonical(path.resolve(cwd, input)))) throw new Error(`--replay writes ${replayDir}, inside ${input}, which the review read and never writes; replay a copy of the record kept outside it`);
  }
  await mkdir(replayDir, { recursive: true });
  log('replay: re-verifying the stored samples (no model)');
  await verify(tools, bundlePath, proposalsPath, replayDir, signal);
  const a = await readFile(path.join(dir, 'report.md'), 'utf8');
  const b = await readFile(path.join(replayDir, 'report.md'), 'utf8');
  return { identical: a === b && sha256(b) === lock.report.sha256, report: path.join(dir, 'report.md'), replayReport: path.join(replayDir, 'report.md') };
}
