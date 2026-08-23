import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { ClaudeCodeProvider, type QueryLike, type QueryMessage } from '../src/agent/providers/claude-code.js';
import { makeProvider } from '../src/agent/loop.js';
import { AnthropicProvider } from '../src/agent/providers/anthropic.js';
import { isRateLimit } from '../src/util/retry.js';
import type { Msg, ToolSchema } from '../src/agent/types.js';

const tools: ToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read a file from the repo',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'finish',
    description: 'Finish the run',
    parameters: { type: 'object', properties: { outcome: { type: 'string' } } },
  },
];

const messages: Msg[] = [
  { role: 'system', content: 'You are copperhead.' },
  { role: 'user', content: 'do the thing' },
];

/** A fake `query` that yields scripted SDK messages and optionally records the
 * args it was called with. */
function fakeQuery(out: QueryMessage[], capture?: (args: { prompt: string; options?: Record<string, unknown> }) => void): QueryLike {
  return (args) => {
    capture?.(args);
    return (async function* () {
      for (const m of out) yield m;
    })();
  };
}

function throwingQuery(err: unknown): QueryLike {
  // eslint-disable-next-line require-yield
  return () =>
    (async function* (): AsyncGenerator<QueryMessage> {
      throw err;
    })();
}

function assistant(text: string): QueryMessage {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

/** An assistant message carrying a tool_use block — what the SDK would emit if
 * it ignored `tools: []` and tried to execute a tool. */
function assistantToolUse(name: string, input: Record<string, unknown>): QueryMessage {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', name, input } as never] } };
}

function result(input = 0, output = 0): QueryMessage {
  return { type: 'result', subtype: 'success', usage: { input_tokens: input, output_tokens: output } };
}

describe('ClaudeCodeProvider — routing', () => {
  it('makeProvider routes claude-code and claude-code:<id> to ClaudeCodeProvider (no API key needed)', async () => {
    expect(await makeProvider('claude-code')).toBeInstanceOf(ClaudeCodeProvider);
    expect((await makeProvider('claude-code')).name).toBe('claude-code');
    expect(await makeProvider('claude-code:opus')).toBeInstanceOf(ClaudeCodeProvider);
  });

  it('does not capture the plain claude* prefix (that still routes to Anthropic)', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic';
    try {
      expect(await makeProvider('claude')).toBeInstanceOf(AnthropicProvider);
      expect(await makeProvider('claude-sonnet-5')).toBeInstanceOf(AnthropicProvider);
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('passes claude-code:<id> through as the SDK model, default omits the model option', async () => {
    let capturedModel: unknown = 'unset';
    const withId = new ClaudeCodeProvider('opus', fakeQuery([assistant('hi'), result()], (a) => {
      capturedModel = (a.options ?? {}).model;
    }));
    await withId.chat(messages, tools);
    expect(capturedModel).toBe('opus');

    let hasModelKey = true;
    const noId = new ClaudeCodeProvider(undefined, fakeQuery([assistant('hi'), result()], (a) => {
      hasModelKey = 'model' in (a.options ?? {});
    }));
    await noId.chat(messages, tools);
    expect(hasModelKey).toBe(false);
  });
});

describe('ClaudeCodeProvider — tool protocol', () => {
  it('advertises availableTools as a text protocol and disables SDK tools', async () => {
    let opts: Record<string, unknown> = {};
    let prompt = '';
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant('ok'), result()], (a) => {
      opts = a.options ?? {};
      prompt = a.prompt;
    }));
    await provider.chat(messages, tools);

    const sys = String(opts.systemPrompt);
    expect(sys).toContain('Tool protocol');
    expect(sys).toContain('read_file');
    expect(sys).toContain('finish');
    expect(sys).toContain('"properties"'); // the JSON Schema is included
    // reasoning-only: the SDK is given no tools and built-ins are denied
    expect(opts.tools).toEqual([]);
    expect(Array.isArray(opts.disallowedTools) && (opts.disallowedTools as string[]).includes('Bash')).toBe(true);
    // full conversation is flattened into the prompt each turn
    expect(prompt).toContain('do the thing');
  });

  it('flattens prior assistant tool-calls and tool results into the prompt (the provider memory)', async () => {
    let prompt = '';
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant('ok'), result()], (a) => {
      prompt = a.prompt;
    }));
    const history: Msg[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'cc-1', name: 'read_file', args: { path: 'docs/BOM.md' } }] },
      { role: 'tool', toolCallId: 'cc-1', content: 'the file contents' },
    ];
    await provider.chat(history, tools);
    expect(prompt).toContain('[assistant tool call]');
    expect(prompt).toContain('"tool":"read_file"');
    expect(prompt).toContain('[result of read_file]'); // id mapped back to the tool name
    expect(prompt).toContain('the file contents');
  });

  it('parses multiple fenced tool blocks into multiple tool calls (accepts >1 even though the protocol asks for one)', async () => {
    const reply = '```json\n{"tool":"read_file","args":{"path":"a"}}\n```\nthen\n```json\n{"tool":"finish","args":{"outcome":"done"}}\n```';
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant(reply), result()]));
    const turn = await provider.chat(messages, tools);
    expect(turn.toolCalls.map((c) => c.name)).toEqual(['read_file', 'finish']);
    expect(new Set(turn.toolCalls.map((c) => c.id)).size).toBe(2); // ids are distinct
  });

  it('parses a write_file call whose content contains nested ``` fences (does not truncate at the inner fence)', async () => {
    // Regression: a markdown doc written via write_file legitimately contains
    // ``` code fences. A fence-delimited parser truncates the JSON at the first
    // inner fence, JSON.parse fails, and the call is silently dropped — the file
    // never gets written and the stage stalls. The brace-balanced scan must keep
    // the whole call intact.
    const writeTool: ToolSchema = {
      name: 'write_file',
      description: 'Create a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    };
    const doc = '# Subsystems\n\n```text\nUSB-C -> Rd -> VBUS\n```\n\nSee `docs/SPEC.md`.\n';
    const reply = '```json\n' + JSON.stringify({ tool: 'write_file', args: { path: 'docs/SUBSYSTEMS.md', content: doc } }) + '\n```';
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant(reply), result()]));
    const turn = await provider.chat(messages, [...tools, writeTool]);
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]!.name).toBe('write_file');
    expect(turn.toolCalls[0]!.args).toEqual({ path: 'docs/SUBSYSTEMS.md', content: doc });
  });

  it('nudges on a malformed near-miss tool call instead of silently dropping it (#I10)', async () => {
    // One closing brace short: scanJsonObject never balances the outer object,
    // so zero calls dispatch. The old parser returned no signal; now it detects
    // the `"tool":"read_file"` near-miss and returns a re-emit nudge.
    const reply = '```json\n{"tool":"read_file","args":{"path":"docs/BOM.md"}\n```';
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant(reply), result()]));
    const turn = await provider.chat(messages, tools);
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.nudge).toMatch(/read_file/);
    expect(turn.nudge).toMatch(/malformed|re-emit/i);
  });

  // I18: the mirror of the near-miss above. A WELL-FORMED call naming a tool the
  // turn withheld (the edit lock) parsed fine and was correctly not dispatched —
  // and said nothing. The model filled the silence by inventing a "Tool not found.
  // Available tools: …" error, concluded the drafting engine was absent from the
  // build, and refused stage 4. The lock still withholds; it just says so now.
  it('nudges with the real catalog when a well-formed call names a withheld tool (#I18)', async () => {
    const reply = '```json\n{"tool":"draft_schematic","args":{"intent_json":"schematic.intent.json"}}\n```';
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant(reply), result()]));
    const turn = await provider.chat(messages, tools); // catalog = read_file, finish
    expect(turn.toolCalls).toHaveLength(0); // still not dispatched — the lock is structural
    expect(turn.nudge).toMatch(/draft_schematic/);
    expect(turn.nudge).toMatch(/propose_change/);
    expect(turn.nudge).toMatch(/validate_change/);
    // The real catalog, so the model cannot invent one.
    expect(turn.nudge).toMatch(/read_file/);
    expect(turn.nudge).toMatch(/finish/);
  });

  it('names every withheld tool when a turn calls more than one (#I18)', async () => {
    const reply =
      '```json\n{"tool":"write_file","args":{"path":"a","content":"x"}}\n```\n' +
      '```json\n{"tool":"draft_schematic","args":{}}\n```';
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant(reply), result()]));
    const turn = await provider.chat(messages, tools);
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.nudge).toMatch(/write_file/);
    expect(turn.nudge).toMatch(/draft_schematic/);
  });

  it('prefers the malformed steer when one named tool is in the catalog and another is not (#I18)', async () => {
    // A near-miss on a catalog tool is the more actionable defect: fix the JSON.
    const reply =
      '```json\n{"tool":"read_file","args":{"path":"a"}\n```\n' +
      '```json\n{"tool":"draft_schematic","args":{}}\n```';
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant(reply), result()]));
    const turn = await provider.chat(messages, tools);
    expect(turn.nudge).toMatch(/malformed|re-emit/i);
  });

  it('does not nudge on ordinary prose with no intended tool call (#I10)', async () => {
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant('Let me think about the design.'), result()]));
    const turn = await provider.chat(messages, tools);
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.nudge).toBeUndefined();
  });

  it('does not nudge when a valid tool call did dispatch (#I10)', async () => {
    const reply = '```json\n{"tool":"read_file","args":{"path":"a"}}\n```';
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant(reply), result()]));
    const turn = await provider.chat(messages, tools);
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.nudge).toBeUndefined();
  });

  it('reuses one isolated scratch cwd across turns (no per-turn temp-dir leak)', async () => {
    const cwds: unknown[] = [];
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant('ok'), result()], (a) => {
      cwds.push((a.options ?? {}).cwd);
    }));
    await provider.chat(messages, tools);
    await provider.chat(messages, tools);
    expect(cwds[0]).toBeTruthy();
    expect(cwds[0]).toBe(cwds[1]);
  });

  it('strips the billed API keys from the SDK subprocess env but inherits the rest', async () => {
    const prevA = process.env.ANTHROPIC_API_KEY;
    const prevO = process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-reach-subprocess';
    process.env.OPENAI_API_KEY = 'sk-openai-should-not-reach-subprocess';
    try {
      let env: Record<string, unknown> = {};
      const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant('ok'), result()], (a) => {
        env = ((a.options ?? {}).env ?? {}) as Record<string, unknown>;
      }));
      await provider.chat(messages, tools);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH); // the rest of the environment is inherited
    } finally {
      if (prevA === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevA;
      if (prevO === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevO;
    }
  });

  it('registers a deny-all canUseTool so the SDK cannot execute any tool', async () => {
    let canUseTool: ((name: string, input: Record<string, unknown>) => Promise<{ behavior: string }>) | undefined;
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant('ok'), result()], (a) => {
      canUseTool = (a.options as { canUseTool?: typeof canUseTool } | undefined)?.canUseTool;
    }));
    await provider.chat(messages, tools);
    expect(typeof canUseTool).toBe('function');
    const decision = await canUseTool!('Bash', { command: 'rm -rf /' });
    expect(decision.behavior).toBe('deny');
  });

  it('disables all built-in tools: empty tools allowlist plus a wildcard denylist', async () => {
    let options: Record<string, unknown> = {};
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant('ok'), result()], (a) => {
      options = (a.options ?? {}) as Record<string, unknown>;
    }));
    await provider.chat(messages, tools);
    expect(options.tools).toEqual([]);
    expect(options.disallowedTools).toContain('*');
  });

  it('close() removes the scratch cwd', async () => {
    let cwd = '';
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant('ok'), result()], (a) => {
      cwd = String((a.options ?? {}).cwd ?? '');
    }));
    await provider.chat(messages, tools);
    expect(existsSync(cwd)).toBe(true);
    await provider.close();
    expect(existsSync(cwd)).toBe(false);
  });

  it('ignores a tool name that is not in the turn catalog (left as prose, not dispatched)', async () => {
    const reply = '```json\n{"tool":"delete_everything","args":{}}\n```';
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant(reply), result()]));
    const turn = await provider.chat(messages, tools); // catalog = read_file, finish
    expect(turn.toolCalls).toHaveLength(0);
    expect(turn.text).toContain('delete_everything'); // surfaced as prose so the loop nudges
  });

  it('parses a fenced json tool-call block into Turn.toolCalls, keeping surrounding prose', async () => {
    const reply = 'Let me read it.\n```json\n{"tool":"read_file","args":{"path":"docs/BOM.md"}}\n```';
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant(reply), result(12, 4)]));
    const turn = await provider.chat(messages, tools);
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]!.name).toBe('read_file');
    expect(turn.toolCalls[0]!.args).toEqual({ path: 'docs/BOM.md' });
    expect(turn.toolCalls[0]!.id).toMatch(/^cc-/);
    expect(turn.text).toContain('Let me read it.');
    expect(turn.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
  });

  it('parses a bare (unfenced) json object as a tool call', async () => {
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant('{"tool":"finish","args":{"outcome":"done"}}'), result()]));
    const turn = await provider.chat(messages, tools);
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]!.name).toBe('finish');
    expect(turn.text).toBeNull();
  });

  it('plain-text reply yields text and no tool calls', async () => {
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant('Here is my reasoning, no action yet.'), result()]));
    const turn = await provider.chat(messages, tools);
    expect(turn.toolCalls).toEqual([]);
    expect(turn.text).toBe('Here is my reasoning, no action yet.');
  });

  it('tolerates malformed tool JSON: no throw, no tool calls', async () => {
    const reply = '```json\n{"tool": "read_file", args: not-valid-json}\n```';
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistant(reply), result()]));
    const turn = await provider.chat(messages, tools);
    expect(turn.toolCalls).toEqual([]);
    expect(turn.text).not.toBeNull();
  });
});

