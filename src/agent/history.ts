import type { Msg, ToolCall } from './types.js';

/**
 * Shrinks what a turn actually sends the model, without changing what the run
 * recorded.
 *
 * Every provider re-sends the whole conversation on every turn (the claude-code
 * provider flattens it with `renderConversation`; the keyed providers post the
 * full `messages` array), so an untrimmed history costs roughly quadratically in
 * turns. The schematic stage is where that bites: a `.kicad_sch` is tens of kB,
 * the model reads it repeatedly, and every stale copy is re-billed on every
 * later turn. Measured create runs spent 40–48k output tokens per stage, most of
 * it re-sent history rather than new work.
 *
 * Two invariants make this safe to drop in front of any provider:
 *
 * 1. **Length, order, roles, and ids are preserved exactly.** Only `content`
 *    strings (and oversized tool-call argument strings) shrink. The claude-code
 *    session-resume path slices by index (`renderDelta(messages, sentCount)`,
 *    with `sentCount = messages.length`), and every provider pairs a `tool`
 *    message to its call by `toolCallId` - both break if messages are dropped or
 *    reordered, so capping never does either.
 * 2. **The transcript is untouched.** Capping builds a view for the request; the
 *    JSONL transcript and the obligations ledger still see full fidelity, so a
 *    postmortem loses nothing. The view is structurally independent (fresh
 *    message objects, tool-call arrays, and argument objects), so a provider
 *    that mutates what it is handed cannot reach the run's history through it.
 *
 * Trimming is always announced in-band. A truncated result says how much was cut
 * and how to get it back (`read_file` with a line range), because a model that
 * cannot tell "this file is short" from "this file was clipped" will confidently
 * reason about content it never saw.
 */
export interface HistoryCapOptions {
  /** Longest single tool result kept verbatim, in characters. */
  maxToolResultChars: number;
  /** Longest single tool-call argument string kept verbatim, in characters. */
  maxToolArgChars: number;
  /**
   * How many messages at the end of the conversation are never *truncated*. The
   * current state of the work lives here, so recent output goes over the wire
   * verbatim.
   *
   * Supersession deliberately ignores this window: dropping a read that a later
   * read of the same path already replaced is safe at any distance, because the
   * replacement is itself in the conversation. Protecting stale reads by recency
   * would shield exactly the largest items - a 30kB schematic re-read two turns
   * ago - which is most of the cost this exists to remove.
   */
  keepRecent: number;
}

export const HISTORY_CAP_DEFAULTS: HistoryCapOptions = {
  // Comfortably fits a normal file read and every report kicad-cli produces,
  // while clipping the multi-tens-of-kB schematic reads that drive the blowup.
  maxToolResultChars: 4000,
  // An anchored KiCad edit is the big one: `new_string` can carry a whole
  // subsystem of s-expressions. Once applied, the payload is in the file, so a
  // settled call does not need to keep restating it.
  maxToolArgChars: 2000,
  // Two full turns' worth of assistant + tool-result traffic, so the model
  // always retains the edit it just made and the report it just read.
  keepRecent: 12,
};

/** Result of one capping pass, for the run's efficiency accounting. */
export interface HistoryCapStats {
  /** Characters removed from what the provider was sent. */
  charsSaved: number;
  /** Tool results replaced because a newer read of the same path exists. */
  superseded: number;
  /** Oversized results and arguments clipped in place. */
  truncated: number;
}

/**
 * Head/tail-preserving clip: the shape of a file matters as much as its start.
 *
 * The marker counts against `max`, so the result is never longer than the cap
 * and therefore never longer than the input (this only runs when the input
 * already exceeds the cap). Without that reservation a barely-oversized value
 * would come back *larger* than it went in, and `charsSaved` would go negative.
 */
function clip(text: string, max: number, note: string): string {
  if (text.length <= max) return text;
  const marker = (cut: number): string => `\n\n... [${cut} characters elided: ${note}] ...\n\n`;
  // Reserve using the largest count the marker could ever print, so the
  // reservation can never come up short once the real count is known.
  const reserve = marker(text.length).length;
  const keep = max - reserve;
  // A cap too small to hold the marker plus any content cannot be clipped
  // usefully; sending the value whole beats sending a marker and nothing else.
  if (keep <= 0) return text;
  const head = Math.floor(keep * 0.6);
  const tail = keep - head;
  return `${text.slice(0, head)}${marker(text.length - keep)}${text.slice(text.length - tail)}`;
}

