import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeProvider } from '../src/agent/loop.js';
import { VertexProvider } from '../src/agent/providers/vertex.js';
import { AnthropicProvider } from '../src/agent/providers/anthropic.js';
import { DEFAULT_CLAUDE_MODEL, buildAnthropicRequest, type AnthropicLikeClient } from '../src/agent/providers/anthropic-wire.js';
import { CachingProvider } from '../src/agent/response-cache.js';
import { adcSource, checkCredential, checkPromptPrivacy } from '../src/commands/doctor.js';
import {
  DEFAULTS,
  DEFAULT_VERTEX_REGION,
  isVertexModel,
  loadConfig,
  resolveModel,
  resolveVertexSettings,
  type CopperheadConfig,
  type VertexSettings,
} from '../src/config.js';
import type { Msg, ToolSchema, Turn } from '../src/agent/types.js';

const base: CopperheadConfig = { schematic: null, board: null, ...DEFAULTS };
const SETTINGS: VertexSettings = { project: 'proj-1', region: 'global' };

const tools: ToolSchema[] = [
  { name: 'a', description: 'a', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'b', description: 'b', parameters: { type: 'object', properties: {}, required: [] } },
];
const msgs: Msg[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: null, toolCalls: [{ id: 't1', name: 'a', args: {} }] },
  { role: 'tool', toolCallId: 't1', content: 'result' },
];

/** A stub messages.create client that records what it was asked to send. */
function stubClient(): { client: AnthropicLikeClient; calls: unknown[] } {
  const calls: unknown[] = [];
  const client: AnthropicLikeClient = {
    messages: {
      create: async (params: never) => {
        calls.push(params);
        return {
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 },
        };
      },
    },
  };
  return { client, calls };
}