describe('ClaudeCodeProvider — session resume (1.1)', () => {
  const withSession = (sid: string, out: QueryMessage[]): QueryMessage[] => [
    { type: 'system', subtype: 'init', session_id: sid },
    ...out,
  ];

  it('first turn sends full history and no resume; a later turn resumes and sends only the delta', async () => {
    const seen: Array<{ prompt: string; options?: Record<string, unknown> }> = [];
    const q: QueryLike = (args) => {
      seen.push(args);
      return (async function* () {
        for (const m of withSession('sess-123', [assistant('ok'), result()])) yield m;
      })();
    };
    const provider = new ClaudeCodeProvider(undefined, q, undefined, true); // resume ON

    const first: Msg[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do it' },
    ];
    await provider.chat(first, tools);
    expect((seen[0]!.options ?? {}).resume).toBeUndefined(); // no session yet
    expect(seen[0]!.prompt).toContain('do it'); // full history on the first turn

    const second: Msg[] = [
      ...first,
      { role: 'assistant', content: null, toolCalls: [{ id: 'cc-1', name: 'read_file', args: { path: 'a' } }] },
      { role: 'tool', toolCallId: 'cc-1', content: 'FILE BODY' },
    ];
    await provider.chat(second, tools);
    expect((seen[1]!.options ?? {}).resume).toBe('sess-123'); // resumes the session
    expect(seen[1]!.prompt).toContain('FILE BODY'); // sends the new tool result
    expect(seen[1]!.prompt).toContain('[result of read_file]');
    expect(seen[1]!.prompt).not.toContain('do it'); // earlier turns live in the session, not re-sent
    expect(seen[1]!.prompt).not.toContain('[assistant tool call]'); // our own reply isn't re-sent
  });

  it('is off by default: every turn re-sends the full flattened history, never resume', async () => {
    const seen: Array<{ prompt: string; options?: Record<string, unknown> }> = [];
    const q: QueryLike = (args) => {
      seen.push(args);
      return (async function* () {
        for (const m of withSession('sess-x', [assistant('ok'), result()])) yield m;
      })();
    };
    const provider = new ClaudeCodeProvider(undefined, q); // resume OFF (default)
    const base: Msg[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do it' },
    ];
    await provider.chat(base, tools);
    await provider.chat([...base, { role: 'assistant', content: 'thinking' }, { role: 'user', content: 'again' }], tools);
    expect((seen[1]!.options ?? {}).resume).toBeUndefined();
    expect(seen[1]!.prompt).toContain('do it'); // full history re-sent when resume is off
  });
});

