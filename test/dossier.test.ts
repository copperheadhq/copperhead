import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveLibrarySymbol } from '../src/kicad/symlib.js';
import { bomSymbolDossier } from '../src/kicad/dossier.js';
import { dispatchTool, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';

// Fixture stand-ins for the installed libraries: a passive with a derived
// symbol, a single-unit and a multi-unit gate (the SN74LVC2G17 trap from the
// lemondrop run), and a codec resolvable by MPN.
const DEVICE_LIB = `(kicad_symbol_lib (version 20251024) (generator test)
  (symbol "R" (pin_numbers hide) (pin_names (offset 0))
    (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54)))
    (symbol "R_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
    )
  )
  (symbol "R_Small" (extends "R"))
)`;

const LOGIC_LIB = `(kicad_symbol_lib (version 20251024) (generator test)
  (symbol "SN74LVC1G17" (pin_names (offset 1.016))
    (symbol "SN74LVC1G17_1_1"
      (pin input line (at -7.62 0 0) (length 2.54) (name "A") (number "2"))
      (pin output line (at 7.62 0 180) (length 2.54) (name "Y") (number "4"))
      (pin power_in line (at 0 7.62 270) (length 2.54) (name "VCC") (number "5"))
      (pin power_in line (at 0 -7.62 90) (length 2.54) (name "GND") (number "3"))
    )
  )
  (symbol "SN74LVC2G17" (pin_names (offset 1.016))
    (symbol "SN74LVC2G17_1_1"
      (pin input line (at -7.62 0 0) (length 2.54) (name "1A") (number "1"))
      (pin output line (at 7.62 0 180) (length 2.54) (name "1Y") (number "6"))
    )
    (symbol "SN74LVC2G17_2_1"
      (pin input line (at -7.62 0 0) (length 2.54) (name "2A") (number "3"))
      (pin output line (at 7.62 0 180) (length 2.54) (name "2Y") (number "4"))
    )
  )
)`;

const AUDIO_LIB = `(kicad_symbol_lib (version 20251024) (generator test)
  (symbol "TLV320AIC3100" (pin_names (offset 1.016))
    (symbol "TLV320AIC3100_1_1"
      (pin power_in line (at 0 7.62 270) (length 2.54) (name "AVDD") (number "1"))
      (pin bidirectional line (at -7.62 0 0) (length 2.54) (name "SDA") (number "2"))
      (pin input line (at -7.62 -2.54 0) (length 2.54) (name "SCL") (number "3"))
    )
  )
)`;

const MCU_LIB = `(kicad_symbol_lib (version 20251024) (generator test)
  (symbol "STM32F103C8Tx" (pin_names (offset 1.016))
    (symbol "STM32F103C8Tx_1_1"
      (pin power_in line (at 0 7.62 270) (length 2.54) (name "VDD") (number "1"))
      (pin bidirectional line (at -7.62 0 0) (length 2.54) (name "PA0") (number "2"))
    )
  )
)`;

const BOM = `| Refdes | Value | Footprint | MPN | Rationale |
| --- | --- | --- | --- | --- |
| U1 | codec | Package_DFN_QFN:X | TLV320AIC3100 | audio codec |
| U2 | buffer | Package_TO_SOT_SMD:X | SN74LVC2G17 | dual schmitt buffer |
| U3 | ghost | Package_QFP:X | XYZQ9999ZZ | not installed anywhere |
| U4 | SN74LVC1G17 | Package_TO_SOT_SMD:X | BOGUSMPN9999 | bogus MPN over a resolvable Value |
| U5 | mcu | Package_QFP:X | STM32F103C8T6 | family variant of the stock symbol |
| SW2 | R_Small | Button:X | | value fallback row |
| Y1 | 8M | Crystal:X | | name too short to search |
| R1 | 10k | Resistor_SMD:X | UNVERIFIED | passive, omitted |
| C3 | 100n | Capacitor_SMD:X | UNVERIFIED | passive, omitted |
`;

describe('pin dossier (R14: stage-4 entry pin facts)', () => {
  let libDir: string;

  beforeAll(async () => {
    libDir = await mkdtemp(path.join(tmpdir(), 'copperhead-dossier-test-'));
    await writeFile(path.join(libDir, 'Device.kicad_sym'), DEVICE_LIB, 'utf8');
    await writeFile(path.join(libDir, 'Logic.kicad_sym'), LOGIC_LIB, 'utf8');
    await writeFile(path.join(libDir, 'Audio.kicad_sym'), AUDIO_LIB, 'utf8');
    await writeFile(path.join(libDir, 'MCU_ST_STM32F1.kicad_sym'), MCU_LIB, 'utf8');
  });

  afterAll(async () => {
    await rm(libDir, { recursive: true, force: true });
  });

  describe('resolveLibrarySymbol unit count', () => {
    it('single-unit symbol reports 1', async () => {
      const r = await resolveLibrarySymbol('Device:R', [libDir]);
      expect(r.status).toBe('ok');
      if (r.status === 'ok') expect(r.units).toBe(1);
    });

    it('multi-unit symbol reports its unit count', async () => {
      const r = await resolveLibrarySymbol('Logic:SN74LVC2G17', [libDir]);
      expect(r.status).toBe('ok');
      if (r.status === 'ok') expect(r.units).toBe(2);
    });

    it('derived symbol reports the base unit count with the base pins', async () => {
      const r = await resolveLibrarySymbol('Device:R_Small', [libDir]);
      expect(r.status).toBe('ok');
      if (r.status === 'ok') {
        expect(r.pins).toHaveLength(2);
        expect(r.units).toBe(1);
      }
    });
  });

  describe('bomSymbolDossier', () => {
    it('resolves MPN rows to lib_id and full pin table', async () => {
      const d = await bomSymbolDossier(BOM, [libDir]);
      expect(d).toContain('U1 (TLV320AIC3100): Audio:TLV320AIC3100 — 3 pin(s)');
      expect(d).toContain('1=AVDD/power_in');
      expect(d).toContain('2=SDA/bidirectional');
    });

    it('flags multi-unit symbols as unit-per-instance placements', async () => {
      const d = await bomSymbolDossier(BOM, [libDir]);
      expect(d).toContain('MULTI-UNIT (2 units)');
      expect(d).toMatch(/U2 \(SN74LVC2G17\).*places each unit separately/);
    });

    it('falls back to the Value column when the MPN is empty', async () => {
      const d = await bomSymbolDossier(BOM, [libDir]);
      expect(d).toContain('SW2 (R_Small): Device:R_Small — 2 pin(s)');
    });

    it('searches the Value as a separate fallback when the MPN finds nothing', async () => {
      const d = await bomSymbolDossier(BOM, [libDir]);
      // A bogus MPN over a resolvable Value must not read as NO INSTALLED SYMBOL.
      expect(d).toContain('U4 (BOGUSMPN9999): Logic:SN74LVC1G17 (matched by Value "SN74LVC1G17")');
      expect(d).not.toMatch(/U4 .*NO INSTALLED SYMBOL/);
    });

    it('resolves a family-variant MPN instead of declaring it absent', async () => {
      // Finding 1 (#202 review): search lacked the edit-distance tier the
      // cross-library resolver had, so STM32F103C8T6 vs the installed
      // STM32F103C8Tx rendered as a false NO INSTALLED SYMBOL under a
      // machine-verified heading, and the prompt told the agent to substitute
      // a correctly chosen part.
      const d = await bomSymbolDossier(BOM, [libDir]);
      expect(d).toContain('U5 (STM32F103C8T6): MCU_ST_STM32F1:STM32F103C8Tx');
      expect(d).not.toMatch(/U5 .*NO INSTALLED SYMBOL/);
    });

    it('discloses rows whose only name is too short to search', async () => {
      const d = await bomSymbolDossier(BOM, [libDir]);
      expect(d).toContain('NOT SEARCHED (name shorter than 3 chars)');
      expect(d).toContain('Y1 (8M)');
      expect(d).not.toMatch(/Y1 .*NO INSTALLED SYMBOL/);
    });

    it('names parts nothing matches instead of omitting them', async () => {
      const d = await bomSymbolDossier(BOM, [libDir]);
      expect(d).toMatch(/U3 \(XYZQ9999ZZ\): NO INSTALLED SYMBOL/);
    });

    it('omits pure-passive refdes classes', async () => {
      const d = await bomSymbolDossier(BOM, [libDir]);
      expect(d).not.toMatch(/^- R1[ ,(]/m);
      expect(d).not.toMatch(/^- C3[ ,(]/m);
      expect(d).not.toContain('(10k)');
      expect(d).not.toContain('(100n)');
    });

    it('discloses size-cap overflow within the cap, never silently', async () => {
      const d = await bomSymbolDossier(BOM, [libDir], { maxChars: 700 });
      expect(d).toContain('NOT INCLUDED (size cap 700 chars)');
      expect(d).toContain('symbol_pins');
      // The bound covers the COMPLETE rendered block, disclosure included.
      expect(d.length).toBeLessThanOrEqual(700);
      // every non-passive part appears — rendered, disclosed by name, or
      // covered by the explicit "…and N more" truncation count
      for (const who of ['U1', 'U2', 'U3', 'U4', 'SW2']) {
        if (!d.includes(who)) expect(d).toMatch(/…and \d+ more/);
      }
    });

    it('degrades to empty on no dirs, no rows, and garbage input', async () => {
      expect(await bomSymbolDossier(BOM, [])).toBe('');
      expect(await bomSymbolDossier('no table here', [libDir])).toBe('');
      expect(await bomSymbolDossier(BOM, [path.join(libDir, 'nonexistent')])).toBe('');
    });
  });

  describe('symbol_pins tool', () => {
    // Typed literal (only the two stub collaborators are cast), so a new
    // required RunContext field fails typecheck here instead of at runtime.
    const ctx = (): RunContext => ({
      repoRoot: '/nonexistent',
      config: {} as RunContext['config'],
      transcript: { event: async () => {} } as unknown as RunContext['transcript'],
      ledger: new ObligationsLedger(),
      runId: 'test',
      interactive: false,
      confirm: async () => true,
      editsUnlocked: false,
      changeId: null,
      proposalValidated: false,
      filesTouched: new Set(),
      decisions: [],
      lastErc: null,
      lastDrc: null,
      lastLegibility: null,
      lastScore: null,
      repairCycles: 0,
      finishRequest: null,
    });

    beforeAll(() => {
      vi.stubEnv('KICAD_SYMBOL_DIR', libDir);
    });

    afterAll(() => {
      vi.unstubAllEnvs();
    });

    it('reports pins and unit count for a resolved lib_id', async () => {
      const out = await dispatchTool(ctx(), 'symbol_pins', { lib_id: 'Logic:SN74LVC1G17' });
      expect(out).toContain('4 pin(s), 1 unit(s)');
      expect(out).toContain('2: A · input');
      expect(out).toContain('5: VCC · power_in');
      expect(out).not.toContain('WARNING');
    });

    it('notes unit-per-instance placement on a multi-unit symbol', async () => {
      const out = await dispatchTool(ctx(), 'symbol_pins', { lib_id: 'Logic:SN74LVC2G17' });
      expect(out).toContain('2 unit(s)');
      expect(out).toContain('places each unit separately');
    });

    it('redirects a wrong-library guess to where the symbol lives', async () => {
      const out = await dispatchTool(ctx(), 'symbol_pins', { lib_id: 'Device:SN74LVC1G17' });
      expect(out).toContain('does not resolve');
      expect(out).toContain('installed as: Logic:SN74LVC1G17');
    });

    it('handles an uninstalled library nickname', async () => {
      const out = await dispatchTool(ctx(), 'symbol_pins', { lib_id: 'Nowhere:TLV320AIC3100' });
      expect(out).toContain('does not resolve');
      expect(out).toContain('installed as: Audio:TLV320AIC3100');
    });

    it('offers same-library closest names for a near-miss with no cross-library hit', async () => {
      const out = await dispatchTool(ctx(), 'symbol_pins', { lib_id: 'Device:R_Smal' });
      expect(out).toContain('does not exist in that library');
      expect(out).toContain('closest in that library: R_Small');
    });

    it('reports a nickname and name that exist nowhere without inventing a location', async () => {
      const out = await dispatchTool(ctx(), 'symbol_pins', { lib_id: 'Nowhere:QQQZZZ9999' });
      expect(out).toContain('no library named "Nowhere" is installed');
      expect(out).toContain('no installed symbol matches "QQQZZZ9999"');
    });
  });

  describe('search_symbols tool', () => {
    beforeAll(() => {
      vi.stubEnv('KICAD_SYMBOL_DIR', libDir);
    });

    afterAll(() => {
      vi.unstubAllEnvs();
    });

    const ctx = (): RunContext => ({
      repoRoot: '/nonexistent',
      config: {} as RunContext['config'],
      transcript: { event: async () => {} } as unknown as RunContext['transcript'],
      ledger: new ObligationsLedger(),
      runId: 'test',
      interactive: false,
      confirm: async () => true,
      editsUnlocked: false,
      changeId: null,
      proposalValidated: false,
      filesTouched: new Set(),
      decisions: [],
      lastErc: null,
      lastDrc: null,
      lastLegibility: null,
      lastScore: null,
      repairCycles: 0,
      finishRequest: null,
    });

    it('lists ranked lib_ids for an installed part', async () => {
      const out = await dispatchTool(ctx(), 'search_symbols', { query: 'SN74LVC1G17' });
      expect(out).toContain('installed symbols matching "SN74LVC1G17"');
      expect(out).toContain('Logic:SN74LVC1G17');
    });

    it('states a genuine miss with the searched directories', async () => {
      const out = await dispatchTool(ctx(), 'search_symbols', { query: 'ZZZQ9999XY' });
      expect(out).toContain('no installed symbol matches "ZZZQ9999XY"');
      expect(out).toContain('not capturable on this machine as named');
    });
  });

  describe('verify_symbols counts wrong-library findings as issues', () => {
    beforeAll(() => {
      vi.stubEnv('KICAD_SYMBOL_DIR', libDir);
    });

    afterAll(() => {
      vi.unstubAllEnvs();
    });

    it('reports 1 issue(s) for a part installed under another nickname', async () => {
      // Finding 3 (#202 review): the found-elsewhere finding carried kind
      // 'no-library', which the mismatch counter excludes, so the summary said
      // "0 issue(s) to reconcile" directly above a printed issue.
      const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-verifycount-'));
      try {
        await writeFile(
          path.join(repo, 'x.kicad_sch'),
          `(kicad_sch (version 20251024) (generator test)
  (lib_symbols
    (symbol "Nowhere:SN74LVC1G17"
      (symbol "SN74LVC1G17_1_1"
        (pin input line (at 0 0 0) (length 1.27) (name "A") (number "2"))
      )
    )
  )
)`,
          'utf8',
        );
        const ctx: RunContext = {
          repoRoot: repo,
          config: { schematic: 'x.kicad_sch' } as RunContext['config'],
          transcript: { event: async () => {} } as unknown as RunContext['transcript'],
          ledger: new ObligationsLedger(),
          runId: 'test',
          interactive: false,
          confirm: async () => true,
          editsUnlocked: false,
          changeId: null,
          proposalValidated: false,
          filesTouched: new Set(),
          decisions: [],
          lastErc: null,
          lastDrc: null,
          lastLegibility: null,
          lastScore: null,
          repairCycles: 0,
          finishRequest: null,
        };
        const out = await dispatchTool(ctx, 'verify_symbols', {});
        expect(out).toContain('1 issue(s) to reconcile');
        expect(out).toContain('[wrong-library]');
      } finally {
        await rm(repo, { recursive: true, force: true });
      }
    });
  });
});
