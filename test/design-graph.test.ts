import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { readFile, writeFile } from 'node:fs/promises';
import { listSymbols, pinNets } from '../src/kicad/sexp.js';
import { parseNetlist, unescapeNetName } from '../src/kicad/netlist.js';
import {
  classifyPart,
  isPinoutWorthy,
  mpnOf,
  manufacturerOf,
  lcscOf,
  buildGraph,
  graphPath,
  writeDesignGraph,
  readFreshGraph,
  extractDesignGraph,
  DESIGN_GRAPH_VERSION,
} from '../src/kicad/design-graph.js';
import { resetKicadCliCache } from '../src/kicad/cli.js';
import { runInit } from '../src/memory/scaffold.js';
import { checkDrift } from '../src/memory/drift.js';
import { FIXTURE, tempFixtureRepo } from './helpers.js';

const SCH = path.join(FIXTURE, 'hardware', 'open-key.kicad_sch');

describe('ingestion preserves symbol fields (issue #248 gaps 1-2)', () => {
  it('reads Datasheet, custom fields, dnp, and in_bom from placed symbols', async () => {
    const syms = await listSymbols(SCH);
    const r1 = syms.find((s) => s.ref === 'R1')!;
    expect(r1.datasheet).toBe('');
    expect(r1.dnp).toBe(false);
    expect(r1.inBom).toBe(true);
    expect(r1.fields).toEqual({});
  });

  it('keeps a real MPN instead of inventing UNVERIFIED', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      let text = await readFile(sch, 'utf8');
      text = text.replace(
        '(property "Datasheet" "~" (at 88.9 95.25 0)',
        '(property "MPN" "RC0603FR-0710KL" (at 88.9 95.25 0)\n      (effects (font (size 1.27 1.27)) hide)\n    )\n    (property "Datasheet" "~" (at 88.9 95.25 0)',
      );
      await writeFile(sch, text, 'utf8');
      const syms = await listSymbols(sch);
      const r1 = syms.find((s) => s.ref === 'R1')!;
      expect(r1.fields['MPN']).toBe('RC0603FR-0710KL');
      expect(mpnOf(r1)).toBe('RC0603FR-0710KL');
      await runInit({ repoRoot: repo, installHooks: false });
      const bom = await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8');
      expect(bom).toContain('| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL |');
    } finally {
      await cleanup();
    }
  });
});

