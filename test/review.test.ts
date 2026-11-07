import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatOpts, Msg, Provider, Turn } from '../src/agent/types.js';
import { AnthropicProvider } from '../src/agent/providers/anthropic.js';
import { OpenAIProvider } from '../src/agent/providers/openai.js';
import { parseToolCalls } from '../src/agent/providers/tool-protocol.js';
import { CancelledError, normalizeProposal, type PassRecord, runPass } from '../src/review/pass.js';
import { digest, domainTask } from '../src/review/prompts.js';
import { replayReview, runReview } from '../src/review/run.js';
import { resolveTools, type ToolsClient, type ToolsResult } from '../src/review/tools-client.js';
import { reviewProviderFactory } from '../src/util/cli-args.js';

/**
 * `copperhead review` (grounded review): the orchestration, with a scripted model and a fake
 * copperhead-tools. The deterministic tools are tested in copperhead-tools; here the contract is
 * what copperhead sends them, what the model sees, and what the record holds.
 */

function scriptedProvider(turns: Partial<Turn>[]): Provider & { seen: Msg[][]; closed: number } {
  let i = 0;
  const p = {
    name: 'scripted',
    seen: [] as Msg[][],
    closed: 0,
    async chat(messages: Msg[]): Promise<Turn> {
      p.seen.push([...messages]);
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      return { text: t.text ?? null, toolCalls: (t.toolCalls ?? []).map((c, j) => ({ ...c, id: `call-${i}-${j}` })), usage: t.usage ?? { inputTokens: 100, outputTokens: 10 } };
    },
    async close() {
      p.closed++;
    },
  };
  return p;
}

const BUNDLE = {
  format: 'copperhead-review-bundle',
  version: 1,
  label: 'fake board',
  design: { source: 'x.kicad_net', generator: 'test', components: [{ ref: 'U1', value: 'EXA', footprint: 'Lib:Pkg', dnp: false, fields: {} }], nets: [{ name: 'GND', nodes: [{ ref: 'U1', pin: '2', pinName: 'GND' }] }] },
  board: null,
  sweep: { findings: [{ severity: 'major', code: 'drc-triage.x', title: 'a sweep finding', evidenceClass: 'tool' }], envelope: [{ title: 'fabrication rules', examined: false, reason: 'no Gerbers' }] },
  sources: [{ id: 'ds/exa.txt', kind: 'datasheet', pages: 3 }],
  notes: [],
};

/** A copperhead-tools stand-in: records every request and answers each tool from a table. */
function fakeTools(): ToolsClient & { calls: { tool: string; inputs: Record<string, unknown>; cwd: string | undefined }[] } {
  const calls: { tool: string; inputs: Record<string, unknown>; cwd: string | undefined }[] = [];
  return {
    command: ['fake-tools'],
    calls,
    async run(tool, inputs, opts): Promise<ToolsResult> {
      calls.push({ tool, inputs, cwd: opts?.cwd });
      const ok = (data: Record<string, unknown>, summary: Record<string, unknown> = {}): ToolsResult => ({ status: 'ok', tool: { id: tool, version: '0' }, package: { name: 'fake', version: '0' }, data, summary });
      if (tool === 'review') {
        await mkdir(String(inputs['out-dir']), { recursive: true });
        await writeFile(path.join(String(inputs['out-dir']), 'review.json'), '{}');
        return ok({}, { completed: 1 });
      }
      if (tool === 'review-bundle') {
        await writeFile(String(inputs.out), JSON.stringify(BUNDLE));
        return ok({ sha256: 'b'.repeat(64) }, { parts: 1 });
      }
      if (tool === 'review-query') return ok({ ok: true, text: `answer to ${String(inputs.op)} ${String(inputs.args ?? '')}` });
      if (tool === 'review-verify') {
        const doc = JSON.parse(await readFile(String(inputs.proposals), 'utf8')) as { proposals: { id: string; kind: string }[] };
        const verifications = doc.proposals.map((p) => ({ id: p.id, kind: p.kind, outcome: 'VERIFIED', class: 'VERIFIED', verifier: 'claim-check', reason: 'ok', claim: 'U1.2 is on GND' }));
        if (inputs.out) {
          await mkdir(String(inputs.out), { recursive: true });
          await writeFile(path.join(String(inputs.out), 'report.md'), `# report\n${doc.proposals.map((p) => p.id).join(', ')}\n`);
        }
        return ok({ verifications }, { proposals: verifications.length });
      }
      throw new Error(`unexpected tool ${tool}`);
    },
  };
}

