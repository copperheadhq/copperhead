import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { explainQuery, formatExplain, runExplain } from '../src/commands/explain.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const cli = (repo: string, ...args: string[]) =>
  execa('npx', ['tsx', 'src/cli.ts', '--repo', repo, ...args], {
    cwd: ROOT,
    reject: false,
    env: { NO_COLOR: '1' },
  });

describe('explainQuery (schematic lookup)', () => {
  it('explains a refdes with pins, nets, and BOM after init', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const res = await explainQuery(repo, 'U1');
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.hit.kind).toBe('part');
      if (res.hit.kind !== 'part') return;
      expect(res.hit.ref).toBe('U1');
      expect(res.hit.value).toBe('ESP32-S3-MINI');
      expect(res.hit.footprint).toContain('ESP32-S3-MINI');
      const gpio = res.hit.pins.find((p) => p.name === 'GPIO14');
      expect(gpio?.net).toBe('KEY_DAH');
      expect(res.hit.bom?.refdes).toBe('U1');
      expect(res.hit.mentions.some((m) => m.file === 'BOM.md' || m.file === 'PINOUT.md')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('explains a net by listing attached pins', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ schematic: 'hardware/open-key.kicad_sch', docs: 'docs/' }),
        'utf8',
      );
      const res = await explainQuery(repo, 'KEY_DAH');
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.hit.kind).toBe('net');
      if (res.hit.kind !== 'net') return;
      expect(res.hit.name).toBe('KEY_DAH');
      const refs = res.hit.pins.map((p) => `${p.ref}.${p.number}`);
      expect(refs).toEqual(expect.arrayContaining(['U1.5', 'R2.1']));
    } finally {
      await cleanup();
    }
  });

  it('explains REF.PIN by number and by pin name', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ schematic: 'hardware/open-key.kicad_sch', docs: 'docs/' }),
        'utf8',
      );
      const byNum = await explainQuery(repo, 'R2.1');
      expect(byNum.ok).toBe(true);
      if (!byNum.ok) return;
      expect(byNum.hit.kind).toBe('pin');
      if (byNum.hit.kind !== 'pin') return;
      expect(byNum.hit.ref).toBe('R2');
      expect(byNum.hit.number).toBe('1');
      expect(byNum.hit.net).toBe('KEY_DAH');

      const byName = await explainQuery(repo, 'U1.GPIO14');
      expect(byName.ok).toBe(true);
      if (!byName.ok) return;
      expect(byName.hit.kind).toBe('pin');
      if (byName.hit.kind !== 'pin') return;
      expect(byName.hit.ref).toBe('U1');
      expect(byName.hit.net).toBe('KEY_DAH');
    } finally {
      await cleanup();
    }
  });

  it('resolves a unique pin name without a refdes', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ schematic: 'hardware/open-key.kicad_sch', docs: 'docs/' }),
        'utf8',
      );
      const res = await explainQuery(repo, 'GPIO14');
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.hit.kind).toBe('pin');
      if (res.hit.kind !== 'pin') return;
      expect(res.hit.ref).toBe('U1');
      expect(res.hit.net).toBe('KEY_DAH');
    } finally {
      await cleanup();
    }
  });

  it('is case-insensitive and suggests nearby names on a miss', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ schematic: 'hardware/open-key.kicad_sch', docs: 'docs/' }),
        'utf8',
      );
      const folded = await explainQuery(repo, 'u1');
      expect(folded.ok).toBe(true);

      const miss = await explainQuery(repo, 'KEY_DAHX');
      expect(miss.ok).toBe(false);
      if (miss.ok) return;
      expect(miss.error).toMatch(/nothing named KEY_DAHX/);
      expect(miss.suggestions).toEqual(expect.arrayContaining(['KEY_DAH']));
    } finally {
      await cleanup();
    }
  });

  it('fails clearly with no schematic configured', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const res = await explainQuery(repo, 'U1');
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/no schematic configured/);
    } finally {
      await cleanup();
    }
  });
});

describe('formatExplain', () => {
  it('prints pins and a miss with suggestions', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const hit = await runExplain(repo, 'R1');
      expect(hit.result.ok).toBe(true);
      expect(hit.text).toContain('R1');
      expect(hit.text).toContain('10k');

      const miss = formatExplain({ ok: false, error: 'nothing named ZX', suggestions: ['U1'] });
      expect(miss).toContain('nothing named ZX');
      expect(miss).toContain('did you mean: U1');
    } finally {
      await cleanup();
    }
  });
});

describe('copperhead explain (CLI)', () => {
  it('exits 0 with prose, and --json is machine-readable', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const prose = await cli(repo, 'explain', 'U1');
      expect(prose.exitCode).toBe(0);
      expect(prose.stdout).toContain('U1');
      expect(prose.stdout).toContain('GPIO14');

      const json = await cli(repo, '--json', 'explain', 'GND');
      expect(json.exitCode).toBe(0);
      const parsed = JSON.parse(json.stdout) as { ok: true; hit: { kind: string; name: string } };
      expect(parsed.ok).toBe(true);
      expect(parsed.hit.kind).toBe('net');
      expect(parsed.hit.name).toBe('GND');
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('exits 1 for an unknown query, with suggestions in JSON', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const res = await cli(repo, '--json', 'explain', 'NOPE');
      expect(res.exitCode).toBe(1);
      const parsed = JSON.parse(res.stdout) as { ok: false; error: string; suggestions: string[] };
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toMatch(/NOPE/);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('prints JSON on a read error when --json is set', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'config.json'), '{ not json', 'utf8');
      const res = await cli(repo, '--json', 'explain', 'U1');
      expect(res.exitCode).toBe(1);
      const parsed = JSON.parse(res.stdout) as { ok: false; error: string; suggestions: string[] };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.length).toBeGreaterThan(0);
      expect(parsed.suggestions).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 60_000);
});