describe('ClaudeCodeProvider — errors and fallback', () => {
  it('re-throws the original SDK error so its status survives for retry (no wrapping)', async () => {
    const rateLimit = Object.assign(new Error('rate limited'), { status: 429 });
    const provider = new ClaudeCodeProvider(undefined, throwingQuery(rateLimit));
    await expect(provider.chat(messages, tools)).rejects.toBe(rateLimit);
    const caught = await provider.chat(messages, tools).catch((e) => e);
    expect(isRateLimit(caught)).toBe(true);
  });

  it('throws loudly if the SDK emits a tool_use block despite tools being disabled (reasoning-only invariant)', async () => {
    const provider = new ClaudeCodeProvider(undefined, fakeQuery([assistantToolUse('Bash', { command: 'ls' }), result()]));
    const caught = await provider.chat(messages, tools).catch((e: Error) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message.toLowerCase()).toContain('tool_use');
    expect(caught.message.toLowerCase()).toContain('disabled');
  });

  it('keeps a 429 retryable even when its message mentions "oauth token" (status wins over the message heuristic)', async () => {
    const err = Object.assign(new Error('oauth token bucket exhausted, rate limited'), { status: 429 });
    const provider = new ClaudeCodeProvider(undefined, throwingQuery(err));
    const caught = await provider.chat(messages, tools).catch((e) => e);
    expect(caught).toBe(err); // re-thrown untouched, not wrapped as an auth error
    expect(isRateLimit(caught)).toBe(true);
  });

  it('turns an auth error into an actionable, non-retryable message', async () => {
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    const provider = new ClaudeCodeProvider(undefined, throwingQuery(authErr));
    const caught = await provider.chat(messages, tools).catch((e: Error) => e);
    expect(caught.message.toLowerCase()).toMatch(/setup-token|log in|authenticat/);
    expect(isRateLimit(caught)).toBe(false);
  });

  it('has a distinct name so otherProvider() never falls back to a keyed provider', () => {
    // otherProvider only swaps openai<->anthropic; a distinct name is what makes
    // a rate-limited claude-code run fail instead of silently using a paid API.
    const provider = new ClaudeCodeProvider();
    expect(provider.name).toBe('claude-code');
    expect(['openai', 'anthropic']).not.toContain(provider.name);
  });
});