describe('review: the model\'s view', () => {
  it('reads the arguments of a call however the model names them', () => {
    const catalog = new Set(['search']);
    const parse = (raw: string) => parseToolCalls(raw, () => 'x', catalog).toolCalls[0]?.args;
    expect(parse('{"tool": "search", "args": {"pattern": "SDO"}}')).toEqual({ pattern: 'SDO' });
    expect(parse('{"tool": "search", "arguments": {"pattern": "SDO"}}')).toEqual({ pattern: 'SDO' });
    expect(parse('{"tool": "search", "pattern": "SDO", "source": "lis3dh"}')).toEqual({ pattern: 'SDO', source: 'lis3dh' });
    expect(parse('{"tool": "search"}')).toEqual({});
  });

  it('says why a call written as an <invoke> block did not run', () => {
    const catalog = new Set(['board', 'search']);
    const turn = parseToolCalls('<invoke name="board">\n</invoke>', () => 'x', catalog);
    expect(turn.toolCalls).toEqual([]);
    expect(turn.nudge).toMatch(/"board" was written as an <invoke> block[\s\S]*\{"tool": "board", "args"/);
    expect(parseToolCalls('<invoke name="shell">\n</invoke>', () => 'x', catalog).nudge).toBeUndefined();
    // A reply that also holds the call as JSON runs it, and needs no nudge.
    const mixed = parseToolCalls('<invoke name="search">\n</invoke>\n```json\n{"tool": "search", "args": {"pattern": "SDO"}}\n```', () => 'x', catalog);
    expect(mixed.toolCalls.map((c) => c.args)).toEqual([{ pattern: 'SDO' }]);
    expect(mixed.nudge).toBeUndefined();
  });

  it('shows the coverage gaps and every net in the bundle digest, and names the domain in the task', () => {
    const d = digest(BUNDLE);
    expect(d).toContain('GND: U1.2(GND)');
    expect(d).toContain('fabrication rules: no Gerbers');
    expect(d).toContain('[major] drc-triage.x');
    expect(domainTask('L', 30)).toMatch(/Your domain is L: physical\.[\s\S]*30 turns/);
  });

  it('prefixes proposal ids and their references with the domain', () => {
    expect(normalizeProposal('P', { id: 'F1', kind: 'finding', premises: ['C1', 'P.C2'] })).toMatchObject({ id: 'P.F1', domain: 'P', premises: ['P.C1', 'P.C2'] });
    expect(normalizeProposal('S', { id: 'K1', kind: 'calculation', inputs: { v: { value: '3.3 V', from: 'C1' }, r: { value: '10k', from: 'design:R1' }, x: { value: '1 V', from: 'assumption: y' } } }).inputs).toEqual({
      v: { value: '3.3 V', from: 'S.C1' },
      r: { value: '10k', from: 'design:R1' },
      x: { value: '1 V', from: 'assumption: y' },
    });
  });
});

describe('review: one pass', () => {
  it('queries through review-query, pre-checks proposals through review-verify, and ends on submit', async () => {
    const tools = fakeTools();
    const bundlePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'review-test-')), 'bundle.json');
    await writeFile(bundlePath, JSON.stringify(BUNDLE));
    const provider = scriptedProvider([
      { toolCalls: [{ name: 'net', args: { net: 'GND' } }] },
      { toolCalls: [{ name: 'propose', args: { proposals: [{ id: 'P1', kind: 'fact', predicate: { 'pin-on-net': { pin: 'U1.2', net: 'GND' } } }] } }] },
      { toolCalls: [{ name: 'submit', args: { summary: 'done' } }] },
    ]);
    const rec = await runPass({ domain: 'P', model: 'scripted', provider, tools, bundlePath, system: 'sys', task: 'task', maxTurns: 10, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined });
    expect(rec).toMatchObject({ outcome: 'submitted', turns: 3, summary: 'done', proposals: [{ id: 'P.P1', domain: 'P' }] });
    expect(tools.calls.map((c) => c.tool)).toEqual(['review-query', 'review-verify']);
    expect(tools.calls[0]!.inputs).toMatchObject({ op: 'net', args: '{"net":"GND"}' });
    expect(rec.calls[1]!.result).toMatch(/^P\.P1: VERIFIED as VERIFIED \(claim-check\): ok/);
    expect(provider.closed).toBeGreaterThan(0);
  });

  it('retries a turn that times out once, and ends the pass on a second in a row', async () => {
    const tools = fakeTools();
    let calls = 0;
    const slowOnce: Provider = {
      name: 'slow',
      async chat(): Promise<Turn> {
        calls++;
        if (calls === 1) await new Promise((r) => setTimeout(r, 200));
        return { text: null, toolCalls: [{ id: `c${calls}`, name: 'submit', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const ok = await runPass({ domain: 'P', model: 's', provider: slowOnce, tools, bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 50, log: () => undefined });
    expect(ok).toMatchObject({ outcome: 'submitted', turns: 2 });
    expect(ok.calls[0]!.tool).toBe('(timeout)');
    const never: Provider = { name: 'never', chat: () => new Promise(() => undefined) };
    const failed = await runPass({ domain: 'P', model: 's', provider: never, tools, bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 20, log: () => undefined });
    expect(failed).toMatchObject({ outcome: 'failed', turns: 2, error: expect.stringMatching(/turn exceeded/) });
  });

  it('redacts API keys from the samples and proposals it writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    const out = path.join(root, 'record');
    const key = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
    const quote = 'Non-solder-mask-defined (NSMD) pads are recommended.';
    const leaky = () => scriptedProvider([
      { text: `my key is ${key}`, toolCalls: [{ name: 'search', args: { pattern: key } }] },
      { toolCalls: [{ name: 'propose', args: { proposals: [{ id: 'Q1', kind: 'question', text: `is ${key} valid?` }, { id: 'C1', kind: 'citation', source: 'ds/exa.txt', page: 1, quote }] } }] },
      { toolCalls: [{ name: 'submit', args: { summary: `found ${key} in the firmware` } }] },
    ]);
    const lines: string[] = [];
    await runReview({ design, out, sources: [], model: 's', domains: ['P'], maxTurns: 5, maxMinutes: 5, parallel: 1, makeProvider: async () => leaky(), log: (l) => lines.push(l), client: fakeTools() });
    for (const f of [path.join(out, 'model', 'samples', 'P.json'), path.join(out, 'model', 'proposals.json'), path.join(out, 'model', 'passes.json')]) {
      const text = await readFile(f, 'utf8');
      expect(text, f).not.toContain(key);
    }
    expect(JSON.parse(await readFile(path.join(out, 'model', 'passes.json'), 'utf8'))[0].summary).toBe('found [REDACTED] in the firmware');
    expect(lines.join('\n')).not.toContain(key);
    // Redaction must not garble a quotation the verifier compares verbatim.
    expect(JSON.parse(await readFile(path.join(out, 'model', 'proposals.json'), 'utf8')).proposals[1].quote).toBe(quote);
  }, 30_000);

  it('stops a pass that never calls a tool, and warns before the turns run out', async () => {
    const tools = fakeTools();
    const stalled = await runPass({ domain: 'M', model: 's', provider: scriptedProvider([{ text: 'thinking' }]), tools, bundlePath: 'b', system: 's', task: 't', maxTurns: 10, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined });
    expect(stalled).toMatchObject({ outcome: 'stalled', turns: 3 });
    const p = scriptedProvider([{ toolCalls: [{ name: 'nets', args: {} }] }]);
    const out = await runPass({ domain: 'M', model: 's', provider: p, tools, bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined });
    expect(out).toMatchObject({ outcome: 'turns-exhausted', turns: 5 });
    expect(p.seen.at(-1)!.some((m) => m.role === 'user' && /turns left/.test(m.content))).toBe(true);
  });

  it('saves the sample after every turn, a turn with no tool call and a timed-out one too', async () => {
    const saved: number[] = [];
    const onTurn = async (r: PassRecord) => void saved.push(r.turns);
    const idleFirst = scriptedProvider([{ text: 'thinking' }, { toolCalls: [{ name: 'submit', args: {} }] }]);
    await runPass({ domain: 'P', model: 's', provider: idleFirst, tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined, onTurn });
    expect(saved).toEqual([1, 2]);
    saved.length = 0;
    let n = 0;
    const slowFirst: Provider = {
      name: 'slow',
      async chat(): Promise<Turn> {
        if (++n === 1) await new Promise((r) => setTimeout(r, 200));
        return { text: null, toolCalls: [{ id: `c${n}`, name: 'submit', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    await runPass({ domain: 'P', model: 's', provider: slowFirst, tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 50, log: () => undefined, onTurn });
    expect(saved).toEqual([1, 2]);
  });

  it('does not time out a turn that keeps streaming, and retries a rate-limited one', async () => {
    const streaming: Provider = {
      name: 'streaming',
      async chat(_m: Msg[], _t, opts?: ChatOpts): Promise<Turn> {
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 30));
          opts?.onStream?.(i);
        }
        return { text: null, toolCalls: [{ id: 'c', name: 'submit', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    // 450 ms of streaming against a 150 ms inactivity timeout.
    const long = await runPass({ domain: 'P', model: 's', provider: streaming, tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 3, maxSeconds: 60, turnTimeoutMs: 150, turnMaxMs: 10_000, log: () => undefined });
    expect(long).toMatchObject({ outcome: 'submitted', turns: 1 });
    let calls = 0;
    const limited: Provider = {
      name: 'limited',
      async chat(): Promise<Turn> {
        if (++calls === 1) throw Object.assign(new Error('429 rate limited'), { status: 429 });
        return { text: null, toolCalls: [{ id: 'c', name: 'submit', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const lines: string[] = [];
    const rec = await runPass({ domain: 'P', model: 's', provider: limited, tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 3, maxSeconds: 60, turnTimeoutMs: 10_000, rateLimitBaseMs: 1, log: (l) => lines.push(l) });
    expect(rec).toMatchObject({ outcome: 'submitted', turns: 1 });
    expect(lines).toContain('[P] turn 1: rate limited; retry 1 of 3');
  });

  it('stops at once when cancelled, tearing the in-flight turn down', async () => {
    const cancel = new AbortController();
    let closed = 0;
    const hanging: Provider = {
      name: 'hanging',
      chat: () => {
        setTimeout(() => cancel.abort(), 20);
        return new Promise(() => undefined);
      },
      async close() {
        closed++;
      },
    };
    const t0 = Date.now();
    const rec = await runPass({ domain: 'P', model: 's', provider: hanging, tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 60_000, log: () => undefined, signal: cancel.signal });
    expect(rec).toMatchObject({ outcome: 'failed', error: 'cancelled', turns: 1 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(closed).toBeGreaterThan(0);
  });

  it('ends a pass whose time runs out during a turn, without waiting for the turn', async () => {
    let closed = 0;
    const endless: Provider = {
      name: 'endless',
      chat: (_m: Msg[], _t, opts?: ChatOpts) =>
        new Promise<Turn>(() => {
          const t = setInterval(() => opts?.onStream?.(1), 20);
          setTimeout(() => clearInterval(t), 20_000);
        }),
      async close() {
        closed++;
      },
    };
    const t0 = Date.now();
    const rec = await runPass({ domain: 'P', model: 's', provider: endless, tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 0.3, turnTimeoutMs: 10_000, turnMaxMs: 20_000, log: () => undefined });
    expect(rec).toMatchObject({ outcome: 'time-exhausted', error: null, turns: 1 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(closed).toBeGreaterThan(0);
  });

  it('saves the turn that ends a pass with its outcome, and ends a pass whose sample cannot be saved', async () => {
    const saved: [number, string][] = [];
    await runPass({ domain: 'P', model: 's', provider: scriptedProvider([{ text: 'thinking' }]), tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 10, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined, onTurn: async (r) => void saved.push([r.turns, r.outcome]) });
    expect(saved).toEqual([[1, 'running'], [2, 'running'], [3, 'stalled']]);
    saved.length = 0;
    await runPass({ domain: 'P', model: 's', provider: scriptedProvider([{ toolCalls: [{ name: 'nets', args: {} }] }]), tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 2, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined, onTurn: async (r) => void saved.push([r.turns, r.outcome]) });
    expect(saved).toEqual([[1, 'running'], [2, 'running'], [2, 'turns-exhausted']]);
    const full = await runPass({
      domain: 'P', model: 's', provider: scriptedProvider([{ toolCalls: [{ name: 'nets', args: {} }] }]), tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 10, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined,
      onTurn: async () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });
    expect(full).toMatchObject({ outcome: 'failed', turns: 1, error: 'could not save the sample: ENOSPC: no space left on device' });
  });

  it('holds none of a propose batch that holds an invalid proposal', async () => {
    const tools = fakeTools();
    const rec = await runPass({
      domain: 'P', model: 's', tools, bundlePath: 'b', system: 's', task: 't', maxTurns: 5, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined,
      provider: scriptedProvider([
        { toolCalls: [{ name: 'propose', args: { proposals: [{ id: 'P1', kind: 'fact', predicate: {} }, { kind: 'fact' }] } }] },
        { toolCalls: [{ name: 'submit', args: {} }] },
      ]),
    });
    expect(rec.calls[0]!.result).toMatch(/none of this batch was held/);
    expect(rec.proposals).toEqual([]);
    expect(tools.calls).toEqual([]);
  });

  it('records a cancellation that lands during a query as one, not as the submit after it', async () => {
    const cancel = new AbortController();
    const tools: ToolsClient = {
      command: ['fake-tools'],
      async run() {
        cancel.abort();
        throw new Error('copperhead-tools review-query: cancelled');
      },
    };
    const rec = await runPass({
      domain: 'P', model: 's', tools, bundlePath: 'b', system: 's', task: 't', maxTurns: 1, maxSeconds: 60, turnTimeoutMs: 10_000, log: () => undefined, signal: cancel.signal,
      provider: scriptedProvider([{ toolCalls: [{ name: 'nets', args: {} }, { name: 'submit', args: {} }] }]),
    });
    expect(rec).toMatchObject({ outcome: 'failed', error: 'cancelled' });
    // The call the stop cut short is in the call log and the transcript; the submit after it never ran.
    expect(rec.calls.map((c) => [c.tool, c.result.slice(0, 8)])).toEqual([['nets', 'Stopped:']]);
    expect(rec.transcript.at(-1)).toMatchObject({ role: 'tool', content: expect.stringMatching(/^Stopped:/) });
  });

  it('aborts the provider request when the pass stops', async () => {
    let aborted = false;
    const listening: Provider = {
      name: 'http-like',
      chat: (_m: Msg[], _t, opts?: ChatOpts) =>
        new Promise<Turn>((_, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('request aborted'));
          });
        }),
    };
    const rec = await runPass({ domain: 'P', model: 's', provider: listening, tools: fakeTools(), bundlePath: 'b', system: 's', task: 't', maxTurns: 3, maxSeconds: 0.2, turnTimeoutMs: 10_000, log: () => undefined });
    expect(rec.outcome).toBe('time-exhausted');
    expect(aborted).toBe(true);
  });
});

describe('review: providers that make an HTTP request', () => {
  /** A server that never answers, and reports when a request arrives and when its client gives up. */
  async function silentServer(): Promise<{ url: string; received: Promise<void>; closed: Promise<void>; stop: () => Promise<void> }> {
    let onRequest!: () => void;
    let onClose!: () => void;
    const received = new Promise<void>((r) => (onRequest = r));
    const closed = new Promise<void>((r) => (onClose = r));
    const server = http.createServer((req) => {
      onRequest();
      req.on('close', onClose);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, received, closed, stop: () => new Promise<void>((r) => server.close(() => r())) };
  }

  it('cancels the request when the turn signal aborts', async () => {
    for (const make of [
      (url: string) => new OpenAIProvider('gpt-5', { baseURL: `${url}/v1`, apiKeyEnv: 'REVIEW_TEST_KEY' }, { REVIEW_TEST_KEY: 'sk-test' }),
      // The Anthropic SDK reads its endpoint from ANTHROPIC_BASE_URL, set below for each server.
      () => new AnthropicProvider('claude-sonnet-5', 'sk-ant-test'),
    ]) {
      const server = await silentServer();
      const previous = process.env.ANTHROPIC_BASE_URL;
      process.env.ANTHROPIC_BASE_URL = server.url;
      try {
        const turn = new AbortController();
        const pending = make(server.url).chat([{ role: 'user', content: 'hi' }], [], { signal: turn.signal });
        pending.catch(() => undefined);
        // Abort only once the request is on the wire: the request itself must be cancelled.
        await server.received;
        turn.abort();
        await expect(pending).rejects.toThrow();
        await server.closed;
      } finally {
        if (previous === undefined) delete process.env.ANTHROPIC_BASE_URL;
        else process.env.ANTHROPIC_BASE_URL = previous;
        await server.stop();
      }
    }
  }, 30_000);
});

describe('review: the run and its record', () => {
  it('runs the sweep, the bundle, a pass per domain and the verification, never writing the design', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    await writeFile(path.join(design, 'board.kicad_sch'), '(kicad_sch)');
    const tools = fakeTools();
    const script = (d: string) => scriptedProvider([
      { toolCalls: [{ name: 'propose', args: { proposals: [{ id: 'P1', kind: 'fact', predicate: {} }] } }] },
      { toolCalls: [{ name: 'submit', args: { summary: d } }] },
    ]);
    let n = 0;
    const out = path.join(root, 'record');
    const res = await runReview({ design, out, sources: [], model: 'scripted', domains: ['P', 'L'], maxTurns: 5, maxMinutes: 5, parallel: 2, makeProvider: async () => script(String(n++)), log: () => undefined, client: tools });
    expect(res.passes.map((p) => [p.domain, p.outcome, p.proposals])).toEqual([['P', 'submitted', 1], ['L', 'submitted', 1]]);
    expect(await readdir(design)).toEqual(['board.kicad_sch']);
    expect(await readFile(path.join(out, 'report.md'), 'utf8')).toBe('# report\nP.P1, L.P1\n');
    const lock = JSON.parse(await readFile(path.join(out, 'review.lock.json'), 'utf8'));
    expect(lock).toMatchObject({ format: 'copperhead-review-lock', domains: ['P', 'L'], model: { id: 'scripted' } });
    expect(Object.keys(lock.templates.sha256)).toEqual(['rules', 'tools', 'task-P', 'task-L']);
    expect(await readdir(path.join(out, 'model', 'samples'))).toEqual(['L.json', 'P.json']);
    const replay = await replayReview(out, { log: () => undefined, client: tools });
    expect(replay.identical).toBe(true);
    expect(tools.calls.filter((c) => c.tool === 'review-verify').at(-1)!.inputs.out).toBe(path.join(out, 'replay'));
    await writeFile(path.join(out, 'model', 'proposals.json'), '{"proposals": []}');
    await expect(replayReview(out, { log: () => undefined, client: tools })).rejects.toThrow(/differs from the lockfile/);
  }, 30_000);

  it('resumes a killed run: keeps ended passes, reruns interrupted ones, reuses the bundle', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    const out = path.join(root, 'record');
    const tools = fakeTools();
    const submitter = () => scriptedProvider([{ toolCalls: [{ name: 'propose', args: { proposals: [{ id: 'P1', kind: 'fact', predicate: {} }] } }] }, { toolCalls: [{ name: 'submit', args: {} }] }]);
    const base = { design, out, sources: [], model: 's', maxTurns: 5, maxMinutes: 5, parallel: 1, log: () => undefined, client: tools };
    await runReview({ ...base, domains: ['P'], makeProvider: async () => submitter() });
    const sample = path.join(out, 'model', 'samples', 'L.json');
    await writeFile(sample, JSON.stringify({ domain: 'L', outcome: 'running', turns: 2, proposals: [] }));
    let made = 0;
    const res = await runReview({ ...base, domains: ['P', 'L'], resume: true, makeProvider: async () => (made++, submitter()) });
    expect(made).toBe(1);
    expect(res.passes.map((p) => [p.domain, p.outcome])).toEqual([['P', 'submitted'], ['L', 'submitted']]);
    expect(tools.calls.filter((c) => c.tool === 'review-bundle')).toHaveLength(1);
    expect((await readdir(path.join(out, 'model', 'samples'))).some((f) => f.startsWith('L.json.interrupted-'))).toBe(true);
  }, 30_000);

  it('prints the progress lines an editor extension parses', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    const lines: string[] = [];
    const submitter = () => scriptedProvider([{ toolCalls: [{ name: 'propose', args: { proposals: [{ id: 'P1', kind: 'fact', predicate: {} }] } }] }, { toolCalls: [{ name: 'submit', args: {} }] }]);
    const failing = async () => {
      throw new Error('not logged in');
    };
    const base = { design, sources: [], model: 's', maxTurns: 5, maxMinutes: 5, parallel: 1, client: fakeTools() };
    await runReview({ ...base, out: path.join(root, 'a'), domains: ['P'], makeProvider: async () => submitter(), log: (l) => lines.push(l) });
    expect(lines[0]).toBe('sweep: copperhead-tools review (every applicable deterministic check)');
    expect(lines[1]).toBe('sweep: {"completed":1}');
    expect(lines[2]).toBe('bundle: {"parts":1}');
    expect(lines[3]).toBe('[P] pass starts (power)');
    expect(lines.at(-1)).toMatch(/^\[P\] pass ends: submitted after 2 turns, 1 proposals, \d+ s$/);
    lines.length = 0;
    // A pass whose provider cannot start still ends with a line, and leaves a sample.
    const res = await runReview({ ...base, out: path.join(root, 'b'), sweep: path.join(root, 'a', 'sweep'), domains: ['L'], makeProvider: failing, log: (l) => lines.push(l) });
    expect(lines[0]).toBe(`sweep: using the record at ${path.join(root, 'a', 'sweep')}`);
    expect(lines.slice(-2)).toEqual(['[L] pass starts (physical)', '[L] pass ends: failed after 0 turns, 0 proposals, 0 s (not logged in)']);
    expect(res.passes).toEqual([{ domain: 'L', outcome: 'failed', turns: 0, proposals: 0, seconds: 0, error: 'not logged in' }]);
    expect(JSON.parse(await readFile(path.join(root, 'b', 'model', 'samples', 'L.json'), 'utf8'))).toMatchObject({ outcome: 'failed' });
  }, 30_000);

  it('records paths inside the working directory relative to it, and still replays', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    await mkdir(path.join(root, 'board'));
    await mkdir(path.join(root, 'fab', 'gerbers'), { recursive: true });
    await writeFile(path.join(root, 'fab', 'jlc.yaml'), '');
    await writeFile(path.join(elsewhere, 'bom.csv'), '');
    const tools = fakeTools();
    await tools.run('review', { 'out-dir': path.join(root, 'sweep-record') });
    await runReview({
      cwd: root,
      design: 'board',
      out: 'reviews/r1',
      sweep: 'sweep-record',
      fab: ['fab/gerbers', path.join(elsewhere, 'bom.csv')],
      fabProfile: 'fab/jlc.yaml',
      sources: [],
      model: 's',
      domains: ['P'],
      maxTurns: 3,
      maxMinutes: 1,
      parallel: 1,
      makeProvider: async () => scriptedProvider([{ toolCalls: [{ name: 'submit', args: {} }] }]),
      log: () => undefined,
      client: tools,
    });
    const record = path.join(root, 'reviews', 'r1');
    const lock = JSON.parse(await readFile(path.join(record, 'review.lock.json'), 'utf8'));
    expect(lock).toMatchObject({ design: 'board', sweep: 'sweep-record', fab: ['fab/gerbers', path.join(elsewhere, 'bom.csv')], fabProfile: 'fab/jlc.yaml' });
    expect(JSON.stringify(lock)).not.toContain(root);
    expect(tools.calls.find((c) => c.tool === 'review-bundle')!.inputs).toMatchObject({ drop: path.join(root, 'board'), sweep: path.join(root, 'sweep-record') });
    // Every copperhead-tools call runs in the review's working directory, which a version 2
    // bundle's relative paths resolve against; so does a replay, given the record's path from there.
    expect(new Set(tools.calls.slice(1).map((c) => c.cwd))).toEqual(new Set([root]));
    tools.calls.length = 0;
    expect((await replayReview('reviews/r1', { cwd: root, log: () => undefined, client: tools })).identical).toBe(true);
    expect(tools.calls.map((c) => [c.tool, c.cwd])).toEqual([['review-verify', root]]);
    // A replay writes replay/ beneath the record, so a record inside what it reviewed is refused.
    await mkdir(path.join(root, 'board', 'r1-copy'), { recursive: true });
    for (const f of ['review.lock.json', 'inputs.json', 'bundle.json', 'report.md']) await writeFile(path.join(root, 'board', 'r1-copy', f), await readFile(path.join(record, f)));
    await mkdir(path.join(root, 'board', 'r1-copy', 'model'));
    await writeFile(path.join(root, 'board', 'r1-copy', 'model', 'proposals.json'), await readFile(path.join(record, 'model', 'proposals.json')));
    await expect(replayReview('board/r1-copy', { cwd: root, log: () => undefined, client: tools })).rejects.toThrow(/inside board, which the review read/);
    expect(await readdir(path.join(root, 'board', 'r1-copy'))).not.toContain('replay');
    // The bundle is pinned by the lockfile too.
    await writeFile(path.join(record, 'bundle.json'), '{}');
    await expect(replayReview(record, { log: () => undefined, client: tools })).rejects.toThrow(/bundle\.json differs from the lockfile/);
  }, 30_000);

  it('refuses budgets that are not positive numbers before writing anything', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const base = { design: path.join(root, 'd'), out: path.join(root, 'rec'), sources: [], model: 's', domains: ['P'], maxTurns: 5, maxMinutes: 5, parallel: 1, makeProvider: async () => scriptedProvider([]), log: () => undefined, client: fakeTools() };
    await expect(runReview({ ...base, maxTurns: Number('nope') })).rejects.toThrow(/--max-turns must be a positive whole number/);
    await expect(runReview({ ...base, maxTurns: 0 })).rejects.toThrow(/--max-turns/);
    await expect(runReview({ ...base, parallel: 1.5 })).rejects.toThrow(/--parallel/);
    await expect(runReview({ ...base, maxMinutes: -1 })).rejects.toThrow(/--max-minutes/);
    expect(await readdir(root)).toEqual([]);
  });

  it('cancels a run: stops its passes, keeps their samples, and a resume reruns them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    const out = path.join(root, 'record');
    const tools = fakeTools();
    const cancel = new AbortController();
    const hanging = (): Provider => ({
      name: 'hanging',
      async chat(messages: Msg[]): Promise<Turn> {
        if (messages.length < 4) return { text: null, toolCalls: [{ id: 'q', name: 'nets', args: {} }], usage: { inputTokens: 1, outputTokens: 1 } };
        setTimeout(() => cancel.abort(), 20);
        return new Promise(() => undefined);
      },
    });
    const base = { design, out, sources: [], model: 's', domains: ['P', 'L'], maxTurns: 5, maxMinutes: 5, parallel: 1, log: () => undefined, client: tools };
    await expect(runReview({ ...base, makeProvider: async () => hanging(), signal: cancel.signal })).rejects.toThrow(CancelledError);
    expect(JSON.parse(await readFile(path.join(out, 'model', 'samples', 'P.json'), 'utf8'))).toMatchObject({ outcome: 'failed', error: 'cancelled', turns: 2 });
    expect(await readdir(path.join(out, 'model', 'samples'))).toEqual(['P.json']);
    const submitter = () => scriptedProvider([{ toolCalls: [{ name: 'submit', args: {} }] }]);
    const res = await runReview({ ...base, resume: true, makeProvider: async () => submitter() });
    expect(res.passes.map((p) => [p.domain, p.outcome])).toEqual([['P', 'submitted'], ['L', 'submitted']]);
  }, 30_000);

  it('reruns a pass whose sample a killed run left unreadable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    const out = path.join(root, 'record');
    const base = { design, out, sources: [], model: 's', domains: ['P'], maxTurns: 5, maxMinutes: 5, parallel: 1, log: () => undefined, client: fakeTools() };
    const submitter = () => scriptedProvider([{ toolCalls: [{ name: 'submit', args: {} }] }]);
    await runReview({ ...base, makeProvider: async () => submitter() });
    await writeFile(path.join(out, 'model', 'samples', 'P.json'), '{"domain": "P", "outc');
    let made = 0;
    const res = await runReview({ ...base, resume: true, makeProvider: async () => (made++, submitter()) });
    expect(made).toBe(1);
    expect(res.passes[0]).toMatchObject({ domain: 'P', outcome: 'submitted' });
  }, 30_000);

  it('reruns a kept pass that ran with another model or budget, and refuses an empty domain list', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    const out = path.join(root, 'record');
    const submitter = () => scriptedProvider([{ toolCalls: [{ name: 'submit', args: {} }] }]);
    const base = { design, out, sources: [], domains: ['P'], maxMinutes: 5, parallel: 1, client: fakeTools() };
    await runReview({ ...base, model: 's', maxTurns: 5, makeProvider: async () => submitter(), log: () => undefined });
    const lines: string[] = [];
    let made = 0;
    const again = { ...base, resume: true, makeProvider: async () => (made++, submitter()), log: (l: string) => lines.push(l) };
    await runReview({ ...again, model: 's', maxTurns: 5 });
    expect(made).toBe(0);
    await runReview({ ...again, model: 's', maxTurns: 6 });
    expect(made).toBe(1);
    await runReview({ ...again, model: 'other', maxTurns: 6 });
    expect(made).toBe(2);
    // A bundle changed since the pass read it reruns the pass too.
    await writeFile(path.join(out, 'bundle.json'), JSON.stringify({ ...BUNDLE, label: 'changed' }));
    await runReview({ ...again, model: 'other', maxTurns: 6 });
    expect(made).toBe(3);
    expect(lines.filter((l) => l.includes('rerunning'))).toEqual(Array(3).fill('[P] resume: rerunning the pass, which ran with another model, prompt or budget'));
    await expect(runReview({ ...base, out: path.join(root, 'none'), domains: [], model: 's', maxTurns: 5, makeProvider: async () => submitter(), log: () => undefined })).rejects.toThrow(/--domains names no domain/);
  }, 30_000);

  it('resumes only a record that names the same inputs', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    await mkdir(path.join(root, 'docs'));
    const out = path.join(root, 'record');
    const submitter = () => scriptedProvider([{ toolCalls: [{ name: 'submit', args: {} }] }]);
    const base = { cwd: root, design: 'design', out: 'record', sources: [], model: 's', domains: ['P'], maxTurns: 5, maxMinutes: 5, parallel: 1, client: fakeTools(), makeProvider: async () => submitter(), log: () => undefined };
    await runReview(base);
    expect(JSON.parse(await readFile(path.join(out, 'inputs.json'), 'utf8'))).toEqual({ design: 'design', sources: [], fab: [], fabProfile: null, sweep: null, label: null });
    await runReview({ ...base, resume: true });
    await expect(runReview({ ...base, resume: true, sources: ['docs'] })).rejects.toThrow(/--resume must name the record's inputs/);
    await mkdir(path.join(root, 'other-board'));
    await expect(runReview({ ...base, resume: true, design: 'other-board' })).rejects.toThrow(/--resume must name the record's inputs/);
    // A run killed before its bundle was written is bound to its inputs as well.
    await unlink(path.join(out, 'bundle.json'));
    await expect(runReview({ ...base, resume: true, sources: ['docs'] })).rejects.toThrow(/--resume must name the record's inputs/);
    await unlink(path.join(out, 'inputs.json'));
    await expect(runReview({ ...base, resume: true })).rejects.toThrow(/holds no inputs\.json/);
    // Nor does it write through a link a record should not hold.
    await runReview({ ...base, out: 'linked' });
    const linked = path.join(root, 'linked');
    await rm(path.join(linked, 'model', 'samples'), { recursive: true });
    await symlink(design, path.join(linked, 'model', 'samples'));
    await expect(runReview({ ...base, out: 'linked', resume: true })).rejects.toThrow(/holds a symbolic link at model\/samples/);
    await expect(replayReview(linked, { log: () => undefined, client: fakeTools() })).rejects.toThrow(/holds a symbolic link/);
    expect(await readdir(design)).toEqual([]);
    // A file sharing an input's inode is refused too: writing it would rewrite the input.
    await runReview({ ...base, out: 'hard' });
    await writeFile(path.join(design, 'board.kicad_sch'), '(kicad_sch)');
    await rm(path.join(root, 'hard', 'report.md'));
    await link(path.join(design, 'board.kicad_sch'), path.join(root, 'hard', 'report.md'));
    await expect(runReview({ ...base, out: 'hard', resume: true })).rejects.toThrow(/another hard link at report\.md/);
    await expect(replayReview(path.join(root, 'hard'), { log: () => undefined, client: fakeTools() })).rejects.toThrow(/another hard link/);
    expect(await readFile(path.join(design, 'board.kicad_sch'), 'utf8')).toBe('(kicad_sch)');
    await unlink(path.join(design, 'board.kicad_sch'));
    // --resume does not make an unrelated directory a record.
    await mkdir(path.join(root, 'notes'));
    await writeFile(path.join(root, 'notes', 'todo.txt'), 'x');
    await expect(runReview({ ...base, out: 'notes', resume: true })).rejects.toThrow(/holds no inputs\.json/);
    expect(await readdir(path.join(root, 'notes'))).toEqual(['todo.txt']);
  }, 30_000);

  it('hands review passes a compat model\'s endpoint and key variable', async () => {
    const seen: unknown[] = [];
    const factory = reviewProviderFactory({ baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'MY_KEY' } as never, async (model, sessionResume, compat) => {
      seen.push([model, sessionResume, compat]);
      return scriptedProvider([]);
    }, {});
    await factory('compat:local-model');
    expect(seen).toEqual([['compat:local-model', true, { baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'MY_KEY' }]]);
  });

  it('reports a cancellation that lands during the last copperhead-tools call as one', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design);
    const out = path.join(root, 'record');
    const inner = fakeTools();
    const cancel = new AbortController();
    const client: ToolsClient = {
      command: inner.command,
      async run(tool, inputs, opts) {
        if (tool === 'review-query' && inputs.op === 'calculators') {
          cancel.abort();
          throw new Error(`copperhead-tools ${tool}: cancelled`);
        }
        return inner.run(tool, inputs, opts);
      },
    };
    const submitter = () => scriptedProvider([{ toolCalls: [{ name: 'submit', args: {} }] }]);
    await expect(runReview({ design, out, sources: [], model: 's', domains: ['P'], maxTurns: 5, maxMinutes: 5, parallel: 1, client, makeProvider: async () => submitter(), log: () => undefined, signal: cancel.signal })).rejects.toThrow(CancelledError);
    expect(await readdir(out)).not.toContain('review.lock.json');
  }, 30_000);

  it('refuses a record directory inside the design, or one that is not empty', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const base = { sources: [], model: 's', domains: ['P'], maxTurns: 1, maxMinutes: 1, parallel: 1, makeProvider: async () => scriptedProvider([]), log: () => undefined, client: fakeTools() };
    await expect(runReview({ ...base, design: root, out: path.join(root, 'rec') })).rejects.toThrow(/outside the design/);
    const full = path.join(root, 'full');
    await mkdir(full);
    await writeFile(path.join(full, 'x'), '');
    await expect(runReview({ ...base, design: path.join(root, 'd'), out: full })).rejects.toThrow(/not empty/);
  });

  it('refuses a record directory that reaches into the design or an input through a link', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(path.join(design, 'empty'), { recursive: true });
    await mkdir(path.join(root, 'docs'));
    await symlink(path.join(design, 'empty'), path.join(root, 'link'));
    const base = { sources: [path.join(root, 'docs')], model: 's', domains: ['P'], maxTurns: 1, maxMinutes: 1, parallel: 1, makeProvider: async () => scriptedProvider([]), log: () => undefined, client: fakeTools() };
    await expect(runReview({ ...base, design, out: path.join(root, 'link') })).rejects.toThrow(/outside the design/);
    await expect(runReview({ ...base, design, out: path.join(root, 'link', 'new') })).rejects.toThrow(/outside the design/);
    await symlink(design, path.join(root, 'design-link'));
    await expect(runReview({ ...base, design: path.join(root, 'design-link'), out: path.join(design, 'rec') })).rejects.toThrow(/outside the design/);
    await expect(runReview({ ...base, design, out: path.join(root, 'docs', 'rec') })).rejects.toThrow(/outside every input/);
    await mkdir(path.join(root, 'sweep-record'));
    await writeFile(path.join(root, 'sweep-record', 'review.json'), '{}');
    await expect(runReview({ ...base, design, sweep: path.join(root, 'sweep-record'), out: path.join(root, 'sweep-record', 'rec') })).rejects.toThrow(/outside every input/);
    expect(await readdir(path.join(root, 'sweep-record'))).toEqual(['review.json']);
    expect(await readdir(path.join(design, 'empty'))).toEqual([]);
  });
  it('validates --tools, --sweep, PATH, and --out before creating the record directory (#404)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const design = path.join(root, 'design');
    await mkdir(design, { recursive: true });
    const base = { design, sources: [], model: 's', domains: ['P'], maxTurns: 1, maxMinutes: 1, parallel: 1, makeProvider: async () => scriptedProvider([]), log: () => undefined };

    const outTools = path.join(root, 'out-bad-tools');
    await expect(runReview({ ...base, out: outTools, tools: path.join(root, 'nope.js') })).rejects.toThrow(/copperhead-tools not found/);
    await expect(readdir(outTools)).rejects.toMatchObject({ code: 'ENOENT' });

    const outSweep = path.join(root, 'out-bad-sweep');
    await expect(runReview({ ...base, out: outSweep, sweep: path.join(root, 'nosweep'), client: fakeTools() })).rejects.toThrow(/holds no review\.json/);
    await expect(readdir(outSweep)).rejects.toMatchObject({ code: 'ENOENT' });

    const outFile = path.join(root, 'existing-file');
    await writeFile(outFile, 'x');
    await expect(runReview({ ...base, out: outFile, client: fakeTools() })).rejects.toThrow(/not a directory/);
    await expect(runReview({ ...base, out: path.join(outFile, 'nested', 'rec'), client: fakeTools() })).rejects.toThrow(/not a directory/);

    const emptyPathDir = path.join(root, 'empty-bin');
    await mkdir(emptyPathDir);
    await expect(resolveTools(undefined, { PATH: emptyPathDir })).rejects.toThrow(/not found on PATH/);

    const savedPath = process.env.PATH;
    const savedTools = process.env.COPPERHEAD_TOOLS;
    process.env.PATH = emptyPathDir;
    delete process.env.COPPERHEAD_TOOLS;
    const outNoPath = path.join(root, 'out-no-path');
    try {
      await expect(runReview({ ...base, out: outNoPath })).rejects.toThrow(/not found on PATH/);
      await expect(readdir(outNoPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      process.env.PATH = savedPath;
      if (savedTools !== undefined) process.env.COPPERHEAD_TOOLS = savedTools;
    }
  });

  it('allows --resume when a resumable record has bundle.json even if its external --sweep directory was deleted, while still refusing missing --sweep without bundle.json (#404)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-resume-sweep-'));
    const design = path.join(root, 'design');
    const sweep = path.join(root, 'sweep-record');
    const out = path.join(root, 'rec');
    await mkdir(design, { recursive: true });
    await mkdir(sweep, { recursive: true });
    await writeFile(path.join(sweep, 'review.json'), '{}');

    const submitter = () =>
      scriptedProvider([
        {
          toolCalls: [
            {
              name: 'submit',
              args: {
                proposals: [],
                summary: 'clean',
              },
            },
          ],
        },
      ]);
    const base = {
      design,
      out,
      sweep,
      sources: [],
      model: 's',
      domains: ['P'],
      maxTurns: 3,
      maxMinutes: 1,
      parallel: 1,
      client: fakeTools(),
      makeProvider: async () => submitter(),
      log: () => undefined,
    };

    await runReview(base);
    await rm(sweep, { recursive: true });
    const resumed = await runReview({ ...base, resume: true });
    expect(resumed.passes[0]?.outcome).toBe('submitted');

    // A partial skeleton without a parsable bundle.json still requires --sweep to exist.
    const outNoBundle = path.join(root, 'rec-no-bundle');
    await mkdir(path.join(outNoBundle, 'model', 'samples'), { recursive: true });
    await writeFile(path.join(outNoBundle, 'inputs.json'), `${JSON.stringify({ design, sources: [], fab: [], fabProfile: null, sweep, label: null }, null, 1)}\n`);
    await writeFile(path.join(outNoBundle, 'bundle.json'), '{broken');
    await expect(
      runReview({ ...base, out: outNoBundle, resume: true }),
    ).rejects.toThrow(/holds no review\.json/);
  });

  it.skipIf(process.platform === 'win32')('resolves copperhead-tools on PATH keeping bare command name in lockfile (#404)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-path-ok-'));
    const bin = path.join(root, 'copperhead-tools');
    await writeFile(bin, '#!/bin/sh\nexit 0\n');
    await chmod(bin, 0o755);
    const client = await resolveTools(undefined, { PATH: root });
    expect(client.command).toEqual(['copperhead-tools']);
  });

  it('rejects Windows .cmd or extensionless shims on win32 PATH lookup (#404)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-win32-shim-'));
    await writeFile(path.join(root, 'copperhead-tools'), '#!/bin/sh\n');
    await writeFile(path.join(root, 'copperhead-tools.cmd'), '@echo off\r\n');
    await expect(resolveTools(undefined, { PATH: root }, 'win32')).rejects.toThrow(/not found on PATH/);
    if (process.platform === 'win32') {
      await expect(resolveTools(undefined, { PATH: root })).rejects.toThrow(/not found on PATH/);
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('rethrows EACCES when --out cannot be read (#404)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'review-eacces-'));
    const design = path.join(root, 'design');
    const locked = path.join(root, 'locked-out');
    await mkdir(design, { recursive: true });
    await mkdir(locked, { recursive: true });
    await chmod(locked, 0o000);
    try {
      await expect(
        runReview({
          design,
          out: locked,
          resume: true,
          sources: [],
          model: 's',
          domains: ['P'],
          maxTurns: 1,
          maxMinutes: 1,
          parallel: 1,
          client: fakeTools(),
          makeProvider: async () => scriptedProvider([]),
          log: () => undefined,
        }),
      ).rejects.toThrow(/EACCES|permission denied/i);
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

describe('review: the copperhead-tools client', () => {
  it('stops the tool process when cancelled', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const pidFile = path.join(dir, 'pid');
    const script = path.join(dir, 'slow-tools.js');
    await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);\n`);
    const client = await resolveTools(script, {});
    const cancel = new AbortController();
    const running = client.run('review', {}, { signal: cancel.signal });
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
    }
    expect(pid).toBeGreaterThan(0);
    cancel.abort();
    await expect(running).rejects.toThrow(/cancelled/);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 30_000);
});
