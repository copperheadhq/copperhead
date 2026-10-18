/**
 * One domain pass of a grounded review (RFC 17 Section 4): a model reads the bundle through
 * read-only queries, proposes, sees each proposal's verification outcome, and submits. The pass
 * never writes the design and never decides a claim; every call and its result are recorded.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TurnTimeoutError, withWatchdog } from '../agent/recovery.js';
import type { Msg, Provider, ToolCall, ToolSchema, Turn } from '../agent/types.js';
import { isRateLimit, withRetry } from '../util/retry.js';
import type { ToolsClient } from './tools-client.js';

const MAX_RESULT_CHARS = 16_000;
const str = { type: 'string' } as const;

/** The read-only query tools, each one review-query op. */
const QUERIES: { name: string; op: string; preset?: Record<string, string>; description: string; properties: Record<string, unknown>; required?: string[] }[] = [
  { name: 'part', op: 'part', description: 'A part: value, footprint, fields, every pin with its name, type and net.', properties: { ref: str }, required: ['ref'] },
  { name: 'net', op: 'net', description: 'A net and its complete member list (pins with names and types, and part values).', properties: { net: str }, required: ['net'] },
  { name: 'pin', op: 'pin', description: 'The net of one pin, REF.PIN.', properties: { pin: str }, required: ['pin'] },
  { name: 'find_parts', op: 'find-parts', description: 'Parts whose reference, value, footprint, description or fields match a regular expression.', properties: { match: str }, required: ['match'] },
  { name: 'nets', op: 'nets', description: 'Net names matching a regular expression (all nets when omitted).', properties: { match: str } },
  { name: 'sweep_findings', op: 'sweep', description: 'Findings of the deterministic sweep, filtered by a regular expression over code and title, a ref, or a severity.', properties: { match: str, ref: str, severity: str } },
  { name: 'not_checked', op: 'not-checked', description: 'What the deterministic sweep did not examine, and checks it could not complete.', properties: {} },
  { name: 'sources', op: 'sources', description: 'Retained source ids matching a regular expression, with page counts.', properties: { match: str } },
  { name: 'search', op: 'search', description: 'Lines matching a regular expression (case-insensitive) in the retained sources, optionally only in sources whose id matches "source". Returns source id, page and line.', properties: { pattern: str, source: str }, required: ['pattern'] },
  { name: 'read', op: 'read', description: 'One page of a source with line numbers; optional line range "from" and "to". Quote citations from this text.', properties: { source: str, page: { type: 'number' }, from: { type: 'number' }, to: { type: 'number' } }, required: ['source'] },
  { name: 'board', op: 'measure', preset: { op: 'board' }, description: 'The board: outline size and position, copper layers, stackup, finish, and counts of footprints by side, pads, vias, tracks and zones.', properties: {} },
  { name: 'placement_list', op: 'measure', preset: { op: 'placement-list' }, description: 'Every footprint on the board (or those whose ref, footprint or value match "match"): position in mm, rotation, side and footprint.', properties: { match: str } },
  { name: 'routing', op: 'measure', preset: { op: 'net-routing' }, description: 'How one net is routed: track length by layer and by width, the narrowest width, vias by size, zones and pads.', properties: { net: str }, required: ['net'] },
  { name: 'routing_summary', op: 'measure', preset: { op: 'routing-summary' }, description: 'One line per routed net (or those matching "match"): length, widths, vias and zones.', properties: { match: str } },
  { name: 'measure', op: 'measure', description: 'A board measurement: op is placement {ref}, pad-distance {a, b}, part-distance {a, b}, edge-distance {target}, copper-path {a, b}, net-proximity {a, b}, net-length {net} or parts-near {ref, within}.', properties: { op: str, ref: str, a: str, b: str, target: str, net: str, within: { type: 'number' } }, required: ['op'] },
  { name: 'calculators', op: 'calculators', description: 'The calculator catalogue with each calculator\'s inputs.', properties: {} },
  { name: 'calc', op: 'calc', description: 'Run a calculator to explore (not a proposal): inputs is an object of name to quantity text, such as {"voltage": "3.3 V"}.', properties: { calculator: str, inputs: { type: 'object' } }, required: ['calculator', 'inputs'] },
];

