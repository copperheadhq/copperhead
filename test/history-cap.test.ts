import { describe, it, expect } from 'vitest';
import { writeFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { capHistory, HISTORY_CAP_DEFAULTS, type HistoryCapOptions } from '../src/agent/history.js';
import { toolReadFile } from '../src/agent/filetools.js';
import { TOOLS, type RunContext } from '../src/agent/tools.js';
import { renderConversation, renderDelta } from '../src/agent/providers/tool-protocol.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { CachingProvider } from '../src/agent/response-cache.js';
import { loadConfig, DEFAULTS } from '../src/config.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';

/**
 * Tight options so fixtures stay readable; the defaults are exercised
 * separately. Small, but still large enough to hold an elision marker: below
 * that, `clip` correctly declines to clip at all (covered by its own test).
 */
const opts: HistoryCapOptions = { maxToolResultChars: 400, maxToolArgChars: 300, keepRecent: 2 };

function read(
  id: string,
  path: string,
  body: string,
  range?: { start?: number; end?: number; failed?: boolean },
): Msg[] {
  const args: Record<string, unknown> = { path };
  if (range?.start !== undefined) args.start_line = range.start;
  if (range?.end !== undefined) args.end_line = range.end;
  return [
    { role: 'assistant', content: null, toolCalls: [{ id, name: 'read_file', args }] },
    { role: 'tool', toolCallId: id, content: body, ...(range?.failed ? { failed: true } : {}) },
  ];
}

/** Filler turns to push earlier messages out of the protected recent window. */
function filler(n: number): Msg[] {
  return Array.from({ length: n }, (_, i): Msg => ({ role: 'user', content: `filler ${i}` }));
}

describe('capHistory — invariants that keep it safe in front of any provider', () => {
  it('preserves length, order, roles, and tool-call ids exactly', () => {
    const msgs: Msg[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do the thing' },
      ...read('c1', 'a.kicad_sch', 'X'.repeat(5000)),
      ...read('c2', 'a.kicad_sch', 'Y'.repeat(5000)),
      ...filler(4),
    ];
    const { messages: out } = capHistory(msgs, opts);
    expect(out).toHaveLength(msgs.length);
    expect(out.map((m) => m.role)).toEqual(msgs.map((m) => m.role));
    expect(out.flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : []))).toEqual(
      msgs.flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : [])),
    );
    // Length parity is what keeps claude-code's resume index (`sentCount`,
    // consumed by renderDelta) pointing at the same message after capping.
    expect(renderDelta(out, msgs.length - 2)).not.toBe('');
  });

  it('never mutates the caller\'s array (the transcript keeps full fidelity)', () => {
    const body = 'Z'.repeat(5000);
    const msgs: Msg[] = [...read('c1', 'a.kicad_sch', body), ...read('c2', 'a.kicad_sch', 'new'), ...filler(2)];
    const before = JSON.parse(JSON.stringify(msgs)) as Msg[];
    capHistory(msgs, opts);
    expect(msgs).toEqual(before);
  });

  it('hands the provider structurally independent messages', () => {
    // A new array alone is not enough: if the message objects are shared, a
    // provider that mutates what it is handed rewrites the run's own history.
    const msgs: Msg[] = [
      { role: 'user', content: 'original user text' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'edit_file', args: { path: 'a.kicad_sch', new_string: 'original payload' } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'ok' },
      ...filler(2),
    ];
    const { messages: out } = capHistory(msgs, opts);

    // Simulate a badly behaved provider mutating every level it can reach.
    (out[0] as { content: string }).content = 'MUTATED';
    const call = out[1].role === 'assistant' ? out[1].toolCalls![0]! : null;
    call!.args.new_string = 'MUTATED';
    (out[2] as { content: string }).content = 'MUTATED';

    expect(msgs[0]).toEqual({ role: 'user', content: 'original user text' });
    expect(msgs[1].role === 'assistant' && msgs[1].toolCalls![0]!.args.new_string).toBe('original payload');
    expect(msgs[2].role === 'tool' && msgs[2].content).toBe('ok');
  });

  it('returns short conversations unchanged, but never as the caller\'s own array', () => {
    const msgs: Msg[] = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    const { messages: out, stats } = capHistory(msgs, opts);
    expect(out).toEqual(msgs); // nothing was eligible to trim
    // A provider that mutates what it is handed must not be able to reach the
    // run's own history through it, even on the early-return path.
    expect(out).not.toBe(msgs);
    expect(stats).toEqual({ charsSaved: 0, superseded: 0, truncated: 0, firstChanged: null });
  });
});

