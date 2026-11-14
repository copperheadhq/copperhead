import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Msg, Provider } from './types.js';
import { resolveLibrarySymbol, searchInstalledSymbols, symbolSearchDirs, listInstalledLibraries } from '../kicad/symlib.js';

/**
 * How many times a hung provider turn is retried before the run gives up. One
 * policy, two turn loops: the main agent loop and the nested skill sub-run.
 */
export const MAX_TURN_TIMEOUTS = 3;

/**
 * Thrown when a provider turn trips its watchdog. `idle`: no response or
 * progress for `ms`, so the call looks hung. `max`: still running at the hard
 * cap however much progress it reported, so the turn is too large, not hung.
 */
export class TurnTimeoutError extends Error {
  constructor(
    public readonly ms: number,
    public readonly kind: 'idle' | 'max' = 'idle',
  ) {
    super(kind === 'max' ? `turn still running after ${ms}ms (hard cap)` : `turn exceeded ${ms}ms without responding`);
    this.name = 'TurnTimeoutError';
  }
}

/**
 * Race `fn()` against a deadline so a hung provider call cannot stall the run
 * forever. On timeout, `onTimeout` runs (tear down the in-flight call, e.g.
 * provider.close()) and the returned promise rejects with TurnTimeoutError; the
 * caller decides whether to retry or fail. `ms <= 0` (or non-finite) disables the
 * watchdog and just awaits `fn()`.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  return withWatchdog(() => fn(), { idleMs: ms, ...(onTimeout ? { onTimeout } : {}) });
}

/**
 * The turn watchdog: `withTimeout` with the deadline measured from the last sign
 * of progress instead of from the start. `fn` receives an `activity` callback and
 * each call restarts the `idleMs` deadline, so a long turn that keeps producing
 * output is never mistaken for a hung one, while a call that reports nothing gets
 * `idleMs` as a plain whole-call deadline (unchanged for providers that cannot
 * stream). `maxMs` is a hard cap activity does not extend, so a turn that streams
 * forever still ends. The cap bounds a call that is producing output, so it only
 * trips once `fn` has reported progress (a silent call is judged by `idleMs`
 * alone, exactly as before the cap existed), and it is never shorter than
 * `idleMs` (a lower cap would cut off a turn the idle deadline alone allows).
 * `<= 0` (or non-finite) disables either limit; with both disabled this just
 * awaits `fn`.
 */
export async function withWatchdog<T>(
  fn: (activity: () => void) => Promise<T>,
  opts: { idleMs: number; maxMs?: number; onTimeout?: () => void | Promise<void> },
): Promise<T> {
  const idleOn = Number.isFinite(opts.idleMs) && opts.idleMs > 0;
  const maxMs = opts.maxMs ?? 0;
  const maxOn = Number.isFinite(maxMs) && maxMs > 0;
  if (!idleOn && !maxOn) return fn(() => {});
  const capMs = idleOn ? Math.max(maxMs, opts.idleMs) : maxMs;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  // Set once the race is decided either way, so a late activity() from an
  // abandoned call cannot re-arm a timer after the watchdog is done.
  let settled = false;
  // Whether fn has reported progress yet, and whether the cap came due while it
  // had not (see the cap timer below).
  let progressed = false;
  let capPassed = false;
  let trip!: (err: TurnTimeoutError) => void;
  const timeout = new Promise<never>((_, reject) => {
    trip = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      // Reject before tearing down: onTimeout (provider.close()) may reject the
      // in-flight call synchronously, and the race must settle on the timeout,
      // not on that teardown error, or the caller never sees TurnTimeoutError.
      reject(err);
      void Promise.resolve(opts.onTimeout?.()).catch(() => {});
    };
  });
  const armIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => trip(new TurnTimeoutError(opts.idleMs, 'idle')), opts.idleMs);
  };
  const activity = (): void => {
    if (settled) return;
    progressed = true;
    if (capPassed) return trip(new TurnTimeoutError(capMs, 'max'));
    if (idleOn) armIdle();
  };
  if (idleOn) armIdle();
  if (maxOn) {
    maxTimer = setTimeout(() => {
      // The cap bounds a turn that is producing output. A call that has reported
      // nothing yet stays under the idle deadline alone; if it starts reporting
      // progress later, the cap applies at that moment.
      if (progressed) trip(new TurnTimeoutError(capMs, 'max'));
      else capPassed = true;
    }, capMs);
  }
  try {
    return await Promise.race([fn(activity), timeout]);
  } finally {
    settled = true;
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
  }
}

export interface StageDiagnosis {
  verdict: 'retry' | 'abort';
  reason: string;
  /** When retrying: concrete instructions to prepend to the next attempt. */
  guidance?: string;
  /** Tokens the diagnosis call itself spent, so the pipeline can fold them into
   *  the stage's cost total (F6). Absent when the call threw before a response. */
  usage?: { inputTokens: number; outputTokens: number };
}

