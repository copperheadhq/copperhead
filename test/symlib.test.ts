import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveLibrarySymbol,
  verifySchematicSymbols,
  symbolSearchDirs,
  findSymbolAcrossLibraries,
  closestSymbolNames,
  searchInstalledSymbols,
  findLibraryFile,
} from '../src/kicad/symlib.js';
import { symbolAvailabilityFacts } from '../src/agent/recovery.js';

// A minimal stand-in for /usr/share/kicad/symbols/Device.kicad_sym: R (2 pins)
// and R_Small which `extends` R (inherits R's pins, has none of its own).
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

// A schematic whose lib_symbols mixes a faithful copy, a wrong-pin-count copy, a
// nonexistent lib_id, and one whose library is not installed here.
function schematic(): string {
  return `(kicad_sch (version 20251024) (generator test)
  (lib_symbols
    (symbol "Device:R" (pin_numbers hide) (pin_names (offset 0))
      (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54)))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
      )
    )
    (symbol "Device:R_Small"
      (symbol "R_Small_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
        (pin passive line (at 0 0 90) (length 1.27) (name "~") (number "3"))
      )
    )
    (symbol "Nowhere:Gadget"
      (symbol "Gadget_1_1"
        (pin passive line (at 0 0 0) (length 1.27) (name "A") (number "1"))
      )
    )
  )
)`;
}

describe('symlib (I9: verify symbols against the installed KiCad library)', () => {
  let libDir: string;
  let schPath: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    libDir = await mkdtemp(path.join(tmpdir(), 'copperhead-symlib-test-'));
    await writeFile(path.join(libDir, 'Device.kicad_sym'), DEVICE_LIB, 'utf8');
    const work = await mkdtemp(path.join(tmpdir(), 'copperhead-sch-test-'));
    schPath = path.join(work, 'x.kicad_sch');
    await writeFile(schPath, schematic(), 'utf8');
    // Point discovery at our fake lib only; nothing else on PATH matters.
    env = { KICAD_SYMBOL_DIR: libDir };
  });

  afterAll(async () => {
    await rm(libDir, { recursive: true, force: true }).catch(() => {});
    await rm(path.dirname(schPath), { recursive: true, force: true }).catch(() => {});
  });

  it('resolves an exact symbol to its real pins', async () => {
    const r = await resolveLibrarySymbol('Device:R', [libDir]);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.pins.map((p) => p.number).sort()).toEqual(['1', '2']);
      expect(r.pins.every((p) => p.type === 'passive')).toBe(true);
    }
  });

  it('follows `extends` to the base symbol for pins', async () => {
    const r = await resolveLibrarySymbol('Device:R_Small', [libDir]);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.pins).toHaveLength(2);
  });

  it('reports candidates when the exact name is absent', async () => {
    const r = await resolveLibrarySymbol('Device:R_Smal', [libDir]);
    expect(r.status).toBe('no-symbol');
    if (r.status === 'no-symbol') expect(r.candidates).toContain('R_Small'); // prefix match
  });

  it('never pads candidates with single-letter generics for a long query (#195)', async () => {
    // Old behavior: "R" ⊂ "R_Nonexistent" counted as a match, so any long
    // query got the library's one-letter passives as "closest" suggestions.
    const r = await resolveLibrarySymbol('Device:R_Nonexistent', [libDir]);
    expect(r.status).toBe('no-symbol');
    if (r.status === 'no-symbol') expect(r.candidates).not.toContain('R');
  });

  it('reports no-library when the library file is missing', async () => {
    const r = await resolveLibrarySymbol('Connector:Whatever', [libDir]);
    expect(r.status).toBe('no-library');
  });

  it('ranks separator-variant names as near-misses and drops sub-units (#195)', () => {
    // Real strings from the lemondrop run (run-logs/2026-08-07T17-52-03): the
    // validator answered "Device:Rotary_Encoder" with "closest: C, D, R" while
    // RotaryEncoder_Switch sat one underscore away in that library.
    const device = ['C', 'D', 'L', 'R', 'FerriteBead', 'RotaryEncoder', 'RotaryEncoder_Switch', 'RotaryEncoder_Switch_MP'];
    const got = closestSymbolNames(device, 'Rotary_Encoder');
    expect(got[0]).toBe('RotaryEncoder'); // separator-insensitive exact match first
    expect(got).toContain('RotaryEncoder_Switch');
    expect(got).not.toContain('C');
    expect(got).not.toContain('R');

    // "microSD_Card" differs from the installed name by case and underscore placement.
    expect(closestSymbolNames(['Micro_SD_Card', 'Micro_SD_Card_Det1', 'USB_A'], 'microSD_Card')[0]).toBe('Micro_SD_Card');

    // Sub-unit children polluted 5 of 8 candidate slots in the real run.
    const audio = ['TLV320AIC23BPW', 'TLV320AIC23BPW_0_1', 'TLV320AIC23BPW_1_1', 'TLV320AIC23BRHD', 'TLV320AIC23BRHD_0_1', 'TLV320AIC23BRHD_1_1', 'TLV320AIC3100', 'TLV320AIC3100_0_1'];
    const tlv = closestSymbolNames(audio, 'TLV320');
    expect(tlv.sort()).toEqual(['TLV320AIC23BPW', 'TLV320AIC23BRHD', 'TLV320AIC3100']);
  });

  it('verifies a schematic: clean match, pin-count diff, missing symbol, uninstalled lib', async () => {
    const { findings, checked, skipped } = await verifySchematicSymbols(schPath, env);
    // Device:R matched cleanly → counts as checked, no finding.
    const kinds = findings.map((f) => f.kind);
    expect(checked).toBeGreaterThanOrEqual(1);
    // Device:R_Small (extends R → 2 pins) authored with 3 pins.
    expect(kinds).toContain('pin-count');
    // Nowhere:Gadget → Nowhere.kicad_sym not installed → skipped, not a mismatch.
    expect(kinds).toContain('no-library');
    expect(skipped).toBe(1);
    // The faithful Device:R must NOT produce a pin-mismatch.
    expect(findings.find((f) => f.libId === 'Device:R')).toBeUndefined();
  });
});

