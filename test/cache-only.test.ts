import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CachingProvider } from '../src/agent/response-cache.js';
import { makeProvider, runAgentLoop } from '../src/agent/loop.js';
import { tempFixtureRepo } from './helpers.js';
import type { Msg, Turn } from '../src/agent/types.js';

const messages: Msg[] = [{ role: 'user', content: 'recorded request' }];
const recorded: Turn = { text: 'recorded answer', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } };
afterEach(() => vi.unstubAllEnvs());

describe('strict cache-only execution', () => {
  it('invalidates responses when tool parameters change under the same name', async () => {
    vi.stubEnv('COPPERHEAD_CACHE_ONLY', '0');
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-schema-'));
    try {
      const live = vi.fn(async () => recorded);
      const cache = new CachingProvider({ name: 'openai', chat: live }, dir);
      const tool = { name: 'propose_change', description: 'Propose', parameters: { type: 'object' } };
      await cache.chat(messages, [tool]);
      await cache.chat(messages, [{ ...tool, parameters: { type: 'object', properties: { specs: { type: 'array' } } } }]);
      expect(live).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['gpt-5', 'claude', 'codex', 'claude-code:opus', 'cursor', 'compat:local-model'])(
    '%s cannot call a live provider or require credentials', async (model) => {
      vi.stubEnv('COPPERHEAD_CACHE_ONLY', '1');
      vi.stubEnv('OPENAI_API_KEY', undefined);
      vi.stubEnv('ANTHROPIC_API_KEY', undefined);
      const provider = await makeProvider(model);
      await expect(provider.chat(messages, [])).rejects.toThrow('forbids live provider calls');
    },
  );

  it('replays a recorded entry without invoking the inner provider', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-only-'));
    try {
      vi.stubEnv('COPPERHEAD_CACHE_ONLY', '0');
      const live = vi.fn(async () => recorded);
      await new CachingProvider({ name: 'openai', chat: live }, dir, undefined, 'gpt-5').chat(messages, []);
      vi.stubEnv('COPPERHEAD_CACHE_ONLY', '1');
      const replay = new CachingProvider(await makeProvider('gpt-5'), dir, undefined, 'gpt-5');
      expect(await replay.chat(messages, [])).toEqual({ ...recorded, usage: { inputTokens: 0, outputTokens: 0 } });
      expect(replay.cacheHits).toBe(1);
      expect(live).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['{broken', '{}', 'null', '{"text":"bad","toolCalls":[{"id":"x","name":"write_file","args":null}]}'])(
    'fails closed on corrupt entry %s', async (corrupt) => {
      const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-cache-only-'));
      try {
        vi.stubEnv('COPPERHEAD_CACHE_ONLY', '0');
        await new CachingProvider({ name: 'openai', chat: async () => recorded }, dir).chat(messages, []);
        const file = (await readdir(dir)).find((name) => name.endsWith('.json'))!;
        await writeFile(path.join(dir, file), corrupt, 'utf8');
        vi.stubEnv('COPPERHEAD_CACHE_ONLY', '1');
        const inner = vi.fn(async () => recorded);
        const replay = new CachingProvider({ name: 'openai', chat: inner }, dir);
        await expect(replay.chat(messages, [])).rejects.toThrow('LLM cache miss');
        expect(inner).not.toHaveBeenCalled();
        expect(replay.cacheHits).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('cannot bypass strict replay through llmCache:false in the real loop', async () => {
    vi.stubEnv('COPPERHEAD_CACHE_ONLY', '1');
    vi.stubEnv('OPENAI_API_KEY', undefined);
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const configFile = path.join(repo, '.copperhead', 'config.json');
      await mkdir(path.dirname(configFile), { recursive: true });
      await writeFile(configFile, JSON.stringify({ llmCache: false }), 'utf8');
      const result = await runAgentLoop({ repoRoot: repo, model: 'gpt-5', request: 'uncached', allowDirty: true, log: () => {} });
      expect(result.outcome).toBe('failure');
      expect(result.summary).toContain('LLM cache miss in COPPERHEAD_CACHE_ONLY mode');
    } finally {
      await cleanup();
    }
  });
});
