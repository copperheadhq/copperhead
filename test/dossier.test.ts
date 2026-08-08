import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveLibrarySymbol, nearestInstalledSymbols } from '../src/kicad/symlib.js';
import { bomSymbolDossier, resolveBomSymbols, renderDossier } from '../src/kicad/dossier.js';
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

    it('flags multi-unit symbols as ones the engine refuses', async () => {
      const d = await bomSymbolDossier(BOM, [libDir]);
      expect(d).toContain('MULTI-UNIT (2 units)');
      expect(d).toMatch(/U2 \(SN74LVC2G17\).*refuses/);
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

  describe('resolveBomSymbols (resolution/render split)', () => {
    it('classifies each part: resolved with lib_id/units/alternatives, absent, and the not-searched set', async () => {
      const r = await resolveBomSymbols(BOM, [libDir]);
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      const byQuery = new Map(r.parts.map((p) => [p.query, p]));
      const codec = byQuery.get('TLV320AIC3100')!;
      expect(codec.status).toBe('resolved');
      expect(codec.libId).toBe('Audio:TLV320AIC3100');
      expect(codec.refs).toEqual(['U1']);
      const buffer = byQuery.get('SN74LVC2G17')!;
      expect(buffer.status).toBe('resolved');
      expect(buffer.units).toBe(2);
      const ghost = byQuery.get('XYZQ9999ZZ')!;
      expect(ghost.status).toBe('absent');
      expect(ghost.refs).toEqual(['U3']);
      // The Value fallback resolves a bogus MPN — never classified absent.
      const bogus = byQuery.get('BOGUSMPN9999')!;
      expect(bogus.status).toBe('resolved');
      expect(bogus.fallback).toBe('SN74LVC1G17');
      expect(r.notSearched).toContain('Y1 (8M)');
      expect(r.errored).toEqual([]);
      expect(r.overflow).toEqual([]);
    });

    it('reports distinct empty-with-reason degrade states instead of throwing', async () => {
      expect(await resolveBomSymbols(BOM, [])).toEqual({ status: 'empty', reason: 'no-search-dirs' });
      expect(await resolveBomSymbols(BOM, [path.join(libDir, 'nonexistent')])).toEqual({
        status: 'empty',
        reason: 'no-readable-library',
      });
      expect(await resolveBomSymbols('no table here', [libDir])).toEqual({
        status: 'empty',
        reason: 'no-searchable-rows',
      });
    });

    it('moves parts past the size cap into the overflow set, scans skipped', async () => {
      const r = await resolveBomSymbols(BOM, [libDir], { maxChars: 700 });
      expect(r.status).toBe('ok');
      if (r.status !== 'ok') return;
      expect(r.overflow.length).toBeGreaterThan(0);
      // An overflow part has no record: its classification was never rendered
      // and (once the body is full) never even scanned.
      for (const who of r.overflow) {
        expect(r.parts.some((p) => `${p.refs.join(', ')} (${p.query})` === who)).toBe(false);
      }
    });

    it('classifies a probe error as errored, never absent', async () => {
      vi.resetModules();
      vi.doMock('../src/kicad/symlib.js', async (importOriginal) => {
        const real = await importOriginal<typeof import('../src/kicad/symlib.js')>();
        return {
          ...real,
          searchInstalledSymbols: async (q: string, dirs: string[], cap?: number) => {
            if (q === 'TLV320AIC3100') throw new Error('probe boom');
            return real.searchInstalledSymbols(q, dirs, cap);
          },
        };
      });
      try {
        const { resolveBomSymbols: resolveMocked } = await import('../src/kicad/dossier.js');
        const r = await resolveMocked(BOM, [libDir]);
        expect(r.status).toBe('ok');
        if (r.status !== 'ok') return;
        expect(r.errored).toContain('U1 (TLV320AIC3100)');
        expect(r.parts.some((p) => p.query === 'TLV320AIC3100')).toBe(false);
      } finally {
        vi.doUnmock('../src/kicad/symlib.js');
        vi.resetModules();
      }
    });

    it('renderDossier(resolveBomSymbols(...)) is byte-identical to bomSymbolDossier', async () => {
      expect(renderDossier(await resolveBomSymbols(BOM, [libDir]))).toBe(await bomSymbolDossier(BOM, [libDir]));
      // …including under a tight maxChars, where the overflow trailer renders.
      const opts = { maxChars: 700 };
      expect(renderDossier(await resolveBomSymbols(BOM, [libDir], opts), opts)).toBe(
        await bomSymbolDossier(BOM, [libDir], opts),
      );
      // …and on degraded inputs, where both say nothing.
      expect(renderDossier(await resolveBomSymbols(BOM, []))).toBe('');
    });
  });

  describe('nearestInstalledSymbols (checkpoint suggestion search)', () => {
    it('suggests digit-sibling family variants the match ranking refuses', async () => {
      // SN74LVC3G17 differs from both installed buffers by one digit: never a
      // match claim, exactly the suggestion a human wants to see.
      const s = await nearestInstalledSymbols('SN74LVC3G17', [libDir]);
      expect(s).toContain('Logic:SN74LVC1G17');
      expect(s).toContain('Logic:SN74LVC2G17');
    });

    it('finds a distance-bounded near miss', async () => {
      const s = await nearestInstalledSymbols('TLV320AIC31', [libDir]);
      expect(s).toContain('Audio:TLV320AIC3100');
    });

    it('returns nothing for an alien query', async () => {
      expect(await nearestInstalledSymbols('QQXV77', [libDir])).toEqual([]);
    });

    it('respects the cap', async () => {
      const s = await nearestInstalledSymbols('SN74LVC3G17', [libDir], 1);
      expect(s).toHaveLength(1);
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

    it('warns on a multi-unit symbol', async () => {
      const out = await dispatchTool(ctx(), 'symbol_pins', { lib_id: 'Logic:SN74LVC2G17' });
      expect(out).toContain('2 unit(s)');
      expect(out).toContain('refuses multi-unit symbols');
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