describe('cross-library resolution (review findings on #186)', () => {
  let libDir: string;

  beforeAll(async () => {
    libDir = await mkdtemp(path.join(tmpdir(), 'copperhead-crosslib-test-'));
    // Device.kicad_sym: guessed-but-wrong library for these tests, plus a
    // same-file typo target (R_Small) that must still win over any
    // cross-library fuzzy noise.
    await writeFile(path.join(libDir, 'Device.kicad_sym'), DEVICE_LIB, 'utf8');
    // The real symbol lives elsewhere, and is spelled differently than the
    // query (SHT4x, not SHT40) — the shape that broke substring-only matching.
    await writeFile(
      path.join(libDir, 'Sensor_Humidity.kicad_sym'),
      `(kicad_symbol_lib (version 20251024) (generator test)
  (symbol "SHT4x" (pin_numbers hide) (pin_names (offset 0))
    (symbol "SHT4x_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
    )
  )
)`,
      'utf8',
    );
    // TPS22810 really installed, so the one-edit guard against TPS22860 is
    // exercised for real — without this fixture the "does not match" test
    // passes vacuously against an empty library set.
    await writeFile(
      path.join(libDir, 'Power_Switch.kicad_sym'),
      `(kicad_symbol_lib (version 20251024) (generator test)
  (symbol "TPS22810" (pin_numbers hide) (pin_names (offset 0))
    (symbol "TPS22810_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))
    )
  )
)`,
      'utf8',
    );
  });

  afterAll(async () => {
    await rm(libDir, { recursive: true, force: true });
  });

  it('finds an exact match under a different library name', async () => {
    const matches = await findSymbolAcrossLibraries('SHT4x', [libDir], 'Sensor_Wrong');
    expect(matches).toContainEqual({ lib: 'Sensor_Humidity', name: 'SHT4x', exact: true });
  });

  it('a fuzzy cross-library match reports the real symbol name, not the query', async () => {
    const matches = await findSymbolAcrossLibraries('SHT40', [libDir], 'Sensor_Wrong');
    const hit = matches.find((m) => m.lib === 'Sensor_Humidity');
    expect(hit).toBeDefined();
    expect(hit!.exact).toBe(false);
    // The bug this guards: recording only `{ lib, exact }` and reconstructing
    // the suggestion from the caller's original query built "Sensor_Humidity:SHT40",
    // a lib_id that does not exist anywhere.
    expect(hit!.name).toBe('SHT4x');
  });

  it('does not match a genuinely different part number one edit away', async () => {
    // TPS22860 vs TPS22810: same length, one digit differs. Real parts, not
    // the same chip — TPS22810 IS installed in the fixture set, so this
    // exercises the digit-for-digit guard rather than passing vacuously.
    // excludeLib only skips the exact check; the fuzzy path still runs
    // against Power_Switch and must reject the digit swap.
    const matches = await findSymbolAcrossLibraries('TPS22860', [libDir], 'Power_Switch');
    expect(matches.some((m) => m.name === 'TPS22810')).toBe(false);
  });

  it('search applies the same family-variant rule as cross-library discovery', async () => {
    // The two resolvers must never disagree about what counts as a near-miss
    // (finding 1, #202 review): the family variant matches, the digit swap
    // does not, in both directions of the machinery.
    expect(await searchInstalledSymbols('SHT40', [libDir])).toContain('Sensor_Humidity:SHT4x');
    expect(await searchInstalledSymbols('TPS22860', [libDir])).toEqual([]);
  });

  it('a same-file typo wins over a cross-library fuzzy match, and never suggests itself', async () => {
    // Device:R_Sma is a typo of Device:R_Small, which lives in the same file.
    // The fix on #186 ordered same-file candidates before cross-library
    // lookup; before that fix this returned 'found-elsewhere' pointing at
    // "Device:R_Sma" itself, the identical failing lib_id.
    const r = await resolveLibrarySymbol('Device:R_Sma', [libDir]);
    expect(r.status).toBe('no-symbol');
    if (r.status === 'no-symbol') {
      expect(r.candidates).toContain('R_Small');
    }
  });

  it('resolveLibrarySymbol resolves a fuzzy cross-library suggestion end to end', async () => {
    const first = await resolveLibrarySymbol('Sensor_Wrong:SHT40', [libDir]);
    expect(first.status).toBe('found-elsewhere');
    if (first.status !== 'found-elsewhere') return;
    const suggested = first.libIds[0]!;
    expect(suggested).toBe('Sensor_Humidity:SHT4x');
    const second = await resolveLibrarySymbol(suggested, [libDir]);
    expect(second.status).toBe('ok');
  });
});

