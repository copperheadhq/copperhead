import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CachingProvider } from '../src/agent/response-cache.js';
import type { Msg, ToolSchema, Turn } from '../src/agent/types.js';

const dirs: string[] = [];
const messages: Msg[] = [{ role: 'user', content: 'inspect the schematic' }];
const tool: ToolSchema = {
  name: 'inspect', description: 'Inspect the schematic',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};
const turn = (content: string): Turn => ({
  text: content,
  toolCalls: [{ id: 'call-1', name: tool.name, args: { path: 'hardware/board.kicad_sch' } }],
  usage: { inputTokens: 5, outputTokens: 2 },
});

async function cache(response: Turn = turn('inspection requested')) {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-safety-'));
  dirs.push(dir);
  const chat = vi.fn(async () => response);
  return { dir, chat, provider: new CachingProvider({ name: 'test', chat }, dir) };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('response cache tool contracts', () => {
  it.each(['description', 'schema'])('does not reuse a response when a tool %s changes', async (change) => {
    const { chat, provider } = await cache();
    const updated: ToolSchema = change === 'description'
      ? { ...tool, description: 'Inspect only electrical connections' }
      : { ...tool, parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] } };
    await provider.chat(messages, [tool]);
    await provider.chat(messages, [updated]);
    expect(chat).toHaveBeenCalledTimes(2);
    const repeated = await provider.chat(messages, [updated]);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(repeated.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('response cache secret hygiene', () => {
  it.each(['text', 'arguments', 'vendor data'])('does not persist a secret in %s or change the live response', async (field) => {
    const secret = 'sk-cache-test-secret';
    const response = turn('inspection requested');
    if (field === 'text') response.text = secret;
    if (field === 'arguments') response.toolCalls[0]!.args = { content: secret };
    if (field === 'vendor data') response.toolCalls[0]!.extra = { signature: secret };
    const { dir, chat, provider } = await cache(response);
    expect(await provider.chat(messages, [tool])).toEqual(response);
    expect(await provider.chat(messages, [tool])).toEqual(response);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(provider.cacheHits).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it('detects an environment secret even when JSON escapes quotes, slashes, or newlines', async () => {
    const secret = 'private\\value\nwith"quotes';
    vi.stubEnv('COPPERHEAD_TEST_TOKEN', secret);
    const response = turn('inspection requested');
    response.toolCalls[0]!.args = { content: `prefix ${secret} suffix` };
    const { dir, provider } = await cache(response);
    const live = await provider.chat(messages, [tool]);
    expect(live.toolCalls[0]!.args.content).toBe(`prefix ${secret} suffix`);
    expect(await readdir(dir)).toEqual([]);
  });

  it('discards an existing sensitive cache entry and fetches a clean response', async () => {
    const { dir, chat, provider } = await cache();
    await provider.chat(messages, [tool]);
    const [entry] = (await readdir(dir)).filter((file) => file.endsWith('.json'));
    await writeFile(path.join(dir, entry!), JSON.stringify(turn('sk-persisted-secret')));
    const result = await provider.chat(messages, [tool]);
    expect(result.text).toBe('inspection requested');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(provider.cacheHits).toBe(0);
    expect(await readFile(path.join(dir, entry!), 'utf8')).not.toContain('sk-persisted-secret');
  });
});
