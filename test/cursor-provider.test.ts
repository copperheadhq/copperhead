import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  CursorProvider,
  defaultCursorRun,
  parseCursorStdout,
  subprocessEnv,
  type CursorRunLike,
} from '../src/agent/providers/cursor.js';
import { CachingProvider } from '../src/agent/response-cache.js';
import { makeProvider } from '../src/agent/loop.js';
import type { Msg, ToolSchema } from '../src/agent/types.js';

const tools: ToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

const messages: Msg[] = [
  { role: 'system', content: 'You are copperhead.' },
  { role: 'user', content: 'inspect docs/SPEC.md' },
];

function fakeRun(out: { text: string; sessionId?: string; input?: number; output?: number }): CursorRunLike {
  return async () => ({
    text: out.text,
    sessionId: out.sessionId,
    usage: { inputTokens: out.input ?? 0, outputTokens: out.output ?? 0 },
  });
}

describe('CursorProvider — routing', () => {
  it('makeProvider routes cursor and cursor:<id>', async () => {
    expect(await makeProvider('cursor')).toBeInstanceOf(CursorProvider);
    expect((await makeProvider('cursor')).name).toBe('cursor');
    expect(await makeProvider('cursor:composer-2.5')).toBeInstanceOf(CursorProvider);
    await expect(makeProvider('cursor:')).rejects.toThrow('cursor model override cannot be empty');
  });

  it('passes cursor:<id> as the CLI model', async () => {
    let capturedModel: string | undefined;
    const provider = new CursorProvider('composer-2.5', async (args) => {
      capturedModel = args.model;
      return { text: 'ok', usage: { inputTokens: 1, outputTokens: 2 } };
    });
    await provider.chat(messages, tools);
    expect(capturedModel).toBe('composer-2.5');
  });
});

