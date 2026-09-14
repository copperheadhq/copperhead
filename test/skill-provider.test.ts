import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeProvider } from '../src/agent/loop.js';
import { providerForSkillRun } from '../src/commands/skill.js';
import { loadConfig, resolveCompatSettings } from '../src/config.js';

async function repoWithConfig(config: Record<string, unknown>): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'ch-skill-provider-'));
  await mkdir(path.join(repo, '.copperhead'));
  await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify(config), 'utf8');
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

describe('skill provider resolution', () => {
  it('forwards a configured compat endpoint and matches the direct provider path', async () => {
    const seen: { url?: string; model?: unknown } = {};
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        seen.url = req.url;
        seen.model = (JSON.parse(raw) as { model?: unknown }).model;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok', tool_calls: [] } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/v1`;
    const { repo, cleanup } = await repoWithConfig({ model: 'compat:local-test', baseURL: endpoint });
    try {
      const config = await loadConfig(repo);
      const skillPath = await providerForSkillRun(repo);
      const directPath = await makeProvider(config.model!, false, resolveCompatSettings(config, {}));

      expect(skillPath.model).toBe(config.model);
      expect(skillPath.provider.name).toBe('openai-compat');
      expect(skillPath.provider.name).toBe(directPath.name);
      await skillPath.provider.chat([], []);
      expect(seen.url).toBe('/v1/chat/completions');
      expect(seen.model).toBe('local-test');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await cleanup();
    }
  });

  it('preserves missing-endpoint validation for compat skill runs', async () => {
    const { repo, cleanup } = await repoWithConfig({ model: 'compat:local-test' });
    try {
      await expect(providerForSkillRun(repo)).rejects.toThrow(/requires an endpoint/);
    } finally {
      await cleanup();
    }
  });
});
