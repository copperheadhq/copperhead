import type { Msg, ToolCall, ToolSchema } from '../types.js';

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
}

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

  if (!toolCalls.length) {
    // No call dispatched — but did the model clearly *intend* one? A fenced
    // ```json block that names a catalog tool yet produced zero calls is a
    // malformed near-miss (unbalanced braces, a missing `}`, or an inner object
    // with no `tool` key). Silently dropping it gives the model no signal, so it
    // misreads "no result" as "this tool is broken" and can bake that false
    // conclusion into a committed summary (#I10). Surface a nudge instead.
    return { text: text.trim() ? text : null, toolCalls, nudge: detectMalformedCall(text, catalog) };
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
  prose = prose.replace(/```(?:json)?\s*```/gi, '').replace(/```(?:json)?\s*$/gi, '').trim();
  return { text: prose.length ? prose : null, toolCalls };
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
