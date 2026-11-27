import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { MCP_PROTOCOL_VERSION, PIPELINE_TOOL_NAMES } from '../src/mcp/server.js';
import { tempFixtureRepo } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The in-memory suite proves the tool contracts; this one proves the transport.
 * A single stray `console.log` anywhere under `copperhead mcp` corrupts the
 * JSON-RPC stream, and the only way to catch that is to speak the real protocol
 * down a real pipe: the handshake below cannot complete unless stdout carried
 * nothing but JSON-RPC.
 */
describe('copperhead mcp over real stdio', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  it('completes a handshake and serves the pipeline tools with stdout uncorrupted', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/cli.ts', 'mcp', '--repo', repo],
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: '1' } as Record<string, string>,
    });
    const client = new Client({ name: 'stdio-test', version: '1' });
    await client.connect(transport);
    cleanups.push(async () => void (await client.close().catch(() => {})));

    expect(client.getServerVersion()?.version).toBe(MCP_PROTOCOL_VERSION);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...PIPELINE_TOOL_NAMES].sort());

    // A real tool call round-trips too, so the stream survives past the
    // handshake and through a result large enough to span several chunks.
    const res = await client.callTool({ name: 'copperhead_check', arguments: {} });
    const envelope = JSON.parse((res as { content: { text: string }[] }).content[0]!.text);
    expect(envelope).toHaveProperty('summary');
    expect(envelope).toHaveProperty('data');
  }, 180_000);

  it('diagnoses a broken kicad-cli instead of failing opaquely (design D10)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);
    // Shadow kicad-cli with a shim that always fails, so the environment looks
    // broken to every tool. doctor must still answer; check must not pretend to.
    const shimDir = await mkdtemp(path.join(tmpdir(), 'copperhead-shim-'));
    const shim = path.join(shimDir, 'kicad-cli');
    await writeFile(shim, '#!/bin/sh\necho "kicad-cli: simulated failure" >&2\nexit 1\n', 'utf8');
    await chmod(shim, 0o755);
    cleanups.push(() => rm(shimDir, { recursive: true, force: true }));

    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'src/cli.ts', 'mcp', '--repo', repo],
      cwd: ROOT,
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}`, NO_COLOR: '1' } as Record<string, string>,
    });
    const client = new Client({ name: 'stdio-doctor', version: '1' });
    await client.connect(transport);
    cleanups.push(async () => void (await client.close().catch(() => {})));

    const doctor = JSON.parse(
      (
        (await client.callTool({ name: 'copperhead_doctor', arguments: {} })) as { content: { text: string }[] }
      ).content[0]!.text,
    );
    const kicadCheck = (doctor.data.checks as { name: string; status: string }[]).find((c) =>
      /kicad/i.test(c.name),
    );
    expect(kicadCheck, 'doctor reported no kicad-cli check at all').toBeDefined();
    expect(kicadCheck!.status).toBe('fail');

    // Every other tool gates on kicad-cli and must say so with a typed error.
    const check = JSON.parse(
      (
        (await client.callTool({ name: 'copperhead_check', arguments: {} })) as { content: { text: string }[] }
      ).content[0]!.text,
    );
    expect(check.ok).toBe(false);
    expect(check.error.kind).toBe('unavailable');
  }, 180_000);

  it('delivers copperhead_do progress notifications to the host over the pipe (3.1a)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    cleanups.push(cleanup);
    // The real server and transport, with copperhead_do driven by a scripted
    // provider (the createMcpServer test seam), so no model and no network.
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', 'test/fixtures/mcp/scripted-server.ts', repo],
      cwd: ROOT,
      env: { ...process.env, COPPERHEAD_MODEL: 'gpt-5', NO_COLOR: '1' } as Record<string, string>,
    });
    const client = new Client({ name: 'stdio-progress', version: '1' });
    await client.connect(transport);
    cleanups.push(async () => void (await client.close().catch(() => {})));

    const seen: { progress: number; message?: string }[] = [];
    const res = await client.callTool(
      { name: 'copperhead_do', arguments: { request: 'rename R1 to R10' } },
      undefined,
      // the SDK's default request timeout is 60 s; the run gets the test's own budget
      { onprogress: (p) => void seen.push(p), timeout: 170_000 },
    );
    // The scripted run declines, so the result is a refusal; what matters here
    // is that the notifications sent during the run reached this side.
    const envelope = JSON.parse((res as { content: { text: string }[] }).content[0]!.text);
    expect(envelope.data.status).toBe('refused');
    expect(seen.length, 'no progress notification reached the host').toBeGreaterThan(0);
    expect(seen[0]!.message).toMatch(/^turn 1\//);
    expect(seen.map((p) => p.progress)).toEqual(seen.map((_, i) => i + 1));
  }, 180_000);
});