export const PASS_TOOLS: ToolSchema[] = [
  ...QUERIES.map((q) => ({ name: q.name, description: q.description, parameters: { type: 'object', properties: q.properties, ...(q.required ? { required: q.required } : {}) } })),
  {
    name: 'propose',
    description: 'Submit one or more proposals (fact, citation, measurement, calculation, finding, question). Returns each one\'s verification outcome now; re-propose an id to replace it.',
    parameters: { type: 'object', properties: { proposals: { type: 'array', items: { type: 'object' } } }, required: ['proposals'] },
  },
  { name: 'submit', description: 'End this pass. Your proposals as they stand are the pass\'s sample.', parameters: { type: 'object', properties: { summary: str } } },
];

export interface PassRecord {
  domain: string;
  model: string;
  turns: number;
  /** `running` only in a sample saved mid-pass: the pass had not ended when it was written. */
  outcome: 'running' | 'submitted' | 'turns-exhausted' | 'time-exhausted' | 'stalled' | 'failed';
  error: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  seconds: number;
  proposals: Record<string, unknown>[];
  calls: { turn: number; tool: string; args: unknown; result: string; ms: number }[];
  transcript: { role: string; content: string | null; toolCalls?: ToolCall[]; toolCallId?: string }[];
  summary: string | null;
  /** What the pass ran under, so `--resume` keeps it only for a run that would ask the same. */
  provenance?: PassProvenance;
}

export interface PassProvenance {
  templateVersion: string;
  /** sha256 of the rules, the tool schemas and the domain task the pass was given. */
  rules: string;
  tools: string;
  task: string;
  maxTurns: number;
  maxMinutes: number;
  /** sha256 of the bundle the pass read. */
  bundle: string;
}

export interface PassOptions {
  domain: string;
  model: string;
  provider: Provider;
  tools: ToolsClient;
  bundlePath: string;
  system: string;
  task: string;
  maxTurns: number;
  maxSeconds: number;
  /** A turn with no response or progress for this long is aborted and retried once. */
  turnTimeoutMs: number;
  /** A turn still producing output after this long is stopped and ends the pass (default 3 x turnTimeoutMs). */
  turnMaxMs?: number;
  /** First backoff after a rate limit (429); doubled for each of three retries. */
  rateLimitBaseMs?: number;
  log: (line: string) => void;
  /** Called after every turn with the record so far, so a pass that is killed leaves its work. */
  onTurn?: (rec: PassRecord) => Promise<void>;
  /** Aborting it stops the pass: the in-flight turn is torn down and the pass ends `failed`, error `cancelled`. */
  signal?: AbortSignal;
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/** Prefix a pass's ids with its domain, so proposals of different passes never collide. */
function prefixed(domain: string, id: string): string {
  return id.startsWith(`${domain}.`) ? id : `${domain}.${id}`;
}

export function normalizeProposal(domain: string, raw: Record<string, unknown>): Record<string, unknown> {
  const p: Record<string, unknown> = { ...raw, domain };
  if (typeof p.id === 'string') p.id = prefixed(domain, p.id);
  if (Array.isArray(p.premises)) p.premises = p.premises.map((x) => (typeof x === 'string' ? prefixed(domain, x) : x));
  if (p.inputs && typeof p.inputs === 'object' && !Array.isArray(p.inputs)) {
    const inputs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p.inputs as Record<string, unknown>)) {
      if (v && typeof v === 'object' && typeof (v as { from?: unknown }).from === 'string') {
        const from = (v as { from: string }).from;
        inputs[k] = { ...(v as object), from: /^(design:|assum)/i.test(from) ? from : prefixed(domain, from) };
      } else inputs[k] = v;
    }
    p.inputs = inputs;
  }
  return p;
}