describe('DNP and BOM-excluded parts never become orderable (gap 3)', () => {
  it('omits DNP parts from BOM.md and drift does not flag their absence', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      let text = await readFile(sch, 'utf8');
      const flagged = text.replace(
        /\(dnp no\)(\s+\(fields_autoplaced yes\)\s+\(uuid "0d0d0d0d-0000-4000-8000-000000000001"\))/,
        '(dnp yes)$1',
      );
      expect(flagged).not.toBe(text);
      text = flagged;
      await writeFile(sch, text, 'utf8');
      const syms = await listSymbols(sch);
      expect(syms.find((s) => s.ref === 'R1')!.dnp).toBe(true);
      await runInit({ repoRoot: repo, installHooks: false });
      const bom = await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8');
      expect(bom).not.toMatch(/\| R1 \|/);
      expect(bom).toMatch(/\| R2 \|/);
      const drift = await checkDrift(repo, 'docs/', 'hardware/open-key.kicad_sch');
      expect(drift.filter((d) => d.claim.includes('R1'))).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe('chip classification is derived, not prefixed (gap 4)', () => {
  it('classes connectors and regulators as pinout-worthy without a U prefix', async () => {
    const syms = await listSymbols(SCH);
    const u1 = syms.find((s) => s.ref === 'U1')!;
    expect(classifyPart(u1, 8).class).toBe('ic');
    expect(isPinoutWorthy('ic')).toBe(true);
    expect(isPinoutWorthy('connector')).toBe(true);
    expect(isPinoutWorthy('passive')).toBe(false);
    const fakeConnector = { ...u1, ref: 'J1', libId: 'Connector:USB_C', footprint: 'Connector_USB:USB_C_Receptacle' };
    expect(classifyPart(fakeConnector, 16).class).toBe('connector');
    const fakeReg = { ...u1, ref: 'VR1', libId: 'Regulator_Linear:AP2112K-3.3', footprint: 'Package_TO_SOT_SMD:SOT-23-5' };
    expect(classifyPart(fakeReg, 5).class).toBe('ic');
    const fakeR = { ...u1, ref: 'R9', libId: 'Device:R', footprint: 'Resistor_SMD:R_0603_1608Metric', value: '10k' };
    expect(classifyPart(fakeR, 2).class).toBe('passive');
  });

  it('init pinout still lists the MCU nets on the fixture', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const pinout = await readFile(path.join(repo, 'docs', 'PINOUT.md'), 'utf8');
      expect(pinout).toContain('KEY_DAH');
      expect(pinout).toMatch(/\| U1 \| 5 \| GPIO14 \| KEY_DAH \|/);
    } finally {
      await cleanup();
    }
  });
});

describe('netlist extractor keeps identity fields (gaps 6 and 8)', () => {
  it('parses fields, datasheet, pintype, netclass, units, and tstamps', () => {
    const text = `(export (version D)
      (libparts (libpart (lib "Regulator_Linear") (part "AP2112K-3.3")
        (fields (field (name "Datasheet") "https://example.com/ds.pdf") (field (name "Description") "LDO"))
        (pins (pin (num "1") (name "VIN") (type "power_in")))))
      (components (comp (ref "U4") (value "AP2112K-3.3") (footprint "Package_TO_SOT_SMD:SOT-23-5")
        (fields (field (name "MPN") "AP2112K-3.3TRG1") (field (name "Manufacturer") "Diodes"))
        (libsource (lib "Regulator_Linear") (part "AP2112K-3.3") (description "LDO"))
        (sheetpath (names "/power") (tstamps "/power"))
        (tstamps "00000000-0000-0000-0000-0000442a5056")
        (units (unit (name "A") (pins (pin (num "1")) (pin (num "2")))))))
      (nets (net (code "1") (name "+3V3") (class "Power")
        (node (ref "U4") (pin "5") (pinfunction "VOUT") (pintype "power_out")))))`;
    const nl = parseNetlist(text);
    expect(nl.parts).toHaveLength(1);
    expect(nl.parts[0]!.fields['MPN']).toBe('AP2112K-3.3TRG1');
    expect(nl.parts[0]!.datasheet).toBe('https://example.com/ds.pdf');
    expect(nl.parts[0]!.tstamps).toBe('00000000-0000-0000-0000-0000442a5056');
    expect(nl.parts[0]!.units).toEqual([{ name: 'A', pins: ['1', '2'] }]);
    expect(nl.nets[0]!.netclass).toBe('Power');
    expect(nl.nets[0]!.nodes[0]).toMatchObject({ ref: 'U4', pin: '5', pintype: 'power_out', pinfunction: 'VOUT' });
  });
});

describe('design graph build and extract', () => {
  it('builds a versioned graph from s-expression symbols alone', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const { listSymbols: ls, pinNets: pn } = await import('../src/kicad/sexp.js');
      const graph = buildGraph(await ls(sch), await pn(sch), null, [{ path: 'hardware/open-key.kicad_sch', sha256: 'abc' }], null, 'no kicad-cli in test');
      expect(graph.version).toBe(DESIGN_GRAPH_VERSION);
      expect(graph.generated.partial).toBe(true);
      expect(graph.parts.map((p) => p.ref)).toEqual(['R1', 'R2', 'U1']);
      expect(graph.parts.find((p) => p.ref === 'U1')!.class).toBe('ic');
      expect(graph.nets.find((n) => n.name === 'KEY_DAH')!.nodes.length).toBeGreaterThan(1);
    } finally {
      await cleanup();
    }
  });

  it('init writes a fresh .copperhead/design-graph.json', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const raw = await readFile(path.join(repo, '.copperhead', 'design-graph.json'), 'utf8');
      const graph = JSON.parse(raw) as { version: number; parts: unknown[]; nets: unknown[] };
      expect(graph.version).toBe(DESIGN_GRAPH_VERSION);
      expect(graph.parts.length).toBeGreaterThan(0);
      expect(graph.nets.length).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it('extractDesignGraph degrades gracefully without kicad-cli netlist', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const prev = process.env.COPPERHEAD_KICAD_CLI;
      // a missing override is a hard error now, so degrade via an override that exists but is not kicad-cli
      process.env.COPPERHEAD_KICAD_CLI = process.execPath;
      resetKicadCliCache();
      try {
        const graph = await extractDesignGraph(repo, 'hardware/open-key.kicad_sch');
        expect(graph.version).toBe(DESIGN_GRAPH_VERSION);
        expect(graph.generated.partial).toBe(true);
        expect(graph.generated.partialReason).toBeTruthy();
        expect(graph.parts.map((p) => p.ref)).toContain('U1');
      } finally {
        if (prev === undefined) delete process.env.COPPERHEAD_KICAD_CLI;
        else process.env.COPPERHEAD_KICAD_CLI = prev;
        resetKicadCliCache();
      }
    } finally {
      await cleanup();
    }
  }, 60_000);
});

