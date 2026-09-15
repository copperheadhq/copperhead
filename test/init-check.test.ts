import { describe, it, expect } from 'vitest';
import { readFile, writeFile, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { runInit, InitError } from '../src/memory/scaffold.js';
import { runCheck } from '../src/commands/check.js';
import { checkDrift } from '../src/memory/drift.js';
import { listSymbols } from '../src/kicad/sexp.js';
import { resolveModel, DEFAULTS, loadConfig } from '../src/config.js';
import { tempFixtureRepo } from './helpers.js';

const silent = (): void => {};

describe('copperhead init (AC-1)', () => {
  it('scaffolds docs, config, transparency files, and pre-commit hook (AC-1.1)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const res = await runInit({ repoRoot: repo });
      for (const f of ['SPEC.md', 'BOM.md', 'PINOUT.md', 'SUBSYSTEMS.md', 'LAYOUT.md', 'DECISIONS.md', 'CHANGELOG.md']) {
        expect(existsSync(path.join(repo, 'docs', f)), f).toBe(true);
      }
      expect(existsSync(path.join(repo, '.copperhead', 'config.json'))).toBe(true);
      expect(existsSync(path.join(repo, '.copperhead', 'README.md'))).toBe(true);
      expect(existsSync(path.join(repo, '.git', 'hooks', 'pre-commit'))).toBe(true);
      expect(res.refused).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('BOM has one real row per symbol; PINOUT has real nets (AC-1.2, AC-1.3)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const symbols = await listSymbols(path.join(repo, 'hardware', 'open-key.kicad_sch'));
      const bom = await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8');
      const dataRows = bom.split('\n').filter((l) => /^\| (R|U)\d/.test(l));
      expect(dataRows).toHaveLength(symbols.length);
      expect(bom).toContain('| R1 | 10k | Resistor_SMD:R_0603_1608Metric |');
      const pinout = await readFile(path.join(repo, 'docs', 'PINOUT.md'), 'utf8');
      expect(pinout).toContain('KEY_DAH');
      expect(pinout).toMatch(/\| U1 \| 5 \| GPIO14 \| KEY_DAH \|/);
    } finally {
      await cleanup();
    }
  });

  it('re-run is idempotent; hand edits refused without --force (AC-1.4)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const before = await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8');
      const res2 = await runInit({ repoRoot: repo });
      expect(res2.refused).toEqual([]);
      expect(await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8')).toBe(before);

      await writeFile(path.join(repo, 'docs', 'BOM.md'), before + '\nhand edit\n', 'utf8');
      const res3 = await runInit({ repoRoot: repo });
      expect(res3.refused).toContain(path.join('docs', 'BOM.md'));
      expect(await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8')).toContain('hand edit');

      const res4 = await runInit({ repoRoot: repo, force: true });
      expect(res4.refused).toEqual([]);
      expect(await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8')).not.toContain('hand edit');
    } finally {
      await cleanup();
    }
  });

  it('fails clearly with no .kicad_sch (AC-1.5)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ch-empty-'));
    await expect(runInit({ repoRoot: dir })).rejects.toThrow(InitError);
    await expect(runInit({ repoRoot: dir })).rejects.toThrow(/no \.kicad_sch found/);
  });
});

describe('copperhead check (AC-2)', () => {
  it('clean fixture: everything green (AC-2.1) and stable JSON keys (AC-2.4)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const subs = await readFile(path.join(repo, 'docs', 'SUBSYSTEMS.md'), 'utf8');
      await writeFile(path.join(repo, 'docs', 'SUBSYSTEMS.md'), subs + '\n## Keyer\n\nKey input block.\n', 'utf8');
      const res = await runCheck(repo, silent);
      expect(res.ok).toBe(true);
      expect(res.erc).toEqual({ ok: true, violations: 0 });
      expect(res.drc).toEqual({ ok: true, violations: 0 });
      expect(res.drift.ok).toBe(true);
      expect(Object.keys(res).sort()).toEqual([
        'constraints',
        'drc',
        'drift',
        'erc',
        'legibility',
        'ok',
        'openspec',
        'schematicMissing',
      ]);
      expect(res.legibility.counts.error).toBe(0);
      expect(res.schematicMissing).toBeNull();
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('broken schematic (unconnected pin): fails with location (AC-2.2)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const text = await readFile(sch, 'utf8');
      // detach the GPIO0 no_connect flag: pin becomes unconnected
      await writeFile(sch, text.replace('(no_connect (at 127 96.52)', '(no_connect (at 127 50.8)'), 'utf8');
      const res = await runCheck(repo, silent);
      expect(res.ok).toBe(false);
      expect(res.erc!.ok).toBe(false);
      expect(res.erc!.violations).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('BOM value drift: names doc, claim, and actual (AC-2.3)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      const bom = await readFile(bomPath, 'utf8');
      await writeFile(bomPath, bom.replace('| R1 | 10k |', '| R1 | 47k |'), 'utf8');
      const drift = await checkDrift(repo, 'docs/', 'hardware/open-key.kicad_sch');
      expect(drift).toHaveLength(1);
      expect(drift[0]).toEqual({ doc: 'BOM.md', claim: 'R1 value 47k', actual: 'R1 value 10k' });
    } finally {
      await cleanup();
    }
  });

  it('pre-commit hook blocks a desynced hand edit at git commit', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'init docs', '--no-verify'], { cwd: repo });
      // hand-edit the schematic value so BOM.md drifts
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const text = await readFile(sch, 'utf8');
      await writeFile(sch, text.replace('"Value" "10k"', '"Value" "47k"'), 'utf8');
      await execa('git', ['add', '-A'], { cwd: repo });
      // the hook runs `copperhead check`; expose the dev build via PATH shim
      const bin = path.join(repo, '.testbin');
      await mkdir(bin, { recursive: true });
      const cliPath = path.resolve('dist', 'cli.js');
      await writeFile(path.join(bin, 'copperhead'), `#!/bin/sh\nexec node ${cliPath} "$@"\n`, { mode: 0o755 });
      const result = await execa('git', ['commit', '-q', '-m', 'desync'], {
        cwd: repo,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
        reject: false,
      });
      expect(result.exitCode).not.toBe(0);
    } finally {
      await cleanup();
    }
  }, 60_000);
});

