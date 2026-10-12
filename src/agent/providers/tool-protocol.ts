import type { Msg, ToolCall, ToolSchema, UndispatchedCalls } from '../types.js';

export function renderToolProtocol(tools: ToolSchema[]): string {
  if (!tools.length) return '';
  const lines = [
    '# Tool protocol',
    '',
    'You are the reasoning half of a tool-driven workflow; you cannot run anything yourself.',
    'To take an action, reply with EXACTLY ONE JSON object and nothing else, wrapped in a',
    '```json fenced code block:',
    '',
    '```json',
    '{"tool": "<tool_name>", "args": { ... }}',
    '```',
    '',
    'Use only the tools listed below, with `args` matching the tool\'s JSON Schema. If you have',
    'no tool to call and only want to say something, reply with plain prose and no JSON block.',
    '',
    '## Available tools',
  ];
  for (const t of tools) {
    lines.push(
      '',
      `### ${t.name}`,
      t.description,
      `Parameters (JSON Schema): ${JSON.stringify(t.parameters)}`,
    );
  }
  return lines.join('\n');
}

/** Delta prompt for a resumed CLI session: new user lines and tool results only. */
export function renderDelta(messages: Msg[], from: number): string {
  const idToName = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'assistant') for (const call of m.toolCalls ?? []) idToName.set(call.id, call.name);
  }
  const parts: string[] = [];
  for (const m of messages.slice(Math.max(0, from))) {
    if (m.role === 'user') {
      parts.push(`[user]\n${m.content}`);
    } else if (m.role === 'tool') {
      const name = idToName.get(m.toolCallId) ?? m.toolCallId;
      parts.push(`[result of ${name}]\n${m.content}`);
    }
  }
  return parts.join('\n\n');
}

export function renderConversation(messages: Msg[]): string {
  const idToName = new Map<string, string>();
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      parts.push(`[user]\n${m.content}`);
    } else if (m.role === 'assistant') {
      if (m.content) parts.push(`[assistant]\n${m.content}`);
      for (const call of m.toolCalls ?? []) {
        idToName.set(call.id, call.name);
        parts.push(
          `[assistant tool call]\n\`\`\`json\n${JSON.stringify({ tool: call.name, args: call.args })}\n\`\`\``,
        );
      }
    } else {
      const name = idToName.get(m.toolCallId) ?? m.toolCallId;
      parts.push(`[result of ${name}]\n${m.content}`);
    }
  }
  return parts.join('\n\n');
}

export interface ParsedToolTurn {
  text: string | null;
  toolCalls: ToolCall[];
  nudge?: string;
  /** Set when the reply wrote harness-only blocks and its tail was discarded (#320). */
  notice?: string;
  /** The discarded tail, verbatim, for the transcript only; never sent back to the model. */
  discarded?: string;
  /** Calls left in the prose of a reply whose other calls ran (#306). */
  undispatched?: UndispatchedCalls;
}

/**
 * A line the harness writes and the model never may: a tool result or a user turn, in the
 * exact form `renderConversation` and `renderDelta` use. A model that continues past its
 * own tool call in that form is inventing the result (#320, register I15), so the reply is
 * cut at the first one.
 */
const HARNESS_MARKER = /^[ \t]*\[(?:result of [A-Za-z0-9_.:-]+|user)\][ \t]*\r?$/m;
const HARNESS_MARKER_ALL = new RegExp(HARNESS_MARKER.source, 'gm');
/** History markers that are harmless to write but must not be replayed as the model's prose. */
const ECHOED_MARKER_LINES = /^[ \t]*\[(?:assistant|assistant tool call)\][ \t]*\r?$\n?/gm;

/**
 * Detect a malformed-but-intended tool call in a turn that dispatched none
 * (#I10). The signature is machine-recognizable: the text contains
 * `"tool":"<name>"` naming a tool in the current catalog, yet nothing parsed.
 * That is the exact case where the tolerant extractor's silence misleads the
 * model — the JSON was near-miss malformed (a brace short, or the outer object
 * split so only an inner `{args}` with no `tool` key balanced), not the tool
 * being broken. Returns a one-line steer to re-emit it, or undefined when the
 * absence of a call is genuine (plain prose, no tool named).
 *
 * Also covers the mirror case (I18): well-formed JSON naming a tool that is NOT in
 * the catalog — withheld by the edit lock, or invented. That call is correctly not
 * dispatched, but it must not be silent either.
 */