describe('capHistory — what it actually trims', () => {
  it('supersedes an earlier read of a path that is read again later', () => {
    const stale = 'OLD'.repeat(2000);
    const msgs: Msg[] = [...read('c1', 'a.kicad_sch', stale), ...read('c2', 'a.kicad_sch', 'CURRENT'), ...filler(2)];
    const { messages: out, stats } = capHistory(msgs, opts);
    const first = out[1];
    expect(first.role).toBe('tool');
    expect(first.role === 'tool' && first.content).toContain('superseded');
    expect(first.role === 'tool' && first.content).toContain('a.kicad_sch');
    expect(first.role === 'tool' && first.content).not.toContain('OLD');
    expect(stats.superseded).toBe(1);
    expect(stats.charsSaved).toBeGreaterThan(stale.length - 500);
  });

  it('keeps the newest read of a path in full even when older ones are dropped', () => {
    // The newest read is the model's only current view of the file; superseding
    // it would be actively wrong, not merely lossy.
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', 'OLD'.repeat(2000)),
      ...read('c2', 'a.kicad_sch', 'NEWEST'.repeat(2000)),
      ...filler(6),
    ];
    const { messages: out } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    const newest = out[3];
    expect(newest.role === 'tool' && newest.content).toBe('NEWEST'.repeat(2000));
  });

  it('does not supersede a whole-file read with a later partial read', () => {
    // `read_file` honours start_line/end_line, so a later 20-line read does not
    // reproduce the whole file. Dropping the earlier read here would delete
    // content the model can still legitimately be relying on.
    const whole = 'WHOLE'.repeat(2000);
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', whole),
      ...read('c2', 'a.kicad_sch', 'lines 100-120 only', { start: 100, end: 120 }),
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    expect(out[1].role === 'tool' && out[1].content).toBe(whole);
    expect(stats.superseded).toBe(0);
  });

  it('does not supersede a ranged read with a later disjoint range', () => {
    const first = 'FIRST'.repeat(500);
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', first, { start: 1, end: 50 }),
      ...read('c2', 'a.kicad_sch', 'other lines', { start: 100, end: 120 }),
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    expect(out[1].role === 'tool' && out[1].content).toBe(first);
    expect(stats.superseded).toBe(0);
  });

  it('supersedes a ranged read when a later read covers it', () => {
    const narrow = 'NARROW'.repeat(500);
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', narrow, { start: 10, end: 20 }),
      ...read('c2', 'a.kicad_sch', 'wider', { start: 1, end: 100 }),
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    expect(out[1].role === 'tool' && out[1].content).toContain('superseded');
    expect(stats.superseded).toBe(1);
  });

  it('treats start_line with no end_line as open-ended, to the end of the file', () => {
    // rangeOf's fallback for a missing end_line is Infinity, mirroring
    // toolReadFile's own "read from start_line to EOF" behavior. Every other
    // range test in this file supplies both bounds, so this exercises that
    // arm specifically.
    const openEnded = 'TAIL'.repeat(500);
    // A later [1, 200] read does NOT contain an unbounded [50, Infinity] read
    // (200 < Infinity), so it must not supersede it. This is the real
    // assertion: the open-ended read is treated as genuinely unbounded, not
    // silently capped at some default end line.
    const boundedMsgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', openEnded, { start: 50 }), // lines 50..EOF
      ...read('c2', 'a.kicad_sch', 'lines 1-200', { start: 1, end: 200 }),
      ...filler(2),
    ];
    const { messages: notSuperseded, stats: statsA } = capHistory(boundedMsgs, { ...opts, maxToolResultChars: 100000 });
    expect(notSuperseded[1].role === 'tool' && notSuperseded[1].content).toBe(openEnded);
    expect(statsA.superseded).toBe(0);

    // A later read that is itself open-ended (or whole-file) DOES contain it.
    const wholeFileMsgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', openEnded, { start: 50 }),
      ...read('c2', 'a.kicad_sch', 'whole file'), // [1, Infinity]
      ...filler(2),
    ];
    const { messages: superseded, stats: statsB } = capHistory(wholeFileMsgs, { ...opts, maxToolResultChars: 100000 });
    expect(superseded[1].role === 'tool' && superseded[1].content).toContain('superseded');
    expect(statsB.superseded).toBe(1);
  });

  it('does not let a failed later read supersede a successful earlier one', () => {
    // A read that failed returned no file content, so it cannot stand in for
    // one that succeeded. The loop marks this from the dispatch outcome.
    const good = 'GOOD'.repeat(2000);
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', good),
      ...read('c2', 'a.kicad_sch', 'error: ENOENT: no such file or directory', { failed: true }),
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    expect(out[1].role === 'tool' && out[1].content).toBe(good);
    expect(stats.superseded).toBe(0);
  });

  it('supersedes normally when a file\'s own contents look like an error message', () => {
    // The failure status comes from the dispatch outcome, never from sniffing
    // the text, so a real file that happens to start with "error: " (a log, a
    // pasted traceback) is still a successful read and still supersedes.
    const looksLikeAnError = `error: ${'something went wrong\n'.repeat(500)}`;
    const msgs: Msg[] = [
      ...read('c1', 'logs/build.log', looksLikeAnError),
      ...read('c2', 'logs/build.log', 'error: newer contents'),
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    expect(out[1].role === 'tool' && out[1].content).toContain('superseded');
    expect(stats.superseded).toBe(1);
  });

  it('treats a read with end_line but no start_line as a whole-file read', () => {
    // toolReadFile returns the entire file whenever start_line is absent, so
    // recording this as [1, 50] would understate it and let a later narrower
    // read wrongly supersede it.
    const whole = 'WHOLE'.repeat(2000);
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', whole, { end: 50 }),
      ...read('c2', 'a.kicad_sch', 'lines 1-40', { start: 1, end: 40 }),
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    expect(out[1].role === 'tool' && out[1].content).toBe(whole);
    expect(stats.superseded).toBe(0);
  });

  it('read_file normalizes a stringified start_line and writes it back into the call args', async () => {
    // The primary fix: normalize once, at the handler, so the tool and the
    // history recorder can never read the same bound differently. read_file's
    // handler uses only ctx.repoRoot, so a bare object stands in for RunContext.
    const dir = await mkdtemp(path.join(tmpdir(), 'history-handler-'));
    await writeFile(path.join(dir, 'f.txt'), 'a\nb\nc\nd\ne\n', 'utf8');
    const handler = TOOLS.find((t) => t.schema.name === 'read_file')!.handler;
    const args: Record<string, unknown> = { path: 'f.txt', start_line: '4' };
    const out = await handler({ repoRoot: dir } as unknown as RunContext, args);
    expect(out).not.toContain('a'); // a real partial read: line 1 is gone
    expect(args.start_line).toBe(4); // written back as the number the tool used

    // Garbage bounds are dropped, so the recorded call reads as a whole-file read.
    const args2: Record<string, unknown> = { path: 'f.txt', start_line: 'abc' };
    const out2 = await handler({ repoRoot: dir } as unknown as RunContext, args2);
    expect(out2).toContain('a'); // whole file
    expect('start_line' in args2).toBe(false); // dropped, not left as "abc"
  });

  it('does not treat a stringified start_line as a whole-file read', async () => {
    // Tool args reach the loop straight from JSON.parse of model output with no
    // schema coercion, so start_line can arrive as "4". toolReadFile coerces it
    // and really returns lines 4->EOF; rangeOf must credit the read with that
    // partial span, not the whole file. Recording it as [1, Infinity] would let
    // this partial read supersede an earlier genuine whole-file read and delete
    // content the model still relies on (the exact failure D3a forbids).
    const dir = await mkdtemp(path.join(tmpdir(), 'history-bound-'));
    await writeFile(path.join(dir, 'f.txt'), 'a\nb\nc\nd\ne\n', 'utf8');
    // The tool coerces the string to a partial read: line 'a' (line 1) is gone.
    expect(await toolReadFile(dir, 'f.txt', '4' as unknown as number, undefined)).not.toContain('a');

    const big = 'FULL-FILE-CONTENT '.repeat(200);
    const msgs: Msg[] = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'f.txt' } }] },
      { role: 'tool', toolCallId: 'c1', content: big },
      { role: 'assistant', content: null, toolCalls: [{ id: 'c2', name: 'read_file', args: { path: 'f.txt', start_line: '4' } }] },
      { role: 'tool', toolCallId: 'c2', content: '4: d\n5: e' },
    ];
    const { messages: out, stats } = capHistory(msgs);
    expect(stats.superseded).toBe(0);
    expect(out[3].role === 'tool' && out[3].content).toBe(big);
  });

  it('does not let a read with a non-numeric end_line supersede an earlier read', () => {
    // rangeOf's bad(e) half: a present-but-non-numeric end_line yields an
    // unknown span, so the read supersedes nothing — symmetric with the
    // stringified start_line guard, and the same conservative direction.
    const whole = 'WHOLE'.repeat(2000);
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', whole, { start: 1, end: 100 }),
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c2', name: 'read_file', args: { path: 'a.kicad_sch', start_line: 1, end_line: 'oops' } }],
      },
      { role: 'tool', toolCallId: 'c2', content: 'malformed range read' },
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    expect(out[1].role === 'tool' && out[1].content).toBe(whole);
    expect(stats.superseded).toBe(0);
  });

  it('does not supersede across different paths', () => {
    const msgs: Msg[] = [...read('c1', 'a.kicad_sch', 'A'.repeat(50)), ...read('c2', 'b.md', 'B'.repeat(50)), ...filler(2)];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 100000 });
    expect(out[1].role === 'tool' && out[1].content).toBe('A'.repeat(50));
    expect(stats.superseded).toBe(0);
  });

  it('clips an oversized tool result, keeping head and tail and saying so', () => {
    const body = `HEAD${'m'.repeat(5000)}TAIL`;
    const msgs: Msg[] = [
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'run_erc', args: {} }] },
      { role: 'tool', toolCallId: 'c1', content: body },
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, opts);
    const clipped = out[1];
    expect(clipped.role === 'tool' && clipped.content).toMatch(/^HEAD/);
    expect(clipped.role === 'tool' && clipped.content).toMatch(/TAIL$/);
    expect(clipped.role === 'tool' && clipped.content).toContain('characters elided');
    expect(clipped.role === 'tool' && clipped.content.length).toBeLessThan(body.length);
    expect(stats.truncated).toBe(1);
  });

  it('clips an oversized tool-call argument (a settled anchored edit payload)', () => {
    const payload = '(symbol (lib_id "Device:R"))'.repeat(200);
    const msgs: Msg[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'edit_file', args: { path: 'a.kicad_sch', new_string: payload } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'ok' },
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, opts);
    const call = out[0].role === 'assistant' ? out[0].toolCalls?.[0] : undefined;
    expect(String(call?.args.new_string).length).toBeLessThan(payload.length);
    expect(String(call?.args.new_string)).toContain('already applied');
    expect(call?.args.path).toBe('a.kicad_sch'); // short args pass through untouched
    expect(call?.name).toBe('edit_file');
    expect(stats.truncated).toBe(1);
  });

  it('never grows a barely-oversized value, and never reports a negative saving', () => {
    // The elision marker counts against the cap. Without that, a value one
    // character over the limit came back longer than it went in and
    // charsSaved went negative, so capping made the request bigger.
    const body = 'x'.repeat(opts.maxToolResultChars + 1);
    const msgs: Msg[] = [
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'run_erc', args: {} }] },
      { role: 'tool', toolCallId: 'c1', content: body },
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, opts);
    const got = out[1].role === 'tool' ? out[1].content : '';
    expect(got.length).toBeLessThanOrEqual(opts.maxToolResultChars);
    expect(got.length).toBeLessThan(body.length);
    expect(stats.charsSaved).toBeGreaterThan(0);
  });

  it('leaves a value whole when the cap is too small to hold a marker', () => {
    // Better to send the value intact than to replace it with a marker and
    // almost no content, or to grow it past its original size.
    const body = 'y'.repeat(500);
    const msgs: Msg[] = [
      { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'run_erc', args: {} }] },
      { role: 'tool', toolCallId: 'c1', content: body },
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolResultChars: 10 });
    expect(out[1].role === 'tool' && out[1].content).toBe(body);
    expect(stats.charsSaved).toBe(0);
  });

  it('does not count an argument clip that the cap was too small to make', () => {
    // The arg path must guard its accounting the way the result path does:
    // when clip declines (the cap cannot hold a marker) it returns the value
    // whole, so nothing was truncated and truncated/charsSaved must stay at 0.
    const payload = 'z'.repeat(500);
    const msgs: Msg[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'edit_file', args: { path: 'a.kicad_sch', new_string: payload } }],
      },
      { role: 'tool', toolCallId: 'c1', content: 'ok' },
      ...filler(2),
    ];
    const { messages: out, stats } = capHistory(msgs, { ...opts, maxToolArgChars: 10 });
    const call = out[0].role === 'assistant' ? out[0].toolCalls?.[0] : undefined;
    expect(String(call?.args.new_string)).toBe(payload); // returned whole, not clipped
    expect(stats.truncated).toBe(0);
    expect(stats.charsSaved).toBe(0);
  });

  it('never emits a lone surrogate when clipping across an astral character', () => {
    // clip slices by UTF-16 code unit, so an emoji straddling the head or tail
    // cut used to be split into unpaired surrogates. Sweep one across both cut
    // offsets and assert every code unit still pairs up.
    const hasLoneSurrogate = (t: string): boolean => {
      for (let i = 0; i < t.length; i++) {
        const c = t.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = t.charCodeAt(i + 1);
          if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
          i++;
        } else if (c >= 0xdc00 && c <= 0xdfff) {
          return true;
        }
      }
      return false;
    };
    // Range chosen to straddle both cut points under the real defaults: the
    // head cut lands near 2328 and the tail cut near 2445.
    for (let offset = 2300; offset <= 2470; offset++) {
      const body = 'a'.repeat(offset) + '\u{1F600}' + 'b'.repeat(6000);
      const msgs: Msg[] = [
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'run_erc', args: {} }] },
        { role: 'tool', toolCallId: 'c1', content: body },
        ...filler(20),
      ];
      const { messages: out } = capHistory(msgs, HISTORY_CAP_DEFAULTS);
      const got = out[1].role === 'tool' ? out[1].content : '';
      expect(got.length).toBeLessThan(body.length); // it really did clip
      expect(hasLoneSurrogate(got), `lone surrogate at offset ${offset}`).toBe(false);
    }
  });

  it('reports the lowest index it rewrote, so a prompt cache can keep a breakpoint below it', () => {
    // firstChanged is what lets AnthropicProvider place a cache_control
    // breakpoint under the rewrite instead of losing the whole cached prefix.
    const stale = 'OLD'.repeat(2000);
    const msgs: Msg[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'go' },
      ...read('c1', 'a.kicad_sch', stale), // assistant 2, tool 3
      ...read('c2', 'a.kicad_sch', 'CURRENT'),
      ...filler(2),
    ];
    const { stats } = capHistory(msgs, opts);
    expect(stats.superseded).toBe(1);
    expect(stats.firstChanged).toBe(3); // the superseded tool result

    // Nothing trimmed means nothing to invalidate.
    const clean = capHistory([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }], opts);
    expect(clean.stats.firstChanged).toBeNull();
  });

  it('leaves an unsettled tool call\'s arguments intact', () => {
    // A call with no result yet has not run, so the "already applied" argument
    // for clipping its payload does not hold: it is still the live instruction.
    const payload = '(symbol (lib_id "Device:R"))'.repeat(200);
    const msgs: Msg[] = [
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'pending', name: 'edit_file', args: { path: 'a.kicad_sch', new_string: payload } }],
      },
      ...filler(6), // pushes it well outside the recent window, but it stays unsettled
    ];
    const { messages: out, stats } = capHistory(msgs, opts);
    const call = out[0].role === 'assistant' ? out[0].toolCalls?.[0] : undefined;
    expect(String(call?.args.new_string)).toBe(payload);
    expect(stats.truncated).toBe(0);
  });

  it('leaves everything inside the recent window verbatim', () => {
    const body = 'R'.repeat(5000);
    const msgs: Msg[] = [
      ...filler(4),
      { role: 'assistant', content: null, toolCalls: [{ id: 'c9', name: 'read_file', args: { path: 'a.md' } }] },
      { role: 'tool', toolCallId: 'c9', content: body },
    ];
    const { messages: out, stats } = capHistory(msgs, opts);
    expect(out[out.length - 1].role === 'tool' && (out[out.length - 1] as { content: string }).content).toBe(body);
    expect(stats.charsSaved).toBe(0);
  });

  it('shrinks what a provider actually renders, end to end', () => {
    const msgs: Msg[] = [
      ...read('c1', 'a.kicad_sch', 'OLD'.repeat(3000)),
      ...read('c2', 'a.kicad_sch', 'NEW'.repeat(3000)),
      ...filler(2),
    ];
    const { messages: out } = capHistory(msgs, opts);
    expect(renderConversation(out).length).toBeLessThan(renderConversation(msgs).length / 2);
  });

  it('cuts a realistic schematic-stage conversation substantially, on the real defaults', () => {
    // Shaped like the observed create-pipeline runs: a 30kB schematic re-read
    // between anchored edits, each edit carrying a large payload, over enough
    // turns that the early reads are long settled.
    const sch = '(kicad_sch (symbol (lib_id "Device:R") (at 100 100 0)))\n'.repeat(600);
    const msgs: Msg[] = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(...read(`r${i}`, 'hardware/board.kicad_sch', sch));
      msgs.push({
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: `e${i}`, name: 'edit_file', args: { path: 'hardware/board.kicad_sch', new_string: sch.slice(0, 9000) } },
        ],
      });
      msgs.push({ role: 'tool', toolCallId: `e${i}`, content: 'edit applied' });
    }
    const { messages: out, stats } = capHistory(msgs, HISTORY_CAP_DEFAULTS);
    const before = renderConversation(msgs).length;
    const after = renderConversation(out).length;
    expect(after).toBeLessThan(before * 0.35);
    expect(stats.superseded).toBeGreaterThan(0);
    expect(stats.truncated).toBeGreaterThan(0);
    // The most recent read must survive intact regardless of how much was cut.
    // `toContain(sch.slice(0, 200))` would NOT prove that: `clip` keeps a 60%
    // head (2385 chars at the default cap), so a truncated result satisfies it
    // too. Assert on the newest read's own message: full length, and no elision
    // marker anywhere in it.
    const newest = out.find((m) => m.role === 'tool' && m.toolCallId === 'r5');
    expect(newest?.role === 'tool' && newest.content).toBe(sch);
    expect(newest?.role === 'tool' && newest.content).not.toContain('characters elided');
  });

  it('does not exempt the newest read from truncation once it leaves the recent window', () => {
    // The delta spec used to claim the newest read is "always sent in full".
    // It is not: being newest protects a read from supersession only. With both
    // reads below truncateBefore under the real defaults, the earlier is stubbed
    // AND the later is clipped, so the file is fully present in neither. This
    // pins the actual behavior the corrected spec describes.
    const sch = '(kicad_sch (symbol (lib_id "Device:R") (at 100 100 0)))\n'.repeat(600);
    const msgs: Msg[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do the thing' },
      ...read('c1', 'hardware/board.kicad_sch', sch),
      ...read('c2', 'hardware/board.kicad_sch', sch),
      ...filler(20), // pushes BOTH reads below truncateBefore at keepRecent: 12
    ];
    const { messages: out, stats } = capHistory(msgs, HISTORY_CAP_DEFAULTS);
    const first = out[3];
    const second = out[5];
    expect(first.role === 'tool' && first.content).toContain('superseded');
    expect(stats.superseded).toBe(1);
    // The newest read is NOT superseded, but it IS truncated.
    expect(second.role === 'tool' && second.content).not.toContain('superseded');
    expect(second.role === 'tool' && second.content).toContain('characters elided');
    expect(second.role === 'tool' && second.content.length).toBeLessThanOrEqual(
      HISTORY_CAP_DEFAULTS.maxToolResultChars,
    );
    expect(stats.truncated).toBeGreaterThanOrEqual(1);
  });
});