const sym = (ref: string, libId: string, footprint = '') => ({ ref, libId, footprint });

describe('classification (table-driven)', () => {
  it('keeps stock Power_* library ICs as ic, not power', () => {
    expect(classifyPart(sym('U3', 'Power_Protection:USBLC6-2SC6'), 6).class).toBe('ic');
    expect(classifyPart(sym('U4', 'Power_Management:TPS2113A'), 8).class).toBe('ic');
    expect(classifyPart(sym('#PWR1', 'power:GND'), 1).class).toBe('power');
  });

  it.each([
    ['D1', 'Device:LED', 2, 'discrete'],
    ['D2', 'Device:D_Schottky', 2, 'discrete'],
    ['Y1', 'Device:Crystal', 2, 'discrete'],
    ['Q1', 'Transistor_FET:2N7002', 3, 'discrete'],
    ['F1', 'Device:Fuse', 2, 'discrete'],
    ['SW1', 'Switch:SW_Push', 2, 'discrete'],
    ['CP1', 'Device:CP', 2, 'discrete'],
    ['R?', 'Device:R', 2, 'passive'],
    ['RN1', 'Device:R_Network04', 8, 'passive'],
    ['MH1', 'Mechanical:MountingHole', 1, 'mechanical'],
    ['MH2', 'Other:Thing', 1, 'mechanical'],
    ['J1', 'Other:Thing', 4, 'connector'],
    ['P_USB', 'Other:Thing', 4, 'connector'],
    ['U1', 'MCU_Module:Thing', 20, 'ic'],
    ['Y1', 'Device:Crystal_GND24', 4, 'discrete'],
    ['D1', 'Device:LED_RGBA', 4, 'discrete'],
    ['SW1', 'Switch:SW_Push_Dual', 4, 'discrete'],
    ['D2', 'Diode_Bridge:MB6S', 4, 'discrete'],
    ['TP1', 'Connector:TestPoint', 1, 'discrete'],
    ['T1', 'Transistor_FET:BSS138', 3, 'discrete'],
    ['X1', 'Other:Thing', 4, 'discrete'],
    ['R7', 'Other:Thing', 2, 'passive', 'Resistor_SMD:R_0603_1608Metric'],
    ['CONN1', 'Other:Thing', 6, 'connector'],
    ['H1', 'Other:Thing', 1, 'ic'],
    ['FID1', 'Other:Thing', 1, 'mechanical'],
    ['LOGO1', 'Other:Thing', 1, 'mechanical'],
    ['X9', 'Connector_Generic:Conn_01x04', 4, 'connector'],
    ['H2', 'MountingHole:MountingHole_3.2mm', 1, 'mechanical'],
  ] as [string, string, number, string, string?][])('%s %s (%i pins) is %s', (ref, lib, pins, cls, fp) => {
    expect(classifyPart(sym(ref, lib, fp), pins).class).toBe(cls);
  });

  it('keeps discretes out of the pinout', () => {
    expect(isPinoutWorthy('discrete')).toBe(false);
    expect(isPinoutWorthy('mechanical')).toBe(false);
  });
});

describe('field pickers', () => {
  const withFields = (fields: Record<string, string>) => ({ fields }) as Parameters<typeof mpnOf>[0];
  it('reads manufacturer and LCSC, and treats placeholders as empty', () => {
    expect(manufacturerOf(withFields({ Manufacturer: 'TI' }))).toBe('TI');
    expect(lcscOf(withFields({ 'LCSC Part': 'C25804' }))).toBe('C25804');
    for (const v of ['~', '-', 'N/A', 'TBD', '  ', 'none', '\u2014', '\u2013', '?', 'unverified', 'Unverified']) expect(mpnOf(withFields({ MPN: v })), v).toBe('');
  });

  it('keeps a pipe or newline in an MPN from splitting the BOM row', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const text = await readFile(sch, 'utf8');
      const edited = text.replace(
        '(property "Datasheet" "~" (at 88.9 95.25 0)',
        '(property "MPN" "AB|CD" (at 88.9 95.25 0)\n      (effects (font (size 1.27 1.27)) hide)\n    )\n    (property "Datasheet" "~" (at 88.9 95.25 0)',
      );
      expect(edited).not.toBe(text);
      await writeFile(sch, edited, 'utf8');
      await runInit({ repoRoot: repo, installHooks: false });
      const bom = await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8');
      expect(bom).toContain('| R1 | 10k | Resistor_SMD:R_0603_1608Metric | AB/CD |');
    } finally {
      await cleanup();
    }
  });
});

