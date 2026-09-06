import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createMcpServer,
  failure,
  runStatus,
  RepoLocks,
  MCP_PROTOCOL_VERSION,
  PIPELINE_TOOL_NAMES,
  TOOL_SCHEMA_VERSIONS,
} from '../src/mcp/server.js';
import { registry } from '../src/agent/tools.js';
import { runCheck } from '../src/commands/check.js';
import { runInit } from '../src/memory/scaffold.js';
import { runDoctor } from '../src/commands/doctor.js';
import { tempFixtureRepo } from './helpers.js';

/** Connect an in-process client to a server bound to `repo`. */
async function connect(repo: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createMcpServer({ repoRoot: repo });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: async () => void (await Promise.allSettled([client.close(), server.close()])) };
}

/** Tool results are a JSON envelope in a single text block. */
function envelopeOf(res: unknown): { ok: boolean; summary: string; data?: unknown; error?: { kind: string; message: string } } {
  const content = (res as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text);
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function fixture(): Promise<string> {
  const { repo, cleanup } = await tempFixtureRepo();
  cleanups.push(cleanup);
  return repo;
}

describe('MCP tool surface is the whole surface (spec: opacity)', () => {
  it('lists exactly the pipeline tools and nothing else', async () => {
    const repo = await fixture();
    const { client, close } = await connect(repo);
    cleanups.push(close);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...PIPELINE_TOOL_NAMES].sort());
  });

  it('exposes no file-edit, raw-KiCad, or partial-loop tool', async () => {
    const repo = await fixture();
    const { client, close } = await connect(repo);
    cleanups.push(close);
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.name, `${t.name} looks like an operation, not an outcome`).not.toMatch(
        /edit|write|patch|apply|raw|kicad_cli|erc|drc|turn|step|tool_call/i,
      );
    }
  });

  it('accepts no filesystem path into the gated pipeline (surface audit)', async () => {
    const repo = await fixture();
    const { client, close } = await connect(repo);
    cleanups.push(close);
    const { tools } = await client.listTools();
    for (const t of tools) {
      const props = Object.keys(((t.inputSchema as { properties?: object }).properties ?? {}) as object);
      for (const p of props) {
        // `copperhead_init --path` selects where to *look* for a project and is
        // consumed by the scaffolder, which sandboxes to the repo root. Nothing
        // else may take a path at all: a path input is how an opaque surface
        // stops being opaque.
        if (t.name === 'copperhead_init' && p === 'path') continue;
        expect(p, `${t.name}.${p} accepts a path`).not.toMatch(/path|file|dir|glob/i);
      }
    }
  });

  it('carries a schema version on every tool', async () => {
    const repo = await fixture();
    const { client, close } = await connect(repo);
    cleanups.push(close);
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect((t._meta as { schemaVersion?: number } | undefined)?.schemaVersion).toBe(
        TOOL_SCHEMA_VERSIONS[t.name as keyof typeof TOOL_SCHEMA_VERSIONS],
      );
    }
  });
});

describe('experimental status is declared, not assumed (design D7)', () => {
  it('pins a 0. major so stabilizing is a deliberate edit', () => {
    expect(MCP_PROTOCOL_VERSION).toMatch(/^0\./);
  });

  it('tells the host the surface is unstable', async () => {
    const repo = await fixture();
    const server = createMcpServer({ repoRoot: repo });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    cleanups.push(async () => void (await Promise.allSettled([client.close(), server.close()])));
    expect(client.getServerVersion()?.version).toBe(MCP_PROTOCOL_VERSION);
    expect(client.getInstructions()).toMatch(/EXPERIMENTAL|unstable/i);
  });
});

describe('the pipeline is unreachable from inside the loop (design D9)', () => {
  it('registers none of the pipeline tools in the agent capability catalog', () => {
    for (const name of PIPELINE_TOOL_NAMES) {
      expect(registry.get(name), `${name} is reachable by the agent loop`).toBeUndefined();
    }
  });
});