function detectMalformedCall(text: string, catalog: Set<string>): string | undefined {
  const re = /"tool"\s*:\s*"([^"]+)"/g;
  const offCatalog: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const name = m[1]!;
    if (catalog.has(name)) {
      return (
        `A tool call for "${name}" looks malformed — it named the tool but did not parse as ` +
        'valid JSON (likely unbalanced braces or a missing closing brace), so no call ran. ' +
        'Re-emit it as exactly one complete JSON object: {"tool": "...", "args": { ... }}.'
      );
    }
    if (!offCatalog.includes(name)) offCatalog.push(name);
  }
  // A well-formed call naming a tool the turn did not advertise — a locked edit or
  // drafting tool before propose_change/validate_change, or an invented name.
  // `toToolCall` is right to refuse it (the lock is structural, D2), but dropping it
  // to prose tells the model NOTHING, and it fills that silence: fabricating the
  // result it never got (I15), or concluding the engine is absent from the build and
  // refusing the stage outright (I18). Withholding the tool is the invariant; hiding
  // the reason never was, so name it and print the real catalog.
  if (offCatalog.length) {
    const named = offCatalog.map((n) => `"${n}"`).join(', ');
    return (
      `No call ran: ${named} ${offCatalog.length > 1 ? 'are' : 'is'} not in this turn's tool ` +
      'catalog. Edit and drafting tools are withheld until a proposal validates — call ' +
      'propose_change, then validate_change, and they appear. Do not conclude a tool is ' +
      `missing from the build. Available this turn: ${[...catalog].join(', ')}.`
    );
  }
  return undefined;
}

/**
 * Find the tool calls left behind in a reply that also dispatched some (#306).
 * `detectMalformedCall` only speaks when nothing parsed; in a mixed reply the
 * off-catalog and near-miss calls were dropped to prose with no message, so the
 * model assumed they ran. `prose` is the reply with the dispatched calls removed,
 * so a call that did run is never reported. Only a `"tool"` key that opens an
 * object and names an identifier counts: narration that quotes a call, or an echo
 * of the protocol template (`"<tool_name>"`), is not a call that failed to run.
 */
function detectUndispatched(prose: string, catalog: Set<string>): UndispatchedCalls | undefined {
  const re = /\{\s*"tool"\s*:\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;
  const unavailable: string[] = [];
  const malformed: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(prose)) !== null) {
    const name = m[1]!;
    const bucket = catalog.has(name) ? malformed : unavailable;
    if (!bucket.includes(name)) bucket.push(name);
  }
  return unavailable.length || malformed.length ? { unavailable, malformed } : undefined;
}

/**
 * The message for the calls `detectUndispatched` found. `available` is the tool
 * catalog AFTER the reply's calls ran: a `validate_change` in the same reply may
 * have unlocked the edit tools, and then the steer is to re-send, not to propose.
 * The edit lock is the only gate on the catalog, so once `editsUnlocked` a name
 * that is still absent is not locked, it does not exist: say so and print the
 * catalog, since a second propose_change would open a second change.
 */
export function renderUndispatched(calls: UndispatchedCalls, available: Set<string>, editsUnlocked: boolean): string {
  const quote = (names: string[]) => names.map((n) => `"${n}"`).join(', ');
  const unlocked = calls.unavailable.filter((n) => available.has(n));
  const absent = calls.unavailable.filter((n) => !available.has(n));
  const lines = ['Some tool calls in your last reply did not run, so nothing they describe happened:'];
  if (unlocked.length) {
    lines.push(
      `- ${quote(unlocked)}: not in the tool catalog when you replied. ` +
        `${unlocked.length > 1 ? 'They are' : 'It is'} available now, so send those calls again.`,
    );
  }
  if (absent.length && editsUnlocked) {
    lines.push(
      `- ${quote(absent)}: not ${absent.length > 1 ? 'tools' : 'a tool'} in the catalog. ` +
        `Use one of the available tools: ${[...available].join(', ')}.`,
    );
  } else if (absent.length) {
    lines.push(
      `- ${quote(absent)}: not in the tool catalog. Edit and drafting tools are withheld until a ` +
        'proposal validates: call propose_change, then validate_change, and send those calls in a later reply.',
    );
  }
  if (calls.malformed.length) {
    lines.push(
      `- ${quote(calls.malformed)}: a call did not parse as valid JSON (likely unbalanced braces). ` +
        'Re-emit it as one complete JSON object: {"tool": "...", "args": { ... }}.',
    );
  }
  lines.push('Do not assume a result for any of them.');
  return lines.join('\n');
}

/**
 * Extract tool-call JSON from the model's reply. Tolerant by design (D1):
 * unparseable output is returned as plain text with no tool calls rather than
 * throwing, so a non-conforming turn degrades to the loop's stall/nudge path.
 * A parsed block only counts as a tool call when its name is in the current
 * turn's catalog (`availableTools(ctx)`): a hallucinated or locked tool name is
 * left as prose so the loop nudges, rather than dispatching a bogus call.
 */
