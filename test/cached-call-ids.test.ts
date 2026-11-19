import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeCodeProvider, type QueryLike, type QueryMessage } from '../src/agent/providers/claude-code.js';
import { CachingProvider } from '../src/agent/response-cache.js';
import { renderConversation, renderDelta } from '../src/agent/providers/tool-protocol.js';
import type { Msg, ToolSchema } from '../src/agent/types.js';

const tools: ToolSchema[] = [
  { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'run_erc', description: 'erc', parameters: { type: 'object', properties: {} } },
];
const reply = (tool: string, args: Record<string, unknown>): QueryMessage[] => [
  { type: 'assistant', message: { content: [{ type: 'text', text: '```json\n' + JSON.stringify({ tool, args }) + '\n```' }] } },
  { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } },
];
const fakeQuery = (out: QueryMessage[]): QueryLike => () => (async function* () { for (const m of out) yield m; })();

/**
 * Review finding on #460: CachingProvider replays a stored turn with its stored
 * `cc-N` ids, and a provider constructed after a restart hands the same ids out
 * live, so one history holds `cc-1` twice. Each result must stay labelled by the
 * call that preceded it.
 */
describe('cached and live turns that reuse a tool-call id', () => {
  it('keep their own result labels in the rendered history', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-'));
    try {
      const messages: Msg[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
      // Run 1: a live read_file turn, written to the cache under id cc-1.
      const first = new CachingProvider(new ClaudeCodeProvider('claude-code', fakeQuery(reply('read_file', { path: 'a' }))), dir);
      const t1 = await first.chat(messages, tools);
      expect(t1.toolCalls.map((c) => [c.id, c.name])).toEqual([['cc-1', 'read_file']]);

      // Run 2 (restart): the same turn replays from the cache, then a live turn
      // from the fresh provider, whose counter starts over.
      const second = new CachingProvider(new ClaudeCodeProvider('claude-code', fakeQuery(reply('run_erc', {}))), dir);
      const replayed = await second.chat(messages, tools);
      expect(second.cacheHits).toBe(1);
      expect(replayed.toolCalls[0]!.id).toBe('cc-1');
      const history: Msg[] = [
        ...messages,
        { role: 'assistant', content: replayed.text, toolCalls: replayed.toolCalls },
        { role: 'tool', toolCallId: 'cc-1', content: 'FILE CONTENTS' },
      ];
      const live = await second.chat(history, tools);
      expect(live.toolCalls.map((c) => [c.id, c.name])).toEqual([['cc-1', 'run_erc']]); // the collision
      history.push({ role: 'assistant', content: live.text, toolCalls: live.toolCalls }, { role: 'tool', toolCallId: 'cc-1', content: 'ERC: clean' });

      const full = renderConversation(history);
      expect(full).toContain('[result of read_file]\nFILE CONTENTS');
      expect(full).toContain('[result of run_erc]\nERC: clean');
      expect(full).not.toContain('[result of run_erc]\nFILE CONTENTS');
      expect(renderDelta(history, 3)).toContain('[result of read_file]\nFILE CONTENTS');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
