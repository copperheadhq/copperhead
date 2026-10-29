import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { resolveInRepo, isKicadFile } from '../util/paths.js';
import { SEARCH_WORKER_SOURCE, type SearchWorkerRequest } from './search-worker.js';

export async function toolReadFile(
  repoRoot: string,
  p: string,
  startLine?: number,
  endLine?: number,
): Promise<string> {
  const abs = resolveInRepo(repoRoot, p);
  const text = await readFile(abs, 'utf8');
  if (startLine === undefined) return text;
  const lines = text.split('\n');
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, endLine ?? lines.length);
  return lines
    .slice(from - 1, to)
    .map((l, i) => `${from + i}: ${l}`)
    .join('\n');
}

/** New files only; refuses to overwrite anything and to create KiCad files (SPEC §4.2). */
export async function toolWriteFile(repoRoot: string, p: string, content: string): Promise<string> {
  const abs = resolveInRepo(repoRoot, p);
  if (isKicadFile(abs)) {
    throw new Error(`write_file refuses KiCad files (${p}); use edit_file with anchors instead`);
  }
  if (existsSync(abs)) {
    throw new Error(`write_file refuses to overwrite existing file ${p}; use edit_file`);
  }
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
  return `wrote ${p}`;
}

/**
 * Exact-match anchored replace; fails with an actionable error unless unique.
 * `replaceAll` replaces every occurrence (the rename case, AC-3.1) while still
 * being a surgical text edit on the s-expression source.
 */
export async function toolEditFile(
  repoRoot: string,
  p: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): Promise<string> {
  const abs = resolveInRepo(repoRoot, p);
  const text = await readFile(abs, 'utf8');
  const first = text.indexOf(oldString);
  if (first === -1) {
    throw new Error(`edit_file: anchor not found in ${p}; re-read the file and use an exact excerpt`);
  }
  const count = text.split(oldString).length - 1;
  if (replaceAll) {
    await writeFile(abs, text.split(oldString).join(newString), 'utf8');
    return `edited ${p} (${count} occurrence(s) replaced)`;
  }
  if (count > 1) {
    throw new Error(
      `edit_file: anchor matched ${count} times in ${p}; widen the anchor with surrounding lines until it is unique, or pass replace_all: true to replace every occurrence`,
    );
  }
  await writeFile(abs, text.slice(0, first) + newString + text.slice(first + oldString.length), 'utf8');
  return `edited ${p}`;
}

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.copperhead']);

/**
 * Longest match line returned to the model, in characters.
 *
 * The file-size bound in `toolSearch` (5 MB) bounds the file, not the line, and
 * on a one-object-per-line document those are very different limits. A
 * `transcript.jsonl` line is an entire `{ts, type, data}` record with tool
 * output inline, so a few matches inside one file can be hundreds of thousands
 * of tokens. A live run died on exactly that — `Prompt is too long · the
 * request is ~1003121 tokens (limit 1000000) but this conversation is only
 * ~403383 tokens`, the balance being search results — and it cost a stage
 * attempt. The agent had done nothing wrong: it searched the repo it was told
 * to work in, and a `run-logs/` directory happened to be sitting in it.
 *
 * A match is a pointer, not a payload — enough to see the hit and decide
 * whether to read the file. Truncation is marked so a clipped line is
 * distinguishable from a short one.
 */
const MAX_MATCH_CHARS = 400;

export function globToRegex(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?'; // zero or more directories
      i += 2;
    } else if (glob.startsWith('**', i)) {
      out += '.*';
      i += 1;
    } else if (glob[i] === '*') {
      out += '[^/]*';
    } else if (glob[i] === '?') {
      out += '.';
    } else {
      out += glob[i]!.replace(/[.+^${}()|[\]\\]/, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}


/**
 * Longest pattern `toolSearch` accepts. Real search patterns are short; the cap
 * only rejects a pathological or abusive input before it reaches the worker.
 */
export const MAX_SEARCH_PATTERN_CHARS = 1000;

/** Wall-clock budget for one search, in milliseconds. */
export const DEFAULT_SEARCH_BUDGET_MS = 2000;

/**
 * Worker heap limits. A search never holds more than one 5 MB file plus a
 * bounded result list, so 64 MB is generous while still bounding the thread.
 */
const SEARCH_WORKER_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } as const;

export type SearchErrorCode = 'pattern-too-long' | 'invalid-pattern' | 'timeout' | 'worker-failed' | 'aborted';

/** A failed search. `code` distinguishes a bad pattern from a timed-out or dead worker. */
export class SearchError extends Error {
  constructor(
    message: string,
    readonly code: SearchErrorCode,
  ) {
    super(message);
    this.name = 'SearchError';
  }
}

