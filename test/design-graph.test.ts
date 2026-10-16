import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { listSymbols } from '../src/kicad/sexp.js';
import { parseNetlist } from '../src/kicad/netlist.js';
import {
  classifyPart,
  isPinoutWorthy,
  mpnOf,
  buildGraph,
  extractDesignGraph,
  DESIGN_GRAPH_VERSION,
} from '../src/kicad/design-graph.js';
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
    expect(r1.onBoard).toBe(true);
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
      text = text.replace('(dnp no)\n    (fields_autoplaced yes)\n    (uuid "0d0d0d0d-0000-4000-8000-000000000001")', '(dnp yes)\n    (fields_autoplaced yes)\n    (uuid "0d0d0d0d-0000-4000-8000-000000000001")');
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
      const graph = await extractDesignGraph(repo, 'hardware/open-key.kicad_sch');
      expect(graph.version).toBe(DESIGN_GRAPH_VERSION);
      expect(graph.parts.map((p) => p.ref)).toContain('U1');
    } finally {
      await cleanup();
    }
  }, 60_000);
});