describe('symbolSearchDirs: Windows version-directory discovery', () => {
  let root: string;
  let versionDir: string;

  beforeAll(async () => {
    // Stand-in for "C:\Program Files\KiCad": a version-numbered child holding
    // the real symbols directory, the layout every real Windows install uses.
    // symbolSearchDirs builds the version path by string concatenation with
    // forward slashes (matching a Windows-accepted `C:/...` root), not
    // path.join, so the expected values here must be built the same way.
    root = (await mkdtemp(path.join(tmpdir(), 'copperhead-kicadroot-'))).split(path.sep).join('/');
    versionDir = `${root}/10.0/share/kicad/symbols`;
    await mkdir(versionDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // These assertions filter to paths under the fixture root: on a machine with
  // a real KiCad install, symbolSearchDirs legitimately includes the standard
  // locations (/usr/share/kicad/symbols, …) too, and asserting deep equality
  // against only the fixture made the suite fail on exactly the machines the
  // harness runs on.
  const underRoot = (dirs: string[]): string[] => dirs.filter((d) => d.startsWith(root));

  it('discovers a version-numbered directory when no env override is set', async () => {
    const dirs = await symbolSearchDirs({}, root);
    expect(underRoot(dirs)).toEqual([versionDir]);
  });

  it('prefers the newest version when more than one is installed', async () => {
    const older = `${root}/8.0/share/kicad/symbols`;
    await mkdir(older, { recursive: true });
    try {
      const dirs = await symbolSearchDirs({}, root);
      expect(underRoot(dirs)).toEqual([versionDir, older]); // 10.0 sorts before 8.0
    } finally {
      await rm(`${root}/8.0`, { recursive: true, force: true });
    }
  });

  it('an env override skips Windows auto-discovery entirely, even when set', async () => {
    // Regression: symbolSearchDirs used to run the Windows version-directory
    // scan unconditionally, so a caller pinning KICAD_SYMBOL_DIR at an
    // isolated directory (this repo's own tests, or a pinned library set)
    // could silently get the real machine's KiCad install appended too.
    // A second version directory the override does NOT name would be exactly
    // what leaky auto-discovery appends — its absence is the real assertion.
    const other = `${root}/11.0/share/kicad/symbols`;
    await mkdir(other, { recursive: true });
    try {
      const dirs = await symbolSearchDirs({ KICAD_SYMBOL_DIR: versionDir }, root);
      // Exclusive, not merely filtered: the override must suppress the stock
      // defaults too, or tests pinning a fixture dir still scan the host's
      // real libraries (finding 11, #202 review).
      expect(dirs).toEqual([versionDir]);
      expect(dirs).not.toContain(other);
    } finally {
      await rm(`${root}/11.0`, { recursive: true, force: true });
    }
  });

  it('discovers a non-versioned share/ layout under the KiCad root', async () => {
    const flatRoot = (await mkdtemp(path.join(tmpdir(), 'copperhead-kicadflat-'))).split(path.sep).join('/');
    const flat = `${flatRoot}/share/kicad/symbols`;
    await mkdir(flat, { recursive: true });
    try {
      const dirs = await symbolSearchDirs({}, flatRoot);
      expect(dirs).toContain(flat);
    } finally {
      await rm(flatRoot, { recursive: true, force: true });
    }
  });
});

// A one-pin top-level symbol entry, with the sub-unit child the scrape must skip.
const sym = (name: string): string =>
  `  (symbol "${name}" (pin_names (offset 0))
    (symbol "${name}_1_1"
      (pin passive line (at 0 0 0) (length 1.27) (name "~") (number "1"))
    )
  )`;
const lib = (...names: string[]): string =>
  `(kicad_symbol_lib (version 20251024) (generator test)\n${names.map(sym).join('\n')}\n)`;

describe('cross-library discovery and refusal fact-checking (#195, #196, #197)', () => {
  // The lemondrop run's real layout: the parts the stage-4 agent declared
  // "verified absent" live in libraries it never guessed.
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'copperhead-symsearch-test-'));
    await writeFile(path.join(dir, 'Audio.kicad_sym'), lib('TLV320AIC23BPW', 'TLV320AIC3100'), 'utf8');
    await writeFile(path.join(dir, 'Driver_LED.kicad_sym'), lib('TPS61165DBV'), 'utf8');
    await writeFile(path.join(dir, 'Connector_Audio.kicad_sym'), lib('AudioJack3', 'AudioJack3_Ground'), 'utf8');
    await writeFile(path.join(dir, 'Device.kicad_sym'), lib('C', 'D', 'R', 'RotaryEncoder_Switch'), 'utf8');
    // A user-added library whose nickname carries the other separators a
    // .kicad_sym filename stem allows.
    await writeFile(path.join(dir, 'Custom-Parts.RF.kicad_sym'), lib('LNA_Frontend'), 'utf8');
    // Family symbol under the stock spelling: the datasheet MPN differs by one
    // trailing character (T6 vs Tx), the shape finding 1 (#202 review) is about.
    await writeFile(path.join(dir, 'MCU_ST_STM32F1.kicad_sym'), lib('STM32F103C8Tx'), 'utf8');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('finds a part filed under a library nickname the caller could not derive', async () => {
    expect(await searchInstalledSymbols('TPS61165', [dir])).toEqual(['Driver_LED:TPS61165DBV']);
    expect(await searchInstalledSymbols('AudioJack3', [dir])).toContain('Connector_Audio:AudioJack3');
    // exact (separator-insensitive) matches outrank other libraries' near-misses
    expect((await searchInstalledSymbols('Rotary_Encoder_Switch', [dir]))[0]).toBe('Device:RotaryEncoder_Switch');
  });

  it('returns nothing for a part that is genuinely absent everywhere', async () => {
    expect(await searchInstalledSymbols('TLP2361', [dir])).toEqual([]);
  });

  it('finds a family-variant spelling instead of declaring it absent', async () => {
    // Before the edit-distance tier, search returned [] here while
    // findSymbolAcrossLibraries found the part, and the dossier rendered the
    // disagreement as a false NO INSTALLED SYMBOL under a machine-verified label.
    expect(await searchInstalledSymbols('STM32F103C8T6', [dir])).toEqual(['MCU_ST_STM32F1:STM32F103C8Tx']);
  });

  it('renders a genuinely absent lib_id with the not-found line, never a fabricated location', async () => {
    const facts = await symbolAvailabilityFacts('Optoisolator:TLP9999QQ was refused', [dir]);
    expect(facts).toContain('no installed symbol matches "TLP9999QQ"');
  });

  it('produces no facts block when the search dirs hold no readable library', async () => {
    // An existing-but-empty directory means nothing was checked; emitting
    // "not installed" lines as ground truth from that state is the false
    // absence the block exists to prevent (finding 2, #202 review).
    const empty = await mkdtemp(path.join(tmpdir(), 'copperhead-emptylibs-'));
    try {
      expect(await symbolAvailabilityFacts('"Device:R" is not installed', [empty])).toBe('');
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('rejects a library nickname that escapes the search directories', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'copperhead-outside-'));
    try {
      await writeFile(path.join(outside, 'Private.kicad_sym'), lib('SECRET_PART'), 'utf8');
      expect(await findLibraryFile(`../${path.basename(outside)}/Private`, [dir])).toBeNull();
      const r = await resolveLibrarySymbol(`../${path.basename(outside)}/Private:SECRET_PART`, [dir]);
      expect(r.status).not.toBe('ok');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('ranks a later library\'s stronger match above an earlier library\'s weaker one', async () => {
    // Search dirs are scanned in order, so the weak match is guaranteed to be
    // collected first: ranking per library and capping in scan order would put
    // it on top and, at a small cap, evict the better hit entirely.
    const early = await mkdtemp(path.join(tmpdir(), 'copperhead-symrank-a-'));
    const late = await mkdtemp(path.join(tmpdir(), 'copperhead-symrank-b-'));
    try {
      await writeFile(path.join(early, 'Early_Misc.kicad_sym'), lib('Legacy_Widget_Shim'), 'utf8');
      await writeFile(path.join(late, 'Late_Parts.kicad_sym'), lib('Widget_Driver'), 'utf8');
      const dirs = [early, late];
      expect((await searchInstalledSymbols('Widget', dirs))[0]).toBe('Late_Parts:Widget_Driver');
      expect(await searchInstalledSymbols('Widget', dirs, 1)).toEqual(['Late_Parts:Widget_Driver']);
    } finally {
      await rm(early, { recursive: true, force: true }).catch(() => {});
      await rm(late, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('fact-checks lib_ids named in a refusal against the installed libraries', async () => {
    // Condensed from the recorded constraint that drove the real abort: the
    // first claim is false (the symbol resolves), the second names a part
    // that is installed under a different library.
    const refusal =
      'VERIFIED ABSENT: "Audio:TLV320AIC23BPW" does not exist; ' +
      'Regulator_Switching:TPS61165 is not installed (see docs/BOM.md and create.ts:311)';
    const facts = await symbolAvailabilityFacts(refusal, [dir]);
    expect(facts).toMatch(/Audio:TLV320AIC23BPW: RESOLVES/);
    expect(facts).toContain('Driver_LED:TPS61165DBV');
    // file:line refs are not lib_ids
    expect(facts).not.toContain('create.ts');
  });

  it('probes a library nickname that carries "-" or "." separators', async () => {
    const refusal = 'VERIFIED ABSENT: Custom-Parts.RF:LNA_Frontend has no symbol on this machine.';
    const facts = await symbolAvailabilityFacts(refusal, [dir]);
    expect(facts).toMatch(/Custom-Parts\.RF:LNA_Frontend: RESOLVES/);
  });

  it('names the lib_ids it did not probe rather than implying full coverage', async () => {
    const refusal = 'absent: Audio:TLV320AIC23BPW, Driver_LED:TPS61165DBV, Device:R, Device:C';
    const facts = await symbolAvailabilityFacts(refusal, [dir], 2);
    expect(facts).toMatch(/Audio:TLV320AIC23BPW: RESOLVES/);
    expect(facts).toContain('NOT RE-PROBED (probe limit 2)');
    expect(facts).toContain('Device:R');
    expect(facts).toContain('Device:C');
  });

  it('produces no facts block when the text names no lib_ids', async () => {
    expect(await symbolAvailabilityFacts('turn timed out after 300s; see create.ts:311', [dir])).toBe('');
  });
});