export function parseToolCalls(
  text: string | null,
  nextId: () => string,
  catalog: Set<string>,
): ParsedToolTurn {
  if (!text) return { text: null, toolCalls: [] };

  // #320: the model sometimes writes past its tool call in the transcript format, inventing
  // the `[result of …]` it never received, then more calls planned against that invention.
  // Only what precedes the first harness-only line is the model's turn; the rest is dropped,
  // not dispatched and not stored, and the notice tells the model so. On a resumed CLI
  // session the provider keeps the raw reply, so the notice is also the only correction the
  // model's own history gets.
  let notice: string | undefined;
  let discarded: string | undefined;
  const cut = text.search(HARNESS_MARKER);
  if (cut >= 0) {
    const tail = text.slice(cut);
    const fabricated = (tail.match(HARNESS_MARKER_ALL) ?? []).length;
    const dropped = extractCalls(tail, () => 'dropped', catalog).toolCalls.length;
    text = text.slice(0, cut);
    discarded = tail;
    notice =
      `Your last reply contained ${fabricated} "[result of …]" or "[user]" block${fabricated === 1 ? '' : 's'} ` +
      'that you wrote yourself. Only copperhead writes those: real tool results arrive in the next message. ' +
      `Everything from the first such block on was discarded${dropped ? `, including ${dropped} tool call${dropped === 1 ? '' : 's'} that did not run` : ''}. ` +
      'Treat any result you wrote yourself as unknown, and end each reply after your tool calls.';
  }

  const { toolCalls, matched } = extractCalls(text, nextId, catalog);

  if (!toolCalls.length) {
    // No call dispatched — but did the model clearly *intend* one? A fenced
    // ```json block that names a catalog tool yet produced zero calls is a
    // malformed near-miss (unbalanced braces, a missing `}`, or an inner object
    // with no `tool` key). Silently dropping it gives the model no signal, so it
    // misreads "no result" as "this tool is broken" and can bake that false
    // conclusion into a committed summary (#I10). Surface a nudge instead. A
    // discarded fabricated tail outranks it: that is what the model must fix first.
    const clean = text.replace(ECHOED_MARKER_LINES, '');
    return {
      text: clean.trim() ? clean : null,
      toolCalls,
      nudge: notice ?? detectMalformedCall(text, catalog),
      ...(notice ? { notice, discarded } : {}),
    };
  }

  // Prose is whatever survives once the tool-call objects (and any now-empty
  // ```json fences around them) are removed.
  let prose = '';
  let cursor = 0;
  for (const [start, end] of matched) {
    prose += text.slice(cursor, start);
    cursor = end;
  }
  prose += text.slice(cursor);
  const undispatched = detectUndispatched(prose, catalog);
  prose = prose
    .replace(ECHOED_MARKER_LINES, '')
    .replace(/```(?:json)?\s*```/gi, '')
    .replace(/```(?:json)?\s*$/gi, '')
    .trim();
  return {
    text: prose.length ? prose : null,
    toolCalls,
    ...(notice ? { notice, discarded } : {}),
    ...(undispatched ? { undispatched } : {}),
  };
}

/** Every catalog tool call in `text`, with the spans it occupied. */
function extractCalls(
  text: string,
  nextId: () => string,
  catalog: Set<string>,
): { toolCalls: ToolCall[]; matched: Array<[number, number]> } {
  const toolCalls: ToolCall[] = [];
  const matched: Array<[number, number]> = [];

  // Extract tool calls by scanning for complete JSON objects, NOT by matching
  // ``` fences. A tool call's `content`/`args` can hold a full markdown doc that
  // itself contains ``` code fences; a fence regex truncates the JSON at the
  // first inner fence, JSON.parse fails, and the call is silently dropped (the
  // model then assumes it wrote a file it never did). The brace scan is
  // string-aware, so braces and backticks inside JSON string values are ignored.
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const braceAt = text.indexOf('{', searchFrom);
    if (braceAt < 0) break;
    const span = scanJsonObject(text, braceAt);
    if (!span) {
      // Unbalanced '{' (stray brace in prose): retry from the next candidate so
      // one bad brace can't hide a well-formed call later in the reply.
      searchFrom = braceAt + 1;
      continue;
    }
    const call = toToolCall(text.slice(span.start, span.end), nextId, catalog);
    if (call) {
      toolCalls.push(call);
      matched.push([span.start, span.end]);
    }
    searchFrom = span.end;
  }
  return { toolCalls, matched };
}

/**
 * Find the first complete, brace-balanced JSON object at or after `from`,
 * respecting JSON string quoting/escaping so braces or backticks inside string
 * values do not end the scan. Returns its `[start, end)` bounds or null.
 */
function scanJsonObject(text: string, from: number): { start: number; end: number } | null {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
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
    else if (ch === '}' && --depth === 0) return { start, end: i + 1 };
  }
  return null;
}

function toToolCall(raw: string | undefined, nextId: () => string, catalog: Set<string>): ToolCall | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.tool !== 'string') return null;
  // Only accept names the turn actually advertised. An empty catalog means the
  // turn offered no tools, so nothing parses as a call.
  if (!catalog.has(rec.tool)) return null;
  const args = rec.args && typeof rec.args === 'object' ? (rec.args as Record<string, unknown>) : {};
  return { id: nextId(), name: rec.tool, args };
}
