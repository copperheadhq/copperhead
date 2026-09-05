import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { draftSchematic, draftSchematicToText } from '../src/kicad/draft/draft.js';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { uuidv5, renameSymbolBlock } from '../src/kicad/emit.js';
import { checkLegibility } from '../src/kicad/legibility.js';
import { listSymbols, pinNets } from '../src/kicad/sexp.js';
import { verifySchematicSymbols } from '../src/kicad/symlib.js';
import { runErc } from '../src/kicad/cli.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');
const DRAFT_FIXTURE = path.join(HERE, 'fixtures', 'draft');

async function draftRepo(): Promise<{ repo: string; symDirs: string[]; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-engine-'));
  await cp(path.join(DRAFT_FIXTURE, 'schematic.intent.json'), path.join(repo, 'schematic.intent.json'));
  await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
  return { repo, symDirs: [SYMLIB], cleanup: () => rm(repo, { recursive: true, force: true }) };
}

const draftOpts = (repo: string, symDirs: string[]) => ({
  repoRoot: repo,
  schematic: 'board.kicad_sch',
  intentPath: 'schematic.intent.json',
  docsDir: path.join(repo, 'docs'),
  symbolDirs: symDirs,
});

async function mutateIntent(repo: string, fn: (intent: any) => void): Promise<void> {
  const p = path.join(repo, 'schematic.intent.json');
  const intent = JSON.parse(await readFile(p, 'utf8'));
  fn(intent);
  await writeFile(p, JSON.stringify(intent, null, 2), 'utf8');
}

