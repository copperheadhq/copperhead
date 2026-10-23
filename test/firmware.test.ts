import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import {
  checkFirmwareDrift,
  ExportError,
  extractSchematicPinout,
  formatFirmwareCheckResult,
  normalizePinToken,
  parseFirmwareHeaderC,
  parseFirmwareTarget,
  renderFirmwareHeaderC,
  runExportFirmware,
} from '../src/kicad/firmware.js';
import * as kicadCli from '../src/kicad/cli.js';
import { runCheck } from '../src/commands/check.js';
import { syncVerify } from '../src/commands/sync.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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
          (name "MTCK/GPIO39/CLK_OUT3" (effects (font (size 1.27 1.27))))
          (number "31" (effects (font (size 1.27 1.27))))
        )
        (pin bidirectional line (at -10.16 -5.08 0) (length 2.54)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "32" (effects (font (size 1.27 1.27))))
        )
        (pin power_in line (at -10.16 -7.62 0) (length 2.54)
          (name "VDD" (effects (font (size 1.27 1.27))))
          (number "33" (effects (font (size 1.27 1.27))))
        )
      )
    )
    (symbol "Regulator_Linear:AP2112"
      (symbol "AP2112_1_1"
        (pin input line (at -10.16 0 0) (length 2.54)
          (name "EN" (effects (font (size 1.27 1.27))))
          (number "3" (effects (font (size 1.27 1.27))))
        )
      )
    )
  )
  (symbol (lib_id "Regulator_Linear:AP2112") (at 50 50 0) (unit 1)
    (uuid "u0-uuid")
    (property "Reference" "U1" (at 50 40 0))
    (property "Value" "AP2112K-3.3" (at 50 42 0))
    (property "Footprint" "Package_TO_SOT_SMD:SOT-23-5" (at 50 44 0))
  )
  (label "VREG_EN" (at 39.84 50 0))
  (symbol (lib_id "MCU:STM32") (at 100 100 0) (unit 1)
    (uuid "u2-uuid")
    (property "Reference" "U2" (at 100 90 0))
    (property "Value" "STM32F4" (at 100 92 0))
    (property "Footprint" "Package_QFP:LQFP-48" (at 100 94 0))
  )
  (label "LED_STATUS" (at 89.84 97.46 0))
  (label "UART_TX" (at 89.84 100 0))
  (label "UART_RX" (at 89.84 102.54 0))
  (label "SPI_CS" (at 89.84 105.08 0))
  (label "VCC_3V3" (at 89.84 107.62 0))
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
  await writeFile(
    path.join(dir, 'docs', 'PINOUT.md'),
    '# Pinout\n\n| Refdes | Pin | Name | Net | Notes |\n| --- | --- | --- | --- | --- |\n| U2 | 32 | PA4 | SPI_CS | chip select |\n',
    'utf8',
  );
  return dir;
}