function clip(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n... (cut at ${MAX_RESULT_CHARS} characters; narrow the query)` : text;
}

/** Settle with `p`, or reject with CancelledError as soon as `signal` aborts (after running `onAbort`). */
async function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined, onAbort: () => unknown): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    void Promise.resolve(onAbort()).catch(() => undefined);
    p.catch(() => undefined);
    throw new CancelledError();
  }
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    listener = () => {
      reject(new CancelledError());
      void Promise.resolve(onAbort()).catch(() => undefined);
    };
    signal.addEventListener('abort', listener, { once: true });
  });
  try {
    return await Promise.race([p, aborted]);
  } finally {
    signal.removeEventListener('abort', listener!);
  }
}

/** A delay that ends early, rejecting with CancelledError, when `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return untilAborted(new Promise<void>((r) => (timer = setTimeout(r, ms))), signal, () => clearTimeout(timer));
}

export async function runPass(o: PassOptions): Promise<PassRecord> {
  const started = Date.now();
  const rec: PassRecord = {
    domain: o.domain,
    model: o.model,
    turns: 0,
    outcome: 'running',
    error: null,
    inputTokens: 0,
    outputTokens: 0,
    startedAt: new Date(started).toISOString(),
    seconds: 0,
    proposals: [],
    calls: [],
    transcript: [],
    summary: null,
  };
  const proposals = new Map<string, Record<string, unknown>>();
  const scratch = await mkdtemp(path.join(os.tmpdir(), `copperhead-review-${o.domain}-`));
  const messages: Msg[] = [
    { role: 'system', content: o.system },
    { role: 'user', content: o.task },
  ];
  let idle = 0;
  let timeouts = 0;
  let warned = false;
  // The pass stops when it is cancelled or its wall-clock budget runs out, in flight too: a turn,
  // a query or a pre-check under way is torn down then, not left to run to its own limit.
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), Math.min(o.maxSeconds * 1000, 2 ** 31 - 1));
  const halt = new AbortController();
  const onHalt = () => halt.abort();
  if (o.signal?.aborted) halt.abort();
  o.signal?.addEventListener('abort', onHalt, { once: true });
  deadline.signal.addEventListener('abort', onHalt, { once: true });
  const stop = halt.signal;
  // The sample is saved at the end of every turn, whichever way the turn ends, so a pass that is
  // killed leaves every turn it had taken (design D5). A sample that cannot be saved ends the pass.
  const checkpoint = async () => {
    if (!o.onTurn) return;
    rec.proposals = [...proposals.values()];
    rec.seconds = Math.round((Date.now() - started) / 1000);
    rec.transcript = transcriptOf(messages);
    await o.onTurn(rec).catch((e: unknown) => {
      throw new Error(`could not save the sample: ${(e as Error).message}`);
    });
  };
  const close = () => o.provider.close?.();
  // A pass that was stopped never records an ending of its own: it is cancelled or out of time.
  const ending = () => {
    if (stop.aborted) throw new CancelledError();
  };
  // One provider turn: an inactivity watchdog (a turn that keeps streaming is not hung) with a
  // hard cap, rate limits retried with backoff, and cancellation that tears the turn down.
  const chat = (turn: number): Promise<Turn> =>
    untilAborted(
      withRetry(
        () => {
          if (stop.aborted) throw new CancelledError();
          // Each attempt's request is aborted when the pass stops or the watchdog trips: a provider
          // that makes an HTTP request cancels it, one that runs a subprocess is closed.
          const attempt = new AbortController();
          const abort = () => attempt.abort();
          stop.addEventListener('abort', abort, { once: true });
          return withWatchdog((activity) => o.provider.chat(messages, PASS_TOOLS, { onStream: () => activity(), signal: attempt.signal }), {
            idleMs: o.turnTimeoutMs,
            maxMs: o.turnMaxMs ?? 3 * o.turnTimeoutMs,
            onTimeout: () => {
              abort();
              return close();
            },
          }).finally(() => stop.removeEventListener('abort', abort));
        },
        {
          baseMs: o.rateLimitBaseMs ?? 5000,
          isRetryable: isRateLimit,
          onRetry: (attempt) => o.log(`[${o.domain}] turn ${turn}: rate limited; retry ${attempt} of 3`),
          sleep: (ms) => delay(ms, stop),
        },
      ),
      stop,
      close,
    );
  try {
    for (let turn = 1; turn <= o.maxTurns; turn++) {
      if (stop.aborted) throw new CancelledError();
      if ((Date.now() - started) / 1000 > o.maxSeconds) {
        rec.outcome = 'time-exhausted';
        break;
      }
      if (!warned && o.maxTurns - turn < 4) {
        warned = true;
        messages.push({ role: 'user', content: `${o.maxTurns - turn + 1} turns left. Propose your remaining findings with their premises now, then call submit.` });
      }
      rec.turns = turn;
      let reply: Turn;
      try {
        reply = await chat(turn);
      } catch (e) {
        // A turn with no response or progress past its timeout is retried once; two in a row end
        // the pass. A turn still producing output at the hard cap is too large, not hung: it ends
        // the pass at once, since resending it would run just as long.
        if (!(e instanceof TurnTimeoutError) || e.kind === 'max' || ++timeouts >= 2) throw e;
        rec.calls.push({ turn, tool: '(timeout)', args: {}, result: e.message, ms: e.ms });
        o.log(`[${o.domain}] turn ${turn}: timed out; retrying`);
        await checkpoint();
        continue;
      }
      timeouts = 0;
      rec.inputTokens += reply.usage.inputTokens;
      rec.outputTokens += reply.usage.outputTokens;
      messages.push({ role: 'assistant', content: reply.text, ...(reply.toolCalls.length ? { toolCalls: reply.toolCalls } : {}) });
      if (!reply.toolCalls.length) {
        if (++idle >= 3) {
          ending();
          rec.outcome = 'stalled';
          await checkpoint();
          break;
        }
        messages.push({ role: 'user', content: reply.nudge ?? 'Reply with exactly one tool call: a query, propose, or submit.' });
        await checkpoint();
        continue;
      }
      idle = 0;
      let done = false;
      for (const call of reply.toolCalls) {
        const t0 = Date.now();
        let result = '';
        // A call the stop cut short is recorded like any other, with what happened, before the
        // pass ends: the call log holds every call.
        let stopped: CancelledError | null = null;
        try {
          if (call.name === 'submit') {
            rec.summary = typeof call.args.summary === 'string' ? call.args.summary : null;
            result = `Submitted ${proposals.size} proposal(s).`;
            done = true;
          } else if (call.name === 'propose') {
            result = await propose(o, call.args, proposals, scratch, stop);
          } else {
            const q = QUERIES.find((x) => x.name === call.name);
            if (!q) result = `Unknown tool ${call.name}.`;
            else {
              const args = { ...call.args, ...(q.preset ?? {}) };
              try {
                const r = await o.tools.run('review-query', { bundle: o.bundlePath, op: q.op, args: JSON.stringify(args) }, { signal: stop });
                const d = r.data as { ok?: boolean; text?: string; problem?: string } | undefined;
                result = d?.ok ? (d.text ?? '') : `Problem: ${d?.problem ?? 'no result'}`;
                if (!d?.ok && !Object.keys(call.args).length && (q.required ?? []).length) {
                  result += `\nThe call arrived with no arguments. Write it as {"tool": "${call.name}", "args": {${(q.required ?? Object.keys(q.properties)).map((k) => `"${k}": ...`).join(', ')}}}.`;
                }
              } catch (e) {
                if (stop.aborted) throw new CancelledError();
                result = `Problem: ${(e as Error).message}`;
              }
            }
          }
        } catch (e) {
          if (!(e instanceof CancelledError)) throw e;
          stopped = e;
          result = 'Stopped: the pass was cancelled or ran out of its time budget before this call finished.';
        }
        result = clip(result);
        rec.calls.push({ turn, tool: call.name, args: call.args, result, ms: Date.now() - t0 });
        messages.push({ role: 'tool', toolCallId: call.id, content: result });
        o.log(`[${o.domain}] turn ${turn}: ${call.name} ${call.name === 'propose' ? `(${proposals.size} held)` : JSON.stringify(call.args).slice(0, 90)}`);
        if (stopped) throw stopped;
        if (done) break;
      }
      if (reply.notice) messages.push({ role: 'user', content: reply.notice });
      if (done) {
        ending();
        rec.outcome = 'submitted';
      }
      await checkpoint();
      if (done) break;
    }
    if (rec.outcome === 'running') {
      ending();
      rec.outcome = 'turns-exhausted';
    }
    // Every ending is saved before the provider is closed (stalled and submitted saved in the loop).
    if (rec.outcome === 'turns-exhausted' || rec.outcome === 'time-exhausted') await checkpoint();
  } catch (e) {
    if (e instanceof CancelledError && deadline.signal.aborted && !o.signal?.aborted) rec.outcome = 'time-exhausted';
    else {
      rec.outcome = 'failed';
      rec.error = (e as Error).message;
    }
    // A save that fails again is left to the caller's final save.
    await checkpoint().catch(() => undefined);
  } finally {
    clearTimeout(deadlineTimer);
    o.signal?.removeEventListener('abort', onHalt);
    await o.provider.close?.();
    await rm(scratch, { recursive: true, force: true });
  }
  rec.proposals = [...proposals.values()];
  rec.seconds = Math.round((Date.now() - started) / 1000);
  rec.transcript = transcriptOf(messages);
  return rec;
}

