import { describe, it, expect } from 'vitest';
import {
  parseToolCalls,
  renderToolProtocol,
} from '../src/agent/providers/tool-protocol.js';
import type { ToolSchema } from '../src/agent/types.js';

const tools: ToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read a file from the repo',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'search',
    description: 'Search the repo',
    parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  },
  {
    name: 'finish',
    description: 'Finish the run',
    parameters: { type: 'object', properties: { outcome: { type: 'string' } } },
  },
];

const catalog = new Set(tools.map((t) => t.name));

function ids(): () => string {
  let n = 0;
  return () => `t-${++n}`;
}

describe('renderToolProtocol (#192)', () => {
  it('invites one or more tool calls per reply and does not say EXACTLY ONE', () => {
    const text = renderToolProtocol(tools);
    expect(text).toContain('# Tool protocol');
    expect(text).toMatch(/one or more JSON objects/i);
    expect(text).toMatch(/same turn/i);
    expect(text).toContain('read_file');
    expect(text).toContain('search');
    expect(text).not.toMatch(/EXACTLY ONE/i);
  });

  it('returns empty string when no tools are advertised', () => {
    expect(renderToolProtocol([])).toBe('');
  });
});

describe('parseToolCalls (#192)', () => {
  it('parses a single fenced tool call', () => {
    const reply = '```json\n{"tool":"read_file","args":{"path":"docs/SPEC.md"}}\n```';
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]).toMatchObject({ name: 'read_file', args: { path: 'docs/SPEC.md' } });
    expect(parsed.text).toBeNull();
    expect(parsed.nudge).toBeUndefined();
  });

  it('parses several independent fenced tool calls in one reply', () => {
    const reply = [
      '```json',
      '{"tool":"read_file","args":{"path":"docs/SPEC.md"}}',
      '```',
      '',
      '```json',
      '{"tool":"read_file","args":{"path":"docs/BOM.md"}}',
      '```',
      '',
      '```json',
      '{"tool":"search","args":{"pattern":"USB_DP"}}',
      '```',
    ].join('\n');
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['read_file', 'read_file', 'search']);
    expect(parsed.toolCalls.map((c) => c.args)).toEqual([
      { path: 'docs/SPEC.md' },
      { path: 'docs/BOM.md' },
      { pattern: 'USB_DP' },
    ]);
    expect(new Set(parsed.toolCalls.map((c) => c.id)).size).toBe(3);
    expect(parsed.nudge).toBeUndefined();
  });

  it('keeps surrounding prose when multiple calls are present', () => {
    const reply =
      'Reading the docs first.\n```json\n{"tool":"read_file","args":{"path":"a"}}\n```\n' +
      'and then searching.\n```json\n{"tool":"search","args":{"pattern":"x"}}\n```';
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['read_file', 'search']);
    expect(parsed.text).toMatch(/Reading the docs first/);
    expect(parsed.text).toMatch(/and then searching/);
  });

  it('rejects locked or hallucinated tool names (leaves them as prose)', () => {
    const reply = [
      '```json',
      '{"tool":"read_file","args":{"path":"ok.md"}}',
      '```',
      '```json',
      '{"tool":"edit_file","args":{"path":"secret.md","old":"a","new":"b"}}',
      '```',
      '```json',
      '{"tool":"totally_fake","args":{}}',
      '```',
    ].join('\n');
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['read_file']);
    // Locked/hallucinated JSON is not dispatched; remnants may remain in prose.
    expect(parsed.toolCalls.some((c) => c.name === 'edit_file')).toBe(false);
    expect(parsed.toolCalls.some((c) => c.name === 'totally_fake')).toBe(false);
  });

  it('nudges on a malformed near-miss without saying EXACTLY ONE', () => {
    const reply = '```json\n{"tool":"read_file","args":{"path":"docs/BOM.md"}\n```';
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls).toHaveLength(0);
    expect(parsed.nudge).toMatch(/read_file/);
    expect(parsed.nudge).toMatch(/malformed|re-emit/i);
    expect(parsed.nudge).not.toMatch(/EXACTLY ONE/i);
  });
});