describe('BOM-excluded parts and drift', () => {
  async function exclude(repo: string, flag: string): Promise<void> {
    const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
    const text = await readFile(sch, 'utf8');
    const edited = text.replace(
      /\(in_bom yes\)(\s+\(on_board yes\)\s+\(dnp no\)\s+\(fields_autoplaced yes\)\s+\(uuid "0d0d0d0d-0000-4000-8000-000000000001"\))/,
      `${flag}$1`,
    );
    expect(edited).not.toBe(text);
    await writeFile(sch, edited, 'utf8');
  }

  it('reads (in_bom no) and omits the part from BOM.md without drift', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await exclude(repo, '(in_bom no)');
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      expect((await listSymbols(sch)).find((s) => s.ref === 'R1')!.inBom).toBe(false);
      await runInit({ repoRoot: repo, installHooks: false });
      expect(await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8')).not.toMatch(/\| R1 \|/);
      expect((await checkDrift(repo, 'docs/', 'hardware/open-key.kicad_sch')).filter((d) => d.claim.includes('R1'))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('flags a BOM row for a part now excluded from the BOM', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      await exclude(repo, '(in_bom no)');
      const drift = await checkDrift(repo, 'docs/', 'hardware/open-key.kicad_sch');
      expect(drift).toContainEqual(expect.objectContaining({ doc: 'BOM.md', claim: 'R1 orderable' }));
    } finally {
      await cleanup();
    }
  });
});

describe('netlist is the source of truth for the graph (findings 3 and 4)', () => {
  const NETLIST = `(export (version E)
    (components
      (comp (ref "R1") (value "10k") (footprint "Resistor_SMD:R_0603_1608Metric")
        (libsource (lib "Device") (part "R")) (sheetpath (names "/") (tstamps "/"))
        (tstamps "0d0d0d0d-0000-4000-8000-000000000001"))
      (comp (ref "C20") (value "1u") (footprint "")
        (libsource (lib "Device") (part "C")) (sheetpath (names "/sub") (tstamps "/aa/"))
        (tstamps "11111111-0000-4000-8000-000000000020"))
      (comp (ref "U2") (value "74LS125") (footprint "")
        (libsource (lib "74xx") (part "74LS125")) (sheetpath (names "/") (tstamps "/"))
        (tstamps "11111111-0000-4000-8000-000000000002")
        (units (unit (name "A") (pins (pin (num "1")))) (unit (name "B") (pins (pin (num "4"))))))
      (comp (ref "U2") (value "74LS125") (footprint "")
        (libsource (lib "74xx") (part "74LS125")) (sheetpath (names "/") (tstamps "/"))
        (tstamps "11111111-0000-4000-8000-000000000002")))
    (nets
      (net (code "1") (name "{slash}sub{slash}VCC") (class "Default")
        (node (ref "R1") (pin "1") (pintype "passive"))
        (node (ref "C20") (pin "1") (pintype "passive"))
        (node (ref "U2") (pin "1") (pinfunction "A") (pintype "input")))
      (net (code "2") (name "Net-(R1-Pad2)") (class "Default")
        (node (ref "R1") (pin "2") (pintype "passive"))
        (node (ref "U2") (pin "4") (pintype "input")))))`;

  it('builds one part per netlist component and names every pin net as in nets[]', async () => {
    const symbols = await listSymbols(SCH);
    const pins = await pinNets(SCH);
    const graph = buildGraph(symbols, pins, parseNetlist(NETLIST), [], '10.0.0', null);
    expect(graph.generated.partial).toBe(false);
    expect(graph.parts.map((p) => p.ref)).toEqual(['C20', 'R1', 'U2']);
    const names = new Set(graph.nets.map((n) => n.name));
    expect(names.has('/sub/VCC')).toBe(true);
    for (const part of graph.parts) for (const pin of part.pins) expect(names.has(pin.net!), `${part.ref}:${pin.num}`).toBe(true);
    const r1 = graph.parts.find((p) => p.ref === 'R1')!;
    expect(r1.pins.map((p) => [p.num, p.net])).toEqual([['1', '/sub/VCC'], ['2', 'Net-(R1-Pad2)']]);
    expect(r1.uuid).toBe('0d0d0d0d-0000-4000-8000-000000000001');
    expect(r1.pins[0]!.type).toBe('passive');
    expect(graph.parts.find((p) => p.ref === 'U2')!.units).toEqual([
      { name: 'A', pins: ['1'] },
      { name: 'B', pins: ['4'] },
    ]);
  });

  it('collapses multi-unit symbols to one part per ref without a netlist', async () => {
    const symbols = await listSymbols(SCH);
    const u1 = symbols.find((s) => s.ref === 'U1')!;
    const graph = buildGraph([...symbols, { ...u1, unit: 2 }], await pinNets(SCH), null, [], null, 'x');
    expect(graph.parts.filter((p) => p.ref === 'U1')).toHaveLength(1);
    expect(graph.generated.partial).toBe(true);
  });

  it('undoes KiCad net-name escapes', () => {
    expect(unescapeNetName('{slash}a{slash}B{dblquote}')).toBe('/a/B"');
    expect(unescapeNetName('a{dollar}b{return}c{brace}d')).toBe('a$b\nc{d');
    expect(unescapeNetName('{newline}{semicolon}')).toBe('{newline}{semicolon}');
    expect(unescapeNetName('{unknown}')).toBe('{unknown}');
  });

  it('parseNetlist keeps libpart descriptions, sheet files and unit fallbacks', () => {
    const nl = parseNetlist(`(export (libparts (libpart (lib "Device") (part "R") (description "Resistor")))
      (components (comp (ref "R1") (value "1k") (libsource (lib "Device") (part "R"))
        (property (name "Sheetfile") (value "sub.kicad_sch")) (units (unit (name "A") (pins (pin (num "1")))))))
      (nets))`);
    expect(nl.parts[0]).toMatchObject({ description: 'Resistor', sheetFile: 'sub.kicad_sch', sheet: '/' });
    expect(nl.parts[0]!.units).toEqual([{ name: 'A', pins: ['1'] }]);
  });
});

describe('graph freshness covers every sheet (finding 5)', () => {
  async function legibilityRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-graph-'));
    const dir = path.join(FIXTURE, '..', 'legibility');
    await cp(path.join(dir, 'ugly.kicad_sch'), path.join(repo, 'ugly.kicad_sch'));
    await cp(path.join(dir, 'ugly-sub.kicad_sch'), path.join(repo, 'ugly-sub.kicad_sch'));
    return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
  }

  it('returns the graph while fresh and null once a sub-sheet changes', async () => {
    const { repo, cleanup } = await legibilityRepo();
    try {
      expect(await readFreshGraph(repo, 'ugly.kicad_sch')).toBeNull(); // missing
      const graph = await extractDesignGraph(repo, 'ugly.kicad_sch');
      expect(graph.generated.sources.map((s) => s.path)).toEqual(['ugly-sub.kicad_sch', 'ugly.kicad_sch']);
      await writeDesignGraph(repo, graph);
      expect(await readFreshGraph(repo, 'ugly.kicad_sch')).not.toBeNull();
      const sub = path.join(repo, 'ugly-sub.kicad_sch');
      await writeFile(sub, (await readFile(sub, 'utf8')).replace('"R7"', '"XR7"'), 'utf8');
      expect(await readFreshGraph(repo, 'ugly.kicad_sch')).toBeNull();
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('returns null for unreadable, version-mismatched and source-less graphs', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const rel = 'hardware/open-key.kicad_sch';
      const graph = await extractDesignGraph(repo, rel);
      await writeFile(graphPath(repo), '{not json', 'utf8').catch(async () => {
        await writeDesignGraph(repo, graph);
        await writeFile(graphPath(repo), '{not json', 'utf8');
      });
      expect(await readFreshGraph(repo, rel)).toBeNull();
      await writeDesignGraph(repo, { ...graph, version: DESIGN_GRAPH_VERSION + 1 });
      expect(await readFreshGraph(repo, rel)).toBeNull();
      await writeDesignGraph(repo, graph);
      expect(await readFreshGraph(repo, rel)).not.toBeNull();
      expect(await readFreshGraph(repo, 'hardware/missing.kicad_sch')).toBeNull();
    } finally {
      await cleanup();
    }
  }, 60_000);
});

describe('graph file is a gitignored cache (finding 7)', () => {
  it('init and ingest write identical bytes and git ignores the file', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const afterInit = await readFile(graphPath(repo), 'utf8');
      expect(await readFile(path.join(repo, '.gitignore'), 'utf8')).toContain('.copperhead/design-graph.json');
      expect((await execa('git', ['check-ignore', '.copperhead/design-graph.json'], { cwd: repo })).stdout).toBeTruthy();
      await writeDesignGraph(repo, await extractDesignGraph(repo, 'hardware/open-key.kicad_sch'));
      expect(await readFile(graphPath(repo), 'utf8')).toBe(afterInit);
    } finally {
      await cleanup();
    }
  }, 60_000);
});