describe('copperhead export firmware and check --firmware (#263)', () => {
  it('validates --target and rejects unsupported languages', () => {
    expect(parseFirmwareTarget('c')).toBe('c');
    expect(() => parseFirmwareTarget('rust')).toThrow(/unknown firmware target "rust"/);
    expect(() => parseFirmwareTarget('all')).toThrow(/unknown firmware target "all"/);
  });

  it('extracts GPIO tokens from multi-function pin names and active-low pins', () => {
    expect(normalizePinToken('MTCK/GPIO39/CLK_OUT3')).toBe('GPIO39');
    expect(normalizePinToken('ADC1/PA0')).toBe('PA0');
    expect(normalizePinToken('PA9/USART1_TX')).toBe('PA9');
    expect(normalizePinToken('~{RESET}')).toBe('RESET');
  });

  it('extracts MCU signal pin assignments, uses PINOUT.md Name column fallback, excludes regulators and power rails', async () => {
    const dir = await setupProject();
    try {
      const pins = await extractSchematicPinout(dir);
      expect(pins).toEqual([
        { macro: 'PIN_LED_STATUS', signal: 'LED_STATUS', pin: 'PA5', ref: 'U2', pinNumber: '15' },
        { macro: 'PIN_SPI_CS', signal: 'SPI_CS', pin: 'PA4', ref: 'U2', pinNumber: '32' },
        { macro: 'PIN_UART_RX', signal: 'UART_RX', pin: 'GPIO39', ref: 'U2', pinNumber: '31' },
        { macro: 'PIN_UART_TX', signal: 'UART_TX', pin: 'PA9', ref: 'U2', pinNumber: '30' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a regulator-only board when --ref is omitted, and exports when --ref is explicitly given', async () => {
    const dir = await setupProject();
    try {
      const regOnly = `(kicad_sch
        (version 20231120)
        (generator "eeschema")
        (lib_symbols
          (symbol "Regulator_Linear:AP2112"
            (symbol "AP2112_1_1"
              (pin input line (at -10.16 0 0) (length 2.54) (name "EN") (number "3"))
              (pin power_in line (at -10.16 -2.54 0) (length 2.54) (name "VIN") (number "1"))
            )
          )
        )
        (symbol (lib_id "Regulator_Linear:AP2112") (at 50 50 0) (unit 1)
          (uuid "u1")
          (property "Reference" "U1" (at 50 40 0))
          (property "Value" "AP2112K-3.3" (at 50 42 0))
        )
        (label "REG_ENABLE" (at 39.84 50 0))
        (label "VIN" (at 39.84 52.54 0))
      )`;
      await writeFile(path.join(dir, 'board.kicad_sch'), regOnly, 'utf8');
      await expect(runExportFirmware({ repoRoot: dir })).rejects.toThrow(/no MCU found; pass --ref/);
      await expect(runExportFirmware({ repoRoot: dir, ref: 'U99' })).rejects.toThrow(/no symbol "U99"/);

      const explicit = await runExportFirmware({ repoRoot: dir, ref: 'U1' });
      expect(explicit.pins).toEqual([
        { macro: 'PIN_REG_ENABLE', signal: 'REG_ENABLE', pin: 'EN', ref: 'U1', pinNumber: '3' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves VBUS_DET, VBAT_SENSE, VCC_EN, and 5V_EN while excluding AVCC, VIN, 3.3V, and power-symbol nets', async () => {
    const dir = await setupProject();
    try {
      const sch = `(kicad_sch
        (version 20231120)
        (generator "eeschema")
        (lib_symbols
          (symbol "power:+3.3VA"
            (power)
            (symbol "+3.3VA_1_1"
              (pin power_in line (at 0 0 90) (length 0) (name "+3.3VA") (number "1"))
            )
          )
          (symbol "MCU:STM32"
            (symbol "STM32_1_1"
              (pin bidirectional line (at -10.16 5.08 0) (length 2.54) (name "PA9") (number "1"))
              (pin bidirectional line (at -10.16 2.54 0) (length 2.54) (name "GPIO39") (number "2"))
              (pin bidirectional line (at -10.16 0 0) (length 2.54) (name "PB0") (number "3"))
              (pin bidirectional line (at -10.16 -2.54 0) (length 2.54) (name "PB1") (number "4"))
              (pin passive line (at -10.16 -5.08 0) (length 2.54) (name "VDDA_PIN") (number "5"))
              (pin passive line (at -10.16 -7.62 0) (length 2.54) (name "EXT_SUP") (number "6"))
              (pin passive line (at -10.16 -10.16 0) (length 2.54) (name "RAIL_PIN") (number "7"))
              (pin passive line (at -10.16 -12.7 0) (length 2.54) (name "ANALOG_SUP") (number "8"))
            )
          )
        )
        (symbol (lib_id "MCU:STM32") (at 100 100 0) (unit 1)
          (uuid "u2")
          (property "Reference" "U2" (at 100 90 0))
          (property "Value" "STM32G0" (at 100 92 0))
        )
        (symbol (lib_id "power:+3.3VA") (at 89.84 112.7 0) (unit 1)
          (uuid "pwr1")
          (property "Reference" "#PWR01" (at 89.84 112.7 0))
          (property "Value" "+3.3VA" (at 89.84 112.7 0))
        )
        (label "VBUS_DET" (at 89.84 94.92 0))
        (label "VBAT_SENSE" (at 89.84 97.46 0))
        (label "VCC_EN" (at 89.84 100 0))
        (label "5V_EN" (at 89.84 102.54 0))
        (label "AVCC" (at 89.84 105.08 0))
        (label "VIN" (at 89.84 107.62 0))
        (label "3.3V" (at 89.84 110.16 0))
        (label "CUSTOM_RAIL_FROM_PWR_SYM" (at 89.84 112.7 0))
      )`;
      await writeFile(path.join(dir, 'board.kicad_sch'), sch, 'utf8');
      const pins = await extractSchematicPinout(dir);
      expect(pins.map((p) => p.macro)).toEqual([
        'PIN_5V_EN',
        'PIN_VBAT_SENSE',
        'PIN_VBUS_DET',
        'PIN_VCC_EN',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exports a deterministic C header, passes check --firmware, and does not trigger sync pins-h on lowercase nets', async () => {
    const dir = await setupProject();
    try {
      const lowerSch = MCU_SCHEMATIC.replace('(label "LED_STATUS"', '(label "led_status"');
      await writeFile(path.join(dir, 'board.kicad_sch'), lowerSch, 'utf8');
      await writeFile(
        path.join(dir, 'docs', 'PINOUT.md'),
        '# Pinout\n\n| Refdes | Pin | Name | Net | Notes |\n| --- | --- | --- | --- | --- |\n| U2 | 15 | PA5 | led_status | status LED |\n| U2 | 32 | PA4 | SPI_CS | chip select |\n',
        'utf8',
      );

      const exported = await runExportFirmware({ repoRoot: dir });
      expect(exported.outPath).toBe('firmware/inc/pinout.h');
      const check = await checkFirmwareDrift(dir);
      expect(check.ok).toBe(true);
      expect(check.pinsChecked).toBe(4);
      expect(formatFirmwareCheckResult(check)).toBe('✓ Firmware pinout in sync (4 pins checked)');

      const syncRep = await syncVerify(dir);
      expect(syncRep.resolvable.filter((i) => i.doc === 'firmware/inc/pinout.h')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('supports explicit custom header paths and names --out in the resync hint without silently falling back to firmware/src/pins.h', async () => {
    const dir = await setupProject();
    try {
      await runExportFirmware({ repoRoot: dir, outPath: 'firmware/src/pins.h' });
      // Default check looks at firmware/inc/pinout.h only, never silently falling back to pins.h
      const defaultCheck = await checkFirmwareDrift(dir);
      expect(defaultCheck.ok).toBe(false);
      expect(defaultCheck.headerPath).toBe('firmware/inc/pinout.h');

      // Explicit custom header check passes and prints matching --out advice when drifted
      const customOk = await checkFirmwareDrift(dir, { headerPath: 'firmware/src/pins.h' });
      expect(customOk.ok).toBe(true);

      await writeFile(path.join(dir, 'firmware/src/pins.h'), '#define PIN_LED_STATUS PA0\n', 'utf8');
      const customDrifted = await checkFirmwareDrift(dir, { headerPath: 'firmware/src/pins.h' });
      expect(customDrifted.ok).toBe(false);
      expect(formatFirmwareCheckResult(customDrifted)).toContain(
        'Run `copperhead export firmware --out firmware/src/pins.h` to resync.',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('covers missing schematic, macro collisions, named-pin preference on shared nets, missing empty header sentinel, CLI --json, and runCheck integration', async () => {
    const dir = await setupProject();
    try {
      // Collision + named-pin preference
      const collSch = `(kicad_sch
        (version 20231120)
        (generator "eeschema")
        (lib_symbols
          (symbol "MCU:STM32"
            (symbol "STM32_1_1"
              (pin bidirectional line (at -10.16 2.54 0) (length 2.54) (name "~") (number "1"))
              (pin bidirectional line (at -10.16 0 0) (length 2.54) (name "PA2") (number "2"))
              (pin bidirectional line (at -10.16 -2.54 0) (length 2.54) (name "PA3") (number "3"))
            )
          )
        )
        (symbol (lib_id "MCU:STM32") (at 100 100 0) (unit 1)
          (uuid "u2")
          (property "Reference" "U2" (at 100 90 0))
          (property "Value" "STM32F4" (at 100 92 0))
        )
        (label "SHARED_SIG" (at 89.84 97.46 0))
        (label "SHARED_SIG" (at 89.84 100 0))
      )`;
      await writeFile(path.join(dir, 'board.kicad_sch'), collSch, 'utf8');
      await writeFile(path.join(dir, 'docs', 'PINOUT.md'), '# Pinout\n', 'utf8');
      const shared = await extractSchematicPinout(dir);
      expect(shared).toEqual([
        { macro: 'PIN_SHARED_SIG', signal: 'SHARED_SIG', pin: 'PA2', ref: 'U2', pinNumber: '2' },
      ]);

      const collidingSch = collSch.replace(
        '(label "SHARED_SIG" (at 89.84 100 0))',
        '(label "SHARED-SIG" (at 89.84 100 0))\n        (label "BUS_A" (at 89.84 102.54 0))',
      );
      await writeFile(path.join(dir, 'board.kicad_sch'), collidingSch, 'utf8');
      await expect(extractSchematicPinout(dir)).rejects.toThrow(/macro collision/);

      // Unconnected MCU (0 signal pins) with missing header emits 'present' sentinel
      const zeroSignalSch = `(kicad_sch
        (version 20231120)
        (generator "eeschema")
        (lib_symbols
          (symbol "MCU:STM32"
            (symbol "STM32_1_1"
              (pin bidirectional line (at -10.16 0 0) (length 2.54) (name "PA0") (number "1"))
            )
          )
        )
        (symbol (lib_id "MCU:STM32") (at 100 100 0) (unit 1)
          (uuid "u2")
          (property "Reference" "U2" (at 100 90 0))
          (property "Value" "STM32F4" (at 100 92 0))
        )
      )`;
      await writeFile(path.join(dir, 'board.kicad_sch'), zeroSignalSch, 'utf8');
      const missingHdr = await checkFirmwareDrift(dir);
      expect(missingHdr.ok).toBe(false);
      expect(missingHdr.mismatches).toEqual([
        { macro: 'firmware/inc/pinout.h', schematicPin: 'present', headerPin: null },
      ]);
      expect(formatFirmwareCheckResult(missingHdr)).toContain('schematic=present, firmware/inc/pinout.h=absent');

      // CLI `export firmware --json`
      await writeFile(path.join(dir, 'board.kicad_sch'), MCU_SCHEMATIC, 'utf8');
      const cliOut = await execa(
        'npx',
        ['tsx', 'src/cli.ts', '--repo', dir, '--json', 'export', 'firmware'],
        { cwd: ROOT, reject: false, env: { NO_COLOR: '1' } },
      );
      expect(cliOut.exitCode).toBe(0);
      const parsedCli = JSON.parse(cliOut.stdout) as { outPath: string; pins: unknown[] };
      expect(parsedCli.outPath).toBe('firmware/inc/pinout.h');
      expect(parsedCli.pins.length).toBe(4);

      // runCheck integration when only firmware header is drifted
      await writeFile(path.join(dir, 'firmware/inc/pinout.h'), '#define PIN_LED_STATUS PA9\n', 'utf8');
      const ercSpy = vi.spyOn(kicadCli, 'runErc').mockResolvedValue({
        kind: 'erc',
        ok: true,
        violations: [],
        rawPath: '',
      });
      try {
        const res = await runCheck(dir, () => {}, { firmware: true });
        expect(res.ok).toBe(false);
        expect(res.firmware?.ok).toBe(false);
      } finally {
        ercSpy.mockRestore();
      }

      // Missing / unconfigured schematic errors
      await rm(path.join(dir, 'board.kicad_sch'));
      await expect(extractSchematicPinout(dir)).rejects.toThrow(ExportError);
      await writeFile(path.join(dir, '.copperhead', 'config.json'), JSON.stringify({ docs: 'docs/' }), 'utf8');
      await expect(extractSchematicPinout(dir)).rejects.toThrow(/no schematic configured/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('rejects paths escaping the repository sandbox (AC-4.2)', async () => {
    const dir = await setupProject();
    try {
      await expect(
        runExportFirmware({ repoRoot: dir, outPath: '../../outside.h' }),
      ).rejects.toThrow(/escapes repository/);
      await expect(
        checkFirmwareDrift(dir, { headerPath: '/etc/passwd' }),
      ).rejects.toThrow(/escapes repository/);
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

  it('parses C header #define PIN_* macros and ignores both // and /* ... */ comments', () => {
    const parsed = parseFirmwareHeaderC(
      renderFirmwareHeaderC([
        { macro: 'PIN_LED_STATUS', signal: 'LED_STATUS', pin: 'PA5', ref: 'U2', pinNumber: '15' },
      ]) +
        '// #define PIN_FAKE PA0\n' +
        '/*\n#define PIN_BLOCK_COMMENTED PA1\n*/\n' +
        '#define PIN_INLINE_COMMENT PA2 /* inline comment */\n',
    );
    expect(parsed.get('PIN_LED_STATUS')).toBe('PA5');
    expect(parsed.get('PIN_INLINE_COMMENT')).toBe('PA2');
    expect(parsed.has('PIN_FAKE')).toBe(false);
    expect(parsed.has('PIN_BLOCK_COMMENTED')).toBe(false);
  });
});
