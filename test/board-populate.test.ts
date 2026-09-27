import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { bootstrapKicadProject } from '../src/kicad/bootstrap.js';
import { draftSchematic, symLibTableRows } from '../src/kicad/draft/draft.js';
import { exportNetlist, resolveKicadCli } from '../src/kicad/cli.js';
import { expandUri, libTableRows } from '../src/kicad/libtable.js';
import { kicadLoadError, runDrc, runErc } from '../src/kicad/cli.js';
import { childSpans } from '../src/kicad/spans.js';
import { unroutedGuard } from '../src/capabilities/handlers.js';
import { seededKicadConfig } from './helpers.js';
import { FootprintResolver, footprintSearchDirs, formatMissingFootprints, missingFootprints } from '../src/kicad/footprints.js';
import {
  boardFootprints,
  boardMatchesNetlist,
  instantiateFootprint,
  MissingFootprintsError,
  moveFootprint,
  PadMismatchError,
  padNetMismatches,
  parseNetlist,
  populateBoard,
} from '../src/kicad/populate.js';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { isManagedPath, STAGES } from '../src/commands/create.js';
import { loadConfig } from '../src/config.js';
import { bomFootprintRows } from '../src/memory/bom-table.js';
import { normalizeReport } from '../src/kicad/report.js';
import { catalog } from '../src/capabilities/index.js';
import { dispatchTool, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';

/**
 * #314: the schematic's parts reach the board with their exact footprints, or
 * the run stops for the user to install what is missing. Nothing is guessed.
 * AC-15.29 – AC-15.38.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRAFT_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'draft');
const SYMLIB = path.join(ROOT, 'test', 'fixtures', 'symlib');
const SCH = 'demo-board.kicad_sch';
const PCB = 'demo-board.kicad_pcb';

let stock: string;
let emptyConfig: string;
let seededConfig: string;
/** Only the stock install and the project table: the machine's global table stays out. */
const hermetic = (): NodeJS.ProcessEnv => ({ ...process.env, KICAD_CONFIG_HOME: emptyConfig });
/**
 * For kicad-cli DRC: a global fp-lib-table naming every stock library, as a
 * configured KiCad has, whatever this machine's own config holds.
 */
const seeded = (): NodeJS.ProcessEnv => ({ ...process.env, KICAD_CONFIG_HOME: seededConfig });

beforeAll(async () => {
  stock = (await footprintSearchDirs())[0]!;
  emptyConfig = await mkdtemp(path.join(tmpdir(), 'copperhead-kicadcfg-'));
  seededConfig = (await seededKicadConfig(stock)).dir;
});
afterAll(async () => {
  await rm(emptyConfig, { recursive: true, force: true });
  await rm(seededConfig, { recursive: true, force: true });
});

/** The drafting fixture as a create-shaped project: scaffold, then draft. */
async function draftedProject(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-populate-'));
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  const sch = await bootstrapKicadProject(repo, '# Demo board');
  expect(sch).toBe(SCH);
  await cp(path.join(DRAFT_FIXTURE, 'schematic.intent.json'), path.join(repo, 'schematic.intent.json'));
  await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
  const res = await draftSchematic({
    repoRoot: repo,
    schematic: SCH,
    intentPath: 'schematic.intent.json',
    docsDir: path.join(repo, 'docs'),
    symbolDirs: [SYMLIB],
  });
  if (!res.ok) throw new Error(res.message);
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

/** Swap one footprint id in the drafted schematic (a Footprint property is plain text). */
async function setSchematicFootprint(repo: string, from: string, to: string): Promise<void> {
  const p = path.join(repo, SCH);
  const text = await readFile(p, 'utf8');
  expect(text).toContain(`"${from}"`);
  await writeFile(p, text.split(`"${from}"`).join(`"${to}"`), 'utf8');
}

/** A project-local library holding one stock footprint under a new name. */
async function projectLibrary(repo: string, lib: string, name: string, from: string): Promise<void> {
  const [stockLib, stockName] = from.split(':') as [string, string];
  await mkdir(path.join(repo, 'lib', `${lib}.pretty`), { recursive: true });
  await cp(path.join(stock, `${stockLib}.pretty`, `${stockName}.kicad_mod`), path.join(repo, 'lib', `${lib}.pretty`, `${name}.kicad_mod`));
  await writeFile(
    path.join(repo, 'fp-lib-table'),
    `(fp_lib_table\n\t(version 7)\n\t(lib (name "${lib}")(type "KiCad")(uri "\${KIPRJMOD}/lib/${lib}.pretty")(options "")(descr ""))\n)\n`,
    'utf8',
  );
}

describe('library tables (AC-15.30)', () => {
  it('expands ${VAR} and $(VAR), and refuses a row whose variable has no value', () => {
    expect(expandUri('${KIPRJMOD}/lib/A.pretty', { KIPRJMOD: '/p' })).toBe('/p/lib/A.pretty');
    expect(expandUri('$(HOME)/x', { HOME: '/h' })).toBe('/h/x');
    expect(expandUri('${KICAD10_FOOTPRINT_DIR}/A.pretty', {})).toBeNull();
  });

  it('reads the project table first, follows nested Table rows, and skips disabled rows', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-libtable-'));
    try {
      const cfg = path.join(dir, 'cfg', '10.0');
      await mkdir(cfg, { recursive: true });
      await mkdir(path.join(dir, 'proj'));
      await writeFile(
        path.join(dir, 'proj', 'fp-lib-table'),
        '(fp_lib_table (version 7)\n (lib (name "Mine")(type "KiCad")(uri "${KIPRJMOD}/Mine.pretty")(options "")(descr ""))\n (lib (name "Off")(type "KiCad")(uri "/x")(options "")(descr "")(disabled))\n)\n',
      );
      await writeFile(
        path.join(dir, 'template'),
        '(fp_lib_table (version 7)\n (lib (name "Stock")(type "KiCad")(uri "${KICAD10_FOOTPRINT_DIR}/Stock.pretty")(options "")(descr ""))\n (lib (name "Mine")(type "KiCad")(uri "/global/Mine.pretty")(options "")(descr ""))\n)\n',
      );
      await writeFile(
        path.join(cfg, 'fp-lib-table'),
        `(fp_lib_table (version 7)\n (lib (name "KiCad")(type "Table")(uri "${path.join(dir, 'template')}")(options "")(descr ""))\n)\n`,
      );
      const { rows, searched } = await libTableRows('fp', {
        projectDir: path.join(dir, 'proj'),
        env: { KICAD_CONFIG_HOME: path.join(dir, 'cfg') },
        defaults: { KICAD10_FOOTPRINT_DIR: '/stock' },
      });
      expect(rows.get('Mine')?.uri).toBe(path.join(dir, 'proj', 'Mine.pretty')); // project wins the clash
      expect(rows.get('Stock')?.uri).toBe('/stock/Stock.pretty'); // nested table, variable defaulted
      expect(rows.has('Off')).toBe(false);
      expect(searched).toEqual(['project fp-lib-table', 'global fp-lib-table (KiCad 10.0)']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('KiCad path variables in library tables (AC-15.30)', () => {
  it('expands ${KICAD<n>_3RD_PARTY} to its default and user variables from kicad_common.json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-pathvars-'));
    try {
      const cfg = path.join(dir, 'cfg', '10.0');
      const data = path.join(dir, 'data');
      await mkdir(cfg, { recursive: true });
      await mkdir(path.join(data, 'kicad', '10.0', '3rdparty', 'footprints', 'PCM_Espressif.pretty'), { recursive: true });
      await mkdir(path.join(dir, 'vendor', 'Mine.pretty'), { recursive: true });
      await writeFile(
        path.join(cfg, 'fp-lib-table'),
        '(fp_lib_table\n\t(version 7)\n' +
          '\t(lib (name "PCM_Espressif")(type "KiCad")(uri "${KICAD10_3RD_PARTY}/footprints/PCM_Espressif.pretty")(options "")(descr ""))\n' +
          '\t(lib (name "Mine")(type "KiCad")(uri "${MY_PARTS}/Mine.pretty")(options "")(descr ""))\n)\n',
        'utf8',
      );
      await writeFile(path.join(cfg, 'kicad_common.json'), JSON.stringify({ environment: { vars: { MY_PARTS: path.join(dir, 'vendor') } } }), 'utf8');
      const env = { HOME: dir, KICAD_CONFIG_HOME: path.join(dir, 'cfg'), XDG_DATA_HOME: data };
      const { rows } = await libTableRows('fp', { projectDir: dir, env, platform: 'linux', kicadMajor: 10 });
      expect(rows.get('PCM_Espressif')?.uri).toBe(path.join(data, 'kicad', '10.0', '3rdparty', 'footprints', 'PCM_Espressif.pretty'));
      expect(rows.get('Mine')?.uri).toBe(path.join(dir, 'vendor', 'Mine.pretty'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the running KiCad version picks the config (AC-15.30)', () => {
  it("reads only the running KiCad's config and variables, not the newest install's", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-versions-'));
    try {
      const data = path.join(dir, 'data');
      for (const v of ['9.0', '10.0']) {
        const major = v.split('.')[0];
        await mkdir(path.join(dir, 'cfg', v), { recursive: true });
        await mkdir(path.join(data, 'kicad', v, '3rdparty', `PCM_V${major}.pretty`), { recursive: true });
        await writeFile(
          path.join(dir, 'cfg', v, 'fp-lib-table'),
          `(fp_lib_table\n\t(version 7)\n\t(lib (name "V${major}")(type "KiCad")(uri "\${KICAD${major}_3RD_PARTY}/PCM_V${major}.pretty")(options "")(descr ""))\n)\n`,
          'utf8',
        );
      }
      const env = { HOME: dir, KICAD_CONFIG_HOME: path.join(dir, 'cfg'), XDG_DATA_HOME: data };
      const nine = await libTableRows('fp', { projectDir: dir, env, platform: 'linux', kicadMajor: 9 });
      expect([...nine.rows.keys()]).toEqual(['V9']);
      expect(nine.rows.get('V9')?.uri).toBe(path.join(data, 'kicad', '9.0', '3rdparty', 'PCM_V9.pretty'));
      expect(nine.searched).toEqual(['global fp-lib-table (KiCad 9.0)']);
      const ten = await libTableRows('fp', { projectDir: dir, env, platform: 'linux', kicadMajor: 10 });
      expect([...ten.rows.keys()]).toEqual(['V10']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fills in only the running KiCad's stock-footprint variable", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-versions-'));
    try {
      await writeFile(
        path.join(dir, 'fp-lib-table'),
        '(fp_lib_table\n\t(version 7)\n' +
          '\t(lib (name "Nine")(type "KiCad")(uri "${KICAD9_FOOTPRINT_DIR}/Resistor_SMD.pretty")(options "")(descr ""))\n' +
          '\t(lib (name "Ten")(type "KiCad")(uri "${KICAD10_FOOTPRINT_DIR}/Resistor_SMD.pretty")(options "")(descr ""))\n)\n',
        'utf8',
      );
      const r = await FootprintResolver.create({ projectDir: dir, env: hermetic(), global: false, stockDirs: [stock], kicadMajor: 10 });
      expect(await r.resolve('Ten:R_0603_1608Metric')).toMatchObject({ ok: true });
      expect(await r.resolve('Nine:R_0603_1608Metric')).toMatchObject({ ok: false, why: 'no-library' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("searches only the running KiCad's versioned footprint dir when several are exported", async () => {
    const nine = await mkdtemp(path.join(tmpdir(), 'copperhead-fp9-'));
    const ten = await mkdtemp(path.join(tmpdir(), 'copperhead-fp10-'));
    const generic = await mkdtemp(path.join(tmpdir(), 'copperhead-fpgen-'));
    try {
      const env = { KICAD9_FOOTPRINT_DIR: nine, KICAD10_FOOTPRINT_DIR: ten };
      expect(await footprintSearchDirs(env, undefined, 9)).toEqual([nine]);
      expect(await footprintSearchDirs(env, undefined, 10)).toEqual([ten]);
      // the generic override always applies, ahead of the versioned dir
      expect(await footprintSearchDirs({ ...env, KICAD_FOOTPRINT_DIR: generic }, undefined, 9)).toEqual([generic, nine]);
      // unknown version: every exported dir, newest first, as before
      expect(await footprintSearchDirs(env)).toEqual([ten, nine]);
      // a version whose dir is not exported gets no other version's dir
      expect(await footprintSearchDirs({ KICAD10_FOOTPRINT_DIR: ten }, undefined, 9)).not.toContain(ten);
    } finally {
      for (const d of [nine, ten, generic]) await rm(d, { recursive: true, force: true });
    }
  });
});

describe('exact footprint resolution (AC-15.29, AC-15.30, AC-15.33)', () => {
  it('resolves a library that exists only in the project fp-lib-table, with no KICAD_* variables set', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-fpres-'));
    try {
      await projectLibrary(repo, 'Espressif', 'ESP32-C3-MINI-1', 'Resistor_SMD:R_0603_1608Metric');
      const r = await FootprintResolver.create({ projectDir: repo, env: {}, stockDirs: [], global: false });
      const hit = await r.resolve('Espressif:ESP32-C3-MINI-1');
      expect(hit).toMatchObject({ ok: true, library: 'project fp-lib-table' });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('never substitutes: a missing library or name is a miss with suggestions, not a fallback', async () => {
    const r = await FootprintResolver.create({ projectDir: emptyConfig, env: hermetic(), global: false });
    expect(await r.resolve('Resistor_SMD:R_0603_1608Metric')).toMatchObject({ ok: true });
    const noLib = await r.resolve('Resistors:R_0603_1608Metric');
    expect(noLib).toMatchObject({ ok: false, why: 'no-library' });
    expect(noLib.ok ? [] : noLib.near).toContain('Resistor_SMD:R_0603_1608Metric');
    const noName = await r.resolve('Resistor_SMD:R_0603_1608Metrc');
    expect(noName).toMatchObject({ ok: false, why: 'no-footprint' });
    expect(noName.ok ? [] : noName.near.length).toBeGreaterThan(0);
    expect(await r.resolve('R_0603')).toMatchObject({ ok: false, why: 'bad-id' });
  });

  it('a typo in both the library and the name still shows the installed id, flagged as a guess', async () => {
    const r = await FootprintResolver.create({ projectDir: emptyConfig, env: hermetic(), global: false });
    const both = await r.resolve('Resistors:R_0603_1608Metrc');
    expect(both).toMatchObject({ ok: false, why: 'no-library', fuzzy: true });
    expect(both.ok ? [] : both.near).toContain('Resistor_SMD:R_0603_1608Metric');
    // an exact name found under another nickname is not a guess
    const exact = await r.resolve('Resistors:R_0603_1608Metric');
    expect(exact).toMatchObject({ ok: false, why: 'no-library' });
    expect(exact.ok || exact.fuzzy).toBeFalsy();
    // the stop message says which kind it is showing
    const missing = await missingFootprints([{ ref: 'R1', footprint: 'Resistors:R_0603_1608Metrc' }], r);
    expect(formatMissingFootprints(missing, r.searched, 'x')).toContain('closest installed: Resistor_SMD:R_0603_1608Metric');
  });

  it('the stop message names every part, the fix, and no absolute path', async () => {
    const r = await FootprintResolver.create({ projectDir: emptyConfig, env: hermetic(), global: false });
    const missing = await missingFootprints(
      [
        { ref: 'U3', footprint: 'Espressif:ESP32-C3-MINI-1' },
        { ref: 'R1', footprint: 'Resistor_SMD:R_0603_1608Metric' },
        { ref: 'J9', footprint: '' },
      ],
      r,
    );
    expect(missing.map((m) => m.ref)).toEqual(['J9', 'U3']);
    const msg = formatMissingFootprints(missing, r.searched, 'the schematic stage');
    expect(msg).toContain('U3');
    expect(msg).toContain('no library named "Espressif"');
    expect(msg).toContain('no footprint assigned in BOM.md');
    expect(msg).toContain('(lib (name "Espressif")(type "KiCad")(uri "${KIPRJMOD}/Espressif.pretty")');
    expect(msg).toContain('re-run `copperhead create` (it resumes at the schematic stage)');
    expect(msg).not.toMatch(/\/(usr|home|tmp)\//);
  });
});

describe('board comparison (AC-15.38)', () => {
  const parts = [
    { ref: 'R1', footprint: 'Resistor_SMD:R_0603_1608Metric' },
    { ref: 'U1', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm' },
  ];
  it('passes only on the exact set of (ref, footprint) pairs', () => {
    expect(boardMatchesNetlist(parts, parts).ok).toBe(true);
    expect(boardMatchesNetlist([], parts)).toMatchObject({ ok: false, missing: ['R1', 'U1'] });
    expect(boardMatchesNetlist([parts[0]!], parts)).toMatchObject({ ok: false, missing: ['U1'] });
    expect(boardMatchesNetlist([...parts, { ref: 'X1', footprint: 'A:B' }], parts)).toMatchObject({ ok: false, extra: ['X1'] });
    const swapped = [parts[0]!, { ref: 'U1', footprint: 'Package_SO:SOIC-8_5.3x5.3mm_P1.27mm' }];
    expect(boardMatchesNetlist(swapped, parts).ok).toBe(false);
    expect(boardMatchesNetlist(swapped, parts).changed[0]).toContain('U1');
  });
});

describe('populateBoard against kicad-cli (AC-15.36, AC-15.37)', () => {
  it('puts every part on the board with its exact footprint, pads, and nets; DRC and schematic parity are clean', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      const res = await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      expect(res.unchanged).toBe(false);
      const board = await readFile(path.join(repo, PCB), 'utf8');
      const netlist = parseNetlist(await exportNetlist(path.join(repo, SCH)));
      expect(boardMatchesNetlist(boardFootprints(board), netlist.parts).ok).toBe(true);
      expect(netlist.parts.map((p) => p.ref)).toEqual(['C1', 'J1', 'R1', 'R2', 'U1']);

      // every pad's net is the netlist's
      for (const [name, nodes] of netlist.nets) {
        for (const [ref, pin] of nodes) {
          const fp = board.slice(board.indexOf(`(property "Reference" "${ref}"`));
          const pad = fp.slice(fp.indexOf(`(pad "${pin}"`));
          expect(pad.slice(0, pad.indexOf('\n\t\t)'))).toContain(`"${name.replace(/"/g, '\\"')}")`);
        }
      }

      // pad geometry is the library's, byte-for-byte apart from the net line
      const lib = await readFile(path.join(stock, 'Package_SO.pretty', 'SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod'), 'utf8');
      const libPads = lib.match(/\n\t\(pad [\s\S]*?\n\t\)/g)!;
      const flat = (s: string): string =>
        s
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => !l.startsWith('(net '))
          .join('\n');
      const boardFlat = flat(board);
      for (const p of libPads) expect(boardFlat).toContain(flat(p));

      // KiCad agrees: no violations, and the board matches the schematic
      const out = path.join(repo, 'drc.json');
      await execa(resolveKicadCli(), ['pcb', 'drc', '--schematic-parity', '--format', 'json', '--output', out, path.join(repo, PCB)], {
        reject: false,
        env: seeded(),
      });
      const drc = JSON.parse(await readFile(out, 'utf8')) as { violations: unknown[]; schematic_parity: unknown[] };
      expect(drc.violations).toEqual([]);
      expect(drc.schematic_parity).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('a value holding a tab and a newline reaches the board escaped, and the board still loads', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      // the schematic carries the escapes KiCad's reader turns into the characters
      const p = path.join(repo, SCH);
      const text = await readFile(p, 'utf8');
      expect(text).toContain('(property "Value" "100n"');
      await writeFile(p, text.replace('(property "Value" "100n"', '(property "Value" "100n\\tX\\nY"'), 'utf8');
      const res = await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      expect(res.unchanged).toBe(false);
      const board = await readFile(path.join(repo, PCB), 'utf8');
      expect(board).toContain('(property "Value" "100n\\tX\\nY"');
      // populate proved the board loads; KiCad reads the escapes back as the characters
      const netlist = parseNetlist(await exportNetlist(path.join(repo, SCH)));
      expect(netlist.parts.find((q) => q.ref === 'C1')?.value).toBe('100n\tX\nY');
    } finally {
      await cleanup();
    }
  }, 120_000);

  it('is idempotent and deterministic: a second run writes nothing, and two fresh runs agree byte-for-byte', async () => {
    const a = await draftedProject();
    const b = await draftedProject();
    try {
      await populateBoard({ repoRoot: a.repo, schematic: SCH, board: PCB, env: hermetic() });
      await populateBoard({ repoRoot: b.repo, schematic: SCH, board: PCB, env: hermetic() });
      const first = await readFile(path.join(a.repo, PCB), 'utf8');
      expect(await readFile(path.join(b.repo, PCB), 'utf8')).toBe(first);
      const again = await populateBoard({ repoRoot: a.repo, schematic: SCH, board: PCB, env: hermetic() });
      expect(again.unchanged).toBe(true);
      expect(await readFile(path.join(a.repo, PCB), 'utf8')).toBe(first);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('a footprint that is not installed throws and leaves the board byte-identical', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await setSchematicFootprint(repo, 'Capacitor_SMD:C_0402_1005Metric', 'Espressif:ESP32-C3-MINI-1');
      const before = await readFile(path.join(repo, PCB), 'utf8');
      const err = await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MissingFootprintsError);
      expect((err as MissingFootprintsError).missing).toMatchObject([{ ref: 'C1', footprint: 'Espressif:ESP32-C3-MINI-1', why: 'no-library' }]);
      expect(await readFile(path.join(repo, PCB), 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('refuses a pin its footprint has no pad for, instead of silently dropping the net', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      // a one-pad test point under a two-pin resistor: pin 2's net has nowhere to go
      await setSchematicFootprint(repo, 'Capacitor_SMD:C_0402_1005Metric', 'TestPoint:TestPoint_Pad_D1.0mm');
      const before = await readFile(path.join(repo, PCB), 'utf8');
      const err = await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PadMismatchError);
      expect((err as PadMismatchError).mismatches).toEqual([
        { ref: 'C1', footprint: 'TestPoint:TestPoint_Pad_D1.0mm', pins: ['2'], pads: ['1'] },
      ]);
      expect((err as Error).message).toContain('C1: pin(s) 2 have no pad in footprint TestPoint:TestPoint_Pad_D1.0mm (its pads: 1)');
      expect(await readFile(path.join(repo, PCB), 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('the scaffold allows the 0.2 mm thermal vias stock QFN footprints carry', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      const pro = JSON.parse(await readFile(path.join(repo, 'demo-board.kicad_pro'), 'utf8'));
      expect(pro.board.design_settings.rules.min_through_hole_diameter).toBe(0.2);
    } finally {
      await cleanup();
    }
  });

  it('places a footprint from a project-local library under its exact id', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await projectLibrary(repo, 'Espressif', 'Cap_Custom', 'Capacitor_SMD:C_0402_1005Metric');
      await setSchematicFootprint(repo, 'Capacitor_SMD:C_0402_1005Metric', 'Espressif:Cap_Custom');
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      const onBoard = boardFootprints(await readFile(path.join(repo, PCB), 'utf8'));
      expect(onBoard.find((f) => f.ref === 'C1')?.footprint).toBe('Espressif:Cap_Custom');
    } finally {
      await cleanup();
    }
  });

  it('refuses to touch a board whose footprints disagree with the schematic', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      await setSchematicFootprint(repo, 'Capacitor_SMD:C_0402_1005Metric', 'Capacitor_SMD:C_0603_1608Metric');
      const before = await readFile(path.join(repo, PCB), 'utf8');
      await expect(populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() })).rejects.toThrow(/do not match the schematic/);
      expect(await readFile(path.join(repo, PCB), 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  });
});

describe('layout-draft completion compares the board with the schematic (AC-15.38)', () => {
  const layoutDraft = STAGES.find((s) => s.name === 'layout-draft')!;
  // completion runs kicad-cli DRC, which resolves stock footprints through a global table
  beforeEach(() => {
    vi.stubEnv('KICAD_CONFIG_HOME', seededConfig);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const withLayoutDoc = async (repo: string): Promise<void> =>
    writeFile(path.join(repo, 'docs', 'LAYOUT.md'), '# Layout\n\n## Draft quality\n\nGrid placement; route by hand.\n', 'utf8');

  it('an outline-only board never completes the stage, even with the LAYOUT.md section', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await withLayoutDoc(repo);
      expect(await layoutDraft.isComplete(repo, 'docs/')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('the populated board completes it; a renamed or swapped footprint does not', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await withLayoutDoc(repo);
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      expect(await layoutDraft.isComplete(repo, 'docs/')).toBe(true);
      const board = path.join(repo, PCB);
      const populated = await readFile(board, 'utf8');
      await writeFile(board, populated.replace('(property "Reference" "C1"', '(property "Reference" "C9"'), 'utf8');
      expect(await layoutDraft.isComplete(repo, 'docs/')).toBe(false); // C1 missing, C9 extra
      await writeFile(
        board,
        populated.replace('(footprint "Capacitor_SMD:C_0402_1005Metric"', '(footprint "Capacitor_SMD:C_0603_1608Metric"'),
        'utf8',
      );
      expect(await layoutDraft.isComplete(repo, 'docs/')).toBe(false); // footprint changed
    } finally {
      await cleanup();
    }
  });

  it('a board that fails DRC does not complete it, even with every part and the LAYOUT.md section', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await withLayoutDoc(repo);
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      expect(await layoutDraft.isComplete(repo, 'docs/')).toBe(true);
      const board = path.join(repo, PCB);
      const populated = await readFile(board, 'utf8');
      // C1 dropped on top of R1: overlapping courtyards and shorted pads
      const r1 = /\(property "Reference" "R1"/.exec(populated)!.index;
      const at = /\(at ([-\d.]+) ([-\d.]+)\)/.exec(populated.slice(populated.lastIndexOf('(footprint ', r1)))!;
      await writeFile(board, moveFootprint(populated, 'C1', Number(at[1]), Number(at[2])), 'utf8');
      expect(await layoutDraft.isComplete(repo, 'docs/')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('a pad moved to another net does not complete it, and populate will not keep stale nets', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await withLayoutDoc(repo);
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      const board = path.join(repo, PCB);
      const populated = await readFile(board, 'utf8');
      const netlist = parseNetlist(await exportNetlist(path.join(repo, SCH)));
      expect(padNetMismatches(populated, netlist)).toEqual([]);
      // R1 pad 1 re-netted by hand (what an edit_file "fix" for a short would do)
      const r1 = populated.indexOf('(property "Reference" "R1"');
      const pad = populated.indexOf('(pad "1"', r1);
      const net = populated.indexOf('(net ', pad);
      const netEnd = populated.indexOf(')', net) + 1;
      const renetted = populated.slice(0, net) + '(net 0 "")' + populated.slice(netEnd);
      await writeFile(board, renetted, 'utf8');
      expect(padNetMismatches(renetted, netlist)).toEqual([expect.stringMatching(/^R1\.1 \(no net, schematic /)]);
      expect(await layoutDraft.isComplete(repo, 'docs/')).toBe(false);
      await expect(populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() })).rejects.toThrow(
        /1 pad net\(s\) differ from the schematic/,
      );
    } finally {
      await cleanup();
    }
  });
});

describe('project symbol libraries (AC-15.31)', () => {
  it('a symbol library named only in the project sym-lib-table resolves', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-symtable-'));
    try {
      await mkdir(path.join(repo, 'lib'));
      await cp(path.join(SYMLIB, 'CopperMCU.kicad_sym'), path.join(repo, 'lib', 'Espressif.kicad_sym'));
      await writeFile(
        path.join(repo, 'sym-lib-table'),
        '(sym_lib_table\n\t(version 7)\n\t(lib (name "Espressif")(type "KiCad")(uri "${KIPRJMOD}/lib/Espressif.kicad_sym")(options "")(descr ""))\n)\n',
        'utf8',
      );
      // no stock dirs at all: only the project table can answer
      const sym = await new SymbolSource(repo, [], false).resolve('Espressif:MCU8');
      expect(sym.pins.length).toBeGreaterThan(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('drafting keeps the rows a user added to sym-lib-table', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      const table = path.join(repo, 'sym-lib-table');
      const userRow = '(lib (name "Espressif")(type "KiCad")(uri "${KIPRJMOD}/lib/Espressif.kicad_sym")(options "")(descr ""))';
      const drafted = await readFile(table, 'utf8');
      await writeFile(table, drafted.replace('(version 7)', `(version 7)\n\t${userRow}`), 'utf8');
      const res = await draftSchematic({
        repoRoot: repo,
        schematic: SCH,
        intentPath: 'schematic.intent.json',
        docsDir: path.join(repo, 'docs'),
        symbolDirs: [SYMLIB],
      });
      expect(res.ok).toBe(true);
      const after = await readFile(table, 'utf8');
      expect(after).toContain(userRow);
      expect(after).toContain('copperhead vendored'); // the vendored rows are still written
    } finally {
      await cleanup();
    }
  });

  it('keeps a user row verbatim however it is laid out: multi-line, unquoted name, nested Table', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      const table = path.join(repo, 'sym-lib-table');
      const rows = [
        '(lib\n\t\t(name "UserLib")\n\t\t(type "KiCad")\n\t\t(uri "${KIPRJMOD}/lib/UserLib.kicad_sym")\n\t\t(options "")\n\t\t(descr "multi-line")\n\t)',
        '(lib (name Bare)(type KiCad)(uri "${KIPRJMOD}/lib/Bare.kicad_sym")(options "")(descr ""))',
        '(lib (name "Vendor")(type "Table")(uri "${KIPRJMOD}/vendor/sym-lib-table")(options "")(descr ""))',
      ];
      const drafted = await readFile(table, 'utf8');
      await writeFile(table, drafted.replace('(version 7)', `(version 7)\n\t${rows.join('\n\t')}`), 'utf8');
      const res = await draftSchematic({
        repoRoot: repo,
        schematic: SCH,
        intentPath: 'schematic.intent.json',
        docsDir: path.join(repo, 'docs'),
        symbolDirs: [SYMLIB],
      });
      expect(res.ok).toBe(true);
      const after = await readFile(table, 'utf8');
      for (const row of rows) expect(after).toContain(row);
      // still a table KiCad (and copperhead) can read, with each row whole
      expect(symLibTableRows(after).map((r) => r.name)).toEqual(expect.arrayContaining(['UserLib', 'Bare', 'Vendor']));
    } finally {
      await cleanup();
    }
  });

  it('refuses to rewrite a sym-lib-table it cannot parse, and leaves it as it was', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      const table = path.join(repo, 'sym-lib-table');
      const broken = '(sym_lib_table\n\t(version 7)\n\t(lib (name "UserLib")(type "KiCad")\n';
      await writeFile(table, broken, 'utf8');
      const res = await draftSchematic({
        repoRoot: repo,
        schematic: SCH,
        intentPath: 'schematic.intent.json',
        docsDir: path.join(repo, 'docs'),
        symbolDirs: [SYMLIB],
      });
      expect(res.ok).toBe(false);
      expect(res.ok ? '' : res.message).toMatch(/sym-lib-table is not a readable library table/);
      expect(await readFile(table, 'utf8')).toBe(broken);
    } finally {
      await cleanup();
    }
  });

  it('refuses a sym-lib-table with content outside the list, rather than dropping it on rewrite', async () => {
    const row = '\t(lib (name "UserLib")(type "KiCad")(uri "x.kicad_sym")(options "")(descr ""))\n';
    const good = `(sym_lib_table\n\t(version 7)\n${row})\n`;
    expect(symLibTableRows(good).map((r) => r.name)).toEqual(['UserLib']);
    expect(() => symLibTableRows(`(lib (name "Stray"))\n${good}`)).toThrow(/before the \(sym_lib_table/);
    expect(() => symLibTableRows(`${good}(lib (name "Stray"))\n`)).toThrow(/after the \(sym_lib_table/);
    expect(() => symLibTableRows(`${good}garbage`)).toThrow(/after the \(sym_lib_table/);
    const { repo, cleanup } = await draftedProject();
    try {
      const table = path.join(repo, 'sym-lib-table');
      const trailing = `${good}(lib (name "Stray")(type "KiCad")(uri "y.kicad_sym")(options "")(descr ""))\n`;
      await writeFile(table, trailing, 'utf8');
      const res = await draftSchematic({
        repoRoot: repo,
        schematic: SCH,
        intentPath: 'schematic.intent.json',
        docsDir: path.join(repo, 'docs'),
        symbolDirs: [SYMLIB],
      });
      expect(res.ok).toBe(false);
      expect(res.ok ? '' : res.message).toMatch(/sym-lib-table is not a readable library table/);
      expect(await readFile(table, 'utf8')).toBe(trailing);
    } finally {
      await cleanup();
    }
  });

  it('a project library stays the source after a draft uses it, so its other symbols stay reachable', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-symtable-'));
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      const sch = await bootstrapKicadProject(repo, '# Demo board');
      await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
      // UserLib, named only in the project table, holds two of the fixture's symbols
      const mcu = await readFile(path.join(SYMLIB, 'CopperMCU.kicad_sym'), 'utf8');
      const conn = await readFile(path.join(SYMLIB, 'CopperConn.kicad_sym'), 'utf8');
      const connSym = childSpans(conn, conn.indexOf('(kicad_symbol_lib')).find((x) => x.tag === 'symbol')!;
      await mkdir(path.join(repo, 'lib'));
      await writeFile(path.join(repo, 'lib', 'UserLib.kicad_sym'), `${mcu.slice(0, mcu.lastIndexOf(')'))}\t${conn.slice(connSym.start, connSym.end)}\n)\n`, 'utf8');
      const row = '(lib (name "UserLib")(type "KiCad")(uri "${KIPRJMOD}/lib/UserLib.kicad_sym")(options "")(descr "user"))';
      await writeFile(path.join(repo, 'sym-lib-table'), `(sym_lib_table\n\t(version 7)\n\t${row}\n)\n`, 'utf8');
      const intent = await readFile(path.join(DRAFT_FIXTURE, 'schematic.intent.json'), 'utf8');
      const draft = async (text: string): ReturnType<typeof draftSchematic> => {
        await writeFile(path.join(repo, 'schematic.intent.json'), text, 'utf8');
        return draftSchematic({ repoRoot: repo, schematic: sch!, intentPath: 'schematic.intent.json', docsDir: path.join(repo, 'docs'), symbolDirs: [SYMLIB] });
      };
      const first = intent.replace('"CopperMCU:MCU8"', '"UserLib:MCU8"');
      expect((await draft(first)).ok).toBe(true);
      const table = await readFile(path.join(repo, 'sym-lib-table'), 'utf8');
      expect(table).toContain(row);
      expect(symLibTableRows(table).filter((r) => r.name === 'UserLib')).toHaveLength(1);
      // the next draft reaches another symbol in the same library
      const second = await draft(first.replace('"CopperConn:Conn_01x03"', '"UserLib:Conn_01x03"'));
      expect(second.ok ? '' : second.message).toBe('');
      // and KiCad sees the sheet's symbols as the library's own
      const erc = await runErc(path.join(repo, sch!));
      expect(erc.violations.filter((v) => v.type === 'lib_symbol_mismatch')).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('a project in a subfolder resolves a library named in the sym-lib-table beside its schematic', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-symtable-'));
    try {
      await mkdir(path.join(repo, 'hardware', 'lib'), { recursive: true });
      await cp(path.join(SYMLIB, 'CopperMCU.kicad_sym'), path.join(repo, 'hardware', 'lib', 'Espressif.kicad_sym'));
      await writeFile(
        path.join(repo, 'hardware', 'sym-lib-table'),
        '(sym_lib_table\n\t(version 7)\n\t(lib (name "Espressif")(type "KiCad")(uri "${KIPRJMOD}/lib/Espressif.kicad_sym")(options "")(descr ""))\n)\n',
        'utf8',
      );
      await expect(new SymbolSource(repo, [], false).resolve('Espressif:MCU8')).rejects.toThrow();
      const sym = await new SymbolSource(repo, [], false, path.join(repo, 'hardware')).resolve('Espressif:MCU8');
      expect(sym.pins.length).toBeGreaterThan(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('part selection verifies footprints (#314)', () => {
  const BOM = (fp: string): string =>
    '# BOM\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n' +
    `| R1 | 10k | \`Resistor_SMD:R_0603_1608Metric\` | RC0603FR-0710KL | bias |\n| F1 | 4A | ${fp} | 2920L400 | fuse |\n\n` +
    '## Pins\n\n| Refdes | lib_id | Pins used |\n|---|---|---|\n| F1 | Device:Fuse | 1=VBUS,2=VOUT |\n\n' +
    '## Cost\n\n| Refdes | Qty | Cost |\n|---|---|---|\n| R1 | 1 | $0.01 |\n';

  it('reads footprints only from tables with a Footprint column, first row per refdes', () => {
    expect(bomFootprintRows(BOM('Fuse:Fuse_2920_7451Metric'))).toEqual([
      { refdes: 'R1', footprint: 'Resistor_SMD:R_0603_1608Metric' },
      { refdes: 'F1', footprint: 'Fuse:Fuse_2920_7451Metric' },
    ]);
  });

  it('check_footprints answers OK or the reason with the closest installed ids', async () => {
    const ctx = {
      repoRoot: emptyConfig,
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
    } as RunContext;
    const out = JSON.stringify(
      await dispatchTool(ctx, 'check_footprints', { footprints: ['Fuse:Fuse_2920_7451Metric', 'Fuse:Fuse_2920_7351Metric'] }),
    );
    expect(out).toContain('OK  Fuse:Fuse_2920_7451Metric');
    expect(out).toContain('MISS Fuse:Fuse_2920_7351Metric: library \\"Fuse\\" has no such footprint; installed: Fuse:Fuse_2920_7451Metric');
  });

  it('a made-up footprint keeps part selection open for the model; an uninstalled library is left to the stop', async () => {
    const partSelection = STAGES.find((s) => s.name === 'part-selection')!;
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-partsel-'));
    try {
      await mkdir(path.join(repo, 'docs'));
      await writeFile(path.join(repo, 'docs', 'BOM.md'), BOM('Fuse:Fuse_2920_7351Metric'), 'utf8');
      expect(await partSelection.isComplete(repo, 'docs/')).toBe(false); // invented name: the model fixes it
      await writeFile(path.join(repo, 'docs', 'BOM.md'), BOM('Fuse:Fuse_2920_7451Metric'), 'utf8');
      expect(await partSelection.isComplete(repo, 'docs/')).toBe(true);
      await writeFile(path.join(repo, 'docs', 'BOM.md'), BOM('Espressif:ESP32-C3-MINI-1'), 'utf8');
      expect(await partSelection.isComplete(repo, 'docs/')).toBe(true); // not installed: the run stops for the user next
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('moving placed footprints (#314)', () => {
  /** KiCad DRC on the board, through copperhead's own report normalizer. */
  async function drc(repo: string) {
    const out = path.join(repo, 'drc.json');
    await execa(resolveKicadCli(), ['pcb', 'drc', '--format', 'json', '--output', out, path.join(repo, PCB)], { reject: false, env: seeded() });
    const raw = JSON.parse(await readFile(out, 'utf8')) as { violations: { type: string }[] };
    return { raw, report: normalizeReport(raw, 'drc') };
  }

  it('rotating with moveFootprint turns the pads too: the part still matches its library', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      const board = path.join(repo, PCB);
      const populated = await readFile(board, 'utf8');
      // open space at the bottom-right of the 30x20 scaffold outline
      await writeFile(board, moveFootprint(moveFootprint(populated, 'U1', 118, 113, 90), 'C1', 108, 116, 270), 'utf8');
      const moved = await drc(repo);
      expect(moved.raw.violations.filter((v) => v.type === 'lib_footprint_mismatch')).toEqual([]);
      expect(moved.report.intrinsic).toEqual([]);
      const u1 = boardFootprints(await readFile(board, 'utf8')).find((f) => f.ref === 'U1');
      expect(u1?.footprint).toBe('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm');

      // the naive edit — only the footprint's own angle — is what KiCad calls a modified footprint,
      // and its internal findings are then NOT excused as library-intrinsic
      const i = populated.indexOf('(property "Reference" "U1"');
      const at = populated.indexOf('(at ', populated.lastIndexOf('(footprint ', i));
      const naive = populated.slice(0, at) + '(at 118 113 90)' + populated.slice(populated.indexOf(')', at) + 1);
      await writeFile(board, naive, 'utf8');
      const hand = await drc(repo);
      expect(hand.raw.violations.some((v) => v.type === 'lib_footprint_mismatch')).toBe(true);
      expect(hand.report.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('is a spec-gated mutation tool, like edit_file', () => {
    const tool = catalog.find((t) => t.schema.name === 'move_footprint') as { gate?: (ctx: { editsUnlocked: boolean }) => boolean } | undefined;
    expect(tool?.gate?.({ editsUnlocked: false })).toBe(false);
    expect(tool?.gate?.({ editsUnlocked: true })).toBe(true);
  });

  it('refuses an unknown refdes', () => {
    expect(() => moveFootprint('(kicad_pcb\n)', 'X9', 0, 0)).toThrow(/no footprint with refdes X9/);
  });
});

describe('populate edge cases (#314)', () => {
  const LEGACY = `(module R_0603_1608Metric (layer F.Cu) (tedit 5F68FEEE)
  (descr "Resistor SMD 0603")
  (attr smd)
  (fp_text reference REF** (at 0 -1.43) (layer F.SilkS)
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (fp_text value R_0603_1608Metric (at 0 1.43) (layer F.Fab)
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (fp_line (start -0.8 0.4125) (end -0.8 -0.4125) (layer F.Fab) (width 0.1))
  (pad 1 smd roundrect (at -0.7875 0) (size 0.875 0.95) (layers F.Cu F.Paste F.Mask) (roundrect_rratio 0.25))
  (pad 2 smd roundrect (at 0.7875 0) (size 0.875 0.95) (layers F.Cu F.Paste F.Mask) (roundrect_rratio 0.25))
)
`;

  it('instantiates a KiCad 5 (module …) footprint that KiCad then loads', async () => {
    const fp = instantiateFootprint(LEGACY, {
      fpId: 'Legacy:R_0603_1608Metric',
      ref: 'R7',
      value: '10k',
      uuid: '00000000-0000-0000-0000-000000000007',
      at: { x: 110, y: 110 },
      path: '/x',
      sheetname: '/',
      sheetfile: 'demo.kicad_sch',
      padNet: (pad) => (pad === '1' ? [1, 'VCC'] : undefined),
    });
    expect(fp).toContain('(footprint "Legacy:R_0603_1608Metric"');
    expect(fp).toContain('(fp_text reference "R7"');
    expect(fp).toContain('(fp_text value "10k"');
    expect(fp).not.toContain('tedit');
    expect(fp).toContain('(net 1 "VCC")');
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-legacy-'));
    try {
      const board = path.join(dir, 'legacy.kicad_pcb');
      const text = `(kicad_pcb (version 20240108) (generator "pcbnew")\n\t(general (thickness 1.6))\n\t(paper "A4")\n\t(layers\n\t\t(0 "F.Cu" signal)\n\t\t(31 "B.Cu" signal)\n\t\t(44 "Edge.Cuts" user)\n\t)\n\t(net 0 "")\n\t(net 1 "VCC")\n${fp}\n)\n`;
      await writeFile(board, text, 'utf8');
      expect(await kicadLoadError(board)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("moves a footprint's zones with it: ESP32 modules match their library wherever they are placed or turned", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-zones-'));
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await bootstrapKicadProject(repo, '# Demo board');
      const board = path.join(repo, PCB);
      const scaffold = await readFile(board, 'utf8');
      const mismatches = async (text: string): Promise<number> => {
        await writeFile(board, text, 'utf8');
        const out = path.join(repo, 'drc.json');
        await execa(resolveKicadCli(), ['pcb', 'drc', '--format', 'json', '--output', out, board], { reject: false, env: seeded() });
        const raw = JSON.parse(await readFile(out, 'utf8')) as { violations: { type: string }[] };
        return raw.violations.filter((v) => v.type === 'lib_footprint_mismatch').length;
      };
      for (const id of ['RF_Module:ESP32-WROOM-32', 'RF_Module:ESP32-C3-WROOM-02', 'RF_Module:ESP32-S3-WROOM-1']) {
        const [lib, name] = id.split(':') as [string, string];
        const mod = await readFile(path.join(stock, `${lib}.pretty`, `${name}.kicad_mod`), 'utf8');
        expect(mod).toContain('(zone');
        const fp = instantiateFootprint(mod, {
          fpId: id,
          ref: 'U1',
          value: name,
          uuid: '00000000-0000-0000-0000-000000000001',
          at: { x: 120, y: 120 },
          path: '/x',
          sheetname: '/',
          sheetfile: 'demo-board.kicad_sch',
          padNet: () => undefined,
        });
        const placed = scaffold.slice(0, scaffold.lastIndexOf(')')) + fp + '\n)\n';
        expect(await mismatches(placed), `${id} placed off-origin`).toBe(0);
        for (const rot of [90, 45]) {
          expect(await mismatches(moveFootprint(placed, 'U1', 150, 140, rot)), `${id} moved and turned ${rot}`).toBe(0);
        }
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 120_000);

  it('gives every object inside a placed footprint its own id, so two instances of one footprint share none', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-ids-'));
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await bootstrapKicadProject(repo, '# Demo board');
      const board = path.join(repo, PCB);
      const scaffold = await readFile(board, 'utf8');
      const id = 'MountingHole:MountingHole_4.3x6.2mm_M4_Pad';
      const mod = await readFile(path.join(stock, 'MountingHole.pretty', 'MountingHole_4.3x6.2mm_M4_Pad.kicad_mod'), 'utf8');
      expect((mod.match(/\(uuid /g) ?? []).length).toBeGreaterThan(1); // the library carries nested ids
      const inst = (ref: string, x: number, k: number): string =>
        instantiateFootprint(mod, {
          fpId: id,
          ref,
          value: 'MountingHole',
          uuid: `00000000-0000-0000-0000-00000000000${k}`,
          at: { x, y: 110 },
          path: `/${ref}`,
          sheetname: '/',
          sheetfile: 'demo-board.kicad_sch',
          padNet: () => undefined,
        });
      const text = `${scaffold.slice(0, scaffold.lastIndexOf(')'))}${inst('H1', 108, 1)}\n${inst('H2', 122, 2)}\n)\n`;
      const ids = [...text.matchAll(/\(uuid "([^"]+)"\)/g)].map((m) => m[1]);
      expect(new Set(ids).size).toBe(ids.length);
      expect(inst('H1', 108, 1)).toBe(inst('H1', 108, 1)); // deterministic
      await writeFile(board, text, 'utf8');
      const out = path.join(repo, 'drc.json');
      await execa(resolveKicadCli(), ['pcb', 'drc', '--format', 'json', '--output', out, board], { reject: false, env: seeded() });
      const raw = JSON.parse(await readFile(out, 'utf8')) as { violations: { type: string }[] };
      expect(raw.violations.filter((v) => v.type === 'lib_footprint_mismatch')).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  /** Replace the scaffold's gr_rect outline with Edge.Cuts lines around `c`, plus any extra items. */
  const polyOutline = (text: string, c: number[][], extra = ''): string => {
    const start = text.indexOf('(gr_rect');
    const end = text.indexOf('\n\t)', start) + 3;
    const seg = (a: number[], b: number[], i: number): string =>
      `(gr_line (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "00000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}"))`;
    return text.slice(0, start) + c.map((p, i) => seg(p, c[(i + 1) % c.length]!, i)).join('\n\t') + extra + text.slice(end);
  };
  const lineOutline = (text: string, x1: number, y1: number, x2: number, y2: number): string =>
    polyOutline(text, [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]);

  it('packs inside an outline it cannot grow, or stops when the parts do not fit', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      const board = path.join(repo, PCB);
      const scaffold = await readFile(board, 'utf8');
      await writeFile(board, lineOutline(scaffold, 50, 60, 55, 65), 'utf8');
      await expect(populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() })).rejects.toThrow(
        /more than the 5 x 5 mm outline .* grows only a single-rectangle outline/,
      );
      await writeFile(board, lineOutline(scaffold, 50, 60, 110, 120), 'utf8');
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      const text = await readFile(board, 'utf8');
      const ats = [...text.matchAll(/\n\t\t\(at ([-\d.]+) ([-\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      expect(ats.length).toBe(5);
      for (const [x, y] of ats) {
        expect(x).toBeGreaterThan(50);
        expect(x).toBeLessThan(110);
        expect(y).toBeGreaterThan(60);
        expect(y).toBeLessThan(120);
      }
    } finally {
      await cleanup();
    }
  });

  it('stops instead of packing parts into a corner an L-shaped outline leaves off the board, or onto a cutout', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      const board = path.join(repo, PCB);
      const scaffold = await readFile(board, 'utf8');
      // the top band is only 20 mm wide; the box around the L is 60 mm wide
      await writeFile(board, polyOutline(scaffold, [[50, 60], [70, 60], [70, 90], [110, 90], [110, 120], [50, 120]]), 'utf8');
      await expect(populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() })).rejects.toThrow(
        /would land outside the Edge\.Cuts outline .* not a single rectangle/,
      );
      expect(boardFootprints(await readFile(board, 'utf8'))).toEqual([]);
      // a rectangle with a mounting-hole cutout where the pack starts
      const hole = '\n\t(gr_circle (center 54 64) (end 56 64) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "00000000-0000-0000-0000-000000000099"))';
      await writeFile(board, polyOutline(scaffold, [[50, 60], [110, 60], [110, 120], [50, 120]], hole), 'utf8');
      await expect(populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() })).rejects.toThrow(/would land outside/);
    } finally {
      await cleanup();
    }
  });

  it('the scaffold holds board vias to a 0.3 mm drill', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-rules-'));
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await bootstrapKicadProject(repo, '# Demo board');
      const rules = await readFile(path.join(repo, 'demo-board.kicad_dru'), 'utf8');
      // a resumed stage may auto-commit it with the rest of the scaffold
      expect(isManagedPath('demo-board.kicad_dru', await loadConfig(repo))).toBe(true);
      expect(rules).toContain(`(condition "A.Type == 'Via'")`);
      expect(rules).toContain('(constraint hole_size (min 0.3mm))');
      const board = path.join(repo, PCB);
      const text = await readFile(board, 'utf8');
      const via = '\t(via (at 105 105) (size 0.6) (drill 0.2) (layers "F.Cu" "B.Cu") (net 0) (uuid "11111111-2222-3333-4444-555555555555"))\n';
      await writeFile(board, text.slice(0, text.lastIndexOf(')')) + via + ')\n', 'utf8');
      const drc = await runDrc(board);
      expect(drc.violations.map((v) => v.type)).toContain('drill_out_of_range');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('an agent run may not raise the unrouted count (AC-15.39)', () => {
  const report = (unrouted: number) => ({ ok: true, source: 'drc' as const, violations: [], unrouted, intrinsic: [] });

  it('passes while unrouted stays at the starting count, fails when it rises', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-unrouted-'));
    try {
      const board = path.join(dir, 'b.kicad_pcb');
      await writeFile(board, 'same', 'utf8');
      const ctx = { boardAtStart: 'same' } as RunContext;
      // the board is unchanged, so the baseline is this report's own count
      expect((await unroutedGuard(ctx, board, report(8))).ok).toBe(true);
      expect(ctx.unroutedBaseline).toBe(8);
      expect((await unroutedGuard(ctx, board, report(7))).ok).toBe(true);
      const worse = await unroutedGuard(ctx, board, report(9));
      expect(worse.ok).toBe(false);
      expect(worse.violations.map((v) => v.type)).toEqual(['unrouted_increase']);
      // no board at the start (or no run context board): nothing to compare
      expect((await unroutedGuard({ boardAtStart: null } as RunContext, board, report(9))).ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a starting board KiCad cannot load leaves nothing to compare, and run_drc still answers', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-unrouted-'));
    try {
      const board = path.join(dir, 'b.kicad_pcb');
      await writeFile(board, 'repaired', 'utf8');
      const ctx = { boardAtStart: '(kicad_pcb (bogus' } as RunContext;
      expect((await unroutedGuard(ctx, board, report(9))).ok).toBe(true);
      expect(ctx.unroutedBaseline).toBe(Infinity);
      // and every later call answers too, instead of throwing again
      expect((await unroutedGuard(ctx, board, report(12))).ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counts the starting board with KiCad when the board has changed since', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      const board = path.join(repo, PCB);
      const populated = await readFile(board, 'utf8');
      await writeFile(board, moveFootprint(populated, 'U1', 118, 113, 90), 'utf8');
      const ctx = { boardAtStart: populated } as RunContext;
      const now = await runDrc(board);
      const guarded = await unroutedGuard(ctx, board, now);
      expect(ctx.unroutedBaseline).toBe(now.unrouted); // a move breaks no connection
      expect(guarded.violations.some((v) => v.type === 'unrouted_increase')).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
