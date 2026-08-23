import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  runDoctor,
  checkCredential,
  checkPromptPrivacy,
  formatDoctor,
  type DoctorDeps,
} from '../src/commands/doctor.js';
import { tempFixtureRepo } from './helpers.js';

// Deps that make every host-dependent probe deterministic.
function deps(over: Partial<DoctorDeps> = {}): Partial<DoctorDeps> {
  return {
    nodeVersion: 'v20.0.0',
    kicadVersion: async () => 'kicad-cli 9.0.0',
    gitVersion: async () => 'git version 2.43.0',
    openspecVersion: async () => 'openspec 1.8.0',
    env: {},
    ...over,
  };
}

describe('copperhead doctor', () => {
  it('all green when node/kicad/git are present and the provider credential is set', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({ repoRoot: repo, model: 'gpt-5', deps: deps({ env: { OPENAI_API_KEY: 'sk-x' } }) });
      expect(r.ok).toBe(true);
      const provider = r.checks.find((c) => c.name === 'provider')!;
      expect(provider.status).toBe('ok');
      expect(provider.detail).toContain('OPENAI_API_KEY set');
    } finally {
      await cleanup();
    }
  });

  it('fails (ok=false) and gives a hint when the resolved provider key is missing', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({ repoRoot: repo, model: 'gpt-5', deps: deps({ env: {} }) });
      expect(r.ok).toBe(false);
      const provider = r.checks.find((c) => c.name === 'provider')!;
      expect(provider.status).toBe('fail');
      expect(provider.hint).toContain('OPENAI_API_KEY');
    } finally {
      await cleanup();
    }
  });

  it('reports a missing kicad-cli as a failure with an install hint (does not throw)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({
        repoRoot: repo,
        model: 'claude-code',
        deps: deps({
          kicadVersion: async () => {
            throw new Error('ENOENT');
          },
        }),
      });
      expect(r.ok).toBe(false);
      const kicad = r.checks.find((c) => c.name === 'kicad-cli')!;
      expect(kicad.status).toBe('fail');
      expect(kicad.hint).toMatch(/install KiCad/i);
    } finally {
      await cleanup();
    }
  });

  it('a corrupted .copperhead/config.json fails the project check, not the whole command', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'config.json'), '{ this is not valid json,,,', 'utf8');
      const r = await runDoctor({ repoRoot: repo, model: 'gpt-5', deps: deps({ env: { OPENAI_API_KEY: 'sk-x' } }) });
      expect(r.ok).toBe(false);
      const project = r.checks.find((c) => c.name === 'project')!;
      expect(project.status).toBe('fail');
      expect(project.detail).toContain('malformed');
      // Provider resolution still works from --model/env, unaffected by the broken config.
      const provider = r.checks.find((c) => c.name === 'provider')!;
      expect(provider.status).toBe('ok');
    } finally {
      await cleanup();
    }
  });

  it('an unreadable .copperhead/config.json (e.g. EISDIR) gets read-failure advice, not "malformed"', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // A directory at the config path reproduces an fs read error (EISDIR)
      // distinct from JSON.parse's SyntaxError.
      await mkdir(path.join(repo, '.copperhead', 'config.json'), { recursive: true });
      const r = await runDoctor({ repoRoot: repo, model: 'gpt-5', deps: deps({ env: { OPENAI_API_KEY: 'sk-x' } }) });
      const project = r.checks.find((c) => c.name === 'project')!;
      expect(project.status).toBe('fail');
      expect(project.detail).toContain('could not be read');
      expect(project.detail).not.toContain('malformed');
      expect(project.hint).toMatch(/permission|directory/i);
    } finally {
      await cleanup();
    }
  });

  it('a saved-login provider needs no key: info, not a failure', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({ repoRoot: repo, model: 'claude-code', deps: deps({ env: {} }) });
      const provider = r.checks.find((c) => c.name === 'provider')!;
      expect(provider.status).toBe('info');
      expect(r.ok).toBe(true); // info never blocks
    } finally {
      await cleanup();
    }
  });

  it('an old node major fails the node check', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({ repoRoot: repo, model: 'claude-code', deps: deps({ nodeVersion: 'v18.19.0' }) });
      expect(r.checks.find((c) => c.name === 'node')!.status).toBe('fail');
      expect(r.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('checkCredential maps each model prefix to the right credential', () => {
    expect(checkCredential('claude-3-7', { ANTHROPIC_API_KEY: 'x' }).status).toBe('ok');
    expect(checkCredential('claude-3-7', {}).status).toBe('fail');
    expect(checkCredential('o3', { OPENAI_API_KEY: 'x' }).status).toBe('ok');
    expect(checkCredential('o3', {}).status).toBe('fail');
    expect(checkCredential('codex:gpt-5', {}).status).toBe('info');
    expect(checkCredential('claude-code:opus', {}).status).toBe('info');
    expect(checkCredential('cursor', {}).status).toBe('info');
    expect(checkCredential('cursor:gpt-5', {}).status).toBe('info');
  });

  it('an empty saved-login override fails like makeProvider would, not info', () => {
    for (const model of ['codex:', 'claude-code:', 'cursor:']) {
      const c = checkCredential(model, {});
      expect(c.status).toBe('fail');
      expect(c.hint).toContain(`${model}<model-id>`);
    }
    expect(checkCredential('codex', {}).status).toBe('info');
    expect(checkCredential('claude-code', {}).status).toBe('info');
  });

  it('a secret-shaped model value is redacted from the report', () => {
    const c = checkCredential('sk-proj-abc123XYZ', { OPENAI_API_KEY: 'x' });
    expect(JSON.stringify(c)).not.toContain('sk-proj-abc123XYZ');
    expect(c.detail).toContain('[REDACTED]');
    expect(c.status).toBe('ok'); // classification still runs on the raw value
  });

  it('formatDoctor renders a ready/not-ready footer', () => {
    const ready = formatDoctor({ ok: true, checks: [] });
    expect(ready[ready.length - 1]).toBe('ready');
    const notReady = formatDoctor({ ok: false, checks: [] });
    expect(notReady[notReady.length - 1]).toMatch(/not ready/);
  });

  it('formatDoctor wraps long detail and hint text within the given width', () => {
    const lines = formatDoctor(
      {
        ok: false,
        checks: [
          {
            name: 'provider',
            status: 'fail',
            detail: 'no model configured',
            hint: 'pass --model codex, set COPPERHEAD_MODEL, set model in .copperhead/config.json, or provide OPENAI_API_KEY/ANTHROPIC_API_KEY',
          },
        ],
      },
      60,
    );
    expect(lines.length).toBeGreaterThan(3); // head + wrapped hint + footer
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
    // Continuation lines align under the start of the hint text.
    const hintLine = lines.find((l) => l.includes('hint: '))!;
    const contCol = hintLine.indexOf('hint: ') + 'hint: '.length;
    const continuation = lines[lines.indexOf(hintLine) + 1];
    expect(continuation.startsWith(' '.repeat(contCol))).toBe(true);
    expect(continuation.charAt(contCol)).not.toBe(' ');
  });

  it('formatDoctor color mode only adds ANSI codes: stripping them yields the plain output', () => {
    const report = {
      ok: false,
      checks: [
        { name: 'node', status: 'ok' as const, detail: 'v20.0.0 (>= 20)' },
        { name: 'provider', status: 'fail' as const, detail: 'no model configured', hint: 'set COPPERHEAD_MODEL' },
      ],
    };
    const plain = formatDoctor(report, 80);
    expect(plain.join('\n')).not.toContain('\u001b[');
    const colored = formatDoctor(report, 80, true);
    expect(colored.join('\n')).toContain('\u001b[31m'); // red FAIL tag
    // eslint-disable-next-line no-control-regex
    const stripped = colored.map((l) => l.replace(/\u001b\[[0-9]+m/g, ''));
    expect(stripped).toEqual(plain);
  });

  it('formatDoctor renders a warn tag distinctly from ok/fail/info', () => {
    const report = {
      ok: true,
      checks: [{ name: 'privacy', status: 'warn' as const, detail: 'may train on submitted prompts' }],
    };
    const plain = formatDoctor(report, 80);
    expect(plain.join('\n')).toContain('[warn]');
    const colored = formatDoctor(report, 80, true);
    // eslint-disable-next-line no-control-regex
    expect(colored.join('\n')).toContain('[33m'); // yellow warn tag
  });

  it('reports a missing git as a failure with an install hint (does not throw)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({
        repoRoot: repo,
        model: 'gpt-5',
        deps: deps({
          env: { OPENAI_API_KEY: 'sk-x' },
          gitVersion: async () => {
            throw new Error('ENOENT');
          },
        }),
      });
      expect(r.ok).toBe(false);
      const git = r.checks.find((c) => c.name === 'git')!;
      expect(git.status).toBe('fail');
      expect(git.hint).toMatch(/install git/i);
    } finally {
      await cleanup();
    }
  });

  it('reports a missing openspec as a failure with an install hint (does not throw)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({
        repoRoot: repo,
        model: 'claude-code',
        deps: deps({
          openspecVersion: async () => {
            throw Object.assign(new Error('spawn openspec ENOENT'), { code: 'ENOENT' });
          },
        }),
      });
      const os = r.checks.find((c) => c.name === 'openspec')!;
      expect(os.status).toBe('fail');
      expect(os.hint).toContain('@fission-ai/openspec');
      expect(r.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('a raw multi-line shell error never reaches the report unflattened (regression)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      // A shell-shaped error (exit 127, not ENOENT) is not the "not found"
      // case the probe itself can produce (execa yields ENOENT for that on
      // every platform), but any unexpected error must still land as a
      // single line so it cannot break formatDoctor's column layout.
      const r = await runDoctor({
        repoRoot: repo,
        model: 'claude-code',
        deps: deps({
          openspecVersion: async () => {
            throw Object.assign(
              new Error('Command failed: openspec --version\n/bin/sh: 1: openspec: not found\n'),
              { code: 127 },
            );
          },
        }),
      });
      const os = r.checks.find((c) => c.name === 'openspec')!;
      expect(os.status).toBe('fail');
      expect(os.detail).toContain('openspec: not found');
      expect(os.detail).not.toContain('\n');
    } finally {
      await cleanup();
    }
  });

  it('with a config present, the project check reports the wired schematic and board', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ schematic: 'blinky.kicad_sch', board: null }),
      );
      const r = await runDoctor({ repoRoot: repo, model: 'gpt-5', deps: deps({ env: { OPENAI_API_KEY: 'sk-x' } }) });
      const project = r.checks.find((c) => c.name === 'project')!;
      expect(project.status).toBe('info');
      expect(project.detail).toContain('blinky.kicad_sch');
      expect(project.detail).toContain('not wired');
    } finally {
      await cleanup();
    }
  });

  it('the no-model hint does not repeat the "no model configured" detail', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({ repoRoot: repo, deps: deps({ env: {} }) });
      const provider = r.checks.find((c) => c.name === 'provider')!;
      expect(provider.status).toBe('fail');
      expect(provider.detail).toBe('no model configured');
      expect(provider.hint).not.toContain('no model configured');
      expect(provider.hint).toContain('COPPERHEAD_MODEL');
    } finally {
      await cleanup();
    }
  });

  it('reports "ambiguous", not "no model configured", when two credentials are both set', async () => {
    // The two failure modes need different reactions: "no model configured"
    // means add a key; "ambiguous" means an explicit choice is needed despite
    // already having credentials. Conflating them into one message would send
    // a user with two working keys off to fix something that is not broken.
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({
        repoRoot: repo,
        deps: deps({ env: { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' } }),
      });
      const provider = r.checks.find((c) => c.name === 'provider')!;
      expect(provider.status).toBe('fail');
      expect(provider.detail).toContain('ambiguous');
      expect(provider.detail).not.toBe('no model configured');
      expect(provider.hint).toMatch(/OPENAI_API_KEY.*ANTHROPIC_API_KEY|2 credentials/);
      expect(r.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe('doctor — OpenAI-compatible endpoints (issue #110)', () => {
  const groq = { baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' };

  it('checks the configured key variable, not OPENAI_API_KEY', () => {
    const ok = checkCredential('compat:qwen-3-coder', { GROQ_API_KEY: 'gsk-x' }, groq);
    expect(ok.status).toBe('ok');
    expect(ok.detail).toContain('GROQ_API_KEY set');
    expect(ok.detail).toContain('api.groq.com');

    // An OPENAI_API_KEY lying around must not satisfy a Groq endpoint.
    const bad = checkCredential('compat:qwen-3-coder', { OPENAI_API_KEY: 'sk-x' }, groq);
    expect(bad.status).toBe('fail');
    expect(bad.hint).toContain('GROQ_API_KEY');
  });

  it('strips a credential embedded in the endpoint URL from the displayed report', () => {
    const leaky = { baseURL: 'https://api.example.com/v1?key=sk-shouldnotleak123', apiKeyEnv: 'X_API_KEY' };
    const c = checkCredential('compat:model', { X_API_KEY: 'x' }, leaky);
    expect(c.status).toBe('ok');
    expect(c.detail).not.toContain('sk-shouldnotleak123');
    // The rest of the URL still shows, so the endpoint is still diagnosable.
    expect(c.detail).toContain('api.example.com');
  });

  it('strips a Gemini-shaped key (AIza..., not sk-...) from the endpoint URL — regression', () => {
    // redactSecrets covers known key shapes (sk-, Bearer, npm_, gh*_, AIza,
    // gsk_...), but a key embedded in a URL query isn't reliably one of them,
    // and Gemini's own compat endpoint puts the key in the URL as ?key=....
    // Dropping the whole query/userinfo (not pattern-matching the key) is
    // what makes this hold for every provider's key shape, not just the ones
    // tested here.
    const gemini = {
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai?key=AIzaSyABCDEF1234567890shouldnotleak',
      apiKeyEnv: 'GEMINI_API_KEY',
    };
    const c = checkCredential('compat:gemini-2.5-flash', { GEMINI_API_KEY: 'x' }, gemini);
    expect(c.status).toBe('ok');
    expect(c.detail).not.toContain('AIzaSyABCDEF1234567890shouldnotleak');
    expect(c.detail).not.toContain('key=');
    expect(c.detail).toContain('generativelanguage.googleapis.com');
  });

  it('a local endpoint passes with no key (D4)', () => {
    const c = checkCredential('compat:llama3', {}, { baseURL: 'http://localhost:11434/v1', apiKeyEnv: 'UNUSED' });
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('no key required');
  });

  it('falls back to DEFAULT_API_KEY_ENV when no compat settings are passed at all', () => {
    // Every production caller resolves settings via resolveCompatSettings()
    // first, so this default arm (`compat ?? { apiKeyEnv: DEFAULT_API_KEY_ENV }`)
    // only exercises when a caller omits the third argument entirely.
    const c = checkCredential('compat:model', { OPENAI_API_KEY: 'x' });
    expect(c.status).toBe('fail'); // no baseURL configured either way
    expect(c.detail).toContain('no endpoint configured');
  });

  it('compat with no endpoint configured fails with an actionable hint', () => {
    const c = checkCredential('compat:x', {}, { apiKeyEnv: 'OPENAI_API_KEY' });
    expect(c.status).toBe('fail');
    expect(c.hint).toContain('COPPERHEAD_BASE_URL');
  });

  it('rejects an empty compat override, matching makeProvider', () => {
    expect(checkCredential('compat:', {}, groq).status).toBe('fail');
  });

  it('rejects bare `compat` even with a valid endpoint and key present (regression: was a false [ok])', () => {
    // Bug: `model === 'compat:'` only caught the empty-override case, so bare
    // `compat` (no colon at all) fell through to the credential check and
    // reported [ok] whenever the key happened to be set — a false green for a
    // run that would fail on its first turn with no model id. Must fail here
    // the same way makeProvider now throws, or doctor "ready" is a lie.
    const c = checkCredential('compat', { GROQ_API_KEY: 'gsk-x' }, groq);
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('missing model id');
  });

  it('warns (never fails) on a host documented as training on prompts (D5)', () => {
    const warn = checkPromptPrivacy('compat:gemini-2.0-flash', {
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKeyEnv: 'GEMINI_API_KEY',
    });
    expect(warn?.status).toBe('warn');
    expect(warn?.detail).toMatch(/train/i);
    // warn must not block: `ok` is computed from `fail` alone.
    expect(warn?.status).not.toBe('fail');
  });

  it('says plainly when a host has no policy on record, rather than implying safety', () => {
    const c = checkPromptPrivacy('compat:qwen', groq);
    expect(c?.status).toBe('info');
    expect(c?.detail).toMatch(/cannot verify/i);
  });

  it('OpenRouter: warns only for a :free-suffixed model, not a paid one (regression)', () => {
    // Bug: matching only on host meant a fully paid OpenRouter model got the
    // exact same warning as a free one, contradicting the warning's own text
    // ("OpenRouter `:free` models may route to providers that train on prompts").
    const openrouter = { baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' };

    const free = checkPromptPrivacy('compat:some-vendor/some-model:free', openrouter);
    expect(free?.status).toBe('warn');
    expect(free?.detail).toMatch(/train/i);

    const paid = checkPromptPrivacy('compat:anthropic/claude-3.5-sonnet', openrouter);
    expect(paid?.status).toBe('info');
    expect(paid?.detail).toMatch(/cannot verify/i);
    // The info message legitimately says "training-on-prompts policy" too;
    // what must NOT appear is the actual risk description text.
    expect(paid?.detail).not.toMatch(/may route to providers/i);
  });

  it('the privacy check does not apply to non-compat models', () => {
    expect(checkPromptPrivacy('gpt-5', groq)).toBeNull();
    expect(checkPromptPrivacy('claude', groq)).toBeNull();
  });

  it('bypasses entirely for true loopback: no third party to have a policy about', () => {
    for (const baseURL of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1']) {
      expect(checkPromptPrivacy('compat:phi3', { baseURL, apiKeyEnv: 'UNUSED' }), baseURL).toBeNull();
    }
  });

  it('does NOT bypass a .local (mDNS/LAN) host — that traffic leaves the machine (regression)', () => {
    // Bug: reusing isLocalEndpoint (which treats *.local as local, correct for
    // "does this need a credential") also skipped the privacy check for LAN
    // hosts. A request to nas.local goes out over the network to a different
    // physical device, so "nothing leaves the machine" does not hold here.
    const c = checkPromptPrivacy('compat:phi3', { baseURL: 'http://nas.local:11434/v1', apiKeyEnv: 'UNUSED' });
    expect(c).not.toBeNull();
    expect(c?.status).toBe('info');
    expect(c?.detail).toContain('nas.local');
  });

  it('an unparseable baseURL reports no privacy line rather than a wrong one', () => {
    // Exercises both the loopback check's catch (an unparseable URL is not
    // loopback) and checkPromptPrivacy's own catch on the same string: the
    // safe outcome is silence, not a false bypass or a thrown error.
    expect(checkPromptPrivacy('compat:phi3', { baseURL: 'not a url', apiKeyEnv: 'UNUSED' })).toBeNull();
  });

  it('matches a training-risk host on a subdomain, not just the exact host', () => {
    const c = checkPromptPrivacy('compat:gemini-2.0-flash', {
      baseURL: 'https://region-a.generativelanguage.googleapis.com/v1beta/openai',
      apiKeyEnv: 'GEMINI_API_KEY',
    });
    expect(c?.status).toBe('warn');
    expect(c?.detail).toMatch(/train/i);
  });

  it('a training-risk warning still leaves the report ready (exit 0)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({
        repoRoot: repo,
        model: 'compat:gemini-2.0-flash',
        deps: deps({
          env: {
            GEMINI_API_KEY: 'x',
            COPPERHEAD_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
            COPPERHEAD_API_KEY_ENV: 'GEMINI_API_KEY',
          },
        }),
      });
      expect(r.checks.find((c) => c.name === 'privacy')?.status).toBe('warn');
      expect(r.ok).toBe(true); // warn never blocks
    } finally {
      await cleanup();
    }
  });

  it('makes no network request at all: doctor stays fully network-free', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({
        repoRoot: repo,
        model: 'compat:qwen',
        deps: deps({
          env: { GROQ_API_KEY: 'gsk-x', COPPERHEAD_BASE_URL: groq.baseURL, COPPERHEAD_API_KEY_ENV: 'GROQ_API_KEY' },
        }),
      });
      expect(r.checks.find((c) => c.name === 'endpoint')).toBeUndefined();
      expect(r.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