/** Extract the first brace-balanced JSON object from text, tolerating quoting and
 * escaping, and interpret it as a StageDiagnosis. Anything unparseable is treated
 * as "abort" so an ambiguous diagnosis never loops the pipeline forever. */
export function parseDiagnosis(text: string | null): StageDiagnosis {
  if (!text) return { verdict: 'abort', reason: 'no diagnosis produced' };
  const start = text.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          const o = JSON.parse(text.slice(start, i + 1)) as Partial<StageDiagnosis>;
          const verdict = o.verdict === 'retry' ? 'retry' : 'abort';
          return {
            verdict,
            reason: typeof o.reason === 'string' ? o.reason : 'no reason given',
            ...(verdict === 'retry' && typeof o.guidance === 'string' && o.guidance.trim()
              ? { guidance: o.guidance.trim() }
              : {}),
          };
        } catch {
          break;
        }
      }
    }
  }
  return { verdict: 'abort', reason: 'diagnosis was not valid JSON' };
}

/** Compact, most-recent-last excerpt of a run's transcript for the diagnostician:
 * the last assistant message and the last few tool results, truncated. */
export async function transcriptExcerpt(transcriptDir: string, maxChars = 4000): Promise<string> {
  const p = path.join(transcriptDir, 'transcript.jsonl');
  if (!existsSync(p)) return '(no transcript)';
  let lines: string[];
  try {
    lines = (await readFile(p, 'utf8')).trim().split('\n');
  } catch {
    return '(transcript unreadable)';
  }
  const parts: string[] = [];
  for (const line of lines.slice(-12)) {
    try {
      const e = JSON.parse(line) as { type: string; data?: Record<string, unknown> };
      if (e.type === 'assistant' && typeof e.data?.text === 'string' && e.data.text) {
        parts.push(`[assistant] ${e.data.text}`);
      } else if (e.type === 'tool') {
        parts.push(`[${String(e.data?.name)}] ${String(e.data?.result ?? '').split('\n')[0]}`);
      }
    } catch {
      /* skip */
    }
  }
  const joined = parts.join('\n');
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined;
}

/**
 * Deterministically re-probe every lib_id named in a failure narrative against
 * the installed libraries, so the diagnostician judges symbol-availability
 * claims from machine facts instead of the agent's prose. An agent that has
 * been dead-ended by wrong library nicknames concludes — and records — that
 * whole libraries are absent when they are installed; a refusal built on that
 * premise reads exactly like a genuine environmental gap, and the one thing
 * that distinguishes them is re-checking the named lib_ids, which costs no
 * LLM turn. Never throws; on any probe error it reports what it could.
 */