function transcriptOf(messages: Msg[]): PassRecord['transcript'] {
  return messages.map((m) => ({ role: m.role, content: 'content' in m ? (m.content as string | null) : null, ...('toolCalls' in m && m.toolCalls ? { toolCalls: m.toolCalls } : {}), ...('toolCallId' in m ? { toolCallId: m.toolCallId } : {}) }));
}

/** Hold the proposals and return each one's outcome from a verifier pre-check over everything held. */
async function propose(o: PassOptions, args: Record<string, unknown>, held: Map<string, Record<string, unknown>>, scratch: string, signal: AbortSignal): Promise<string> {
  const list = Array.isArray(args.proposals) ? args.proposals : null;
  if (!list || !list.length) return 'Problem: propose needs "proposals", a non-empty array of proposal objects.';
  // The batch is checked whole before any of it is held: a refused batch holds nothing.
  if (list.some((raw) => !raw || typeof raw !== 'object' || typeof (raw as { id?: unknown }).id !== 'string')) return 'Problem: every proposal needs a string "id"; none of this batch was held.';
  const ids: string[] = [];
  for (const raw of list) {
    const p = normalizeProposal(o.domain, raw as Record<string, unknown>);
    held.set(p.id as string, p);
    ids.push(p.id as string);
  }
  const file = path.join(scratch, 'proposals.json');
  await writeFile(file, JSON.stringify({ format: 'copperhead-review-proposals', version: 1, proposals: [...held.values()] }));
  try {
    const r = await o.tools.run('review-verify', { bundle: o.bundlePath, proposals: file }, { signal });
    const vs = ((r.data as { verifications?: { id: string; outcome: string; class: string | null; verifier: string; reason: string; claim: string | null; severity?: string; severityNote?: string }[] }).verifications ?? []);
    const byId = new Map(vs.map((v) => [v.id, v]));
    return ids
      .map((id) => {
        const v = byId.get(id);
        if (!v) return `${id}: not verified`;
        const claim = v.outcome === 'VERIFIED' && v.claim ? ` | ${v.claim.split('\n')[0]!.slice(0, 200)}` : '';
        const sev = v.severityNote ? ` | ${v.severityNote}` : '';
        return `${id}: ${v.outcome}${v.class ? ` as ${v.class}` : ''} (${v.verifier}): ${v.reason}${claim}${sev}`;
      })
      .join('\n');
  } catch (e) {
    if (signal.aborted) throw new CancelledError();
    return `Held ${ids.length} proposal(s); the pre-check failed: ${(e as Error).message}`;
  }
}
