import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, cp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dispatchToolResult, type RunContext } from '../src/agent/tools.js';
import { catalog } from '../src/capabilities/index.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import { STAGES } from '../src/commands/create.js';
import { bomSymbolDossier } from '../src/kicad/dossier.js';
import { validateIntent, type SchematicIntent } from '../src/kicad/draft/ir.js';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { checkDrift } from '../src/memory/drift.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRAFT_FIXTURE = path.join(HERE, 'fixtures', 'draft');
const SYMLIB = path.join(HERE, 'fixtures', 'symlib');

async function makeTestRepo(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-draftbom-test-'));
  await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await writeFile(
    path.join(repo, '.copperhead', 'config.json'),
    JSON.stringify({ schematic: 'board.kicad_sch', docs: 'docs/', origin: 'create' }),
    'utf8',
  );

  // Setup local project fp-lib-table and fixture footprints so tests run hermetically
  const rPretty = path.join(repo, 'Resistor_SMD.pretty');
  const cPretty = path.join(repo, 'Capacitor_SMD.pretty');
  await mkdir(rPretty, { recursive: true });
  await mkdir(cPretty, { recursive: true });
  await writeFile(
    path.join(rPretty, 'R_0603_1608Metric.kicad_mod'),
    '(footprint "R_0603_1608Metric" (version 20240108) (generator kicad) (pad "1" smd roundrect (at -0.8 0)) (pad "2" smd roundrect (at 0.8 0)))',
    'utf8',
  );
  await writeFile(
    path.join(cPretty, 'C_0402_1005Metric.kicad_mod'),
    '(footprint "C_0402_1005Metric" (version 20240108) (generator kicad) (pad "1" smd roundrect (at -0.5 0)) (pad "2" smd roundrect (at 0.5 0)))',
    'utf8',
  );
  await writeFile(
    path.join(cPretty, 'C_0603_1608Metric.kicad_mod'),
    '(footprint "C_0603_1608Metric" (version 20240108) (generator kicad) (pad "1" smd roundrect (at -0.8 0)) (pad "2" smd roundrect (at 0.8 0)))',
    'utf8',
  );
  const fpTable = [
    '(fp_lib_table',
    '  (version 7)',
    '  (lib (name "Resistor_SMD")(type "KiCad")(uri "${KIPRJMOD}/Resistor_SMD.pretty")(options "")(descr ""))',
    '  (lib (name "Capacitor_SMD")(type "KiCad")(uri "${KIPRJMOD}/Capacitor_SMD.pretty")(options "")(descr ""))',
    ')',
  ].join('\n');
  await writeFile(path.join(repo, 'fp-lib-table'), fpTable, 'utf8');

  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

function makeContext(repo: string, editsUnlocked = true): RunContext {
  return {
    repoRoot: repo,
    config: { schematic: 'board.kicad_sch', docs: 'docs/', origin: 'create' } as never,
    transcript: { event: async () => {} } as never,
    ledger: new ObligationsLedger(),
    runId: 'test',
    interactive: false,
    confirm: async () => true,
    editsUnlocked,
    changeId: 'test-change',
    proposalValidated: true,
    filesTouched: new Set(),
    decisions: [],
    constraints: [],
    repairCycles: 0,
    lastErc: null,
    lastDrc: null,
  };
}

describe('Phase 5 & 6 — draft_bom Capability & Stage 3/4 Integration', () => {
  it('1. draft_bom is registered in the capability catalog and gated behind editsUnlocked', () => {
    const entry = catalog.find((c) => c.schema.name === 'draft_bom');
    expect(entry).toBeDefined();
    expect(entry?.viewHint).toBe('mutation');

    const lockedCtx = makeContext('some/repo', false);
    expect(entry?.gate(lockedCtx)).toBe(false);

    const unlockedCtx = makeContext('some/repo', true);
    expect(entry?.gate(unlockedCtx)).toBe(true);
  });

  it('2. draft_bom validation failure leaves BOM.md untouched and returns findings', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      const ctx = makeContext(repo, true);
      const bomPath = path.join(repo, 'docs', 'BOM.md');
      const originalBom = await readFile(bomPath, 'utf8');

      // Invalid manifest: duplicate refdes and model asserting verified: true
      const invalidManifest = {
        version: 1,
        parts: [
          { ref: 'R1', value: '10k', package: '0603', group: 'Power' },
          { ref: 'R1', value: '20k', package: '0603', group: 'Power' },
          { ref: 'U1', value: 'MCU', libId: 'MCU:Chip', footprint: 'FP:Chip', mpn: 'CHIP1', verified: true, group: 'MCU' },
        ],
      };

      const res = await dispatchToolResult(ctx, 'draft_bom', { manifest_json: JSON.stringify(invalidManifest) });
      expect(res.ok).toBe(false);
      const message = `${res.summary} ${res.detail ?? ''}`;
      expect(message).toContain('manifest validation:');
      expect(message).toContain('duplicate refdes "R1"');
      expect(message).toContain("model cannot assert 'verified: true'");

      // BOM.md remains completely untouched
      const bomAfter = await readFile(bomPath, 'utf8');
      expect(bomAfter).toBe(originalBom);
      expect(ctx.filesTouched.has(path.join('docs', 'parts.intent.json'))).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('3. draft_bom success writes parts.intent.json and renders canonical BOM.md', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      const ctx = makeContext(repo, true);
      // Valid manifest with passive expansion, off-board battery, and substitution covering Power and MCU
      const manifest = {
        version: 1,
        parts: [
          { ref: 'R1', value: '10k', package: '0603', group: 'Power' },
          { ref: 'C1', value: '100nF', package: '0402', group: 'MCU' },
          { ref: 'BT1', value: '500mAh Li-Po', offBoard: true, rationale: 'Bare leads to header', group: 'Power' },
        ],
        substitutions: [
          { ref: 'R1', wanted: '10k 0.1%', chosen: '10k 1%', reason: 'Stock availability' },
        ],
      };

      const res = await dispatchToolResult(ctx, 'draft_bom', { manifest_json: JSON.stringify(manifest, null, 2) });
      expect(res.ok).toBe(true);
      expect(res.summary).toContain('draft_bom: successfully validated 3 parts');

      // Check parts.intent.json written
      const manifestFile = await readFile(path.join(repo, 'docs', 'parts.intent.json'), 'utf8');
      expect(JSON.parse(manifestFile).version).toBe(1);
      expect(ctx.filesTouched.has(path.join('docs', 'parts.intent.json'))).toBe(true);

      // Check BOM.md rendered
      const bomFile = await readFile(path.join(repo, 'docs', 'BOM.md'), 'utf8');
      expect(bomFile).toContain('| BT1 | 500mAh Li-Po | (off-board) | (off-board) | - | (off-board) Bare leads to header |');
      expect(bomFile).toContain('| R1 | 10k | Device:R | Resistor_SMD:R_0603_1608Metric | - | - |');
      expect(bomFile).toContain('## Substitutions');
      expect(bomFile).toContain('| R1 | 10k 0.1% | 10k 1% | Stock availability |');
    } finally {
      await cleanup();
    }
  });

  it('4. Stage 3 isComplete and stageGate evaluate clean manifest vs stale BOM', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      const partSelectionStage = STAGES.find((s) => s.name === 'part-selection')!;

      // 1. Author valid manifest covering Power and MCU, and call draft_bom
      const ctx = makeContext(repo, true);
      const manifest = {
        version: 1,
        parts: [
          { ref: 'R1', value: '10k', package: '0603', group: 'Power' },
          { ref: 'C1', value: '100nF', package: '0603', group: 'MCU' },
          { ref: 'BT1', value: '500mAh Li-Po', offBoard: true, rationale: 'Bare leads', group: 'Power' },
        ],
      };
      await dispatchToolResult(ctx, 'draft_bom', { manifest_json: JSON.stringify(manifest) });

      // Clean state: isComplete returns true, stageGate returns null
      const isCompleteInitial = await partSelectionStage.isComplete(repo, 'docs');
      expect(isCompleteInitial).toBe(true);

      const gateInitial = await partSelectionStage.stageGate!(repo, 'docs');
      expect(gateInitial).toBeNull();

      // 2. Introduce staleness: edit parts.intent.json directly without re-running draft_bom
      manifest.parts.push({ ref: 'R2', value: '10k', package: '0603', group: 'Power' } as any);
      await writeFile(path.join(repo, 'docs', 'parts.intent.json'), JSON.stringify(manifest), 'utf8');

      // Stale state: isComplete returns false, stageGate reports mismatch
      const isCompleteStale = await partSelectionStage.isComplete(repo, 'docs');
      expect(isCompleteStale).toBe(false);

      const gateStale = await partSelectionStage.stageGate!(repo, 'docs');
      expect(gateStale).toContain('docs/BOM.md does not match parts.intent.json; call draft_bom to regenerate it');
    } finally {
      await cleanup();
    }
  });

  it('5. Stage 4 dossier consumes exact Symbol column and excludes off-board parts', async () => {
    const bomMd = [
      '# Bill of Materials',
      '',
      '| Refdes | Value | Symbol | Footprint | MPN | Rationale |',
      '|---|---|---|---|---|---|',
      '| U1 | STM32F103C8T6 | MCU_ST_STM32F1:STM32F103C8Tx | Package_QFP:LQFP-48_7x7mm_P0.5mm | UNVERIFIED STM32F103C8T6 | Main MCU |',
      '| BT1 | 500mAh Li-Po | (off-board) | (off-board) | - | (off-board) External battery |',
    ].join('\n');

    // Run dossier with fixture symbol dirs
    const dossier = await bomSymbolDossier(bomMd, [SYMLIB]);
    // BT1 must be excluded from the symbol dossier
    expect(dossier).not.toContain('BT1');
    // U1 must resolve directly to its exact symbol name
    expect(dossier).toContain('U1');
  });

  it('6. Stage 4 IR validation refuses symbol substitution and refuses off-board parts on the sheet', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      const bomMd = [
        '# Bill of Materials',
        '',
        '| Refdes | Value | Symbol | Footprint | MPN | Rationale |',
        '|---|---|---|---|---|---|',
        '| U1 | STM32F103C8T6 | MCU_ST_STM32F1:STM32F103C8Tx | Package_QFP:LQFP-48_7x7mm_P0.5mm | UNVERIFIED STM32F103C8T6 | Main MCU |',
        '| BT1 | 500mAh Li-Po | (off-board) | (off-board) | - | (off-board) External battery |',
      ].join('\n');
      await writeFile(path.join(repo, 'docs', 'BOM.md'), bomMd, 'utf8');

      const symsource = new SymbolSource(repo, [SYMLIB]);

      // Case A: Model tries to substitute another symbol for U1 in schematic.intent.json
      const substitutedIntent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'U1', libId: 'Device:R', value: 'STM32F103C8T6', footprint: 'Package_QFP:LQFP-48_7x7mm_P0.5mm', group: 'Power' },
        ],
        nets: [
          { name: 'GND', pins: ['U1.1', 'U1.2'] },
        ],
      };

      const resSub = await validateIntent(substitutedIntent, symsource, path.join(repo, 'docs'));
      expect(resSub.ok).toBe(false);
      expect(resSub.findings.some((f) => f.detail.includes('differs from BOM.md\'s symbol "MCU_ST_STM32F1:STM32F103C8Tx"'))).toBe(true);

      // Case B: Model tries to place off-board BT1 on the schematic
      const offBoardIntent: SchematicIntent = {
        version: 1,
        parts: [
          { ref: 'BT1', libId: 'Device:Battery_Cell', value: '500mAh Li-Po', group: 'Power' },
        ],
        nets: [
          { name: 'VBAT', pins: ['BT1.1', 'BT1.2'] },
        ],
      };

      const resOffBoard = await validateIntent(offBoardIntent, symsource, path.join(repo, 'docs'));
      expect(resOffBoard.ok).toBe(false);
      expect(resOffBoard.findings.some((f) => f.detail.includes('is marked off-board in BOM.md and cannot be placed on the schematic'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('7. checkDrift excludes off-board components and passes without false drift errors', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      // BOM containing both on-board and off-board components
      const bomMd = [
        '# Bill of Materials',
        '',
        '| Refdes | Value | Symbol | Footprint | MPN | Rationale |',
        '|---|---|---|---|---|---|',
        '| R1 | 10k | Device:R | Resistor_SMD:R_0603_1608Metric | - | Bias resistor |',
        '| BT1 | 500mAh Li-Po | (off-board) | (off-board) | - | (off-board) External battery |',
      ].join('\n');
      await writeFile(path.join(repo, 'docs', 'BOM.md'), bomMd, 'utf8');

      // Schematic only contains R1 (BT1 is off-board)
      // checkDrift must not report BT1 as "exists in BOM.md but not in schematic"
      const schPath = path.join(repo, 'board.kicad_sch');
      // Minimal valid kicad_sch with R1
      const schContent = [
        '(kicad_sch (version 20231120) (generator copperhead)',
        '  (uuid "00000000-0000-0000-0000-000000000001")',
        '  (paper "A4")',
        '  (symbol (lib_id "Device:R") (at 100 100 0) (unit 1)',
        '    (property "Reference" "R1" (at 100 95 0) (effects (font (size 1.27 1.27))))',
        '    (property "Value" "10k" (at 100 105 0) (effects (font (size 1.27 1.27))))',
        '    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 100 110 0) (effects (font (size 1.27 1.27)) hide))',
        '  )',
        ')',
      ].join('\n');
      await writeFile(schPath, schContent, 'utf8');

      const drifts = await checkDrift(repo, 'docs', 'board.kicad_sch');
      expect(drifts.some((d) => d.claim.includes('BT1'))).toBe(false);
      expect(drifts).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
