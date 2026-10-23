import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { tempFixtureRepo } from './helpers.js';

/** Tool results are a JSON envelope in a single text block. */
function envelopeOf(res: unknown): { ok: boolean; summary: string; data?: unknown; error?: { kind: string; message: string } } {
  const content = (res as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text);
}

/** Connect an in-process client to a server bound to `repo`. */
async function connect(repo: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer({ repoRoot: repo });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: async () => void (await Promise.allSettled([client.close(), server.close()])) };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('copperhead_init reports a skipped pre-commit hook (#103)', () => {
  it('names the skip in the summary when a foreign hook is in the way', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);
    await writeFile(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nnpm run lint\n', 'utf8');
    // `copperhead_init` gates on kicad-cli; stub only the version preflight
    // (no KiCad tooling is exercised by this path).
    const bin = await mkdtemp(path.join(tmpdir(), 'copperhead-kicad-stub-'));
    const saved = process.env.COPPERHEAD_KICAD_CLI;
    process.env.COPPERHEAD_KICAD_CLI = path.join(bin, 'kicad-cli');
    try {
      await writeFile(process.env.COPPERHEAD_KICAD_CLI, '#!/bin/sh\necho "kicad-cli 10.0.4"\n', { mode: 0o755 });
      const { client, close } = await connect(repo);
      cleanups.push(close);
      const env = envelopeOf(await client.callTool({ name: 'copperhead_init', arguments: {} }));
      // ok stays true, to match the CLI's unchanged exit 0
      expect(env.ok).toBe(true);
      expect(env.summary).toMatch(/init wrote \d+ file\(s\); WARNING: pre-commit hook not installed/);
      expect(env.summary).toMatch(/gate is NOT active/);
    } finally {
      if (saved === undefined) delete process.env.COPPERHEAD_KICAD_CLI;
      else process.env.COPPERHEAD_KICAD_CLI = saved;
      await rm(bin, { recursive: true, force: true });
    }
  });
});
