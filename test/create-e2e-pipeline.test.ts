import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { STAGES } from '../src/commands/create.js';

describe('copperhead create end-to-end 8-stage gate coverage (#66)', () => {
  it('defines all 8 canonical create pipeline stages in order', () => {
    expect(STAGES.map((s) => s.name)).toEqual([
      'spec-seed',
      'architecture',
      'part-selection',
      'schematic',
      'layout-draft',
      'outputs',
      'firmware',
      'devplan',
    ]);
  });

  it('refuses scaffold placeholders and false-green empty artifacts across stages, then passes when each stage contract is met', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'copperhead-e2e-stages-'));
    try {
      const docs = 'docs';
      await mkdir(path.join(root, docs), { recursive: true });

      const specSeed = STAGES.find((s) => s.name === 'spec-seed')!;
      const architecture = STAGES.find((s) => s.name === 'architecture')!;
      const schematic = STAGES.find((s) => s.name === 'schematic')!;
      const outputs = STAGES.find((s) => s.name === 'outputs')!;
      const firmware = STAGES.find((s) => s.name === 'firmware')!;
      const devplan = STAGES.find((s) => s.name === 'devplan')!;

      // Stage 1: comment-only placeholder under ## Budgets must NOT complete spec-seed
      await writeFile(
        path.join(root, docs, 'SPEC.md'),
        '# USB-C Power Breakout\n\n## Budgets\n\n<!-- placeholder only -->\n',
        'utf8',
      );
      expect(await specSeed.isComplete(root, docs)).toBe(false);

      await writeFile(
        path.join(root, docs, 'SPEC.md'),
        '# USB-C Power Breakout\n\n## 1. Electrical Budgets\n\n- vbus_max_V: 5.5\n- continuous_current_A: 3.0\n',
        'utf8',
      );
      expect(await specSeed.isComplete(root, docs)).toBe(true);

      // Stage 2: auto-generated symbol bullets alone must NOT complete architecture
      await writeFile(
        path.join(root, docs, 'SUBSYSTEMS.md'),
        '# Subsystems\n\nPer-sheet values and reasoning.\n\n## Sheet 1\n\n- R1: 5.1k\n- J1: USB_C_Receptacle_USB2.0\n',
        'utf8',
      );
      expect(await architecture.isComplete(root, docs)).toBe(false);

      await writeFile(
        path.join(root, docs, 'SUBSYSTEMS.md'),
        '# Subsystems\n\n## Power Input and CC Pulldowns\n\nUSB-C receptacle J1 feeds VBUS with dual 5.1k CC1/CC2 pulldown resistors R1 and R2 for 5V/3A sink negotiation.\n',
        'utf8',
      );
      expect(await architecture.isComplete(root, docs)).toBe(true);

      // Stage 4: zero-symbol schematic must NEVER false-green
      await mkdir(path.join(root, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(root, '.copperhead', 'config.json'),
        JSON.stringify({ docs: 'docs/', schematic: 'board.kicad_sch', board: 'board.kicad_pcb' }),
        'utf8',
      );
      await writeFile(
        path.join(root, 'board.kicad_sch'),
        '(kicad_sch (version 20231120) (generator "copperhead"))\n',
        'utf8',
      );
      expect(await schematic.isComplete(root, docs)).toBe(false);

      // Stage 6: empty outputs/ directory must NOT complete outputs
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      expect(await outputs.isComplete(root, docs)).toBe(false);
      await writeFile(path.join(root, 'outputs', 'board-F_Cu.gtl'), 'G04 Gerber*\nM02*\n', 'utf8');
      expect(await outputs.isComplete(root, docs)).toBe(true);

      // Stage 7: empty firmware/ directory must NOT complete firmware
      await mkdir(path.join(root, 'firmware'), { recursive: true });
      expect(await firmware.isComplete(root, docs)).toBe(false);
      await writeFile(path.join(root, 'firmware', 'pins.h'), '#pragma once\n#define PIN_VBUS_SENSE 1\n', 'utf8');
      expect(await firmware.isComplete(root, docs)).toBe(true);

      // Stage 8: heading-only DEVPLAN.md must NOT complete devplan
      await writeFile(path.join(root, docs, 'DEVPLAN.md'), '# Dev Plan\n\n## Bring-up\n', 'utf8');
      expect(await devplan.isComplete(root, docs)).toBe(false);
      await writeFile(
        path.join(root, docs, 'DEVPLAN.md'),
        '# Dev Plan\n\n## Bring-up\n\n1. Continuity check VBUS to GND before applying USB-C power.\n2. Verify 5.0V rail on TP1.\n',
        'utf8',
      );
      expect(await devplan.isComplete(root, docs)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
