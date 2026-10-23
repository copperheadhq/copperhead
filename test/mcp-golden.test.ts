import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../src/mcp/server.js';
import { tempFixtureRepo } from './helpers.js';

/**
 * Golden request/response fixtures for the MCP surface (add-mcp-server 3.1a).
 *
 * Each fixture is one raw JSON-RPC request and the exact response the server
 * sends back, so a change to the handshake, a tool's schema or description, or
 * an error shape shows up as a fixture diff rather than passing silently. The
 * pinned exchanges are the deterministic ones: the handshake, the tool list, and
 * error results that need no model, no network and no machine-specific report.
 * The temp repo path is replaced by `<REPO>` before comparing.
 *
 * Goldens change ONLY via `COPPERHEAD_UPDATE_GOLDENS=1 npm test`; the diff is the
 * review artifact. A mismatch without the flag fails and writes nothing.
 */

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp');
const UPDATE = process.env.COPPERHEAD_UPDATE_GOLDENS === '1';

/** The MCP protocol revision the fixtures were recorded against (SDK 1.30.0's latest). */
const PROTOCOL = '2025-11-25';

interface Exchange {
  request: JSONRPCMessage;
  response: JSONRPCMessage;
}

async function golden(name: string, actual: Exchange): Promise<void> {
  const p = path.join(GOLDEN, `${name}.json`);
  if (UPDATE) {
    await mkdir(GOLDEN, { recursive: true });
    await writeFile(p, JSON.stringify(actual, null, 2) + '\n', 'utf8');
    return;
  }
  expect(existsSync(p), `golden ${name} missing: run COPPERHEAD_UPDATE_GOLDENS=1 npm test`).toBe(true);
  expect(actual).toEqual(JSON.parse(await readFile(p, 'utf8')));
}

/**
 * A raw JSON-RPC peer on the server: sends one request at a time and returns
 * the response with the same id, so the fixture holds exactly what went over
 * the wire, below the client SDK.
 */
async function rawPeer(repo: string): Promise<{
  send: (method: string, params?: Record<string, unknown>) => Promise<Exchange>;
  notify: (method: string) => Promise<void>;
  close: () => Promise<void>;
}> {
  const server = createMcpServer({ repoRoot: repo });
  const [peer, serverTransport] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<number, (m: JSONRPCMessage) => void>();
  peer.onmessage = (m) => {
    const id = (m as { id?: number }).id;
    if (id !== undefined) waiting.get(id)?.(m);
  };
  await server.connect(serverTransport);
  await peer.start();
  let next = 1;
  // match the path as it appears inside serialized JSON (backslashes escaped on Windows)
  const repoInJson = JSON.stringify(repo).slice(1, -1);
  const sanitize = (m: JSONRPCMessage): JSONRPCMessage => JSON.parse(JSON.stringify(m).split(repoInJson).join('<REPO>'));
  return {
    async send(method, params) {
      const request = { jsonrpc: '2.0', id: next++, method, ...(params ? { params } : {}) } as JSONRPCMessage;
      const response = new Promise<JSONRPCMessage>((resolve) => waiting.set((request as { id: number }).id, resolve));
      await peer.send(request);
      return { request, response: sanitize(await response) };
    },
    notify: (method) => peer.send({ jsonrpc: '2.0', method } as JSONRPCMessage),
    close: async () => void (await Promise.allSettled([peer.close(), server.close()])),
  };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A handshaken raw peer on a fresh fixture repo. */
async function session(): Promise<{ send: (method: string, params?: Record<string, unknown>) => Promise<Exchange>; init: Exchange }> {
  const { repo, cleanup } = await tempFixtureRepo();
  cleanups.push(cleanup);
  const peer = await rawPeer(repo);
  cleanups.push(peer.close);
  const init = await peer.send('initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'golden', version: '1' },
  });
  await peer.notify('notifications/initialized');
  return { send: peer.send, init };
}

describe('MCP golden request/response fixtures (3.1a)', () => {
  it('initialize: server info, capabilities, instructions and the negotiated protocol', async () => {
    const { init } = await session();
    await golden('initialize', init);
  });

  it('tools/list: the five tools, their schemas, descriptions and schema versions', async () => {
    const { send } = await session();
    await golden('tools-list', await send('tools/list'));
  });

  it('copperhead_init with a path that escapes the repo: a validation error result', async () => {
    const { send } = await session();
    await golden('init-path-escape', await send('tools/call', { name: 'copperhead_init', arguments: { path: '../..' } }));
  });

  it('copperhead_do with no credential: an unavailable error result, no run started', async () => {
    const { send } = await session();
    const saved = { o: process.env.OPENAI_API_KEY, a: process.env.ANTHROPIC_API_KEY, m: process.env.COPPERHEAD_MODEL };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.COPPERHEAD_MODEL;
    try {
      await golden('do-no-credential', await send('tools/call', { name: 'copperhead_do', arguments: { request: 'rename R1 to R10' } }));
    } finally {
      if (saved.o !== undefined) process.env.OPENAI_API_KEY = saved.o;
      if (saved.a !== undefined) process.env.ANTHROPIC_API_KEY = saved.a;
      if (saved.m !== undefined) process.env.COPPERHEAD_MODEL = saved.m;
    }
  });

  it('a tool outside the surface: the error a host gets for an unknown name', async () => {
    const { send } = await session();
    await golden('unknown-tool', await send('tools/call', { name: 'edit_file', arguments: {} }));
  });
});