/** A pattern whose evaluation exceeded the budget: the worker was terminated. */
export class SearchTimeoutError extends SearchError {
  constructor(budgetMs: number) {
    super(
      `search exceeded its ${budgetMs} ms time budget and was stopped; simplify the pattern ` +
        '(avoid nested quantifiers such as "(a+)+") or narrow it with a glob and try again',
      'timeout',
    );
    this.name = 'SearchTimeoutError';
  }
}

export interface SearchOptions {
  /** Override the default wall-clock budget (tests use a small value). */
  budgetMs?: number;
  /** Cancel a search in flight; the worker is terminated. */
  signal?: AbortSignal;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one search on a worker thread under a hard time budget. On success, on
 * failure, on timeout, and on cancellation the worker is terminated and its
 * listeners removed, so a wedged regex cannot outlive the call. Starting the
 * worker from the raw source (rather than a sibling module path) is what lets
 * the same code run from `dist/`, `tsx`, and vitest.
 */
function runSearchWorker(req: SearchWorkerRequest, budgetMs: number, signal?: AbortSignal): Promise<SearchMatch[]> {
  if (signal?.aborted) return Promise.reject(new SearchError('search cancelled before it started', 'aborted'));
  return new Promise<SearchMatch[]>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(SEARCH_WORKER_SOURCE, {
        eval: true,
        workerData: req,
        resourceLimits: SEARCH_WORKER_RESOURCE_LIMITS,
      });
    } catch (err) {
      reject(new SearchError(`search worker could not start: ${errorMessage(err)}`, 'worker-failed'));
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => finish(new SearchError('search cancelled', 'aborted'));

    function cleanup(): void {
      if (timer) clearTimeout(timer);
      timer = undefined;
      signal?.removeEventListener('abort', onAbort);
      worker.removeAllListeners();
      void worker.terminate();
    }
    function finish(err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }
    function succeed(matches: SearchMatch[]): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(matches);
    }

    worker.on('message', (msg: unknown) => {
      // The worker is self-controlled, but treat its output as untrusted: a
      // malformed message must fail closed, never throw out of this listener.
      if (typeof msg !== 'object' || msg === null) {
        finish(new SearchError('search worker sent a malformed message', 'worker-failed'));
        return;
      }
      const m = msg as { ok?: unknown; code?: unknown; message?: unknown; matches?: unknown };
      if (m.ok === true) {
        if (Array.isArray(m.matches)) succeed(m.matches as SearchMatch[]);
        else finish(new SearchError('search worker sent a malformed result', 'worker-failed'));
        return;
      }
      const detail = typeof m.message === 'string' && m.message.length > 0 ? m.message : 'unknown worker error';
      if (m.code === 'invalid-pattern') finish(new SearchError(`invalid search pattern: ${detail}`, 'invalid-pattern'));
      else finish(new SearchError(`search worker failed: ${detail}`, 'worker-failed'));
    });
    worker.on('error', (err) => finish(new SearchError(`search worker failed: ${errorMessage(err)}`, 'worker-failed')));
    worker.on('exit', (code) => {
      // A zero exit is not itself a failure: the success message may still be in
      // flight (settled wins either way), and the budget catches a worker that
      // exited without posting anything.
      if (code !== 0) finish(new SearchError(`search worker exited before returning results (code ${code})`, 'worker-failed'));
    });

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    // Close the check-to-register race: an AbortSignal is one-shot, so an abort
    // that landed in the window above would never fire its event. Re-checking
    // here settles through the same cleanup, leaving no worker behind.
    if (signal?.aborted) {
      finish(new SearchError('search cancelled before it started', 'aborted'));
      return;
    }
    timer = setTimeout(() => finish(new SearchTimeoutError(budgetMs)), budgetMs);
  });
}

/**
 * ripgrep-style regex search implemented natively (no rg dependency). The
 * pattern is evaluated on a worker thread under a hard time budget so a
 * catastrophic pattern fails closed instead of hanging the process (issue
 * #366). `SearchError` subclasses carry the reason.
 */
export async function toolSearch(
  repoRoot: string,
  pattern: string,
  glob?: string,
  maxMatches = 200,
  opts: SearchOptions = {},
): Promise<SearchMatch[]> {
  if (pattern.length > MAX_SEARCH_PATTERN_CHARS) {
    throw new SearchError(
      `search pattern rejected: ${pattern.length} characters exceeds the ${MAX_SEARCH_PATTERN_CHARS}-character limit; narrow the pattern`,
      'pattern-too-long',
    );
  }
  const req: SearchWorkerRequest = {
    repoRoot,
    pattern,
    globSource: glob ? globToRegex(glob).source : null,
    maxMatches,
    maxMatchChars: MAX_MATCH_CHARS,
  };
  return runSearchWorker(req, opts.budgetMs ?? DEFAULT_SEARCH_BUDGET_MS, opts.signal);
}
