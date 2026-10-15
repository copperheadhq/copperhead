/**
 * The schematic stage may change a part's footprint (the draft engine names the
 * variant whose pads match the symbol), so it does not complete while a BOM.md
 * Footprint cell is an installed id retyped with a slip of separator or case
 * (AC-15.40). Drift
 * compares the schematic with BOM.md and nothing else, so an id mistyped in both
 * stays drift-clean and, left alone, reaches layout-draft, where it stops the run
 * for the user. A footprint never installed (this fixture's ESP32-S3-MINI-1 on
 * KiCad 10, one character from the installed ESP32-S2-MINI-1) is left to that
 * stop, as before, so the fixture still completes.
 *
 * ERC is stubbed here: this test is about the footprint rule, and kicad-cli's
 * verdict on the fixture depends on the KiCad version installed.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

vi.mock('../src/kicad/cli.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/kicad/cli.js')>()),
  runErc: async () => ({ ok: true, source: 'erc', violations: [] }),
}));

const { STAGES } = await import('../src/commands/create.js');
const { tempFixtureRepo } = await import('./helpers.js');
const { runInit } = await import('../src/memory/scaffold.js');

describe('schematic isComplete: a retyped footprint id', () => {
  it('a footprint id mistyped in BOM.md and the schematic alike keeps the stage open', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      // the fixture's caption must name a documented subsystem
      const subs = path.join(repo, 'docs', 'SUBSYSTEMS.md');
      await writeFile(subs, (await readFile(subs, 'utf8')) + '\n## Keyer\n\nKey input block.\n', 'utf8');
      const isComplete = STAGES.find((s) => s.name === 'schematic')!.isComplete;
      expect(await isComplete(repo, 'docs/')).toBe(true);

      // the slip a hosted run made: an installed id retyped with one separator changed
      for (const file of [path.join(repo, 'docs', 'BOM.md'), path.join(repo, 'hardware', 'open-key.kicad_sch')]) {
        const text = await readFile(file, 'utf8');
        expect(text).toContain('Resistor_SMD:R_0603_1608Metric');
        await writeFile(file, text.replaceAll('Resistor_SMD:R_0603_1608Metric', 'Resistor_SMD:R_0603-1608Metric'), 'utf8');
      }
      expect(await isComplete(repo, 'docs/')).toBe(false);
    } finally {
      await cleanup();
    }
  }, 60000);
});
