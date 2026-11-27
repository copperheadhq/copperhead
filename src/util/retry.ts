export interface RetryOpts {
  retries?: number;
  baseMs?: number;
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function isRateLimit(err: unknown): boolean {
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  return status === 429;
}

/**
 * What a saved-login provider knows about the limit it hit, attached to the
 * error it throws as `sessionLimit` (session-limit-names-account D1). Every
 * field is optional: a provider reports what its SDK told it and nothing more.
 */
export interface SessionLimitFacts {
  /** The account that was logged in when the limit hit (its email, or its organization). */
  account?: string | null;
  /** The exact reset moment, in milliseconds since the epoch. */
  resetsAtMs?: number | null;
  /** The provider's name for the limit's window, e.g. `five_hour` or `seven_day`. */
  window?: string | null;
}

export interface SessionLimit {
  /** When the limit resets, for a person to read: `2026-11-11 10:10 UTC` when the
   *  provider gave the exact moment, else its clock text as stated (e.g. "1:40pm",
   *  which carries no time zone), or null when no time was given. */
  resetsAt: string | null;
  /** The exact reset moment as an ISO 8601 UTC timestamp, or null when only clock text is known. */
  resetsAtIso: string | null;
  /** The account that hit the limit, or null when the provider did not say. */
  account: string | null;
  /** The limit's window as the provider names it, or null. */
  window: string | null;
}

/** `2026-11-11T10:10:00.000Z` as `2026-11-11 10:10 UTC`. */
function utcMinute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** A word for a provider's window name: `five_hour` reads `5-hour`. */
export function limitWindowLabel(window: string | null): string | null {
  if (!window) return null;
  if (window === 'five_hour') return '5-hour';
  if (window.startsWith('seven_day')) return 'weekly';
  return window.replace(/_/g, ' ');
}

/**
 * Detect a saved-login SESSION / USAGE limit (claude-code, codex), distinct from
 * an HTTP 429 rate limit and from a code bug (2.4, I13). It is not a transient
 * blip to back off on: it names its own reset time and clears only then. Because
 * every completed turn is already in `.copperhead/llm-cache/`, re-running after
 * the reset replays them at ~0 tokens and resumes in place — so the right
 * handling is a schedulable pause with the reset time surfaced, not a bare
 * "provider error". Returns null when the error is not a session/usage limit.
 *
 * The limit belongs to the account that was logged in, so the facts a provider
 * attached to the error (`sessionLimit`: the account, the exact reset moment,
 * the window) are preferred, and the message's clock text is the fallback
 * (session-limit-names-account D2).
 */
export function sessionLimit(err: unknown): SessionLimit | null {
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  if (status === 429) return null; // a real rate limit: handled by backoff, not a pause
  const msg = (err as Error)?.message ?? '';
  if (!/(session|usage|weekly)\s+limit|hit your .*limit|reached your usage|limit .*reset/i.test(msg)) {
    return null;
  }
  const facts = (err as { sessionLimit?: SessionLimitFacts } | null)?.sessionLimit ?? {};
  const exact = typeof facts.resetsAtMs === 'number' && Number.isFinite(facts.resetsAtMs) && facts.resetsAtMs > 0;
  const resetsAtIso = exact ? new Date(facts.resetsAtMs as number).toISOString() : null;
  // "resets 1:40pm", "resets at 1:40 pm", "reset at 13:40" — capture the clock text.
  const reset = msg.match(/reset[s]?(?:\s+at)?\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)/i);
  return {
    resetsAt: resetsAtIso ? utcMinute(resetsAtIso) : reset?.[1]?.trim() ?? null,
    resetsAtIso,
    account: facts.account?.trim() || null,
    window: facts.window?.trim() || null,
  };
}

/**
 * What a run that stopped on a session/usage limit tells the person
 * (session-limit-names-account D3): whose limit it is, when it resets and in
 * which time zone, and that a re-run can go ahead at once under another login.
 */
export function sessionLimitMessage(provider: string, limit: SessionLimit): string {
  const window = limitWindowLabel(limit.window);
  const reset = limit.resetsAtIso
    ? `resets ${limit.resetsAt}`
    : limit.resetsAt
      ? `resets ${limit.resetsAt} as the provider stated it, with no time zone`
      : null;
  const detail = [window ? `${window} limit` : null, reset].filter(Boolean).join(', ');
  const whose = limit.account
    ? ` on ${limit.account}`
    : '';
  const owner = limit.account
    ? `The limit belongs to that account.`
    : `The limit belongs to the account that was logged in when it hit.`;
  return (
    `${provider} session/usage limit reached${whose}${detail ? ` (${detail})` : ''}. This is a schedulable pause, not a bug. ` +
    `${owner} If you have switched ${provider} to another account, re-run the same command now; otherwise re-run it after the reset. ` +
    `Completed turns replay from the cache at ~0 tokens and the run resumes where it left off.`
  );
}

/** Exponential backoff ×N for rate limits (SPEC §4.5). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const baseMs = opts.baseMs ?? 1000;
  const isRetryable = opts.isRetryable ?? isRateLimit;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === retries) throw err;
      opts.onRetry?.(attempt + 1, err);
      await sleep(baseMs * 2 ** attempt);
    }
  }
  throw lastErr;
}