describe('historyCap config parsing', () => {
  it('defaults to true, and loadConfig turns { historyCap: false } into config.historyCap === false', async () => {
    expect(DEFAULTS.historyCap).toBe(true);

    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ historyCap: false }),
        'utf8',
      );
      const config = await loadConfig(repo);
      expect(config.historyCap).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('historyCap: false actually disables capping: a stale duplicate read is sent uncapped, not stubbed', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // Write historyCap: false before init, so runInit's read-modify-write of
      // config.json (via loadConfig) carries it through rather than overwriting
      // it with the default.
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify({ historyCap: false }), 'utf8');
      await runInit({ repoRoot: repo, installHooks: false });
      const writtenConfig = JSON.parse(
        await readFile(path.join(repo, '.copperhead', 'config.json'), 'utf8'),
      ) as { historyCap?: boolean };
      expect(writtenConfig.historyCap).toBe(false); // sanity: init didn't clobber it

      const body = 'a big file\n'.repeat(2000);
      await writeFile(path.join(repo, 'big.txt'), body, 'utf8');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });

      const seen: Msg[][] = [];
      let turn = 0;
      const provider: Provider = {
        name: 'scripted-uncapped',
        async chat(messages: Msg[]): Promise<Turn> {
          seen.push(messages.map((m) => JSON.parse(JSON.stringify(m)) as Msg));
          turn++;
          const usage = { inputTokens: 100, outputTokens: 10 };
          if (turn <= 2) {
            return {
              text: null,
              toolCalls: [{ id: `read-${turn}`, name: 'read_file', args: { path: 'big.txt' } }],
              usage,
            };
          }
          return {
            text: null,
            toolCalls: [{ id: 'fin', name: 'finish', args: { outcome: 'done', summary: 'done' } }],
            usage,
          };
        },
      };

      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'read the same file twice, with capping disabled',
        model: 'gpt-5',
        provider,
        maxTurns: 20,
        log: () => {},
        meta: { command: 'do', modelSource: 'flag', version: '0.0.0-test', kicadCliVersion: '0.0.0' },
      });

      // No saving at all: capHistory never ran, so RunStats.capCharsSaved must
      // be absent (the field is omitted, per transcript.ts, when there is
      // nothing to report) rather than merely zero.
      expect(res.stats.capCharsSaved).toBeUndefined();

      // The real assertion: the third request (after both reads) must carry the
      // first read's full, unstubbed content — proving the provider actually
      // received the uncapped array, not just that the counter stayed at zero.
      const lastRequest = seen[seen.length - 1]!;
      const toolResults = lastRequest.filter((m) => m.role === 'tool');
      expect(toolResults).toHaveLength(2);
      for (const m of toolResults) {
        expect(m.role === 'tool' && m.content).toBe(body);
      }
      expect(lastRequest.some((m) => m.role === 'tool' && m.content.includes('superseded'))).toBe(false);
    } finally {
      await cleanup();
    }
  }, 20000);
});

