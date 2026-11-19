/**
 * Unit tests for the strengthened stage isComplete probes (issue #23).
 *
 * Each probe is exercised against:
 *   1. A false-positive case — scaffold / init template / blank file → false
 *   2. A true-positive case  — real agent-produced content         → true
 *
 * The STAGES array is imported directly so we always test the live contracts,
 * not a copy.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { STAGES, contractGapDetail } from '../src/commands/create.js';
import { loadConfig } from '../src/config.js';

/** Return the isComplete function for the named stage (throws if not found). */
function stageNamed(name: string) {
  const s = STAGES.find((x) => x.name === name);
  if (!s) throw new Error(`Stage not found: ${name}`);
  return s.isComplete;
}

/** Create a fresh temp dir, run the callback, then remove it. */
async function withTmpDir(fn: (root: string) => Promise<void>): Promise<void> {
  const dir = path.join(
    os.tmpdir(),
    `copperhead-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const DOCS = 'docs';

// ---------------------------------------------------------------------------
// Stage 1: spec-seed
// ---------------------------------------------------------------------------
describe('spec-seed isComplete', () => {
  it('returns false when SPEC.md has only the init scaffold placeholder (## Budgets + HTML comment)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      // Exact content that `copperhead init` writes
      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project — Specification\n\nWhat the device is.\n\n## Budgets\n\n<!-- Add hard budgets here -->\n<!-- - sleep_current_uA: 25 -->\n\n## Assumptions\n\n<!-- Decisions flagged ASSUMED -->\n`,
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when SPEC.md has no Budgets section at all', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(path.join(root, DOCS, 'SPEC.md'), '# Spec\n\nNo budgets section.\n', 'utf8');
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when SPEC.md is missing', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when SPEC.md Budgets section contains multi-line HTML comments only', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project\n\n## Budgets\n\n<!--\nAdd hard budgets here\n- sleep_current_uA: 25\n-->\n\n## Assumptions\n`,
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when SPEC.md Budgets heading has trailing title text and contains HTML comments only', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project\n\n## 3. Budgets and constraints\n\n<!-- Add hard budgets here -->\n\n## Assumptions\n`,
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(false);
    });
  });

  it('returns true when SPEC.md has a Budgets section with real content lines', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project\n\n## Budgets\n\n- sleep_current_uA: 25\n- peak_current_mA: 500\n\n## Assumptions\n\n- USB-C assumed ASSUMED\n`,
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(true);
    });
  });

  // I17: the budgets live under subsections, so the parent heading's own body is
  // empty. Ending the section at the next heading of ANY depth read this fully
  // populated spec as an unfilled placeholder and failed the stage after it had
  // already committed its work.
  it('returns true when the Budgets section carries its content in subsections', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project\n\n## 3. Electrical budgets\n\n### 3.1 Input and rails\n\n| ID | Budget | Value |\n|----|--------|-------|\n| B-1 | VIN | 12 V |\n\n### 3.2 Battery\n\n- charge_current_mA: 500\n\n## 4. Motion requirements\n\n- 90 deg index\n`,
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(true);
    });
  });

  it('returns false when the Budgets section holds subheadings but no content', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project\n\n## Budgets\n\n### Power\n\n<!-- TODO -->\n\n### Thermal\n\n## Assumptions\n`,
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(false);
    });
  });

  it('does not let a later sibling section satisfy the Budgets contract', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SPEC.md'),
        `# My Project\n\n## Budgets\n\n<!-- Add hard budgets here -->\n\n## Assumptions\n\n- USB-C assumed ASSUMED\n`,
        'utf8',
      );
      expect(await stageNamed('spec-seed')(root, DOCS)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 2: architecture
// ---------------------------------------------------------------------------
describe('architecture isComplete', () => {
  it('returns false when SUBSYSTEMS.md does not exist', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      expect(await stageNamed('architecture')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when SUBSYSTEMS.md has only a title heading and no section content', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      // A file with only a top-level heading and blank lines — no prose, no ## sections
      await writeFile(
        path.join(root, DOCS, 'SUBSYSTEMS.md'),
        `# Subsystems\n\n`,
        'utf8',
      );
      expect(await stageNamed('architecture')(root, DOCS)).toBe(false);
    });
  });

  it('returns false for untouched init scaffold SUBSYSTEMS.md output with auto-generated sheet symbol bullets', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      // Exact scaffold output generated by generateDocs() in src/memory/scaffold.ts
      await writeFile(
        path.join(root, DOCS, 'SUBSYSTEMS.md'),
        `# Subsystems\n\nPer-sheet values and reasoning (regulator, charger, RF, ...).\n\n## Sheet hardware\n\n- R1: 10k\n- U1: ESP32\n`,
        'utf8',
      );
      expect(await stageNamed('architecture')(root, DOCS)).toBe(false);
    });
  });

  it('returns false for untouched init scaffold SUBSYSTEMS.md output with unannotated symbol bullets (- U?: / - ?:)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SUBSYSTEMS.md'),
        `# Subsystems\n\nPer-sheet values and reasoning (regulator, charger, RF, ...).\n\n## Sheet hardware\n\n- U?: ESP32\n- ?: 10k\n- R?: 100n\n`,
        'utf8',
      );
      expect(await stageNamed('architecture')(root, DOCS)).toBe(false);
    });
  });

  it('returns true when SUBSYSTEMS.md has at least one section with prose content', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SUBSYSTEMS.md'),
        `# Subsystems\n\n## Power\n\nLDO regulator, 3.3 V output, 300 mA max. Chosen for low quiescent current.\n\n## MCU\n\nESP32-S3 in MINI-1 module for BLE + Wi-Fi.\n`,
        'utf8',
      );
      expect(await stageNamed('architecture')(root, DOCS)).toBe(true);
    });
  });

  it('returns true when SUBSYSTEMS.md has bullet-styled subsystem reasoning lines', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SUBSYSTEMS.md'),
        `# Subsystems\n\n## Power\n\n- Regulator: AP2112, 3.3V/600mA, chosen for low quiescent current\n- Battery: single-cell LiPo, protection via BQ24075\n`,
        'utf8',
      );
      expect(await stageNamed('architecture')(root, DOCS)).toBe(true);
    });
  });

  it('returns true when SUBSYSTEMS.md has voltage-led bullet reasoning lines (- 5V: / - 12V:)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'SUBSYSTEMS.md'),
        `# Subsystems\n\n## Power\n\n- 5V: regulated rail from AP2112 LDO\n- 12V: input rail, fused\n`,
        'utf8',
      );
      expect(await stageNamed('architecture')(root, DOCS)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 3: part-selection
// ---------------------------------------------------------------------------
describe('part-selection isComplete', () => {
  it('returns false when BOM.md does not exist', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      expect(await stageNamed('part-selection')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when BOM.md has no table rows', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(path.join(root, DOCS, 'BOM.md'), '# Bill of Materials\n\nEmpty.\n', 'utf8');
      expect(await stageNamed('part-selection')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when all BOM rows have UNVERIFIED MPNs (init scaffold)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      // Exact scaffold output from bomTable() in scaffold.ts
      await writeFile(
        path.join(root, DOCS, 'BOM.md'),
        `# Bill of Materials\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | R_0603 | UNVERIFIED | extracted from schematic by copperhead init |\n| U1 | ESP32 | ESP32-S3-MINI-1 | UNVERIFIED | extracted from schematic by copperhead init |\n`,
        'utf8',
      );
      expect(await stageNamed('part-selection')(root, DOCS)).toBe(false);
    });
  });

  it('returns true when at least one BOM row has a real (non-UNVERIFIED) MPN', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'BOM.md'),
        `# Bill of Materials\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL | standard 1% bias |\n| U1 | ESP32 | RF_Module:ESP32-S3-WROOM-1 | ESP32-S3-WROOM-1-N8 | BLE + Wi-Fi module |\n`,
        'utf8',
      );
      expect(await stageNamed('part-selection')(root, DOCS)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 6: outputs
// ---------------------------------------------------------------------------
describe('outputs isComplete', () => {
  it('returns false when outputs/ does not exist', async () => {
    await withTmpDir(async (root) => {
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when outputs/ exists but is empty (failed export run)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when outputs/ contains only non-Gerber files', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await writeFile(path.join(root, 'outputs', 'BOM.csv'), 'ref,mpn\nR1,RC0603\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when outputs/ contains only a .drl drill file (no Gerbers)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await writeFile(path.join(root, 'outputs', 'board.drl'), 'M48\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(false);
    });
  });

  it('returns true when outputs/ contains at least one Gerber file (.gbr)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await writeFile(path.join(root, 'outputs', 'board-F_Cu.gbr'), 'G04 Gerber*\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(true);
    });
  });

  it('returns true when outputs/ contains a .gtl (top copper) Gerber', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'outputs'), { recursive: true });
      await writeFile(path.join(root, 'outputs', 'board.gtl'), 'G04*\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(true);
    });
  });

  it('returns true when Gerber file is located in a nested subdirectory inside outputs/', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'outputs', 'gerbers'), { recursive: true });
      await writeFile(path.join(root, 'outputs', 'gerbers', 'board-F_Cu.gbr'), 'G04 Gerber*\n', 'utf8');
      expect(await stageNamed('outputs')(root, DOCS)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 7: firmware
// ---------------------------------------------------------------------------
describe('firmware isComplete', () => {
  it('returns false when firmware/ does not exist', async () => {
    await withTmpDir(async (root) => {
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when firmware/ exists but is empty', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'firmware'), { recursive: true });
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns true when firmware/ contains a .h file (pins.h)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'firmware'), { recursive: true });
      await writeFile(path.join(root, 'firmware', 'pins.h'), '#pragma once\n#define PIN_LED 2\n', 'utf8');
      expect(await stageNamed('firmware')(root, DOCS)).toBe(true);
    });
  });

  it('returns true when firmware/ contains a .py file (MicroPython)', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, 'firmware'), { recursive: true });
      await writeFile(path.join(root, 'firmware', 'main.py'), 'import machine\n', 'utf8');
      expect(await stageNamed('firmware')(root, DOCS)).toBe(true);
    });
  });
});