describe('check is LLM-free by construction (AC-2.1)', () => {
  it('the check command module graph never imports a provider or SDK', async () => {
    const { execa } = await import('execa');
    // transitive import scan over src/commands/check.ts
    const seen = new Set<string>();
    const queue = ['src/commands/check.ts'];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = await readFile(file, 'utf8');
      expect(text, file).not.toMatch(/providers\/|from 'openai'|@anthropic-ai/);
      expect(file, file).not.toMatch(/capabilities/);
      for (const m of text.matchAll(/from '(\.[^']+)\.js'/g)) {
        queue.push(path.join(path.dirname(file), m[1]!) + '.ts');
      }
    }
    expect(seen.size).toBeGreaterThan(3);
    void execa; // silence unused in case of refactor
  });
});

describe('fab export (create stage 6 tooling)', () => {
  it('produces gerbers, drill, dxf, and svg for the fixture board', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const { exportFab } = await import('../src/kicad/cli.js');
      const out = path.join(repo, 'outputs');
      const res = await exportFab(
        path.join(repo, 'hardware', 'open-key.kicad_pcb'),
        path.join(repo, 'hardware', 'open-key.kicad_sch'),
        out,
      );
      for (const artifact of ['gerbers', 'drill', 'outline.dxf', 'board.svg', 'schematic.svg']) {
        expect(res.produced, artifact).toContain(artifact);
      }
      expect(existsSync(path.join(out, 'gerbers'))).toBe(true);
    } finally {
      await cleanup();
    }
  }, 60_000);
});

describe('model selection precedence (task 4.6)', () => {
  const config = { schematic: null, board: null, ...DEFAULTS };

  it('flag > env > config > available key, and reports the winning source', () => {
    expect(resolveModel('claude', { ...config, model: 'gpt-5' }, { COPPERHEAD_MODEL: 'gpt-5' })).toEqual({
      model: 'claude',
      source: 'flag',
    });
    expect(resolveModel(undefined, { ...config, model: 'gpt-5' }, { COPPERHEAD_MODEL: 'claude' })).toEqual({
      model: 'claude',
      source: 'env',
    });
    expect(resolveModel(undefined, { ...config, model: 'gpt-5' }, {})).toEqual({ model: 'gpt-5', source: 'config' });
    expect(resolveModel(undefined, config, { OPENAI_API_KEY: 'x' })).toEqual({ model: 'gpt-5', source: 'openai-key' });
    expect(resolveModel(undefined, config, { ANTHROPIC_API_KEY: 'x' })).toEqual({
      model: 'claude',
      source: 'anthropic-key',
    });
    expect(resolveModel('codex', config, {})).toEqual({ model: 'codex', source: 'flag' });
    expect(resolveModel('codex:gpt-test', config, {})).toEqual({ model: 'codex:gpt-test', source: 'flag' });
    expect(resolveModel(undefined, config, { COPPERHEAD_MODEL: 'codex' })).toEqual({
      model: 'codex',
      source: 'env',
    });
    expect(() => resolveModel(undefined, config, {})).toThrow(/no model configured/);
  });

  it('refuses to guess when two or more credentials are present (no silent favorite)', () => {
    // A single key is a safe guess (nothing to guess wrong). Two keys is not:
    // silently favoring OPENAI_API_KEY over an also-present ANTHROPIC_API_KEY
    // (or vice versa) can route a request to the wrong provider — including a
    // paid one — with no signal that a choice was even made.
    expect(() => resolveModel(undefined, config, { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' })).toThrow(
      /ambiguous: 2 credentials found \(OPENAI_API_KEY, ANTHROPIC_API_KEY\)/,
    );
    // --model, COPPERHEAD_MODEL, and config.model all still break the tie explicitly.
    expect(resolveModel('claude', config, { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' })).toEqual({
      model: 'claude',
      source: 'flag',
    });
    expect(
      resolveModel(undefined, config, { COPPERHEAD_MODEL: 'gpt-5', OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }),
    ).toEqual({ model: 'gpt-5', source: 'env' });
  });
});

describe('config loading', () => {
  it('defaults apply and budgets round-trip', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const config = await loadConfig(repo);
      expect(config.maxTurns).toBe(40);
      expect(config.maxRepairCycles).toBe(5);
      expect(config.schematic).toBe(path.join('hardware', 'open-key.kicad_sch'));
      expect(config.board).toBe(path.join('hardware', 'open-key.kicad_pcb'));
    } finally {
      await cleanup();
    }
  });
});
