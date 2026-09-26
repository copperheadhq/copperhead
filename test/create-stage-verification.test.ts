import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { tempFixtureRepo } from './helpers.js';

const mocks = vi.hoisted(() => ({ check: vi.fn(), drc: vi.fn(), loop: vi.fn() }));
vi.mock('../src/commands/check.js', () => ({ runCheck: mocks.check }));
vi.mock('../src/kicad/cli.js', async (original) => ({
  ...(await original<object>()),
  runDrc: mocks.drc,
}));
vi.mock('../src/agent/loop.js', async (original) => ({
  ...(await original<object>()),
  runAgentLoop: mocks.loop,
}));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit: async () => ({ ok: true, output: '' }) }));

import { runCreate, STAGES } from '../src/commands/create.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.check.mockResolvedValue({ ok: false });
  mocks.drc.mockResolvedValue({ ok: false, source: 'drc', violations: [] });
  mocks.loop.mockResolvedValue({ outcome: 'refused', exitPath: 'refused', summary: 'stop', transcriptDir: '' });
});

describe('create completion follows the stage safety contracts', () => {
  it.each([
    'UNVERIFIED: RC0603FR-0710KL',
    'RC0603FR-0710KL (UNVERIFIED)',
    '**UNVERIFIED** RC0603FR-0710KL',
  ])('accepts a selected part while preserving its review flag: %s', async (mpn) => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, 'docs'));
      await writeFile(path.join(repo, 'docs', 'BOM.md'),
        `| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | ${mpn} | 1% bias resistor |\n`);
      expect(await STAGES.find((s) => s.name === 'part-selection')!.isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('reads MPN by header and does not mistake an unrelated table for selected parts', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, 'docs'));
      const bom = path.join(repo, 'docs', 'BOM.md');
      const complete = STAGES.find((s) => s.name === 'part-selection')!.isComplete;
      await writeFile(bom, '| Refdes | MPN | Value | Footprint |\n|---|---|---|---|\n| R1 | UNVERIFIED | 10k | R_0603 |\n');
      expect(await complete(repo, 'docs')).toBe(false);
      await writeFile(bom, '| Risk | Level | Owner | Status |\n|---|---|---|---|\n| Thermal | Low | team | closed |\n');
      expect(await complete(repo, 'docs')).toBe(false);
      await writeFile(bom, '| Refdes | MPN | Value | Footprint |\n|---|---|---|---|\n| R1 | UNVERIFIED: RC0603FR-0710KL | 10k | R_0603 |\n');
      expect(await complete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('keeps a resumed layout active until the board passes DRC', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'));
      await mkdir(path.join(repo, 'docs'));
      await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify({ board: 'board.kicad_pcb' }));
      await writeFile(path.join(repo, 'board.kicad_pcb'), '(kicad_pcb (footprint "R_0603"))');
      await writeFile(path.join(repo, 'docs', 'LAYOUT.md'), '## Draft quality\nPlacement needs review.\n');
      const complete = STAGES.find((s) => s.name === 'layout-draft')!.isComplete;
      expect(await complete(repo, 'docs')).toBe(false);
      mocks.drc.mockResolvedValue({ ok: true, source: 'drc', violations: [] });
      expect(await complete(repo, 'docs')).toBe(true);
      expect(mocks.drc).toHaveBeenCalledWith(path.join(repo, 'board.kicad_pcb'));
    } finally {
      await cleanup();
    }
  });

  it.each([
    { ok: false },
    { ok: true, erc: null, drc: null },
  ])('does not commit dirty KiCad files after an earlier doc stage resumes with failed or skipped verification: %j', async (verification) => {
    mocks.check.mockResolvedValue(verification);
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await mkdir(path.join(repo, '.copperhead'));
      await mkdir(path.join(repo, 'docs'));
      await writeFile(path.join(repo, '.copperhead', 'config.json'), JSON.stringify({
        schematic: 'hardware/open-key.kicad_sch', board: 'hardware/open-key.kicad_pcb', maxStageRetries: 0,
      }));
      await writeFile(path.join(repo, 'docs', 'SPEC.md'), '# Specification\n\n## Budgets\n- sleep_current_uA: 25\n');
      const briefPath = path.join(repo, 'docs', 'brief.md');
      await writeFile(briefPath, 'A keyer.\n');
      const schematic = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const unverified = (await readFile(schematic, 'utf8')).replace('"Value" "10k"', '"Value" "47k"');
      await writeFile(schematic, unverified);
      const lines: string[] = [];
      const result = await runCreate({ repoRoot: repo, briefPath, model: 'gpt-5', log: (line) => lines.push(line) });
      expect(result.ok).toBe(false);
      expect(result.completed).toContain('spec-seed');
      expect(mocks.check).toHaveBeenCalled();
      expect(lines.join('\n')).toContain('leaving resumed KiCad work uncommitted because verification failed');
      expect((await execa('git', ['log', '--format=%s'], { cwd: repo })).stdout).toBe('fixture');
      expect(await readFile(schematic, 'utf8')).toBe(unverified);
    } finally {
      await cleanup();
    }
  });
});