describe('uuidv5 and emitter primitives', () => {
  it('uuidv5 is stable and RFC-shaped', () => {
    const a = uuidv5('sheet/R1/pin/2');
    expect(a).toBe(uuidv5('sheet/R1/pin/2'));
    expect(a).not.toBe(uuidv5('sheet/R1/pin/3'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('renameSymbolBlock changes only the identifier', () => {
    const block = '(symbol "R"\n\t(pin passive line (at 0 3.81 270))\n)';
    const renamed = renameSymbolBlock(block, 'Device:R');
    expect(renamed).toBe('(symbol "Device:R"\n\t(pin passive line (at 0 3.81 270))\n)');
  });

  it('renameSymbolBlock renames unit children with the parent (derived symbols)', () => {
    // KiCad's schematic loader requires child sub-symbol names to carry the
    // parent's prefix: a derived symbol emitted with its base's children
    // (AMS1117-3.3 wrapping AP1117-15_0_1) fails to load outright.
    const block = '(symbol "Base"\n\t(symbol "Base_0_1"\n\t\t(rectangle)\n\t)\n\t(symbol "Base_1_1"\n\t\t(pin)\n\t)\n)';
    const renamed = renameSymbolBlock(block, 'Lib:Derived');
    expect(renamed).toContain('(symbol "Lib:Derived"');
    expect(renamed).toContain('(symbol "Derived_0_1"');
    expect(renamed).toContain('(symbol "Derived_1_1"');
    expect(renamed).not.toContain('Base');
  });
});

describe('drafting engine: the reference IR end to end', () => {
  it('drafts byte-identically, passes the legibility gate, and round-trips connectivity (AC-16.1, AC-16.3)', async () => {
    const { repo, symDirs, cleanup } = await draftRepo();
    try {
      const res = await draftSchematic(draftOpts(repo, symDirs));
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // byte-identical re-draft (AC-16.1 / AC-16.4)
      const first = await readFile(res.schematicPath, 'utf8');
      const again = await draftSchematic(draftOpts(repo, symDirs));
      expect(again.ok).toBe(true);
      expect(await readFile(res.schematicPath, 'utf8')).toBe(first);

      // gate by construction (AC-16.3): zero error-severity legibility findings
      const leg = await checkLegibility(res.schematicPath, { docsDir: path.join(repo, 'docs') });
      expect(leg.findings.filter((f) => f.severity === 'error')).toEqual([]);

      // pins on-grid by construction (AC-16.2) is the off-grid family; assert explicitly
      expect(leg.findings.some((f) => f.kind === 'off-grid')).toBe(false);

      // parse round-trip (AC-16.13): the inferred netlist matches the IR
      const syms = await listSymbols(res.schematicPath);
      expect(syms.map((s) => s.ref)).toEqual(['C1', 'J1', 'R1', 'R2', 'U1']);
      const nets = new Map((await pinNets(res.schematicPath)).map((p) => [`${p.ref}.${p.pinNumber}`, p.net]));
      expect(nets.get('J1.1')).toBe('VCC');
      expect(nets.get('J1.2')).toBe('GND');
      expect(nets.get('J1.3')).toBe('SIG_IN');
      expect(nets.get('R1.1')).toBe('SIG_IN');
      expect(nets.get('R1.2')).toBe('DIV');
      expect(nets.get('R2.1')).toBe('DIV');
      expect(nets.get('U1.3')).toBe('DIV');
      expect(nets.get('C1.1')).toBe('VCC');
      expect(nets.get('C1.2')).toBe('GND');

      // power nets are never routed as spanning wires (AC-16.8): every VCC/GND
      // wire is a short per-pin stub
      const text = await readFile(res.schematicPath, 'utf8');
      expect(res.report.pwrFlags).toEqual(['GND', 'VCC']);
      expect(res.report.noConnects).toBe(5);
      expect(text).toContain('(no_connect');

      // DIV is the divider's tap, on U1.3. With R1 and R2 hung on that pin
      // (#220 phase 3) the net is local enough to wire, and the trunk clears
      // every foreign connection point — the merged-net guard below is what
      // says so, not the label count. Before pin attachment every trunk for
      // DIV contacted a foreign stub end and the net fell back to three
      // labels; a wired DIV that shorted to GND at R2.2's stub end was the
      // I22 (#204) defect, so the guard stays the load-bearing check.
      expect(res.report.netClasses.find((n) => n.name === 'DIV')?.class).toBe('signal');
      expect(res.report.mergedNets).toEqual([]);
      // wired (one label naming the net) or labelled at each of its three
      // stubs; either is a legal drawing, a short is not
      expect([1, 3]).toContain((text.match(/\((?:global_)?label "DIV"/g) ?? []).length);
    } finally {
      await cleanup();
    }
  }, 60000);

  it('passes ERC clean on the drafted output (gate-resolvability, AC-16.9/AC-16.10/AC-16.12)', async () => {
    const { repo, symDirs, cleanup } = await draftRepo();
    try {
      const res = await draftSchematic(draftOpts(repo, symDirs));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const erc = await runErc(res.schematicPath);
      expect(erc.violations).toEqual([]);
      expect(erc.ok).toBe(true);
    } finally {
      await cleanup();
    }
  }, 60000);

  it('draft is deterministic across processes: no clock in the output', async () => {
    const { repo, symDirs, cleanup } = await draftRepo();
    try {
      const res = await draftSchematic(draftOpts(repo, symDirs));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const text = await readFile(res.schematicPath, 'utf8');
      // The title-block date is the pinned epoch stamp exactly — asserting the
      // absence of the wall-clock year would prove nothing in most years and
      // false-fail whenever a fixture legitimately contains the current one.
      expect(text).toContain('(date "2020-01-01")');
      expect(text.match(/\(date "[^"]*"\)/g)).toEqual(['(date "2020-01-01")']);
    } finally {
      await cleanup();
    }
  });
});

describe('IR validation fails structured and early', () => {
  const failCase = (name: string, mutate: (intent: any) => void, expectDetail: RegExp) =>
    it(name, async () => {
      const { repo, symDirs, cleanup } = await draftRepo();
      try {
        // draft once so a previous schematic exists…
        const first = await draftSchematic(draftOpts(repo, symDirs));
        expect(first.ok).toBe(true);
        const before = await readFile(path.join(repo, 'board.kicad_sch'), 'utf8');
        await mutateIntent(repo, mutate);
        const res = await draftSchematic(draftOpts(repo, symDirs));
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.findings.map((f) => f.detail).join('\n')).toMatch(expectDetail);
        // …and prove a failed draft leaves it untouched (AC-16.6)
        expect(await readFile(path.join(repo, 'board.kicad_sch'), 'utf8')).toBe(before);
      } finally {
        await cleanup();
      }
    }, 60000);

  failCase(
    'unknown pin is rejected with the real pin range (AC-16.6)',
    (i) => i.nets.push({ name: 'X', pins: ['U1.99', 'R1.1'] }),
    /U1 has no pin 99.*\[1, 2, 3, 4, 5, 6, 7, 8\]/,
  );
  failCase(
    'BOM mismatch is rejected at validation (AC-16.7)',
    (i) => (i.parts.find((p: any) => p.ref === 'R1').value = '22k'),
    /R1 value "22k" differs from BOM.md's "10k"/,
  );
  failCase(
    'ungrouped part is rejected with the available groups',
    (i) => delete i.parts.find((p: any) => p.ref === 'R1').group,
    /R1 has no group assignment.*Power, MCU/,
  );
  failCase(
    'unknown group is rejected against SUBSYSTEMS.md',
    (i) => (i.parts.find((p: any) => p.ref === 'R1').group = 'Flux'),
    /names group "Flux".*not a SUBSYSTEMS.md heading/,
  );
  failCase(
    'contradictory no-connect is rejected',
    (i) => i.noConnect.push('R1.1'),
    /R1.1 is declared no-connect but appears in a net/,
  );
  failCase(
    'unsupported intent version is refused',
    (i) => (i.version = 99),
    /unsupported intent version 99/,
  );
  failCase(
    'single-endpoint net is rejected',
    (i) => i.nets.push({ name: 'LONELY', pins: ['U1.5'] }),
    /LONELY has 1 endpoint\(s\)/,
  );
});

describe('hermetic symbol vendoring (AC-16.5)', () => {
  it('a library change does not move drafted bytes until the cache is refreshed; verify_symbols still sees the divergence', async () => {
    const { repo, symDirs, cleanup } = await draftRepo();
    try {
      // vendor from a mutable copy of the fixture library
      const libDir = await mkdtemp(path.join(tmpdir(), 'copperhead-libs-'));
      await cp(SYMLIB, libDir, { recursive: true });
      const first = await draftSchematic(draftOpts(repo, [libDir]));
      expect(first.ok).toBe(true);
      const before = await readFile(path.join(repo, 'board.kicad_sch'), 'utf8');
      expect(existsSync(path.join(repo, 'sym-lib-cache', 'Device.kicad_sym'))).toBe(true);

      // upgrade the "installed" library: R grows a pin
      const devPath = path.join(libDir, 'Device.kicad_sym');
      const dev = await readFile(devPath, 'utf8');
      await writeFile(
        devPath,
        dev.replace(
          '(pin passive line (at 0 -3.81 90)',
          '(pin passive line (at 2.54 0 180)\n\t\t\t\t(name "~" (effects (font (size 1.27 1.27))))\n\t\t\t\t(number "3" (effects (font (size 1.27 1.27))))\n\t\t\t)\n\t\t\t(pin passive line (at 0 -3.81 90)',
        ),
        'utf8',
      );
      const again = await draftSchematic(draftOpts(repo, [libDir]));
      expect(again.ok).toBe(true);
      expect(await readFile(path.join(repo, 'board.kicad_sch'), 'utf8')).toBe(before);

      // the divergence is not silently frozen: verify_symbols compares the
      // schematic against the (upgraded) installed library and reports it
      const { findings } = await verifySchematicSymbols(path.join(repo, 'board.kicad_sch'), {
        KICAD_SYMBOL_DIR: libDir,
      } as NodeJS.ProcessEnv);
      expect(findings.some((f) => f.libId === 'Device:R' && f.kind === 'pin-count')).toBe(true);
      await rm(libDir, { recursive: true, force: true });
    } finally {
      await cleanup();
    }
  }, 60000);

  it('vendoring is deterministic: two fresh repos produce identical caches and schematics', async () => {
    const a = await draftRepo();
    const b = await draftRepo();
    try {
      const ra = await draftSchematic(draftOpts(a.repo, a.symDirs));
      const rb = await draftSchematic(draftOpts(b.repo, b.symDirs));
      expect(ra.ok && rb.ok).toBe(true);
      expect(await readFile(path.join(a.repo, 'board.kicad_sch'), 'utf8')).toBe(
        await readFile(path.join(b.repo, 'board.kicad_sch'), 'utf8'),
      );
      expect(await readFile(path.join(a.repo, 'sym-lib-cache', 'Device.kicad_sym'), 'utf8')).toBe(
        await readFile(path.join(b.repo, 'sym-lib-cache', 'Device.kicad_sym'), 'utf8'),
      );
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  }, 60000);

  it('the vendored block is byte-identical to the library source apart from nothing at all', async () => {
    const { repo, symDirs, cleanup } = await draftRepo();
    try {
      const src = new SymbolSource(repo, symDirs);
      const r = await src.resolve('Device:R');
      const libText = await readFile(path.join(SYMLIB, 'Device.kicad_sym'), 'utf8');
      expect(libText).toContain(r.sourceText); // verbatim copy, no re-serialization
    } finally {
      await cleanup();
    }
  });
});

describe('IR overrides', () => {
  it('a net-kind override wins over pin-type inference and is noted in the report', async () => {
    const { repo, symDirs, cleanup } = await draftRepo();
    try {
      await mutateIntent(repo, (i) => {
        i.nets.find((n: any) => n.name === 'VCC').kind = 'signal';
      });
      const res = await draftSchematicToText(draftOpts(repo, symDirs));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const vcc = res.report.netClasses.find((n) => n.name === 'VCC');
      expect(vcc).toEqual({ name: 'VCC', class: 'signal', overridden: true, basis: 'declared' });
    } finally {
      await cleanup();
    }
  });

  it('an odd rail name is recognized from pin types without any declaration', async () => {
    const { repo, symDirs, cleanup } = await draftRepo();
    try {
      await mutateIntent(repo, (i) => {
        i.nets.find((n: any) => n.name === 'VCC').name = 'VBAT';
        // BOM/IR values untouched; only the net renamed
      });
      const res = await draftSchematicToText(draftOpts(repo, symDirs));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.report.netClasses.find((n) => n.name === 'VBAT')).toEqual({
        name: 'VBAT',
        class: 'rail',
        overridden: false,
        // the pin types said so, not the name: VBAT matches no supply shape
        basis: 'pin-type',
      });
    } finally {
      await cleanup();
    }
  });
});