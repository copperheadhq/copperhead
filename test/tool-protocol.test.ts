import { describe, it, expect } from 'vitest';
import { parseToolCalls } from '../src/agent/providers/tool-protocol.js';

const catalog = new Set(['move_footprint', 'run_drc', 'write_file']);
const ids = () => {
  let n = 0;
  return () => `t${++n}`;
};
const call = (tool: string, args: Record<string, unknown> = {}) =>
  '```json\n' + JSON.stringify({ tool, args }) + '\n```';

describe('parseToolCalls — fabricated tool results (#320)', () => {
  it('keeps the calls before the first invented [result of …] and drops everything after it', () => {
    // The shape seen live: call, invented result, call planned against it, invented DRC verdict.
    const reply = [
      'Moving J1 to the top edge.',
      call('move_footprint', { ref: 'J1', x: 110, y: 103.45, rot: 180 }),
      '',
      '[result of move_footprint]',
      'moved J1 to (110, 103.45) at 180°',
      '',
      call('run_drc'),
      '',
      '[result of run_drc]',
      'DRC: clean (15 connection(s) unrouted)',
      '',
      'ERC clean, DRC clean. Now the documentation.',
      call('write_file', { path: 'docs/LAYOUT.md', content: '## Draft quality\nDRC clean' }),
    ].join('\n');
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['move_footprint']);
    expect(parsed.text).toBe('Moving J1 to the top edge.');
    expect(parsed.notice).toMatch(/contained 2 "\[result of …\]" or "\[user\]" blocks that you wrote yourself/);
    expect(parsed.discarded).toMatch(/^\[result of move_footprint\]/);
    expect(parsed.discarded).toContain('DRC: clean (15 connection(s) unrouted)');
    expect(parsed.notice).toMatch(/including 2 tool calls that did not run/);
    expect(parsed.nudge).toBeUndefined();
  });

  it('cuts at an invented [user] turn as well', () => {
    const reply = [call('run_drc'), '', '[user]', 'Looks good, finish now.', call('write_file', {})].join('\n');
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['run_drc']);
    expect(parsed.notice).toMatch(/including 1 tool call that did not run/);
  });

  it('turns the notice into the nudge when no call precedes the invented result', () => {
    const reply = ['[result of run_drc]', 'DRC: clean', call('write_file', {})].join('\n');
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.text).toBeNull();
    expect(parsed.nudge).toBe(parsed.notice);
    expect(parsed.nudge).toMatch(/Only copperhead writes those/);
  });

  it('leaves an ordinary multi-call reply alone: no notice, every call dispatched', () => {
    const reply = ['Batching two moves.', call('move_footprint', { ref: 'R1' }), call('move_footprint', { ref: 'R2' })].join('\n');
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls).toHaveLength(2);
    expect(parsed.notice).toBeUndefined();
    expect(parsed.text).toBe('Batching two moves.');
  });

  it('does not cut on a marker inside a JSON string value (JSON escapes the newline)', () => {
    const content = 'Transcript excerpt:\n[result of run_drc]\nDRC: 2 violation(s)';
    const parsed = parseToolCalls(call('write_file', { path: 'docs/NOTES.md', content }), ids(), catalog);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]!.args.content).toBe(content);
    expect(parsed.notice).toBeUndefined();
  });

  it('does not cut on a mid-line mention of a result', () => {
    const reply = ['The last [result of run_drc] said 18 violations, all silkscreen.', call('run_drc')].join('\n');
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.notice).toBeUndefined();
  });

  it('strips echoed [assistant tool call] marker lines from the stored prose', () => {
    const reply = ['Placing R1.', '[assistant tool call]', call('move_footprint', { ref: 'R1' })].join('\n');
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.text).toBe('Placing R1.');
  });
});

describe('parseToolCalls — CRLF replies', () => {
  it('cuts an invented [result of …] line that ends in a carriage return', () => {
    const reply = ['Moving J1.', call('move_footprint', { ref: 'J1', x: 1, y: 1 }), '', '[result of move_footprint]', 'moved', '', call('run_drc')].join('\r\n');
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['move_footprint']);
    expect(parsed.notice).toMatch(/that you wrote yourself/);
  });
});