describe('copperhead ingest', () => {
  const ROOT = path.join(path.dirname(FIXTURE), '..', '..');
  const run = (repo: string, ...args: string[]) =>
    execa('npx', ['tsx', 'src/cli.ts', '--repo', repo, ...args], { cwd: ROOT, reject: false, env: { NO_COLOR: '1' } });

  it('exits 1 when no schematic is configured', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-ingest-'));
    try {
      const res = await run(dir, 'ingest');
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('copperhead init');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('prints the graph as JSON under --json', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const res = await run(repo, '--json', 'ingest');
      expect(res.exitCode).toBe(0);
      expect((JSON.parse(res.stdout) as { version: number }).version).toBe(DESIGN_GRAPH_VERSION);
    } finally {
      await cleanup();
    }
  }, 60_000);
});

describe('review round 2 fixes', () => {
  it('escapes pipes and newlines in Value and Footprint without drift (finding 2)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const text = await readFile(sch, 'utf8');
      const edited = text.replace('(property "Value" "10k"', '(property "Value" "10k|1%"');
      expect(edited).not.toBe(text);
      await writeFile(sch, edited, 'utf8');
      await runInit({ repoRoot: repo, installHooks: false });
      expect(await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8')).toContain('| R1 | 10k/1% |');
      expect(await checkDrift(repo, 'docs/', 'hardware/open-key.kicad_sch')).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('flags a BOM row for a DNP part as orderable (finding 12)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      const text = await readFile(sch, 'utf8');
      const edited = text.replace(
        /\(dnp no\)(\s+\(fields_autoplaced yes\)\s+\(uuid "0d0d0d0d-0000-4000-8000-000000000001"\))/,
        '(dnp yes)$1',
      );
      expect(edited).not.toBe(text);
      await writeFile(sch, edited, 'utf8');
      expect(await checkDrift(repo, 'docs/', 'hardware/open-key.kicad_sch')).toContainEqual(
        expect.objectContaining({ claim: 'R1 orderable' }),
      );
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('refuses a redraft that would reset a DNP flag (finding 4)', async () => {
    const { draftSchematicToText } = await import('../src/kicad/draft/draft.js');
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const sch = path.join(repo, 'hardware', 'open-key.kicad_sch');
      await writeFile(
        sch,
        (await readFile(sch, 'utf8')).replace(
          /\(dnp no\)(\s+\(fields_autoplaced yes\)\s+\(uuid "0d0d0d0d-0000-4000-8000-000000000001"\))/,
          '(dnp yes)$1',
        ),
        'utf8',
      );
      await writeFile(
        path.join(repo, 'hardware', 'open-key.intent.json'),
        JSON.stringify({ version: 1, parts: [{ ref: 'R1', libId: 'Device:R', value: '10k' }], nets: [] }),
        'utf8',
      );
      const res = await draftSchematicToText({
        repoRoot: repo,
        schematic: 'hardware/open-key.kicad_sch',
        intentPath: 'hardware/open-key.intent.json',
      });
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/R1 is marked DNP/);
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('readFreshGraph returns null for a null file and for a changed sheet set (findings 5 and 12)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const rel = 'hardware/open-key.kicad_sch';
      const graph = await extractDesignGraph(repo, rel);
      await writeDesignGraph(repo, graph);
      await writeFile(graphPath(repo), 'null', 'utf8');
      expect(await readFreshGraph(repo, rel)).toBeNull();
      await writeDesignGraph(repo, { ...graph, generated: { ...graph.generated, sources: [] } });
      expect(await readFreshGraph(repo, rel)).toBeNull();
    } finally {
      await cleanup();
    }
  }, 60_000);

  it('a missing COPPERHEAD_KICAD_CLI is a hard error, not a partial graph (finding 6)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    const prev = process.env.COPPERHEAD_KICAD_CLI;
    process.env.COPPERHEAD_KICAD_CLI = path.join(repo, 'no-such-kicad-cli');
    resetKicadCliCache();
    try {
      await expect(extractDesignGraph(repo, 'hardware/open-key.kicad_sch')).rejects.toThrow(/no-such-kicad-cli/);
    } finally {
      if (prev === undefined) delete process.env.COPPERHEAD_KICAD_CLI;
      else process.env.COPPERHEAD_KICAD_CLI = prev;
      resetKicadCliCache();
      await cleanup();
    }
  }, 60_000);

  it('fallback net names are unescaped like netlist names (finding 7)', async () => {
    const symbols = await listSymbols(SCH);
    const pins = (await pinNets(SCH)).map((p, i) => (i === 0 ? { ...p, net: 'VPP{slash}MCLR' } : p));
    const graph = buildGraph(symbols, pins, null, [], null, 'x');
    expect(graph.nets.map((n) => n.name)).toContain('VPP/MCLR');
    expect(graph.nets.map((n) => n.name)).not.toContain('VPP{slash}MCLR');
    const names = new Set(graph.nets.map((n) => n.name));
    for (const part of graph.parts) for (const pin of part.pins) if (pin.net) expect(names.has(pin.net)).toBe(true);
  });

  it('prefers netlist sheet and value, adds an instance key, and falls back to ref when tstamps miss (findings 8 and 12)', async () => {
    const symbols = await listSymbols(SCH);
    const nl = parseNetlist(`(export (components
      (comp (ref "R1") (value "22k") (footprint "") (libsource (lib "Device") (part "R"))
        (sheetpath (names "/amp/") (tstamps "/aa/")) (tstamps "99999999-0000-4000-8000-000000000000")))
      (nets))`);
    const graph = buildGraph(symbols, await pinNets(SCH), nl, [], null, null);
    const r1 = graph.parts.find((p) => p.ref === 'R1')!;
    expect(r1.value).toBe('22k');
    expect(r1.sheet).toBe('/amp/');
    expect(r1.instanceKey).toContain('/amp/');
    expect(r1.instanceKey).toContain('0d0d0d0d-0000-4000-8000-000000000001'); // joined to the symbol by ref
  });

  it('ingest prints the partial reason and exits 1 when extraction throws (findings 6 and 12)', async () => {
    const ROOT = path.join(path.dirname(FIXTURE), '..', '..');
    const run = (repo: string, env: Record<string, string>, ...args: string[]) =>
      execa('npx', ['tsx', 'src/cli.ts', '--repo', repo, ...args], { cwd: ROOT, reject: false, env: { NO_COLOR: '1', ...env } });
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      await runInit({ repoRoot: repo, installHooks: false });
      const partial = await run(repo, { COPPERHEAD_KICAD_CLI: process.execPath }, 'ingest');
      expect(partial.exitCode).toBe(0);
      expect(partial.stdout).toMatch(/partial: s-expression fallback \(.+\)/);
      const bad = await run(repo, { COPPERHEAD_KICAD_CLI: path.join(repo, 'nope') }, 'ingest');
      expect(bad.exitCode).toBe(1);
      await rm(path.join(repo, 'hardware', 'open-key.kicad_sch'));
      const gone = await run(repo, {}, 'ingest');
      expect(gone.exitCode).toBe(1);
    } finally {
      await cleanup();
    }
  }, 120_000);
});

const hasKicad = await execa('kicad-cli', ['version'], { reject: false }).then((r) => r.exitCode === 0, () => false);

describe.skipIf(!hasKicad)('real kicad-cli netlist (finding 12)', () => {
  it('builds a non-partial graph whose pin nets all appear in nets[]', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      resetKicadCliCache();
      const graph = await extractDesignGraph(repo, 'hardware/open-key.kicad_sch');
      expect(graph.generated.partial).toBe(false);
      const names = new Set(graph.nets.map((n) => n.name));
      for (const part of graph.parts) for (const pin of part.pins) expect(names.has(pin.net!), `${part.ref}:${pin.num}`).toBe(true);
    } finally {
      await cleanup();
    }
  }, 60_000);
});
