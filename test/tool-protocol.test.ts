import { describe, it, expect } from 'vitest';
import { parseToolCalls, renderUndispatched } from '../src/agent/providers/tool-protocol.js';

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

describe('renderToolProtocol — batching (#192)', () => {
  it('invites one or more calls per reply, run in order, and never says EXACTLY ONE', async () => {
    const { renderToolProtocol } = await import('../src/agent/providers/tool-protocol.js');
    const text = renderToolProtocol([
      { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
    ]);
    expect(text).toMatch(/one or more JSON objects, one per tool call/);
    expect(text).toMatch(/runs in that same turn, in the order written/);
    expect(text).toMatch(/"call k of N"/);
    expect(text).not.toMatch(/EXACTLY ONE/i);
    // The batching rule itself lives in the WORKFLOW prompt; the protocol must not grow a second copy.
    expect(text).not.toMatch(/record_constraint|resolve_affected/);
  });

  it('renders nothing when no tools are advertised', async () => {
    const { renderToolProtocol } = await import('../src/agent/providers/tool-protocol.js');
    expect(renderToolProtocol([])).toBe('');
  });

  it('nudges a malformed near-miss per call, never "exactly one"', () => {
    const parsed = parseToolCalls('```json\n{"tool": "run_drc", "args": {\n```', ids(), catalog);
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.nudge).toMatch(/looks malformed/);
    expect(parsed.nudge).toMatch(/one complete JSON object/);
    expect(parsed.nudge).not.toMatch(/exactly one/i);
  });
});

describe('renderConversation / renderDelta — batched call labels (#192)', () => {
  const history = async () => {
    const mod = await import('../src/agent/providers/tool-protocol.js');
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'go' },
      {
        role: 'assistant' as const,
        content: null,
        toolCalls: [
          { id: 'cc-1', name: 'read_file', args: { path: 'a.md' } },
          { id: 'cc-2', name: 'read_file', args: { path: 'b.md' } },
          { id: 'cc-3', name: 'run_drc', args: {} },
        ],
      },
      { role: 'tool' as const, toolCallId: 'cc-1', content: 'A' },
      { role: 'tool' as const, toolCallId: 'cc-2', content: 'B' },
      { role: 'tool' as const, toolCallId: 'cc-3', content: 'clean' },
      { role: 'assistant' as const, content: null, toolCalls: [{ id: 'cc-4', name: 'read_file', args: { path: 'c.md' } }] },
      { role: 'tool' as const, toolCallId: 'cc-4', content: 'C' },
    ];
    return { ...mod, messages };
  };

  it('numbers the calls and results of a batched reply so same-name results are told apart', async () => {
    const { renderConversation, messages } = await history();
    const text = renderConversation(messages);
    expect(text).toContain('[assistant tool call 1 of 3]\n```json\n{"tool":"read_file","args":{"path":"a.md"}}');
    expect(text).toContain('[assistant tool call 2 of 3]\n```json\n{"tool":"read_file","args":{"path":"b.md"}}');
    expect(text).toContain('[assistant tool call 3 of 3]');
    expect(text).toContain('[result of read_file, call 1 of 3]\nA');
    expect(text).toContain('[result of read_file, call 2 of 3]\nB');
    expect(text).toContain('[result of run_drc, call 3 of 3]\nclean');
  });

  it('keeps the bare label for a reply that made one call', async () => {
    const { renderConversation, messages } = await history();
    const text = renderConversation(messages);
    expect(text).toContain('[assistant tool call]\n```json\n{"tool":"read_file","args":{"path":"c.md"}}');
    expect(text).toContain('[result of read_file]\nC');
    expect(text).not.toContain('call 1 of 1');
  });

  it('labels a resumed session delta the same way, from the call index of the whole history', async () => {
    const { renderDelta, messages } = await history();
    // Only the three results of the batched reply are new.
    const text = renderDelta(messages, 3);
    expect(text).toContain('[result of read_file, call 1 of 3]\nA');
    expect(text).toContain('[result of read_file, call 2 of 3]\nB');
    expect(text).toContain('[result of run_drc, call 3 of 3]\nclean');
    expect(text).not.toContain('[assistant tool call');
  });

  it('cuts a fabricated result written in the batched label form (#320 still holds)', () => {
    const reply = [call('run_drc'), '[result of run_drc, call 1 of 2]', 'clean', call('write_file', {})].join('\n');
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['run_drc']);
    expect(parsed.notice).toMatch(/1 "\[result of …\]" or "\[user\]" block that you wrote yourself/);
  });

  it('strips an echoed batched call marker from the stored prose', () => {
    const reply = ['Checking.', '[assistant tool call 2 of 2]', call('run_drc')].join('\n');
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['run_drc']);
    expect(parsed.text).toBe('Checking.');
  });
});

describe('untested paths from the #460 review', () => {
  it('a tool message whose id is not in the history keeps the bare id as its label', async () => {
    const { renderConversation } = await import('../src/agent/providers/tool-protocol.js');
    const text = renderConversation([
      { role: 'assistant', content: null, toolCalls: [{ id: 'a', name: 'read_file', args: {} }, { id: 'b', name: 'run_drc', args: {} }] },
      { role: 'tool', toolCallId: 'ghost', content: 'orphan' },
    ]);
    expect(text).toContain('[result of ghost]\norphan');
  });

  it('an <invoke> block gets the per-call JSON steer and dispatches nothing', () => {
    const parsed = parseToolCalls('<invoke name="run_drc">\n<parameter name="x">1</parameter>\n</invoke>', ids(), catalog);
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.nudge).toMatch(/written as an <invoke> block/);
    expect(parsed.nudge).toMatch(/Write each call as its own JSON object/);
    expect(parsed.nudge).not.toMatch(/exactly one/i);
  });
});

