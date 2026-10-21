import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkFirmwareDrift,
  extractSchematicPinout,
  formatFirmwareCheckResult,
  parseFirmwareHeaderC,
  parseFirmwareTarget,
  renderFirmwareHeaderC,
  runExportFirmware,
} from '../src/kicad/firmware.js';

const MCU_SCHEMATIC = `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (lib_symbols
    (symbol "MCU:STM32"
      (symbol "STM32_1_1"
        (pin bidirectional line (at -10.16 2.54 0) (length 2.54)
          (name "PA5" (effects (font (size 1.27 1.27))))
          (number "15" (effects (font (size 1.27 1.27))))
        )
        (pin bidirectional line (at -10.16 0 0) (length 2.54)
          (name "PA9/USART1_TX" (effects (font (size 1.27 1.27))))
          (number "30" (effects (font (size 1.27 1.27))))
        )
        (pin bidirectional line (at -10.16 -2.54 0) (length 2.54)
          (name "PA10" (effects (font (size 1.27 1.27))))
          (number "31" (effects (font (size 1.27 1.27))))
        )
        (pin power_in line (at -10.16 -5.08 0) (length 2.54)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "32" (effects (font (size 1.27 1.27))))
        )
      )
    )
  )
  (symbol (lib_id "MCU:STM32") (at 100 100 0) (unit 1)
    (uuid "u1-uuid")
    (property "Reference" "U1" (at 100 90 0))
    (property "Value" "STM32F4" (at 100 92 0))
    (property "Footprint" "Package_QFP:LQFP-48" (at 100 94 0))
  )
  (label "LED_STATUS" (at 89.84 97.46 0))
  (label "UART_TX" (at 89.84 100 0))
  (label "UART_RX" (at 89.84 102.54 0))
  (label "GND" (at 89.84 105.08 0))
)`;

async function setupProject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-fw-'));
  await mkdir(path.join(dir, '.copperhead'), { recursive: true });
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await writeFile(
    path.join(dir, '.copperhead', 'config.json'),
    JSON.stringify({ schematic: 'board.kicad_sch', docs: 'docs/' }, null, 2),
    'utf8',
  );
  await writeFile(path.join(dir, 'board.kicad_sch'), MCU_SCHEMATIC, 'utf8');
  return dir;
}

describe('copperhead export firmware and check --firmware (#263)', () => {
  it('validates --target and rejects unsupported languages', () => {
    expect(parseFirmwareTarget('c')).toBe('c');
    expect(() => parseFirmwareTarget('rust')).toThrow(/unknown firmware target "rust"/);
  });

  it('extracts MCU signal pin assignments and excludes power rails', async () => {
    const dir = await setupProject();
    try {
      const pins = await extractSchematicPinout(dir);
      expect(pins).toEqual([
        { macro: 'PIN_LED_STATUS', signal: 'LED_STATUS', pin: 'PA5', ref: 'U1', pinNumber: '15' },
        { macro: 'PIN_UART_RX', signal: 'UART_RX', pin: 'PA10', ref: 'U1', pinNumber: '31' },
        { macro: 'PIN_UART_TX', signal: 'UART_TX', pin: 'PA9', ref: 'U1', pinNumber: '30' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exports a deterministic C header and passes check --firmware when in sync', async () => {
    const dir = await setupProject();
    try {
      const exported = await runExportFirmware({ repoRoot: dir, target: 'c', outPath: 'firmware/inc/pinout.h' });
      expect(exported.outPath).toBe('firmware/inc/pinout.h');
      const disk = await readFile(path.join(dir, 'firmware/inc/pinout.h'), 'utf8');
      expect(disk).toContain('// Auto-generated from schematic. Do not edit manually.');
      expect(disk).toContain('#define PIN_LED_STATUS   PA5');
      expect(disk).toContain('#define PIN_UART_TX      PA9');
      expect(disk).toContain('#define PIN_UART_RX      PA10');

      const check = await checkFirmwareDrift(dir);
      expect(check.ok).toBe(true);
      expect(check.pinsChecked).toBe(3);
      expect(formatFirmwareCheckResult(check)).toBe('✓ Firmware pinout in sync (3 pins checked)');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('detects pin reassignment drift between schematic and firmware header', async () => {
    const dir = await setupProject();
    try {
      await runExportFirmware({ repoRoot: dir });
      const hdrPath = path.join(dir, 'firmware/inc/pinout.h');
      const drifted = (await readFile(hdrPath, 'utf8')).replace('#define PIN_LED_STATUS   PA5', '#define PIN_LED_STATUS   PA6');
      await writeFile(hdrPath, drifted, 'utf8');

      const check = await checkFirmwareDrift(dir);
      expect(check.ok).toBe(false);
      expect(check.mismatches).toEqual([
        { macro: 'PIN_LED_STATUS', schematicPin: 'PA5', headerPin: 'PA6' },
      ]);
      const formatted = formatFirmwareCheckResult(check);
      expect(formatted).toContain('✗ Firmware drift detected');
      expect(formatted).toContain('PIN_LED_STATUS: schematic=PA5, firmware/inc/pinout.h=PA6');
      expect(formatted).toContain('1 mismatch found. Run `copperhead export firmware` to resync.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses C header #define PIN_* macros and ignores comments', () => {
    const parsed = parseFirmwareHeaderC(
      renderFirmwareHeaderC([
        { macro: 'PIN_LED_STATUS', signal: 'LED_STATUS', pin: 'PA5', ref: 'U1', pinNumber: '15' },
      ]) + '// #define PIN_FAKE PA0\n',
    );
    expect(parsed.get('PIN_LED_STATUS')).toBe('PA5');
    expect(parsed.has('PIN_FAKE')).toBe(false);
  });
});