/** The path a tool call operated on, when it names one. */
function pathOf(call: ToolCall): string | null {
  const p = call.args?.path;
  return typeof p === 'string' && p ? p : null;
}

/**
 * The line span a `read_file` call actually returned, or `null` when it cannot
 * be determined.
 *
 * `read_file` takes optional `start_line`/`end_line` and returns only that
 * range, so a read is not identified by its path alone. Treating an absent
 * bound as the end of the file makes a whole-file read `[1, Infinity]`, which
 * then compares against ranged reads with ordinary interval containment.
 *
 * The `read_file` handler normalizes both bounds to a finite number or drops
 * them, so on the live path a bound is only ever a finite number or absent.
 * A bound that is nonetheless present and non-numeric (a hand-built history, a
 * future caller that skips the handler) is treated as an unknown span (`null`):
 * a read of unknown extent supersedes nothing and is superseded by nothing —
 * the conservative direction, the same one failed reads take. Modelling it as
 * `[1, Infinity]` instead is the unsafe guess that let a partial read stand in
 * for a whole-file one.
 */
function rangeOf(call: ToolCall): { start: number; end: number } | null {
  const s = call.args?.start_line;
  const e = call.args?.end_line;
  const bad = (v: unknown): boolean => v !== undefined && (typeof v !== 'number' || !Number.isFinite(v));
  if (bad(s) || bad(e)) return null;
  // Mirror `toolReadFile` exactly: it returns the whole file whenever
  // `start_line` is absent, ignoring `end_line`. Modelling that read as
  // `[1, end_line]` would understate what it actually returned and could let a
  // later, genuinely narrower read supersede it.
  if (typeof s !== 'number') return { start: 1, end: Infinity };
  return { start: s, end: typeof e === 'number' ? e : Infinity };
}

/** Every message returned gets fresh objects, so a provider that mutates what it
 *  is handed cannot reach the run's own history. Strings are immutable and
 *  shared by reference, so this costs object shells, not payload bytes. */
function copyMsg(m: Msg): Msg {
  if (m.role === 'assistant' && m.toolCalls) {
    return { ...m, toolCalls: m.toolCalls.map((c) => ({ ...c, args: { ...c.args } })) };
  }
  return { ...m };
}

/**
 * Build the capped view of a conversation.
 *
 * Returns a new array; the input is never mutated. Callers pass the result
 * straight to `provider.chat` and keep the original for the transcript.
 */