describe('CursorProvider — tool protocol', () => {
  it('maps a JSON tool block in the result to Turn.toolCalls', async () => {
    const provider = new CursorProvider(
      undefined,
      fakeRun({
        text: '```json\n{"tool":"read_file","args":{"path":"docs/SPEC.md"}}\n```',
        sessionId: 'sess-1',
        input: 10,
        output: 5,
      }),
    );
    const turn = await provider.chat(messages, tools);
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.toolCalls[0]?.name).toBe('read_file');
    expect(turn.usage.inputTokens).toBe(10);
  });

  it('forwards the calls a mixed reply left undispatched (#306)', async () => {
    const text = '{"tool":"read_file","args":{"path":"docs/SPEC.md"}}\n{"tool":"write_file","args":{"path":"a.md","content":"x"}}';
    const turn = await new CursorProvider(undefined, fakeRun({ text })).chat(messages, tools);
    expect(turn.toolCalls.map((c) => c.name)).toEqual(['read_file']);
    expect(turn.undispatched).toEqual({ unavailable: ['write_file'], malformed: [] });
  });

  it('does not resume by default (mutually exclusive with response cache)', async () => {
    const resumes: Array<string | undefined> = [];
    const runFn: CursorRunLike = async (args) => {
      resumes.push(args.resume);
      return {
        text: 'ok',
        sessionId: 'sess-1',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const provider = new CursorProvider(undefined, runFn);
    await provider.chat(messages, tools);
    await provider.chat(
      [...messages, { role: 'assistant', content: 'ok', toolCalls: [] }, { role: 'user', content: 'next' }],
      tools,
    );
    expect(resumes).toEqual([undefined, undefined]);
  });

  it('resumes with --resume only when sessionResume is enabled', async () => {
    const resumes: Array<string | undefined> = [];
    const prompts: string[] = [];
    const runFn: CursorRunLike = async (args) => {
      resumes.push(args.resume);
      prompts.push(args.prompt);
      return {
        text: 'ok',
        sessionId: 'sess-1',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const provider = new CursorProvider(undefined, runFn, true);
    await provider.chat(messages, tools);
    await provider.chat(
      [...messages, { role: 'assistant', content: 'ok', toolCalls: [] }, { role: 'user', content: 'next' }],
      tools,
    );
    expect(resumes).toEqual([undefined, 'sess-1']);
    expect(prompts[1]).toContain('[user]\nnext');
    expect(prompts[1]).not.toContain('You are copperhead');
  });

  it('with cache on, a replayed turn does not leave a later real call mid-session', async () => {
    // Repro for H1: if resume were on while CachingProvider can skip inner.chat,
    // the next real turn would --resume a session that never saw the cached turn.
    const resumes: Array<string | undefined> = [];
    const prompts: string[] = [];
    const runFn: CursorRunLike = async (args) => {
      resumes.push(args.resume);
      prompts.push(args.prompt);
      return {
        text: `reply-${resumes.length}`,
        sessionId: 'sess-1',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const inner = new CursorProvider(undefined, runFn); // sessionResume defaults false
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'copperhead-cursor-cache-'));
    const provider = new CachingProvider(inner, cacheDir);

    const turn1Msgs = messages;
    const turn2Msgs: Msg[] = [
      ...messages,
      { role: 'assistant', content: 'reply-1', toolCalls: [] },
      { role: 'user', content: 'cached-next' },
    ];
    const turn3Msgs: Msg[] = [
      ...turn2Msgs,
      { role: 'assistant', content: 'reply-2', toolCalls: [{ id: 't1', name: 'read_file', args: { path: 'x' } }] },
      { role: 'tool', toolCallId: 't1', content: 'file contents' },
      { role: 'user', content: 'after-cache' },
    ];

    await provider.chat(turn1Msgs, tools);
    await provider.chat(turn2Msgs, tools);
    // Replay turn2 from cache (identical messages/tools) — must not advance CLI session.
    await provider.chat(turn2Msgs, tools);
    await provider.chat(turn3Msgs, tools);

    expect(resumes.every((r) => r === undefined)).toBe(true);
    // Full history is re-sent (no delta), including the intervening assistant tool call.
    expect(prompts.at(-1)).toContain('[assistant tool call]');
    expect(prompts.at(-1)).toContain('after-cache');
  });

  it('tripwire throws on native tool_call events in stdout JSON', () => {
    const line = JSON.stringify({ type: 'tool_call', name: 'Write' });
    expect(() => parseCursorStdout(line)).toThrow(/reasoning-only invariant/);
  });

  it('subtype tripwire matches whole tokens and names the raw subtype', () => {
    const line = JSON.stringify({ type: 'assistant', subtype: 'apply_patch' });
    expect(() => parseCursorStdout(line)).toThrow(/subtype "apply_patch"/);
  });
});

describe('CursorProvider — env and lifecycle', () => {
  it('subprocessEnv allowlists CLI vars and omits billed or unrelated secrets', () => {
    const prev = { ...process.env };
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.CURSOR_API_KEY = 'key';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    process.env.USERPROFILE = 'C:\\Users\\test';
    process.env.HOMEDRIVE = 'C:';
    process.env.HOMEPATH = '\\Users\\test';
    try {
      const env = subprocessEnv();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CURSOR_API_KEY).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
      expect(env.USERPROFILE).toBe('C:\\Users\\test');
      expect(env.HOMEDRIVE).toBe('C:');
      expect(env.HOMEPATH).toBe('\\Users\\test');
    } finally {
      process.env.ANTHROPIC_API_KEY = prev.ANTHROPIC_API_KEY;
      process.env.OPENAI_API_KEY = prev.OPENAI_API_KEY;
      process.env.CURSOR_API_KEY = prev.CURSOR_API_KEY;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prev.USERPROFILE;
      if (prev.HOMEDRIVE === undefined) delete process.env.HOMEDRIVE;
      else process.env.HOMEDRIVE = prev.HOMEDRIVE;
      if (prev.HOMEPATH === undefined) delete process.env.HOMEPATH;
      else process.env.HOMEPATH = prev.HOMEPATH;
    }
  });

  it('has a distinct name so keyed failover does not apply', () => {
    expect(new CursorProvider().name).toBe('cursor');
  });

  it('parseCursorStdout reads result JSON', () => {
    const stdout = JSON.stringify({
      type: 'result',
      result: 'hello',
      session_id: 'abc',
    });
    const parsed = parseCursorStdout(stdout);
    expect(parsed.text).toBe('hello');
    expect(parsed.sessionId).toBe('abc');
    expect(parsed.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('parseCursorStdout accepts a pretty-printed single JSON object', () => {
    const stdout = `{
  "type": "result",
  "result": "pretty",
  "session_id": "s-pretty"
}`;
    const parsed = parseCursorStdout(stdout);
    expect(parsed.text).toBe('pretty');
    expect(parsed.sessionId).toBe('s-pretty');
  });

  it('parseCursorStdout fails loudly on unparseable stdout', () => {
    expect(() => parseCursorStdout('Cursor Agent v1.2\nnot json')).toThrow(/could not parse Cursor Agent output/);
  });

  it('surfaces CLI-not-found guidance when agent binary is missing', async () => {
    const missing = Object.assign(new Error('spawn agent ENOENT'), { code: 'ENOENT' });
    const provider = new CursorProvider(undefined, async () => Promise.reject(missing));
    await expect(provider.chat(messages, tools)).rejects.toThrow(/Cursor Agent CLI not found/);
  });

  it('surfaces agent login guidance when CLI reports not logged in (exitCode 1)', async () => {
    const err = Object.assign(
      new Error('Command failed with exit code 1: agent --print\nnot logged in, run agent login'),
      { exitCode: 1 },
    );
    const provider = new CursorProvider(undefined, async () => Promise.reject(err));
    await expect(provider.chat(messages, tools)).rejects.toThrow(/agent login[\s\S]*agent status/);
  });

  it('close() removes the temp workspace', async () => {
    let workspace = '';
    const provider = new CursorProvider(undefined, async (args) => {
      workspace = args.workspace;
      return { text: 'ok', usage: { inputTokens: 0, outputTokens: 0 } };
    });
    await provider.chat(messages, tools);
    expect(existsSync(workspace)).toBe(true);
    await provider.close();
    expect(existsSync(workspace)).toBe(false);
  });
});

describe('CursorProvider — defaultCursorRun subprocess', () => {
  it('feeds the prompt on stdin (not argv) and keeps the flag vector', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'copperhead-cursor-stub-'));
    const argvFile = path.join(dir, 'argv.txt');
    const stdinFile = path.join(dir, 'stdin.txt');
    const stubJs = path.join(dir, 'stub-agent.mjs');
    await writeFile(
      stubJs,
      `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(argvFile)}, process.argv.slice(2).join('\\n'), 'utf8');
fs.writeFileSync(${JSON.stringify(stdinFile)}, fs.readFileSync(0, 'utf8'), 'utf8');
console.log('{"type":"result","result":"from-stub","session_id":"s1"}');
`,
      'utf8',
    );

    const isWin = process.platform === 'win32';
    const stub = path.join(dir, isWin ? 'stub-agent.bat' : 'stub-agent.sh');
    if (isWin) {
      await writeFile(stub, `@echo off\nnode "${stubJs}" %*\n`, 'utf8');
    } else {
      await writeFile(stub, `#!/bin/sh\nnode "${stubJs}" "$@"\n`, 'utf8');
      await chmod(stub, 0o755);
    }

    const prev = process.env.COPPERHEAD_CURSOR_PATH;
    process.env.COPPERHEAD_CURSOR_PATH = stub;
    const big = 'x'.repeat(150 * 1024);
    try {
      const result = await defaultCursorRun({
        prompt: big,
        systemPrompt: 'sys',
        workspace: dir,
      });
      expect(result.text).toBe('from-stub');
      expect(result.sessionId).toBe('s1');

      const argv = await readFile(argvFile, 'utf8');
      expect(argv).toContain('--print');
      expect(argv).toContain('--output-format');
      expect(argv).toContain('json');
      expect(argv).toContain('--mode');
      expect(argv).toContain('plan');
      expect(argv).toContain('--trust');
      expect(argv).toContain('--sandbox');
      expect(argv).toContain('enabled');
      expect(argv).toContain('--workspace');
      expect(argv).not.toContain(big);

      const stdin = await readFile(stdinFile, 'utf8');
      expect(stdin).toContain('sys');
      expect(stdin).toContain(big);
    } finally {
      if (prev === undefined) delete process.env.COPPERHEAD_CURSOR_PATH;
      else process.env.COPPERHEAD_CURSOR_PATH = prev;
    }
  });
});