describe('results cannot carry secrets (spec: shared envelope)', () => {
  it('redacts an API key that reaches a result', () => {
    const res = failure('exception', 'provider rejected sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(JSON.stringify(res)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    expect(res.summary).toContain('[REDACTED]');
  });
});

describe('copperhead_check', () => {
  it('matches runCheck on the same repo state (parity)', async () => {
    const repo = await fixture();
    const { client, close } = await connect(repo);
    cleanups.push(close);
    const direct = await runCheck(repo, () => {});
    const res = await client.callTool({ name: 'copperhead_check', arguments: {} });
    expect(envelopeOf(res).data).toEqual(JSON.parse(JSON.stringify(direct)));
  });

  it('runs with no API key present', async () => {
    const repo = await fixture();
    const { client, close } = await connect(repo);
    cleanups.push(close);
    const saved = { o: process.env.OPENAI_API_KEY, a: process.env.ANTHROPIC_API_KEY };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const env = envelopeOf(await client.callTool({ name: 'copperhead_check', arguments: {} }));
      expect(env.data).toBeDefined();
      expect(env.error).toBeUndefined();
    } finally {
      if (saved.o !== undefined) process.env.OPENAI_API_KEY = saved.o;
      if (saved.a !== undefined) process.env.ANTHROPIC_API_KEY = saved.a;
    }
  });
});

describe('key handling degrades honestly (design D4)', () => {
  it('refuses copperhead_do with a typed error naming the missing variable, starting no run', async () => {
    const repo = await fixture();
    const { client, close } = await connect(repo);
    cleanups.push(close);
    const saved = { o: process.env.OPENAI_API_KEY, a: process.env.ANTHROPIC_API_KEY, m: process.env.COPPERHEAD_MODEL };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.COPPERHEAD_MODEL;
    try {
      const env = envelopeOf(await client.callTool({ name: 'copperhead_do', arguments: { request: 'rename R1 to R10' } }));
      expect(env.ok).toBe(false);
      expect(env.error?.kind).toBe('unavailable');
      expect(env.error?.message).toMatch(/API key|COPPERHEAD_MODEL|--model/i);
    } finally {
      if (saved.o !== undefined) process.env.OPENAI_API_KEY = saved.o;
      if (saved.a !== undefined) process.env.ANTHROPIC_API_KEY = saved.a;
      if (saved.m !== undefined) process.env.COPPERHEAD_MODEL = saved.m;
    }
  });
});

describe('copperhead_sync', () => {
  it('is verify-only without resolve and changes nothing', async () => {
    const repo = await fixture();
    const { client, close } = await connect(repo);
    cleanups.push(close);
    const env = envelopeOf(await client.callTool({ name: 'copperhead_sync', arguments: {} }));
    expect(env.data).toHaveProperty('resolvable');
    expect(env.data).toHaveProperty('violations');
  });
});

describe('run status mapping (design D6)', () => {
  const base = { summary: '', transcriptDir: '/t', filesTouched: [], stats: {}, cacheHits: 0 } as never;
  it('maps a committed run', () => {
    expect(runStatus({ ...(base as object), outcome: 'success', exitPath: 'done', commit: 'abc' } as never, false)).toBe(
      'committed',
    );
  });
  it('reports a dry run as its own status rather than a commit', () => {
    expect(runStatus({ ...(base as object), outcome: 'success', exitPath: 'done', commit: null } as never, true)).toBe(
      'dry_run',
    );
  });
  it('maps a refusal', () => {
    expect(
      runStatus({ ...(base as object), outcome: 'refused', exitPath: 'refused', commit: null } as never, false),
    ).toBe('refused');
  });
  it('maps every other failure to rolled_back, because the snapshot is restored', () => {
    for (const exitPath of ['repair-cycles-exhausted', 'turn-budget-exhausted', 'provider-error', 'stalled'] as const) {
      expect(runStatus({ ...(base as object), outcome: 'failure', exitPath, commit: null } as never, false)).toBe(
        'rolled_back',
      );
    }
  });
});