export function capHistory(
  messages: Msg[],
  opts: HistoryCapOptions = HISTORY_CAP_DEFAULTS,
): { messages: Msg[]; stats: HistoryCapStats } {
  const stats: HistoryCapStats = { charsSaved: 0, superseded: 0, truncated: 0 };
  // Below the protected window nothing can be truncated; supersession can still
  // fire, but it needs at least two reads of one path to have anything to do, so
  // a short conversation is returned untouched either way.
  const truncateBefore = messages.length - opts.keepRecent;
  // Still a fresh array: the contract is that callers may hand the result to a
  // provider without it becoming an alias for the run's own history.
  if (messages.length <= 2) return { messages: messages.map(copyMsg), stats };

  // Pair each tool result back to the call that produced it. Providers key this
  // by id, and only the assistant message carries the tool name and arguments.
  const callById = new Map<string, ToolCall>();
  for (const m of messages) {
    if (m.role === 'assistant') for (const c of m.toolCalls ?? []) callById.set(c.id, c);
  }

  // A call is settled once its result is in the conversation. Only a settled
  // call's arguments may be clipped: the justification for clipping them is
  // that the call already ran and its effect is on disk, which is exactly what
  // an unsettled call has not done yet.
  const settled = new Set<string>();
  for (const m of messages) if (m.role === 'tool') settled.add(m.toolCallId);

  // Every `read_file` result, with the span it actually returned. A read is
  // superseded only by a LATER read of the same path whose span CONTAINS it:
  // `read_file` honours start_line/end_line, so a later 20-line read does not
  // reproduce an earlier whole-file read, and dropping the earlier one would
  // delete content the model can still legitimately be relying on. Whole-file
  // reads are `[1, Infinity]`, so "both are whole-file reads" falls out of the
  // same containment test rather than needing a case of its own.
  const readsByPath = new Map<string, { at: number; start: number; end: number }[]>();
  messages.forEach((m, i) => {
    if (m.role !== 'tool') return;
    const call = callById.get(m.toolCallId);
    if (!call || call.name !== 'read_file') return;
    // A read that failed returned no content, so it cannot stand in for one
    // that succeeded; letting it supersede would swap real file content for a
    // stub pointing at a read the model never actually received. The loop
    // records this from the dispatch outcome, so a file that merely *looks*
    // like an error message is not mistaken for one.
    if (m.failed) return;
    const p = pathOf(call);
    if (!p) return;
    const span = rangeOf(call);
    // A read whose span cannot be determined stands in for nothing and is
    // stood in for by nothing, so it is simply not a supersession candidate.
    if (!span) return;
    const list = readsByPath.get(p);
    if (list) list.push({ at: i, start: span.start, end: span.end });
    else readsByPath.set(p, [{ at: i, start: span.start, end: span.end }]);
  });

  /** True when some later read of `path` fully contains the span read at `at`. */
  const isSuperseded = (path: string, at: number, start: number, end: number): boolean =>
    (readsByPath.get(path) ?? []).some((r) => r.at > at && r.start <= start && r.end >= end);

  const out = messages.map((m, i) => {
    if (m.role === 'tool') {
      const call = callById.get(m.toolCallId);
      const p = call ? pathOf(call) : null;
      const span = call ? rangeOf(call) : null;
      // Supersession runs at any distance: a later read that covers this span is
      // already in this conversation, so the older copy is redundant, not lost.
      if (call?.name === 'read_file' && p && span && isSuperseded(p, i, span.start, span.end)) {
        const stub = `[superseded: this earlier read of ${p} was replaced by a later read covering the same lines. Use the newer one, or call read_file again for the current contents.]`;
        if (stub.length < m.content.length) {
          stats.charsSaved += m.content.length - stub.length;
          stats.superseded++;
          return { ...m, content: stub };
        }
        return m;
      }
      if (i >= truncateBefore) return m; // recent: never clipped
      const capped = clip(
        m.content,
        opts.maxToolResultChars,
        `re-run this tool, or read_file with start_line/end_line, to see the full output`,
      );
      if (capped !== m.content) {
        stats.charsSaved += m.content.length - capped.length;
        stats.truncated++;
        return { ...m, content: capped };
      }
      return m;
    }

    if (m.role === 'assistant' && m.toolCalls?.length && i < truncateBefore) {
      let changed = false;
      const toolCalls = m.toolCalls.map((c) => {
        // An unsettled call's arguments are still the instruction the provider
        // is acting on, so they go over the wire intact.
        if (!settled.has(c.id)) return c;
        const args: Record<string, unknown> = {};
        let touched = false;
        for (const [k, v] of Object.entries(c.args ?? {})) {
          if (typeof v === 'string' && v.length > opts.maxToolArgChars) {
            // This call already executed; its effect is on disk. Restating the
            // whole payload every later turn buys nothing.
            const capped = clip(v, opts.maxToolArgChars, `already applied by this call`);
            // `clip` returns the value unchanged when the cap is too small to
            // hold a marker; guard the accounting the same way the result
            // branch does, so a no-op clip is not counted as a truncation.
            if (capped !== v) {
              stats.charsSaved += v.length - capped.length;
              stats.truncated++;
              args[k] = capped;
              touched = true;
            } else {
              args[k] = v;
            }
          } else {
            args[k] = v;
          }
        }
        if (!touched) return c;
        changed = true;
        return { ...c, args };
      });
      return changed ? { ...m, toolCalls } : m;
    }

    return m;
  });

  // Copy last, uniformly: the branches above hand back the input object for any
  // message they chose not to trim, and those are exactly the ones a provider
  // could otherwise mutate straight into the run's history.
  return { messages: out.map(copyMsg), stats };
}
