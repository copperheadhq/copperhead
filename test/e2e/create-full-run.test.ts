import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { tempFixtureRepo } from '../helpers.js';
import { runCreate } from '../../src/commands/create.js';

function hasKicadCli(): boolean {
  try {
    execSync('kicad-cli version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const describeE2E = hasKicadCli() ? describe : describe.skip;

describeE2E('End-to-End Create Pipeline Replay Harness', () => {
  it('fails loudly on cache miss when COPPERHEAD_CACHE_ONLY=1', async () => {
    process.env.COPPERHEAD_CACHE_ONLY = '1';
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'dummy-key';
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# USB-C Power Breakout Brief', 'utf8');

      await expect(
        runCreate({
          repoRoot: repo,
          briefPath,
          model: 'gpt-5',
          log: () => {},
        }),
      ).rejects.toThrow(/Cache miss/);
    } finally {
      delete process.env.COPPERHEAD_CACHE_ONLY;
      await cleanup();
    }
  });

  it('runs all 8 stages to completion under deterministic cache replay mode', async () => {
    process.env.COPPERHEAD_CACHE_ONLY = '1';
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'dummy-key';
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const briefPath = path.join(repo, 'brief.md');
      await writeFile(briefPath, '# USB-C Power Breakout Brief', 'utf8');

      // Pre-seed completed stage docs to simulate successful replay progression across all 8 stages
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      await writeFile(path.join(docs, 'SPEC.md'), '# SPEC\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
      await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# SUBSYSTEMS\n\n## Power\n\nLDO regulator.\n', 'utf8');
      const fixtureSch = await readFile(path.join(__dirname, '../fixtures/open-key/hardware/open-key.kicad_sch'), 'utf8');
      const fixturePcb = await readFile(path.join(__dirname, '../fixtures/open-key/hardware/open-key.kicad_pcb'), 'utf8');
      await writeFile(path.join(repo, 'board.kicad_sch'), fixtureSch, 'utf8');
      await writeFile(path.join(repo, 'board.kicad_pcb'), fixturePcb + '\n(footprint "Resistor_SMD:R_0603_1608Metric" (at 100 100))\n', 'utf8');
      await writeFile(
        path.join(docs, 'BOM.md'),
        '# BOM\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | standard |\n| R2 | 1k | Resistor_SMD:R_0603_1608Metric | RC0603FR-071KL | standard |\n| U1 | ESP32-S3-MINI | RF_Module:ESP32-S3-MINI-1 | ESP32-S3-MINI-1-N8 | MCU |\n',
        'utf8',
      );
      await writeFile(path.join(docs, 'PINOUT.md'), '# PINOUT\n\n## Strapping\n\nNone.\n', 'utf8');
      await writeFile(path.join(docs, 'LAYOUT.md'), '# LAYOUT\n\n## Draft quality\n\nOK\n', 'utf8');

      await mkdir(path.join(repo, 'outputs'), { recursive: true });
      await mkdir(path.join(repo, 'firmware'), { recursive: true });
      await writeFile(path.join(docs, 'DEVPLAN.md'), '# DEVPLAN\n', 'utf8');

      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ schematic: 'board.kicad_sch', board: 'board.kicad_pcb' }, null, 2),
        'utf8',
      );

      const res = await runCreate({
        repoRoot: repo,
        briefPath,
        model: 'gpt-5',
        log: () => {},
      });

      expect(res.ok).toBe(true);
      expect(res.completed).toEqual([
        'spec-seed',
        'architecture',
        'part-selection',
        'schematic',
        'layout-draft',
        'outputs',
        'firmware',
        'devplan',
      ]);
    } finally {
      delete process.env.COPPERHEAD_CACHE_ONLY;
      await cleanup();
    }
  });
});
