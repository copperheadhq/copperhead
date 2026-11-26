import { describe, it, expect } from 'vitest';
import { readFile, writeFile, rm, mkdtemp, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
      expect(res.drc).toEqual({ ok: true, violations: 0, unrouted: 0, intrinsic: 0 });
      expect(res.drift.ok).toBe(true);
      expect(Object.keys(res).sort()).toEqual(['constraints', 'drc', 'drift', 'erc', 'legibility', 'ok', 'openspec']);
      expect(res.legibility.counts.error).toBe(0);
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

describe('init reports when the pre-commit hook was not installed (#103)', () => {
  it('installs the hook and reports no skip on a fresh repo', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const res = await runInit({ repoRoot: repo });
      expect(res.hookSkipped).toBeNull();
      const hook = await readFile(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8');
      expect(hook).toContain('# installed by copperhead init');
      expect(res.created).toContain(path.join('.git', 'hooks', 'pre-commit'));
    } finally {
      await cleanup();
    }
  });

  it('is idempotent: re-running reports no skip and does not re-create', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      const before = await readFile(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8');
      const res = await runInit({ repoRoot: repo });
      expect(res.hookSkipped).toBeNull();
      expect(await readFile(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe(before);
      expect(res.created).not.toContain(path.join('.git', 'hooks', 'pre-commit'));
    } finally {
      await cleanup();
    }
  });

  it('reports the skip when the user\'s own hook is in the way, and preserves it', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
      await writeFile(hookPath, '#!/bin/sh\nnpm run lint\n', 'utf8');
      const res = await runInit({ repoRoot: repo });
      expect(res.hookSkipped).toMatch(/already exists.*was not written by copperhead.*gate is NOT active/);
      expect(res.hookSkipped).toContain('Add "copperhead check" to your existing hook');
      // the foreign hook is never clobbered
      expect(await readFile(hookPath, 'utf8')).toBe('#!/bin/sh\nnpm run lint\n');
      // docs still scaffold normally; the skip fails nothing
      expect(res.refused).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('reports the skip when there is no .git/hooks directory', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await rm(path.join(repo, '.git', 'hooks'), { recursive: true, force: true });
      const res = await runInit({ repoRoot: repo });
      expect(res.hookSkipped).toMatch(/no .git\/hooks directory.*gate is NOT active/);
      // docs still scaffold normally
      expect(existsSync(path.join(repo, 'docs', 'SPEC.md'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('follows core.hooksPath: a husky-managed foreign hook is reported, nothing written under .git/hooks', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.husky', '_'), { recursive: true });
      await writeFile(path.join(repo, '.husky', '_', 'pre-commit'), '#!/bin/sh\nnpx husky test\n', 'utf8');
      await execa('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: repo });
      const res = await runInit({ repoRoot: repo });
      // the managed location is named, so the advice points at the right file
      expect(res.hookSkipped).toMatch(/\.husky\/_\/pre-commit already exists.*gate is NOT active/);
      expect(existsSync(path.join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('installs into the shared hooks dir from a linked worktree', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    const wt = `${repo}-wt`;
    await execa('git', ['worktree', 'add', wt], { cwd: repo });
    try {
      const res = await runInit({ repoRoot: wt });
      expect(res.hookSkipped).toBeNull();
      expect(await readFile(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8')).toContain(
        '# installed by copperhead init',
      );
    } finally {
      await execa('git', ['worktree', 'remove', '--force', wt], { cwd: repo });
      await cleanup();
    }
  });

  it('reports not-a-git-repo outside a git repository', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await rm(path.join(repo, '.git'), { recursive: true, force: true });
      const res = await runInit({ repoRoot: repo });
      expect(res.hookSkipped).toMatch(/not a git repository.*gate is NOT active/);
      expect(existsSync(path.join(repo, 'docs', 'SPEC.md'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('prints the warning on the CLI surface, not only in the result object', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const hookPath = path.join(repo, '.git', 'hooks', 'pre-commit');
      await writeFile(hookPath, '#!/bin/sh\nnpm run lint\n', 'utf8');
      // `init` gates on kicad-cli; stub only the version preflight (no KiCad
      // tooling is exercised by this path).
      const bin = await mkdtemp(path.join(tmpdir(), 'copperhead-kicad-stub-'));
      try {
        await writeFile(path.join(bin, 'kicad-cli'), '#!/bin/sh\necho "kicad-cli 10.0.4"\n', { mode: 0o755 });
        const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
        const res = await execa('npx', ['tsx', 'src/cli.ts', '--repo', repo, 'init'], {
          cwd: ROOT,
          env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
          reject: false,
        });
        expect(res.exitCode).toBe(0);
        expect(res.stdout).toMatch(/WARNING: pre-commit hook not installed/);
        expect(await readFile(hookPath, 'utf8')).toBe('#!/bin/sh\nnpm run lint\n');
      } finally {
        await rm(bin, { recursive: true, force: true });
      }
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('scopes the hook to the project when it lives in a monorepo subdirectory', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, 'hw'));
      await rename(path.join(repo, 'hardware'), path.join(repo, 'hw', 'hardware'));
      const sub = path.join(repo, 'hw');
      const res = await runInit({ repoRoot: sub });
      expect(res.hookSkipped).toBeNull();
      // git runs hooks from the worktree top, so the hook must name the subdir
      const hook = await readFile(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8');
      expect(hook).toContain('copperhead --repo "hw" check');
    } finally {
      await cleanup();
    }
  });

  it('refuses to write into a core.hooksPath outside the repository', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    const shared = await mkdtemp(path.join(tmpdir(), 'ch-shared-hooks-'));
    const globalConfig = path.join(shared, 'gitconfig');
    const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
    const savedSystem = process.env.GIT_CONFIG_SYSTEM;
    try {
      await writeFile(globalConfig, `[core]\n\thooksPath = ${shared}/hooks\n`, 'utf8');
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      process.env.GIT_CONFIG_SYSTEM = '/dev/null';
      const res = await runInit({ repoRoot: repo });
      expect(res.hookSkipped).toMatch(/outside this repository.*gate is NOT active/);
      expect(res.hookSkipped).toContain('Add "copperhead check"');
      expect(existsSync(path.join(shared, 'hooks', 'pre-commit'))).toBe(false);
      expect(existsSync(path.join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false);
    } finally {
      if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
      if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = savedSystem;
      await rm(shared, { recursive: true, force: true });
      await cleanup();
    }
  });

  it('reports unwritable hooks dirs instead of throwing', async () => {
    if (process.platform === 'win32') return;
    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const hooksDir = path.join(repo, '.git', 'hooks');
      await execa('chmod', ['555', hooksDir]);
      try {
        const res = await runInit({ repoRoot: repo });
        expect(res.hookSkipped).toMatch(/could not be written.*gate is NOT active/);
        expect(existsSync(path.join(hooksDir, 'pre-commit'))).toBe(false);
      } finally {
        await execa('chmod', ['755', hooksDir]);
      }
    } finally {
      await cleanup();
    }
  });

  it('falls back to .git/hooks when git cannot resolve the hooks dir', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = await mkdtemp(path.join(tmpdir(), 'ch-empty-path-'));
      const res = await runInit({ repoRoot: repo });
      expect(res.hookSkipped).toBeNull();
      expect(await readFile(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8')).toContain(
        '# installed by copperhead init',
      );
    } finally {
      process.env.PATH = savedPath;
      await cleanup();
    }
  });

  it('stays silent about the hook when --no-hooks asked for no hook', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const res = await runInit({ repoRoot: repo, installHooks: false });
      expect(res.hookSkipped).toBeNull();
      expect(existsSync(path.join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false);
    } finally {
      await cleanup();
    }
  });
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