describe('repeated call ids keep chronological result labels (#460 review)', () => {
  // CachingProvider replays stored cc-N ids and a restarted provider hands the same
  // ids out live, so one run's history can hold cc-1 twice.
  const history = [
    { role: 'user' as const, content: 'go' },
    { role: 'assistant' as const, content: null, toolCalls: [{ id: 'cc-1', name: 'read_file', args: { path: 'a' } }] },
    { role: 'tool' as const, toolCallId: 'cc-1', content: 'FILE CONTENTS' },
    { role: 'assistant' as const, content: null, toolCalls: [{ id: 'cc-1', name: 'run_erc', args: {} }, { id: 'cc-2', name: 'run_drc', args: {} }] },
    { role: 'tool' as const, toolCallId: 'cc-1', content: 'ERC: clean' },
    { role: 'tool' as const, toolCallId: 'cc-2', content: 'DRC: clean' },
  ];

  it('renderConversation labels each result by the call that preceded it', async () => {
    const { renderConversation } = await import('../src/agent/providers/tool-protocol.js');
    const text = renderConversation(history);
    expect(text).toContain('[result of read_file]\nFILE CONTENTS');
    expect(text).toContain('[result of run_erc, call 1 of 2]\nERC: clean');
    expect(text).toContain('[result of run_drc, call 2 of 2]\nDRC: clean');
    expect(text).not.toContain('[result of run_erc, call 1 of 2]\nFILE CONTENTS');
  });

  it('renderDelta does the same, with the replies before the delta feeding the index', async () => {
    const { renderDelta } = await import('../src/agent/providers/tool-protocol.js');
    expect(renderDelta(history, 2)).toBe(
      ['[result of read_file]\nFILE CONTENTS', '[result of run_erc, call 1 of 2]\nERC: clean', '[result of run_drc, call 2 of 2]\nDRC: clean'].join('\n\n'),
    );
  });
});

describe('parseToolCalls — undispatched calls in a mixed reply (#306)', () => {
  it('reports a call for a tool outside the catalog written next to calls that ran', () => {
    const reply = [call('run_drc'), call('edit_file', { path: 'docs/SPEC.md' }), call('edit_file', { path: 'docs/BOM.md' })].join('\n');
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['run_drc']);
    expect(parsed.undispatched).toEqual({ unavailable: ['edit_file'], malformed: [] });
  });

  it('reports a catalog call that is one brace short next to calls that ran', () => {
    const broken = '```json\n{"tool": "move_footprint", "args": {"ref": "R1"}\n```';
    const parsed = parseToolCalls([call('run_drc'), broken].join('\n'), ids(), catalog);
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['run_drc']);
    expect(parsed.undispatched).toEqual({ unavailable: [], malformed: ['move_footprint'] });
  });

  it('reports nothing when every call in the reply ran', () => {
    const reply = [call('run_drc'), call('write_file', { path: 'a.md', content: 'see {"tool": "edit_file"} above' })].join('\n');
    const parsed = parseToolCalls(reply, ids(), catalog);
    expect(parsed.toolCalls).toHaveLength(2);
    expect(parsed.undispatched).toBeUndefined();
  });

  it('does not report narration that quotes a call or echoes the protocol template', () => {
    const narration = 'Next I will send {"tool": "<tool_name>", "args": { ... }} for each file, then "tool": "write_file".';
    const parsed = parseToolCalls([call('run_drc'), narration].join('\n'), ids(), catalog);
    expect(parsed.toolCalls.map((c) => c.name)).toEqual(['run_drc']);
    expect(parsed.undispatched).toBeUndefined();
  });

  it('leaves a reply with no dispatched call to the nudge', () => {
    const parsed = parseToolCalls(call('edit_file'), ids(), catalog);
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.undispatched).toBeUndefined();
    expect(parsed.nudge).toMatch(/not in this turn's tool catalog/);
  });
});

describe('renderUndispatched (#306)', () => {
  it('asks for the calls again when the same reply unlocked the tool', () => {
    const message = renderUndispatched({ unavailable: ['write_file'], malformed: [] }, new Set(['write_file', 'run_drc']), true);
    expect(message).toMatch(/"write_file": not in the tool catalog when you replied\. It is available now/);
    expect(message).not.toMatch(/propose_change/);
  });

  it('points at propose_change and validate_change while the tool is still locked', () => {
    const message = renderUndispatched({ unavailable: ['write_file', 'edit_file'], malformed: ['run_drc'] }, new Set(['run_drc']), false);
    expect(message).toMatch(/"write_file", "edit_file": not in the tool catalog\. .*propose_change, then validate_change/);
    expect(message).toMatch(/"run_drc": a call did not parse as valid JSON/);
    expect(message).toMatch(/Do not assume a result/);
  });

  it('uses the plural when the same reply unlocked several tools', () => {
    const message = renderUndispatched({ unavailable: ['write_file', 'edit_file'], malformed: [] }, new Set(['write_file', 'edit_file']), true);
    expect(message).toMatch(/"write_file", "edit_file": not in the tool catalog when you replied\. They are available now/);
  });

  it('calls a name unknown, and does not ask for a second proposal, once edits are unlocked', () => {
    const available = new Set(['run_drc', 'edit_file']);
    const message = renderUndispatched({ unavailable: ['edit_files'], malformed: [] }, available, true);
    expect(message).toMatch(/"edit_files": not a tool in the catalog\. Use one of the available tools: run_drc, edit_file\./);
    expect(message).not.toMatch(/propose_change/);
  });
});
