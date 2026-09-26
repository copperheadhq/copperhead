import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from '../util/redact.js';
import type { ChatOpts, Msg, Provider, ToolSchema, Turn } from './types.js';

/** A cached tool call must replay byte-for-byte; redact it by declining to
 * persist it, never by changing arguments the loop will later execute. */
function containsSecrets(serialized: string): boolean {
  if (redactSecrets(serialized) !== serialized) return true;
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8 || !/_(KEY|SECRET|TOKEN)$/.test(name)) continue;
    // JSON escapes quotes, newlines, and backslashes inside string values.
    if (serialized.includes(JSON.stringify(value).slice(1, -1))) return true;
  }
  return false;
}

/**
 * Wraps a provider so each turn's `(messages, tools) -> Turn` is written to disk
 * and replayed on an identical later call. This makes the pipeline cheap and
 * fast to recover: a stage that is retried after a transient failure (a timed-out
 * turn, a crash, an auto-retry) replays the responses it already paid for, from
 * turn 1 up to the point where the inputs first diverge, instead of re-calling
 * the model. When a retry deliberately changes the prompt (e.g. diagnosis
 * guidance is appended), the input hash changes and the model is called fresh —
 * so caching never pins a run to a stale, failing response.
 *
 * Best-effort by construction: a cache miss or any I/O error falls through to the
 * live provider, and a hit reports zero token usage (the real spend was zero).
 * The key is a content hash of the full message history and the advertised tool
 * schemas and descriptions, so a changed contract always makes a fresh call.
 * Turns containing recognizable secrets are returned normally but never cached.
 */
export class CachingProvider implements Provider {
  readonly name: string;
  private hits = 0;

  /** Turns served from the on-disk cache so far (5.2: per-stage cache-hit%). */
  get cacheHits(): number {
    return this.hits;
  }

  constructor(
    private readonly inner: Provider,
    private readonly dir: string,
    private readonly log?: (s: string) => void,
    /** The concrete model id this run resolved to (e.g. `claude-code:opus`), used
     *  in the cache key so switching model on the same repo does not replay the
     *  other model's cached turns (F6). Falls back to the provider family name. */
    private readonly modelId?: string,
    /** The compat endpoint's base URL, if any. A model id like `compat:llama-3.1-8b-instant`
     *  is not unique across hosts (Groq, OpenRouter, etc. all serve overlapping model
     *  ids), so the endpoint must be part of the key too, or two different hosts
     *  serving "the same" model id would share cached turns. */
    private readonly baseURL?: string,
  ) {
    this.name = inner.name;
  }

  private keyFor(messages: Msg[], tools: ToolSchema[]): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          model: this.modelId ?? this.name,
          // Endpoint identity only applies to compatible-endpoint providers.
          ...(this.baseURL ? { baseURL: this.baseURL } : {}),
          messages,
          tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
        }),
      )
      .digest('hex');
  }

  async chat(messages: Msg[], tools: ToolSchema[], opts?: ChatOpts): Promise<Turn> {
    const file = path.join(this.dir, `${this.keyFor(messages, tools)}.json`);
    if (existsSync(file)) {
      try {
        const cached = JSON.parse(await readFile(file, 'utf8')) as Turn;
        if (containsSecrets(JSON.stringify(cached))) {
          // An older writer may have persisted a secret. Discard this derived
          // entry rather than replaying it or leaving it on disk after a read.
          await unlink(file);
        } else {
          this.hits++;
          this.log?.(`llm-cache: replayed a cached response (hit #${this.hits}, no tokens spent)`);
          // Report zero usage: replaying a cached turn costs nothing.
          return { ...cached, usage: { inputTokens: 0, outputTokens: 0 } };
        }
      } catch {
        // corrupt/partial cache file — fall through and regenerate
      }
    }
    const turn = await this.inner.chat(messages, tools, opts);
    try {
      const serialized = JSON.stringify(turn);
      if (containsSecrets(serialized)) return turn;
      await mkdir(this.dir, { recursive: true });
      // Keep the cache out of git entirely (and out of failed-run stashes): a
      // `*` .gitignore in the cache dir hides every entry, so the cache persists
      // across runs without ever dirtying the tree.
      const ignore = path.join(this.dir, '.gitignore');
      if (!existsSync(ignore)) await writeFile(ignore, '*\n', 'utf8');
      await writeFile(file, serialized, 'utf8');
    } catch {
      // best-effort: caching must never break a run
    }
    return turn;
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }
}
