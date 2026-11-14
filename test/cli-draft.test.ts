import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';

/**
 * The `draft` and `score` commander actions through the real entry point: exit
 * codes and JSON shapes are CLI contract (AC-16.24/AC-16.26 family) and were
 * previously reached by no test. Runs via tsx like the demo-tour test; both
 * commands are LLM-free and network-free, and `score` never lets the composite
 * drive the exit code.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRAFT_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'draft');
const SYMLIB = path.join(ROOT, 'test', 'fixtures', 'symlib');

async function fixtureRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-clidraft-'));
  await cp(path.join(DRAFT_FIXTURE, 'schematic.intent.json'), path.join(repo, 'schematic.intent.json'));
  await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await writeFile(
    path.join(repo, '.copperhead', 'config.json'),
    JSON.stringify({ schematic: 'board.kicad_sch', docs: 'docs/' }),
    'utf8',
  );
  // Vendor the fixture symbols so the spawned CLI (which has no symbolDirs
  // override) resolves hermetically from the committed-style cache.
  const { draftSchematic } = await import('../src/kicad/draft/draft.js');
  const res = await draftSchematic({
    repoRoot: repo,
    schematic: 'board.kicad_sch',
    intentPath: 'schematic.intent.json',
    docsDir: path.join(repo, 'docs'),
    symbolDirs: [SYMLIB],
  });
  if (!res.ok) throw new Error(res.message);
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

const cli = (repo: string, ...args: string[]) =>
  execa('npx', ['tsx', 'src/cli.ts', '--repo', repo, ...args], { cwd: ROOT, reject: false, env: { NO_COLOR: '1' } });

describe('copperhead draft schematic (CLI)', () => {
  it('exits 0 and prints the report on a good intent; --json is machine-readable', async () => {
    const { repo, cleanup } = await fixtureRepo();
    try {
      const prose = await cli(repo, 'draft', 'schematic');
      expect(prose.exitCode).toBe(0);
      expect(prose.stdout).toContain('drafted:');

      const json = await cli(repo, '--json', 'draft', 'schematic');
      expect(json.exitCode).toBe(0);
      const parsed = JSON.parse(json.stdout) as { ok: boolean; report: { paper: string } };
      expect(parsed.ok).toBe(true);
      expect(typeof parsed.report.paper).toBe('string');
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('exits 1 with numbered findings on a refused intent, and writes nothing', async () => {
    const { repo, cleanup } = await fixtureRepo();
    try {
      const bad = JSON.parse(
        await import('node:fs/promises').then((fs) => fs.readFile(path.join(repo, 'schematic.intent.json'), 'utf8')),
      ) as { nets: { name: string; pins: string[] }[] };
      bad.nets.push({ name: 'GHOST', pins: ['U9.1', 'U9.2'] });
      await writeFile(path.join(repo, 'schematic.intent.json'), JSON.stringify(bad), 'utf8');

      const res = await cli(repo, 'draft', 'schematic');
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('unknown part U9');

      const json = await cli(repo, '--json', 'draft', 'schematic');
      expect(json.exitCode).toBe(1);
      const parsed = JSON.parse(json.stdout) as { ok: boolean; findings: { detail: string }[] };
      expect(parsed.ok).toBe(false);
      expect(parsed.findings.some((f) => f.detail.includes('unknown part U9'))).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('exits 1 when no schematic is configured', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-clidraft-nosch-'));
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(path.join(repo, '.copperhead', 'config.json'), '{}', 'utf8');
      const res = await cli(repo, 'draft', 'schematic');
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('no schematic configured');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('copperhead score schematic (CLI)', () => {
  it('exits 0 regardless of the composite, in prose and JSON', async () => {
    const { repo, cleanup } = await fixtureRepo();
    try {
      const prose = await cli(repo, 'score', 'schematic');
      expect(prose.exitCode).toBe(0);
      expect(prose.stdout).toMatch(/\/100/);

      const json = await cli(repo, '--json', 'score', 'schematic');
      expect(json.exitCode).toBe(0);
      const parsed = JSON.parse(json.stdout) as { composite: number; metrics: unknown[] };
      expect(Number.isFinite(parsed.composite)).toBe(true);
      expect(Array.isArray(parsed.metrics)).toBe(true);
    } finally {
      await cleanup();
    }
  }, 120_000);
});