export async function symbolAvailabilityFacts(text: string, dirs?: string[], cap = 8): Promise<string> {
  const ids: string[] = [];
  // A library nickname is its `.kicad_sym` filename stem, so it can carry `-`
  // and `.` as well as `_` (`Custom-Parts`, `MyCorp.RF`) — a nickname the regex
  // truncates is probed as the wrong lib_id and reported absent, which is the
  // false negative this whole fact block exists to prevent. Separators are
  // interior only, so a trailing sentence period is not swallowed.
  for (const m of text.matchAll(/\b([A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?):([A-Za-z0-9][A-Za-z0-9_.+-]*)/g)) {
    const lib = m[1]!;
    const name = m[2]!;
    // Require letters on both sides: drops file:line refs ("create.ts:311"),
    // times and bare numbers. Engine-generated power symbols are not library
    // facts.
    if (!/[A-Za-z]/.test(lib) || !/[A-Za-z]/.test(name) || lib === 'copperhead_power') continue;
    const libId = `${lib}:${name}`;
    if (!ids.includes(libId)) ids.push(libId);
  }
  if (!ids.length) return '';
  // Collection is unbounded but probing is capped, so a probe-heavy transcript
  // stays cheap. The overflow is named rather than dropped: the supervisor is
  // told these facts are ground truth, and silently probing 8 of 30 lib_ids
  // would let it read "unprobed" as "absent".
  const probed = ids.slice(0, cap);
  const unprobed = ids.slice(cap);
  let searchDirs: string[];
  try {
    searchDirs = dirs ?? (await symbolSearchDirs());
  } catch {
    return '';
  }
  if (!searchDirs.length) return '';
  // A directory with no readable library means nothing was checked: emitting
  // "not installed" lines as ground truth from that state is the exact false
  // absence this block exists to prevent (same guard as bomSymbolDossier).
  if (!(await listInstalledLibraries(searchDirs)).size) return '';
  const lines: string[] = [];
  for (const libId of probed) {
    const name = libId.slice(libId.indexOf(':') + 1);
    try {
      const r = await resolveLibrarySymbol(libId, searchDirs);
      if (r.status === 'ok') {
        lines.push(`- ${libId}: RESOLVES on this machine (${r.pins.length} pins)`);
      } else if (r.status === 'found-elsewhere') {
        // The resolver already located the part under another lib_id; saying
        // "not installed" here would be the exact false absence claim this
        // block exists to prevent.
        lines.push(`- ${libId}: not at that lib_id, but installed as: ${r.libIds.slice(0, 4).join(', ')}`);
      } else {
        const elsewhere = await searchInstalledSymbols(name, searchDirs, 4);
        const inThat =
          r.status === 'no-symbol' && r.candidates.length
            ? ` (closest in that library: ${r.candidates.slice(0, 4).join(', ')})`
            : '';
        const where = elsewhere.length
          ? `; installed as: ${elsewhere.join(', ')}`
          : `; no installed symbol matches "${name}" in any library`;
        lines.push(
          r.status === 'no-symbol'
            ? `- ${libId}: not in that library${inThat}${where}`
            : `- ${libId}: no library of that nickname is installed${where}`,
        );
      }
    } catch {
      // a single unreadable library must not sink the fact block
    }
  }
  if (!lines.length) return '';
  if (unprobed.length) {
    lines.push(
      `- NOT RE-PROBED (probe limit ${cap}): ${unprobed.join(', ')} — these were named in the text but not checked, so nothing above says whether they exist.`,
    );
  }
  return lines.join('\n');
}

/**
 * Ask the model whether a failed/incomplete stage is worth retrying, and if so
 * how. Uses a fresh, tool-less provider turn (the same saved-login backend the
 * pipeline runs on), so no extra credentials or config are needed. Any error or
 * ambiguity resolves to "abort" — recovery must fail safe toward reporting to the
 * human rather than looping.
 */
export async function diagnoseStageFailure(
  provider: Provider,
  input: {
    stageName: string;
    stageGoal: string;
    failure: string;
    excerpt: string;
    attempt: number;
    maxAttempts: number;
    /** Deterministic re-probe results for lib_ids named in the failure/excerpt
     *  (`symbolAvailabilityFacts`); authoritative over the transcript's claims. */
    symbolFacts?: string;
  },
): Promise<StageDiagnosis> {
  const system =
    'You are the recovery supervisor for an automated KiCad PCB-design pipeline. ' +
    'A stage just failed or ended without meeting its completion contract. Judge whether ' +
    'another automated attempt is likely to succeed, or whether a human should intervene. ' +
    'Be decisive and terse.';
  const user =
    `Stage: ${input.stageName}\n` +
    `Stage goal: ${input.stageGoal}\n` +
    `Failure: ${input.failure}\n` +
    `This was attempt ${input.attempt} of ${input.maxAttempts}.\n\n` +
    `Recent transcript (most recent last):\n${input.excerpt}\n\n` +
    (input.symbolFacts
      ? `Machine-verified symbol facts — a deterministic re-probe of the lib_ids named above, run just now against this machine's installed KiCad libraries. Each line reported below is ground truth and overrides anything the transcript claims about that symbol's availability. Coverage may be partial: a lib_id listed as NOT RE-PROBED, or absent from this block entirely, is unknown, never confirmed absent.\n${input.symbolFacts}\n\n`
      : '') +
    'Reply with ONLY a JSON object, no prose:\n' +
    '{"verdict":"retry"|"abort","reason":"<one sentence>","guidance":"<if retry: concrete, specific instructions to prepend to the next attempt so it avoids this failure; otherwise empty>"}\n' +
    '- "retry" if the failure looks transient or fixable with clearer instructions (a dropped or locked tool call, an empty/no-op edit, a skipped step, a hung provider call that timed out, a formatting slip).\n' +
    '- a turn stopped at the hard time cap while still producing output (turnMaxMs, "too large, not hung") is NOT transient: repeating it hits the cap again. Retry only with guidance that splits that work into several smaller edits (e.g. one part or one sheet section per edit).\n' +
    '- "abort" if repeating the same attempt will not help and a human should look (missing inputs, a genuine dead-end, or the same failure already seen on a prior attempt).\n' +
    '- an agent\'s claim that a symbol or library is absent is NOT evidence: agents dead-ended by wrong library nicknames routinely conclude whole libraries are missing. If the machine-verified facts contradict the failure\'s premise (a cited-absent lib_id RESOLVES, or the part is installed under another library), the verdict is "retry", with guidance quoting the correct lib_ids.';
  const messages: Msg[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  try {
    const turn = await provider.chat(messages, []);
    return { ...parseDiagnosis(turn.text), usage: turn.usage };
  } catch (e) {
    return { verdict: 'abort', reason: `diagnosis call failed: ${(e as Error).message}` };
  }
}