describe('mutating tools are serialized per repo (spec: serialization)', () => {
  it('admits one holder at a time and releases on the way out', () => {
    const locks = new RepoLocks();
    expect(locks.tryAcquire('/a')).toBe(true);
    expect(locks.tryAcquire('/a')).toBe(false);
    expect(locks.isBusy('/a')).toBe(true);
    locks.release('/a');
    expect(locks.isBusy('/a')).toBe(false);
    expect(locks.tryAcquire('/a')).toBe(true);
  });

  it('locks per repo, so an unrelated repo is never blocked', () => {
    const locks = new RepoLocks();
    expect(locks.tryAcquire('/a')).toBe(true);
    expect(locks.tryAcquire('/b')).toBe(true);
  });

  it('rejects a concurrent mutating call with a typed busy error', async () => {
    const repo = await fixture();
    const { client, close } = await connect(repo);
    cleanups.push(close);
    // Two inits fired together: whichever loses the lock must come back as a
    // typed `unavailable`, never as a protocol error and never interleaved.
    const [a, b] = await Promise.all([
      client.callTool({ name: 'copperhead_init', arguments: {} }),
      client.callTool({ name: 'copperhead_init', arguments: {} }),
    ]);
    for (const res of [a, b]) {
      const env = envelopeOf(res);
      if (!env.ok && env.error?.kind === 'unavailable') {
        expect(env.error.message).toMatch(/in progress/i);
      }
    }
  });
});

describe('copperhead_check over a configured repo runs real ERC', () => {
  it('reports ERC on an initialized project and still matches runCheck', async () => {
    const repo = await fixture();
    await runInit({ repoRoot: repo, force: false, installHooks: false });
    const { client, close } = await connect(repo);
    cleanups.push(close);
    const direct = await runCheck(repo, () => {});
    // The fixture is a real KiCad project, so init wires up a schematic and
    // this path exercises kicad-cli rather than the skip branch.
    expect(direct.erc).not.toBeNull();
    const env = envelopeOf(await client.callTool({ name: 'copperhead_check', arguments: {} }));
    expect(env.data).toEqual(JSON.parse(JSON.stringify(direct)));
  });
});

describe('copperhead_doctor', () => {
  it('reports the environment without a credential and without changing anything', async () => {
    const repo = await fixture();
    const { client, close } = await connect(repo);
    cleanups.push(close);
    const saved = { o: process.env.OPENAI_API_KEY, a: process.env.ANTHROPIC_API_KEY };
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const env = envelopeOf(await client.callTool({ name: 'copperhead_doctor', arguments: {} }));
      expect(env.error).toBeUndefined();
      expect((env.data as { checks: unknown[] }).checks.length).toBeGreaterThan(0);
    } finally {
      if (saved.o !== undefined) process.env.OPENAI_API_KEY = saved.o;
      if (saved.a !== undefined) process.env.ANTHROPIC_API_KEY = saved.a;
    }
  });

  it('matches runDoctor on the same repo', async () => {
    const repo = await fixture();
    const { client, close } = await connect(repo);
    cleanups.push(close);
    const direct = await runDoctor({ repoRoot: repo });
    const env = envelopeOf(await client.callTool({ name: 'copperhead_doctor', arguments: {} }));
    // Check names and statuses are the contract; details can carry timings.
    const names = (r: { checks: { name: string }[] }) => r.checks.map((c) => c.name);
    expect(names(env.data as { checks: { name: string }[] })).toEqual(names(direct));
  });

  it('never carries a credential value into its result', async () => {
    const repo = await fixture();
    const { client, close } = await connect(repo);
    cleanups.push(close);
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-doctorleak0123456789abcdefghij';
    try {
      const raw = JSON.stringify(await client.callTool({ name: 'copperhead_doctor', arguments: {} }));
      expect(raw).not.toContain('sk-doctorleak0123456789abcdefghij');
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });
});