describe('capHistory in the agent loop', () => {
  /** Reads a big file twice (so the first read is superseded), then rate-limits
   *  the third turn once before finishing. */
  function retryingProvider(): Provider & { seen: Msg[][] } {
    let turn = 0;
    let thrown = false;
    const seen: Msg[][] = [];
    return {
      name: 'scripted-429',
      seen,
      async chat(messages: Msg[]): Promise<Turn> {
        // Record what actually went over the wire, not just what was computed.
        seen.push(messages.map((m) => JSON.parse(JSON.stringify(m)) as Msg));
        turn++;
        const usage = { inputTokens: 100, outputTokens: 10 };
        if (turn <= 2) {
          return {
            text: null,
            toolCalls: [{ id: `read-${turn}`, name: 'read_file', args: { path: 'big.txt' } }],
            usage,
          };
        }
        if (!thrown) {
          thrown = true;
          throw Object.assign(new Error('rate limited'), { status: 429 });
        }
        return {
          text: null,
          toolCalls: [{ id: 'fin', name: 'finish', args: { outcome: 'done', summary: 'done' } }],
          usage,
        };
      },
    };
  }

  it('marks a genuinely failed tool call, and only that call, as failed', async () => {
    // Proves the flag is set from the real dispatch outcome end to end, rather
    // than by any inspection of the result text.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      // A file whose contents start exactly like a tool error string.
      await writeFile(path.join(repo, 'looks-like-an-error.txt'), 'error: not really\n', 'utf8');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });

      const seen: Msg[][] = [];
      let turn = 0;
      const provider: Provider = {
        name: 'scripted-mixed',
        async chat(messages: Msg[]): Promise<Turn> {
          seen.push(messages.map((m) => JSON.parse(JSON.stringify(m)) as Msg));
          turn++;
          const usage = { inputTokens: 10, outputTokens: 1 };
          if (turn === 1) {
            return {
              text: null,
              usage,
              toolCalls: [
                // Succeeds, despite content that looks like an error.
                { id: 'ok', name: 'read_file', args: { path: 'looks-like-an-error.txt' } },
                // Genuinely fails: the file does not exist.
                { id: 'bad', name: 'read_file', args: { path: 'no-such-file.txt' } },
              ],
            };
          }
          return {
            text: null,
            usage,
            toolCalls: [{ id: 'fin', name: 'finish', args: { outcome: 'done', summary: 'done' } }],
          };
        },
      };

      await runAgentLoop({
        repoRoot: repo,
        request: 'one good read, one failing read',
        model: 'gpt-5',
        provider,
        maxTurns: 20,
        log: () => {},
        meta: { command: 'do', modelSource: 'flag', version: '0.0.0-test', kicadCliVersion: '0.0.0' },
      });

      const lastRequest = seen[seen.length - 1]!;
      const byId = new Map(lastRequest.flatMap((m) => (m.role === 'tool' ? [[m.toolCallId, m] as const] : [])));
      expect(byId.get('ok')?.failed).toBeUndefined(); // succeeded, text notwithstanding
      expect(byId.get('bad')?.failed).toBe(true); // really failed
    } finally {
      await cleanup();
    }
  }, 20000);

  it('does not count a saving for a turn replayed from the llm-cache', async () => {
    // The counter must reflect what actually went over the wire. A cache replay
    // sends nothing, so trimming it saved nothing: without the `cached` skip a
    // fully replayed stage prints "characters trimmed" beside 0 tokens.
    // (`runAgentLoop` skips its own CachingProvider wrap for an injected
    // provider, so the replay is modelled here by a provider that reports the
    // flag CachingProvider sets, asserted separately below.)
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await writeFile(path.join(repo, 'big.txt'), 'a big file\n'.repeat(2000), 'utf8');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });

      // Reads the same path twice, so supersession has real work to do.
      const script = (cached: boolean): Provider => {
        let turn = 0;
        return {
          name: cached ? 'scripted-replay' : 'scripted-live',
          async chat(): Promise<Turn> {
            turn++;
            const usage = { inputTokens: cached ? 0 : 100, outputTokens: cached ? 0 : 10 };
            const base = turn <= 2
              ? { text: null, toolCalls: [{ id: `read-${turn}`, name: 'read_file', args: { path: 'big.txt' } }], usage }
              : { text: null, toolCalls: [{ id: 'fin', name: 'finish', args: { outcome: 'done', summary: 'done' } }], usage };
            return cached ? { ...base, cached: true } : base;
          },
        };
      };
      const run = async (cached: boolean): Promise<number | undefined> => {
        const res = await runAgentLoop({
          repoRoot: repo,
          request: 'read it twice',
          model: 'gpt-5',
          provider: script(cached),
          maxTurns: 20,
          log: () => {},
          meta: { command: 'do', modelSource: 'flag', version: '0.0.0-test', kicadCliVersion: '0.0.0' },
        });
        return res.stats.capCharsSaved;
      };

      // Control: a live turn genuinely keeps those characters off the wire.
      expect(await run(false)).toBeGreaterThan(0);
      // A replayed turn sent nothing, so it must not be credited with a saving.
      expect(await run(true)).toBeUndefined();
    } finally {
      await cleanup();
    }
  }, 30000);

  it('CachingProvider flags a replayed turn as cached', async () => {
    // The other half of the contract above: the flag the loop keys off is really
    // set on a cache hit, and absent on the miss that populated it.
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-llmcache-'));
    const inner: Provider = {
      name: 'scripted',
      async chat(): Promise<Turn> {
        return { text: 'hello', toolCalls: [], usage: { inputTokens: 42, outputTokens: 7 } };
      },
    };
    const caching = new CachingProvider(inner, dir, () => {}, 'gpt-5');
    const msgs: Msg[] = [{ role: 'user', content: 'hi' }];

    const miss = await caching.chat(msgs, []);
    expect(miss.cached).toBeUndefined();
    expect(miss.usage.inputTokens).toBe(42);

    const hit = await caching.chat(msgs, []);
    expect(hit.cached).toBe(true);
    expect(hit.usage).toEqual({ inputTokens: 0, outputTokens: 0 }); // replay costs nothing
    expect(hit.text).toBe('hello');
  });

  it('counts the saving once per attempt, so a retried turn is not under-reported', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      // Large enough that superseding the first read is a real saving.
      await writeFile(path.join(repo, 'big.txt'), 'a big file\n'.repeat(2000), 'utf8');
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo });

      const provider = retryingProvider();
      const res = await runAgentLoop({
        repoRoot: repo,
        request: 'read it twice, then get rate limited',
        model: 'gpt-5',
        provider,
        // Comfortably above 6: at maxTurns 6 the loop injects its
        // "only 5 turns remain" nudge, which adds a message and muddies the
        // identity assertions below.
        maxTurns: 20,
        log: () => {},
        meta: { command: 'do', modelSource: 'flag', version: '0.0.0-test', kicadCliVersion: '0.0.0' },
      });

      // Turn 3 is capped once, sent, rejected with a 429, then sent again. Both
      // requests genuinely kept those characters off the wire, so the run-level
      // total must reflect two attempts, not one.
      const body = 'a big file\n'.repeat(2000);
      expect(res.stats.capCharsSaved).toBeGreaterThan(body.length * 1.5);

      // The counter alone could be right while the provider was still handed the
      // uncapped history, so assert against what it actually received. The two
      // rate-limited attempts are the last two requests.
      const attempts = provider.seen.slice(-2);
      expect(attempts).toHaveLength(2);
      for (const sent of attempts) {
        const stubs = sent.filter((m) => m.role === 'tool' && m.content.includes('superseded'));
        expect(stubs).toHaveLength(1); // the first read was replaced
        expect(sent.some((m) => m.role === 'tool' && m.content === body)).toBe(true); // the second survives
        // Identity invariants must hold on the wire, not just in the unit tests.
        expect(sent).toHaveLength(6); // system, user, a1, t1, a2, t2
        expect(sent.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);
        expect(sent.flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : []))).toEqual(['read-1', 'read-2']);
      }
      // Both attempts sent the same capped view.
      expect(attempts[0]).toEqual(attempts[1]);
    } finally {
      await cleanup();
    }
  }, 20000);
});
