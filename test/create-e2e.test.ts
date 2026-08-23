import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

// Direct stage contract tests (offline, no KiCad needed)
import { STAGES } from '../src/commands/create.js';
import { tempFixtureRepo } from './helpers.js';

describe('create pipeline: e2e stage contracts (bounty AC)', () => {
  it('stage names and order are correct', () => {
    expect(STAGES.map((s) => s.name)).toEqual([
      'spec-seed', 'architecture', 'part-selection', 'schematic',
      'layout-draft', 'outputs', 'firmware', 'devplan',
    ]);
  });

  it('spec-seed isComplete: SPEC.md with Budgets heading and budget line', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      const s = STAGES[0];
      expect(s.name).toBe('spec-seed');
      expect(await s.isComplete(repo, 'docs')).toBe(false);
      await writeFile(path.join(docs, 'SPEC.md'), '# Device\n\n## Budgets and constraints\nPower budget: 500mA\n', 'utf8');
      expect(await s.isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('architecture isComplete: SUBSYSTEMS.md with section heading and content', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      const s = STAGES[1];
      expect(s.name).toBe('architecture');
      expect(await s.isComplete(repo, 'docs')).toBe(false);
      await writeFile(path.join(docs, 'SUBSYSTEMS.md'), '# Architecture\n\n## Power Subsystem\nRegulates 5V to 3.3V.\n', 'utf8');
      expect(await s.isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('part-selection isComplete: BOM.md with real MPN', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      const s = STAGES[2];
      expect(s.name).toBe('part-selection');
      expect(await s.isComplete(repo, 'docs')).toBe(false);
      await writeFile(path.join(docs, 'BOM.md'), '# BOM\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | 0402 | RC0402JR-0710KL | Pullup |\n', 'utf8');
      expect(await s.isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('layout-draft isComplete: LAYOUT.md with Draft quality + board with footprint', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      const s = STAGES[4];
      expect(s.name).toBe('layout-draft');
      expect(await s.isComplete(repo, 'docs')).toBe(false);
      await writeFile(path.join(docs, 'LAYOUT.md'), '# Layout\n\n## Draft quality\n', 'utf8');
      expect(await s.isComplete(repo, 'docs')).toBe(false);
      const bd = path.join(repo, 'hardware');
      await mkdir(bd, { recursive: true });
      await writeFile(path.join(bd, 'board.kicad_pcb'), '(kicad_pcb (footprint "R_0402"))', 'utf8');
      const cfg = path.join(repo, '.copperhead');
      await mkdir(cfg, { recursive: true });
      await writeFile(path.join(cfg, 'config.json'),
        JSON.stringify({ board: 'hardware/board.kicad_pcb', docs: 'docs/' }), 'utf8');
      expect(await s.isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('outputs isComplete: outputs/ directory exists and contains files', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const s = STAGES[5];
      expect(s.name).toBe('outputs');
      expect(await s.isComplete(repo, 'docs')).toBe(false);
      const outDir = path.join(repo, 'outputs');
      await mkdir(outDir, { recursive: true });
      expect(await s.isComplete(repo, 'docs')).toBe(false); // empty dir is not complete
      await writeFile(path.join(outDir, 'board.gbr'), 'G04 Gerber*\n', 'utf8');
      expect(await s.isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('firmware isComplete: firmware/ directory exists and contains files', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const s = STAGES[6];
      expect(s.name).toBe('firmware');
      expect(await s.isComplete(repo, 'docs')).toBe(false);
      const fwDir = path.join(repo, 'firmware');
      await mkdir(fwDir, { recursive: true });
      expect(await s.isComplete(repo, 'docs')).toBe(false); // empty dir is not complete
      await writeFile(path.join(fwDir, 'main.c'), '// firmware\n', 'utf8');
      expect(await s.isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('devplan isComplete: DEVPLAN.md exists', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      const s = STAGES[7];
      expect(s.name).toBe('devplan');
      expect(await s.isComplete(repo, 'docs')).toBe(false);
      await writeFile(path.join(docs, 'DEVPLAN.md'), '# Dev plan\n\n## Bring-up\n1. Check power rails.\n', 'utf8');
      expect(await s.isComplete(repo, 'docs')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('schematic contract: empty symbols = incomplete (false-green prevention)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const docs = path.join(repo, 'docs');
      await mkdir(docs, { recursive: true });
      
      // Configure an existing, empty schematic
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ schematic: 'hardware/board.kicad_sch', board: 'hardware/board.kicad_pcb' }),
        'utf8'
      );
      await mkdir(path.join(repo, 'hardware'), { recursive: true });
      await writeFile(
        path.join(repo, 'hardware', 'board.kicad_sch'),
        '(kicad_sch (version 20231120) (generator "eeschema"))',
        'utf8'
      );

      const s = STAGES[3];
      expect(s.name).toBe('schematic');
      expect(await s.isComplete(repo, 'docs')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('all 8 stages have prompt and isComplete functions', () => {
    expect(STAGES.length).toBe(8);
    for (const s of STAGES) {
      expect(s.prompt).toBeInstanceOf(Function);
      expect(s.isComplete).toBeInstanceOf(Function);
    }
  });
});