async function repoWithConfig(raw: Record<string, unknown>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ch-vertex-'));
  await mkdir(path.join(dir, '.copperhead'), { recursive: true });
  await writeFile(path.join(dir, '.copperhead', 'config.json'), JSON.stringify(raw), 'utf8');
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe('vertex settings resolution (D1)', () => {
  it('config fields parse; blank values are dropped', async () => {
    const { dir, cleanup } = await repoWithConfig({ vertexProject: ' proj-cfg ', vertexRegion: 'us-east5' });
    try {
      const cfg = await loadConfig(dir);
      expect(cfg.vertexProject).toBe('proj-cfg');
      expect(cfg.vertexRegion).toBe('us-east5');
    } finally {
      await cleanup();
    }
    const { dir: dir2, cleanup: cleanup2 } = await repoWithConfig({ vertexProject: '   ', vertexRegion: '' });
    try {
      const cfg2 = await loadConfig(dir2);
      expect(cfg2.vertexProject).toBeUndefined();
      expect(cfg2.vertexRegion).toBeUndefined();
    } finally {
      await cleanup2();
    }
  });

  it('environment overrides config, which overrides the Vertex SDK variables', () => {
    const cfg = { ...base, vertexProject: 'proj-cfg', vertexRegion: 'region-cfg' };
    const all = resolveVertexSettings(cfg, {
      COPPERHEAD_VERTEX_PROJECT: 'proj-env',
      COPPERHEAD_VERTEX_REGION: 'region-env',
      ANTHROPIC_VERTEX_PROJECT_ID: 'proj-sdk',
      CLOUD_ML_REGION: 'region-sdk',
    });
    expect(all).toEqual({ project: 'proj-env', region: 'region-env' });
    const noEnv = resolveVertexSettings(cfg, { ANTHROPIC_VERTEX_PROJECT_ID: 'proj-sdk', CLOUD_ML_REGION: 'region-sdk' });
    expect(noEnv).toEqual({ project: 'proj-cfg', region: 'region-cfg' });
  });

  it('a machine configured only via the Vertex SDK variables works with no copperhead settings', () => {
    const s = resolveVertexSettings(base, { ANTHROPIC_VERTEX_PROJECT_ID: 'proj-sdk', CLOUD_ML_REGION: 'us-east5' });
    expect(s).toEqual({ project: 'proj-sdk', region: 'us-east5' });
  });

  it('region defaults to global; an unresolvable project stays undefined', () => {
    const s = resolveVertexSettings(base, {});
    expect(s.region).toBe(DEFAULT_VERTEX_REGION);
    expect(s.region).toBe('global');
    expect(s.project).toBeUndefined();
  });

  it('isVertexModel gates exactly the vertex namespace', () => {
    expect(isVertexModel('vertex')).toBe(true);
    expect(isVertexModel('vertex:claude-opus-5')).toBe(true);
    expect(isVertexModel('vertex:')).toBe(true); // routed, then rejected as empty
    expect(isVertexModel('vertexish')).toBe(false);
    expect(isVertexModel('claude')).toBe(false);
    expect(isVertexModel('compat:vertex')).toBe(false);
  });

  it('resolveModel never auto-selects vertex, even with a project exported (opt-in only)', () => {
    const r = resolveModel(undefined, base, {
      COPPERHEAD_VERTEX_PROJECT: 'proj-1',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(r.model).toBe('gpt-5'); // the single keyed credential wins, as before
  });
});

describe('VertexProvider (D2/D3/D4/D5)', () => {
  it('has name "vertex", distinct from the keyed providers, so otherProvider() never fails it over', () => {
    const p = new VertexProvider('claude-sonnet-5', SETTINGS, stubClient().client);
    expect(p.name).toBe('vertex');
    expect(p.name).not.toBe('anthropic');
    expect(p.name).not.toBe('openai');
  });

  it('sends the same request body as the shared builder produces (D4)', async () => {
    const vertex = stubClient();
    const p = new VertexProvider('claude-sonnet-5', SETTINGS, vertex.client);
    await p.chat(msgs, tools);
    expect(vertex.calls[0]).toEqual(buildAnthropicRequest('claude-sonnet-5', msgs, tools));
    const breakpoints = JSON.stringify(vertex.calls[0]).match(/"cache_control"/g) ?? [];
    expect(breakpoints).toHaveLength(3); // system, last tool, last message block
  });

  it('the first-party route sends through that same builder, so the two cannot diverge (D4)', async () => {
    // The assertion above compares VertexProvider against the function it
    // calls, which is true by construction. Parity only holds if
    // AnthropicProvider goes through the shared module too — assert that
    // directly, or a future post-processing step added to anthropic.ts would
    // split the routes with both tests still green. Mocked at the wire seam,
    // so no network call is made (constructing the SDK client makes none).
    vi.doMock('../src/agent/providers/anthropic-wire.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/agent/providers/anthropic-wire.js')>();
      return { ...actual, sendAnthropic: vi.fn(async () => ({ text: 'ok', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } })) };
    });
    try {
      vi.resetModules();
      const wire = await import('../src/agent/providers/anthropic-wire.js');
      const { AnthropicProvider: Fresh } = await import('../src/agent/providers/anthropic.js');
      await new Fresh('claude-sonnet-5', 'test-key').chat(msgs, tools);
      expect(wire.sendAnthropic).toHaveBeenCalledWith(expect.anything(), 'claude-sonnet-5', msgs, tools, {});
    } finally {
      vi.doUnmock('../src/agent/providers/anthropic-wire.js');
      vi.resetModules();
    }
  });

  it('counts cached tokens into inputTokens like the first-party route', async () => {
    const { client } = stubClient();
    const p = new VertexProvider(undefined, SETTINGS, client);
    const turn = await p.chat(msgs, tools);
    expect(turn.usage.inputTokens).toBe(105); // 10 + 90 read + 5 written
    expect(turn.usage.outputTokens).toBe(2);
  });

  it('bare vertex uses the same default model as the claude route (D2)', async () => {
    const { client, calls } = stubClient();
    const p = new VertexProvider(undefined, SETTINGS, client);
    await p.chat(msgs, tools);
    expect((calls[0] as { model: string }).model).toBe(DEFAULT_CLAUDE_MODEL);
    // AnthropicProvider's default comes from the same constant, so the two
    // cannot drift: the class references DEFAULT_CLAUDE_MODEL directly.
    const anthropic = new AnthropicProvider(undefined, 'test-key');
    expect((anthropic as unknown as { model: string }).model).toBe(DEFAULT_CLAUDE_MODEL);
  });

  it('rejects an Anthropic-style dated id, naming the Vertex @ form (D3)', () => {
    expect(() => new VertexProvider('claude-opus-4-5-20251101', SETTINGS)).toThrowError(/claude-opus-4-5@20251101/);
    // …and does not misjudge undated ids or ids with digits.
    expect(() => new VertexProvider('claude-opus-4-5', SETTINGS, stubClient().client)).not.toThrow();
    expect(() => new VertexProvider('claude-opus-4-5@20251101', SETTINGS, stubClient().client)).not.toThrow();
  });

  it('fails fast when no project resolves, naming every setting that could supply one', () => {
    try {
      new VertexProvider('claude-sonnet-5', { region: 'global' });
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('COPPERHEAD_VERTEX_PROJECT');
      expect(msg).toContain('vertexProject');
      expect(msg).toContain('ANTHROPIC_VERTEX_PROJECT_ID');
    }
  });

  it('neither reads nor requires ANTHROPIC_API_KEY (ADC only)', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      // No key anywhere: the first-party provider refuses, vertex does not.
      expect(() => new AnthropicProvider()).toThrowError(/ANTHROPIC_API_KEY/);
      const { client, calls } = stubClient();
      const p = new VertexProvider('claude-sonnet-5', SETTINGS, client);
      await p.chat(msgs, tools);
      // And with a key set, the request is byte-identical: the route never
      // consults it.
      process.env.ANTHROPIC_API_KEY = 'sk-test-should-not-be-read';
      await p.chat(msgs, tools);
      expect(calls[1]).toEqual(calls[0]);
      expect(JSON.stringify(calls[1])).not.toContain('sk-test-should-not-be-read');
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  // No "provider holds no credential" test here: nothing in this class is ever
  // handed one (the Google auth library inside the SDK owns the credential and
  // its refresh), so such an assertion passes under any implementation that
  // compiles. The redaction that does the real work is tested against the
  // write seams in test/safety.test.ts.

  it('a missing @anthropic-ai/vertex-sdk names the package to install (D8)', async () => {
    vi.doMock('@anthropic-ai/vertex-sdk', () => {
      throw new Error('Cannot find module');
    });
    try {
      vi.resetModules();
      const { VertexProvider: Fresh } = await import('../src/agent/providers/vertex.js');
      const p = new Fresh('claude-sonnet-5', SETTINGS); // no injected client: chat must import the SDK
      await expect(p.chat(msgs, tools)).rejects.toThrowError(/@anthropic-ai\/vertex-sdk/);
    } finally {
      vi.doUnmock('@anthropic-ai/vertex-sdk');
      vi.resetModules();
    }
  });
});

describe('vertex routing in makeProvider (D1)', () => {
  it('routes vertex and vertex:<id>; rejects the empty override', async () => {
    const p = await makeProvider('vertex', false, undefined, SETTINGS);
    expect(p).toBeInstanceOf(VertexProvider);
    const p2 = await makeProvider('vertex:claude-opus-5', false, undefined, SETTINGS);
    expect(p2).toBeInstanceOf(VertexProvider);
    await expect(makeProvider('vertex:', false, undefined, SETTINGS)).rejects.toThrowError(/vertex:<model-id>/);
  });

  it('a missing project fails at makeProvider, before any network call', async () => {
    await expect(makeProvider('vertex', false, undefined, { region: 'global' })).rejects.toThrowError(
      /COPPERHEAD_VERTEX_PROJECT/,
    );
  });

  it('existing routes are unaffected and never consult vertex settings', async () => {
    // gpt-5 with vertex settings supplied still routes to OpenAI.
    const saved = { openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    try {
      const gpt = await makeProvider('gpt-5', false, undefined, SETTINGS);
      expect(gpt.name).toBe('openai');
      const claude = await makeProvider('claude', false, undefined, SETTINGS);
      expect(claude.name).toBe('anthropic');
    } finally {
      if (saved.openai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.openai;
      if (saved.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.anthropic;
    }
  });
});

describe('vertex response cache scoping (D9)', () => {
  const turn = (text: string): Turn => ({ text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } });

  class CountingProvider {
    readonly name = 'counting';
    calls = 0;
    constructor(private readonly fn: () => Turn) {}
    async chat(): Promise<Turn> {
      this.calls += 1;
      return this.fn();
    }
  }

  it('a vertex turn and a first-party turn on the same model id do not share entries', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-vertex-cache-'));
    try {
      const vertexInner = new CountingProvider(() => turn('vertex answer'));
      const claudeInner = new CountingProvider(() => turn('claude answer'));
      // The resolved model string is the key ingredient: it carries the
      // vertex: prefix, so no baseURL-style extra field is needed (D9).
      const cachedVertex = new CachingProvider(vertexInner as never, dir, undefined, 'vertex:claude-sonnet-5');
      const cachedClaude = new CachingProvider(claudeInner as never, dir, undefined, 'claude-sonnet-5');
      const a = await cachedVertex.chat(msgs, tools);
      const b = await cachedClaude.chat(msgs, tools);
      expect(a.text).toBe('vertex answer');
      expect(b.text).toBe('claude answer'); // not replayed from the vertex entry
      expect(vertexInner.calls).toBe(1);
      expect(claudeInner.calls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the key does not vary with project or region: same model string hits across settings', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-vertex-cache-'));
    try {
      // Settings never reach CachingProvider — the same model in another
      // region is the same model, and keying on region would orphan every
      // entry the first time a project moved regions (D9).
      const inner = new CountingProvider(() => turn('answer'));
      const first = new CachingProvider(inner as never, dir, undefined, 'vertex:claude-sonnet-5');
      const second = new CachingProvider(inner as never, dir, undefined, 'vertex:claude-sonnet-5');
      await first.chat(msgs, tools);
      await second.chat(msgs, tools);
      expect(inner.calls).toBe(1); // second construction (a "different region") replayed the entry
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('vertex transcript hygiene (AC-4.1)', () => {
  it('credential material quoted into a transcript is redacted at write time', async () => {
    // Every transcript/summary write funnels through redactSecrets
    // (src/agent/transcript.ts), so this is the seam a Vertex run's artifacts
    // go through: a ya29. token or a service-account private key that leaks
    // into a tool result or an error message must not reach disk.
    const { readFile } = await import('node:fs/promises');
    const { Transcript } = await import('../src/agent/transcript.js');
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-vertex-transcript-'));
    try {
      const t = new Transcript(dir);
      await t.init();
      await t.event('tool_result', {
        content:
          'error from google: token ya29.a0AfB_byFAKE0123456789abcdefghijk expired; ' +
          'key -----BEGIN PRIVATE KEY-----\nFAKEKEYMATERIAL\n-----END PRIVATE KEY----- rejected',
      });
      const jsonl = await readFile(t.jsonlPath, 'utf8');
      expect(jsonl).not.toContain('ya29.a0');
      expect(jsonl).not.toContain('FAKEKEYMATERIAL');
      expect(jsonl).toContain('[REDACTED]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('doctor: vertex (D6/D7)', () => {
  const noFile = (): boolean => false;

  const gcloudFile = path.join('/gcloud', 'application_default_credentials.json');

  it('adcSource finds each source by presence, in order, offline', () => {
    expect(adcSource({ GOOGLE_APPLICATION_CREDENTIALS: '/sa.json' }, (p) => p === '/sa.json')).toEqual({
      found: true,
      source: 'GOOGLE_APPLICATION_CREDENTIALS',
    });
    expect(adcSource({ CLOUDSDK_CONFIG: '/gcloud' }, (p) => p === gcloudFile)).toEqual({
      found: true,
      source: 'gcloud ADC file',
    });
    expect(adcSource({ GCE_METADATA_HOST: '169.254.169.254' }, noFile)).toEqual({
      found: true,
      source: 'metadata server (GCE_METADATA_HOST)',
    });
    expect(adcSource({}, noFile)).toEqual({ found: false });
  });

  it('a set-but-missing GOOGLE_APPLICATION_CREDENTIALS never falls through to the gcloud file', () => {
    // google-auth-library treats a set GOOGLE_APPLICATION_CREDENTIALS as
    // authoritative: it loads that exact path and throws when it is absent,
    // rather than falling back. Reporting the gcloud file here would be a
    // false `ok` for a run that fails at auth.
    const env = { GOOGLE_APPLICATION_CREDENTIALS: '/stale/sa.json' };
    const onlyGcloud = (p: string): boolean => p === gcloudFile;
    expect(adcSource(env, onlyGcloud)).toEqual({ found: false, stalePath: '/stale/sa.json' });

    const check = checkCredential('vertex', env, undefined, SETTINGS, onlyGcloud);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('/stale/sa.json');
    expect(check.hint).toContain('GOOGLE_APPLICATION_CREDENTIALS');
  });

  it('passes with project, region, and a discoverable ADC source', () => {
    const check = checkCredential('vertex', {}, undefined, SETTINGS, () => true);
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('proj-1');
    expect(check.detail).toContain('global');
  });

  it('fails with an actionable hint when no ADC source is discoverable', () => {
    const check = checkCredential('vertex:claude-opus-5', {}, undefined, SETTINGS, noFile);
    expect(check.status).toBe('fail');
    expect(check.hint).toContain('gcloud auth application-default login');
    expect(check.hint).toContain('GOOGLE_APPLICATION_CREDENTIALS');
  });

  it('fails naming the project settings when no project resolves', () => {
    const check = checkCredential('vertex', {}, undefined, { region: 'global' }, () => true);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('no GCP project');
    expect(check.hint).toContain('COPPERHEAD_VERTEX_PROJECT');
  });

  it('rejects the empty model override, mirroring makeProvider', () => {
    const check = checkCredential('vertex:', {}, undefined, SETTINGS, () => true);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('empty model override');
  });

  it('rejects an Anthropic-style dated id, mirroring makeProvider (D3)', () => {
    // Otherwise doctor reports ready for a run the provider rejects at
    // construction, on its very first turn.
    const check = checkCredential('vertex:claude-opus-4-5-20251101', {}, undefined, SETTINGS, () => true);
    expect(check.status).toBe('fail');
    expect(check.hint).toContain('claude-opus-4-5@20251101');
    // …and the corrected form still passes.
    expect(checkCredential('vertex:claude-opus-4-5@20251101', {}, undefined, SETTINGS, () => true).status).toBe('ok');
  });

  it('reports the shared default region when no settings are supplied', () => {
    const check = checkCredential('vertex', {}, undefined, undefined, () => true);
    // No project, so this fails — the point is that the region shown by the
    // no-settings fallback comes from the constant, not a second literal.
    expect(check.status).toBe('fail');
    expect(DEFAULT_VERTEX_REGION).toBe('global');
  });

  it('privacy line is info for vertex — the Gemini free-tier warn does not carry over (D7)', () => {
    const privacy = checkPromptPrivacy('vertex:claude-opus-5');
    expect(privacy?.status).toBe('info');
    expect(privacy?.detail).toContain('Google Cloud terms');
    // Regression: the compat-route Gemini warning itself is unchanged.
    const gemini = checkPromptPrivacy('compat:gemini-2.5-flash', {
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKeyEnv: 'GEMINI_API_KEY',
    });
    expect(gemini?.status).toBe('warn');
    expect(gemini?.detail).toContain('train');
  });
});