// Detected once at module load: the missing-dependency path is only exercisable
// when the optional SDK is genuinely absent. If a future install adds it, skip
// rather than fail.
let sdkInstalled = false;
try {
  await import('@anthropic-ai/claude-agent-sdk');
  sdkInstalled = true;
} catch {
  sdkInstalled = false;
}

describe('ClaudeCodeProvider — missing optional dependency', () => {
  // Integration-level: only runs when the SDK is genuinely absent (e.g. an
  // `--omit=optional` install). Since the SDK is now a declared optional
  // dependency it is usually present, so this self-skips; the deterministic
  // cases below cover the same branch via an injected importer regardless.
  it.skipIf(sdkInstalled)('fails with an actionable install message when the SDK is absent', async () => {
    const provider = new ClaudeCodeProvider(); // no injected query -> real lazy import
    const caught = await provider.chat(messages, tools).catch((e: Error) => e);
    expect(caught.message).toContain('@anthropic-ai/claude-agent-sdk');
    expect(caught.message.toLowerCase()).toContain('install');
  });

  const moduleNotFound = () =>
    Promise.reject(Object.assign(new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    }));

  it('maps a module-not-found import to an actionable, non-retryable install message (SDK-agnostic)', async () => {
    const provider = new ClaudeCodeProvider(undefined, undefined, moduleNotFound);
    const caught = await provider.chat(messages, tools).catch((e: Error) => e);
    expect(caught.message).toContain('@anthropic-ai/claude-agent-sdk');
    expect(caught.message.toLowerCase()).toContain('install');
    expect(isRateLimit(caught)).toBe(false);
  });

  it('re-throws a non-module import error unchanged (a present-but-broken install is not mislabeled)', async () => {
    const broken = Object.assign(new Error('boom: bad build'), { code: 'ERR_DLOPEN_FAILED' });
    const provider = new ClaudeCodeProvider(undefined, undefined, () => Promise.reject(broken));
    const caught = await provider.chat(messages, tools).catch((e: Error) => e);
    expect(caught).toBe(broken); // the real error propagates, not the "install it" message
  });

  it('errors when the SDK resolves but does not export query (incompatible version)', async () => {
    const provider = new ClaudeCodeProvider(undefined, undefined, () => Promise.resolve({}));
    const caught = await provider.chat(messages, tools).catch((e: Error) => e);
    expect(caught.message).toContain('did not export `query`');
  });
});