// A board with no programmable part completes stage 7 on a "# No firmware"
// README, and only when the schematic shows it (#377).
describe('firmware isComplete: no programmable part', () => {
  const NO_FW = '# No firmware\n\nThis board has no MCU: docs/SPEC.md and docs/SUBSYSTEMS.md record it as deliberate.\n';

  /** A project whose schematic places one symbol per lib_id. */
  async function project(root: string, libIds: string[]): Promise<void> {
    await mkdir(path.join(root, '.copperhead'), { recursive: true });
    await writeFile(path.join(root, '.copperhead', 'config.json'), JSON.stringify({ schematic: 'board.kicad_sch', docs: DOCS }), 'utf8');
    const symbols = libIds
      .map((id, i) => `  (symbol (lib_id "${id}") (at ${i * 10} 0 0) (unit 1) (uuid "u${i}")\n    (property "Reference" "X${i + 1}" (at 0 0 0))\n    (property "Value" "v" (at 0 0 0)))`)
      .join('\n');
    await writeFile(path.join(root, 'board.kicad_sch'), `(kicad_sch (version 20231120) (generator "test")\n  (lib_symbols)\n${symbols}\n)\n`, 'utf8');
  }

  async function readme(root: string, text: string): Promise<void> {
    await mkdir(path.join(root, 'firmware'), { recursive: true });
    await writeFile(path.join(root, 'firmware', 'README.md'), text, 'utf8');
  }

  const firmwarePrompt = (): string => STAGES.find((x) => x.name === 'firmware')!.prompt('brief', 'docs/');

  const PASSIVE = ['Device:R', 'Device:R', 'Device:Polyfuse', 'Device:LED', 'Connector:USB_C_Receptacle_PowerOnly_6P', 'Connector_Generic:Conn_02x02_Odd_Even', 'Mechanical:MountingHole', 'power:GND'];

  it('returns true for a passive board with a "# No firmware" README', async () => {
    await withTmpDir(async (root) => {
      await project(root, PASSIVE);
      await readme(root, NO_FW);
      expect(await stageNamed('firmware')(root, DOCS)).toBe(true);
    });
  });

  it('accepts CRLF and a leading blank line', async () => {
    await withTmpDir(async (root) => {
      await project(root, PASSIVE);
      await readme(root, `\r\n${NO_FW.replace(/\n/g, '\r\n')}`);
      expect(await stageNamed('firmware')(root, DOCS)).toBe(true);
    });
  });

  it('returns false for a passive board without the README', async () => {
    await withTmpDir(async (root) => {
      await project(root, PASSIVE);
      await mkdir(path.join(root, 'firmware'), { recursive: true });
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when the README states no reason', async () => {
    await withTmpDir(async (root) => {
      await project(root, PASSIVE);
      await readme(root, '# No firmware\n\n<!-- why -->\n');
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when the README does not begin with "# No firmware"', async () => {
    await withTmpDir(async (root) => {
      await project(root, PASSIVE);
      await readme(root, '# Firmware\n\nNo firmware here: no MCU.\n');
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when a stock MCU is on the schematic', async () => {
    await withTmpDir(async (root) => {
      await project(root, [...PASSIVE, 'MCU_Microchip_ATtiny:ATtiny85-20S']);
      await readme(root, NO_FW);
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when a part comes from a project library, so an unknown part never waives firmware', async () => {
    await withTmpDir(async (root) => {
      await project(root, [...PASSIVE, 'fixture:ESP32-S3-MINI']);
      await readme(root, NO_FW);
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns false with no schematic to read', async () => {
    await withTmpDir(async (root) => {
      await readme(root, NO_FW);
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when the schematic has no parts', async () => {
    await withTmpDir(async (root) => {
      await project(root, ['power:GND']);
      await readme(root, NO_FW);
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  // Stock analog libraries hold nothing programmable either (#409 review).
  it.each([
    'Amplifier_Operational:LM358',
    'Amplifier_Instrumentation:INA128',
    'Comparator:LM393',
    'Reference_Voltage:LM4040DBZ-2.5',
    'Relay:G5LE-1',
    'Timer:TLC555xD',
  ])('returns true for an analog board with %s and a "# No firmware" README', async (libId) => {
    await withTmpDir(async (root) => {
      await project(root, [...PASSIVE, libId]);
      await readme(root, NO_FW);
      expect(await stageNamed('firmware')(root, DOCS)).toBe(true);
    });
    // the stage-7 prompt names every library the gate accepts, so the model knows the waiver applies
    expect(firmwarePrompt()).toContain(libId.split(':')[0]);
  });

  it('the stage-7 prompt tells the model how to write the waiver', () => {
    expect(firmwarePrompt()).toContain('# No firmware');
  });

  it('returns false for a real-time clock, which Timer does not cover', async () => {
    await withTmpDir(async (root) => {
      await project(root, [...PASSIVE, 'Timer_RTC:DS3231M']);
      await readme(root, NO_FW);
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when config.json names a schematic file that does not exist', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, '.copperhead'), { recursive: true });
      await writeFile(path.join(root, '.copperhead', 'config.json'), JSON.stringify({ schematic: 'missing.kicad_sch', docs: DOCS }), 'utf8');
      await readme(root, NO_FW);
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when the root sheet points to a missing sub-sheet, which may hold the MCU', async () => {
    await withTmpDir(async (root) => {
      await project(root, PASSIVE);
      const sch = path.join(root, 'board.kicad_sch');
      await writeFile(
        sch,
        (await readFile(sch, 'utf8')).replace(
          /\)\n$/,
          '  (sheet (at 0 0) (size 10 10) (uuid "s1")\n    (property "Sheetname" "mcu" (at 0 0 0))\n    (property "Sheetfile" "mcu.kicad_sch" (at 0 0 0)))\n)\n',
        ),
        'utf8',
      );
      await readme(root, NO_FW);
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns false for an empty or whitespace-only README', async () => {
    await withTmpDir(async (root) => {
      await project(root, PASSIVE);
      await readme(root, '');
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
      await readme(root, '  \n\t\n');
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when the only thing below the heading is a multi-line HTML comment', async () => {
    await withTmpDir(async (root) => {
      await project(root, PASSIVE);
      await readme(root, '# No firmware\n\n<!--\nwhy goes here\n-->\n');
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when the only thing below the heading is an unclosed HTML comment', async () => {
    await withTmpDir(async (root) => {
      await project(root, PASSIVE);
      await readme(root, '# No firmware\n\n<!-- TODO: why');
      expect(await stageNamed('firmware')(root, DOCS)).toBe(false);
    });
  });

  it('ignores an HTML comment above the heading', async () => {
    await withTmpDir(async (root) => {
      await project(root, PASSIVE);
      await readme(root, `<!-- generated by stage 7 -->\n${NO_FW}`);
      expect(await stageNamed('firmware')(root, DOCS)).toBe(true);
    });
  });

  it('the failure detail names each part outside the waiver list', async () => {
    await withTmpDir(async (root) => {
      await project(root, [...PASSIVE, 'fixture:ESP32-S3-MINI']);
      await readme(root, NO_FW);
      const detail = await contractGapDetail('firmware', root, await loadConfig(root));
      expect(detail).toContain('fixture:ESP32-S3-MINI');
      expect(detail).toContain('outside the waiver list');
      expect(detail).not.toContain('Device:R');
    });
  });

  it('the failure detail says when no schematic with parts could be read', async () => {
    await withTmpDir(async (root) => {
      await readme(root, NO_FW);
      const detail = await contractGapDetail('firmware', root, await loadConfig(root));
      expect(detail).toContain('no schematic with parts could be read');
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 8: devplan
// ---------------------------------------------------------------------------
describe('devplan isComplete', () => {
  it('returns false when DEVPLAN.md does not exist', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      expect(await stageNamed('devplan')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when DEVPLAN.md exists but is blank', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(path.join(root, DOCS, 'DEVPLAN.md'), '', 'utf8');
      expect(await stageNamed('devplan')(root, DOCS)).toBe(false);
    });
  });

  it('returns false when DEVPLAN.md has only headings and no prose', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'DEVPLAN.md'),
        `# Development Plan\n\n## Bring-up steps\n\n## Test points\n`,
        'utf8',
      );
      expect(await stageNamed('devplan')(root, DOCS)).toBe(false);
    });
  });

  it('returns true when DEVPLAN.md has at least one section with content', async () => {
    await withTmpDir(async (root) => {
      await mkdir(path.join(root, DOCS), { recursive: true });
      await writeFile(
        path.join(root, DOCS, 'DEVPLAN.md'),
        `# Development Plan\n\n## Bring-up steps\n\n1. Power on — measure 3.3 V rail.\n2. Flash firmware via USB-C.\n\n## Test points\n\nTP1: 3.3 V rail. TP2: GND.\n`,
        'utf8',
      );
      expect(await stageNamed('devplan')(root, DOCS)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Stage 4: schematic — legibility joins the contract (AC-16.22)
// ---------------------------------------------------------------------------
describe('schematic isComplete: legibility gate', () => {
  it('error-severity findings keep the stage active; a clean sheet completes', async () => {
    const { tempFixtureRepo } = await import('./helpers.js');
    const { runInit } = await import('../src/memory/scaffold.js');
    const { readFile, writeFile: wf } = await import('node:fs/promises');
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo });
      // the fixture's caption must name a documented subsystem
      const subsPath = path.join(repo, 'docs', 'SUBSYSTEMS.md');
      await wf(subsPath, (await readFile(subsPath, 'utf8')) + '\n## Keyer\n\nKey input block.\n', 'utf8');
      const isComplete = stageNamed('schematic');
      expect(await isComplete(repo, DOCS)).toBe(true);

      // strip the group box: every symbol becomes ungrouped (error severity),
      // while symbols, drift, and ERC stay green — only legibility blocks now
      const schPath = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const sch = await readFile(schPath, 'utf8');
      const stripped = sch.replace(/  \(rectangle \(start 76 84\)[\s\S]*?\n  \)\n/, '');
      expect(stripped).not.toBe(sch);
      await wf(schPath, stripped, 'utf8');
      expect(await isComplete(repo, DOCS)).toBe(false);
    } finally {
      await cleanup();
    }
  }, 60000);
});
