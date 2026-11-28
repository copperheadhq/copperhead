import { describe, it, expect } from 'vitest';
import { readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { parseSexp, listSymbols, pinNets } from '../src/kicad/sexp.js';
import { checkDrift } from '../src/memory/drift.js';
import { runErc, runDrc, KicadCliMissingError } from '../src/kicad/cli.js';
import { tempFixtureRepo } from './helpers.js';
import { buildAllFixtures } from '../scripts/build-edit-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITS_DIR = path.join(HERE, 'fixtures', 'edits');

const EXPECTED_CASES = [
  'rename-net-cross-sheet',
  'pin-choice-strapping',
  'add-part-second-led',
  'budget-refusal-pullup',
  'repair-loop',
  'rollback',
];

describe('edit-verification fixtures (issue #58, AC-3.1..AC-3.6)', () => {
  it('includes all 6 expected test cases', async () => {
    const entries = await readdir(EDITS_DIR, { withFileTypes: true });
    const cases = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    for (const expected of EXPECTED_CASES) {
      expect(cases).toContain(expected);
    }
  });

  it('README.md references all fixtures and their acceptance criteria', async () => {
    const readme = await readFile(path.join(EDITS_DIR, 'README.md'), 'utf8');
    for (const c of EXPECTED_CASES) {
      expect(readme).toContain(c);
    }
    expect(readme).toContain('AC-3.1');
    expect(readme).toContain('AC-3.2');
    expect(readme).toContain('AC-3.3');
    expect(readme).toContain('AC-3.4');
    expect(readme).toContain('AC-3.5');
    expect(readme).toContain('AC-3.6');
  });

  // F4(a): static guard test asserting every mustContain is unmet in the starting tree
  it('every mustContain expectation is unmet in starting tree', async () => {
    for (const caseId of EXPECTED_CASES) {
      const caseDir = path.join(EDITS_DIR, caseId);
      const manifestPath = path.join(caseDir, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const mustContain = manifest.expect?.mustContain;
      if (!mustContain) continue;

      for (const [relPath, needleOrNeedles] of Object.entries(mustContain)) {
        const fullPath = path.join(caseDir, relPath);
        if (!existsSync(fullPath)) continue;
        const text = await readFile(fullPath, 'utf8');
        const needles = Array.isArray(needleOrNeedles) ? needleOrNeedles : [needleOrNeedles];
        for (const needle of needles) {
          expect(
            text.includes(needle as string),
            `case "${caseId}": expected mustContain "${needle}" in ${relPath} to be absent from starting tree`,
          ).toBe(false);
        }
      }
    }
  });

  // F7: generator reproduction test ensuring generator reproduces committed tree byte-for-byte
  it('generator reproduces committed fixtures byte-for-byte', async () => {
    const tempDir = path.join(os.tmpdir(), `copperhead-edits-diff-${Date.now()}`);
    try {
      await buildAllFixtures(tempDir);

      const compareDirs = async (sourceDir: string, targetDir: string): Promise<void> => {
        const entries = await readdir(sourceDir, { withFileTypes: true });
        for (const entry of entries) {
          const sPath = path.join(sourceDir, entry.name);
          const tPath = path.join(targetDir, entry.name);
          expect(existsSync(tPath), `Generated file missing: ${tPath}`).toBe(true);
          if (entry.isDirectory()) {
            await compareDirs(sPath, tPath);
          } else {
            const sContent = await readFile(sPath, 'utf8');
            const tContent = await readFile(tPath, 'utf8');
            expect(tContent, `Content mismatch in ${entry.name}`).toBe(sContent);
          }
        }
      };

      await compareDirs(EDITS_DIR, tempDir);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  for (const caseId of EXPECTED_CASES) {
    describe(`case: ${caseId}`, () => {
      const caseDir = path.join(EDITS_DIR, caseId);

      it('has valid manifest.json matching schema', async () => {
        const manifestPath = path.join(caseDir, 'manifest.json');
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        expect(manifest.id).toBe(caseId);
        expect(manifest.ac).toMatch(/^AC-3\.[1-6]$/);
        expect(typeof manifest.title).toBe('string');
        expect(manifest.title.length).toBeGreaterThan(0);
        expect(typeof manifest.instruction).toBe('string');
        expect(manifest.instruction.length).toBeGreaterThan(0);
        expect(manifest.expect).toBeDefined();
        expect(['success', 'refused', 'failure']).toContain(manifest.expect.outcome);

        // F5 schema verification
        if (manifest.expect.filesChanged) {
          expect(Array.isArray(manifest.expect.filesChanged.mustChange)).toBe(true);
          expect(Array.isArray(manifest.expect.filesChanged.mayChange)).toBe(true);
        }
        if (manifest.expect.outcome === 'refused') {
          expect(typeof manifest.expect.refusalBlocker).toBe('string');
        }
      });

      it('has complete documentation set in docs/', () => {
        const requiredDocs = ['SPEC.md', 'BOM.md', 'PINOUT.md', 'SUBSYSTEMS.md', 'LAYOUT.md', 'DECISIONS.md', 'CHANGELOG.md'];
        for (const doc of requiredDocs) {
          expect(existsSync(path.join(caseDir, 'docs', doc)), `${doc} must exist`).toBe(true);
        }
      });

      it('has copperhead config and constraints', () => {
        expect(existsSync(path.join(caseDir, '.copperhead', 'config.json'))).toBe(true);
        expect(existsSync(path.join(caseDir, '.copperhead', 'constraints.json'))).toBe(true);
      });

      it('has hardware files (.kicad_pro, .kicad_prl, .kicad_sch, .kicad_pcb)', () => {
        expect(existsSync(path.join(caseDir, 'hardware', `${caseId}.kicad_pro`))).toBe(true);
        expect(existsSync(path.join(caseDir, 'hardware', `${caseId}.kicad_prl`))).toBe(true);
        expect(existsSync(path.join(caseDir, 'hardware', `${caseId}.kicad_sch`))).toBe(true);
        expect(existsSync(path.join(caseDir, 'hardware', `${caseId}.kicad_pcb`))).toBe(true);
      });

      it('schematic and PCB parse cleanly as KiCad s-expressions', async () => {
        const schText = await readFile(path.join(caseDir, 'hardware', `${caseId}.kicad_sch`), 'utf8');
        const [schRoot] = parseSexp(schText);
        expect(schRoot).toBeDefined();

        const pcbText = await readFile(path.join(caseDir, 'hardware', `${caseId}.kicad_pcb`), 'utf8');
        const [pcbRoot] = parseSexp(pcbText);
        expect(pcbRoot).toBeDefined();
      });

      it('extracts symbols and pin nets cleanly', async () => {
        const schPath = path.join(caseDir, 'hardware', `${caseId}.kicad_sch`);
        const symbols = await listSymbols(schPath);
        expect(symbols.length).toBeGreaterThan(0);

        const pins = await pinNets(schPath);
        expect(pins.length).toBeGreaterThan(0);
      });

      it('has zero drift between schematic and docs', async () => {
        const mismatches = await checkDrift(caseDir, 'docs', `hardware/${caseId}.kicad_sch`);
        expect(mismatches).toEqual([]);
      });

      // F6: ERC and DRC clean check on a copy of the case in a temp repo
      it('starting project is ERC- and DRC-clean under kicad-cli', async () => {
        const { repo, cleanup } = await tempFixtureRepo(caseDir);
        try {
          const schPath = path.join(repo, 'hardware', `${caseId}.kicad_sch`);
          const erc = await runErc(schPath);
          const ercErrors = erc.violations.filter((v) => v.severity === 'error');
          expect(ercErrors, `Starting ERC errors in ${caseId}`).toEqual([]);

          const pcbPath = path.join(repo, 'hardware', `${caseId}.kicad_pcb`);
          const drc = await runDrc(pcbPath);
          const drcErrors = drc.violations.filter((v) => v.severity === 'error');
          expect(drcErrors, `Starting DRC errors in ${caseId}`).toEqual([]);
          expect(drc.unconnected, `Starting unconnected items in ${caseId}`).toBe(0);
          expect(drc.parityErrors, `Starting schematic/PCB parity errors in ${caseId}`).toBe(0);
        } catch (err) {
          if (err instanceof KicadCliMissingError) {
            // kicad-cli not installed in this environment (e.g. dev host); safely skip
            return;
          }
          throw err;
        } finally {
          await cleanup();
        }
      });
    });
  }

  it('multi-sheet case (rename-net-cross-sheet) parses both root and subsheet', async () => {
    const caseDir = path.join(EDITS_DIR, 'rename-net-cross-sheet');
    const schPath = path.join(caseDir, 'hardware', 'rename-net-cross-sheet.kicad_sch');
    const symbols = await listSymbols(schPath);
    // Root sheet has U1, Keyer subsheet has R1 and R2
    expect(symbols.map((s) => s.ref).sort()).toEqual(['R1', 'R2', 'U1']);
    const sheets = symbols.map((s) => s.sheet);
    expect(sheets).toContain('/');
    expect(sheets).toContain('Keyer');

    const pins = await pinNets(schPath);
    const dahPins = pins.filter((p) => p.net === 'KEY_DAH');
    expect(dahPins.length).toBeGreaterThanOrEqual(2);
    expect(dahPins.map((p) => p.ref)).toContain('U1');
    expect(dahPins.map((p) => p.ref)).toContain('R2');
  });

  it('strapping-pin case has documented strapping constraints', async () => {
    const caseDir = path.join(EDITS_DIR, 'pin-choice-strapping');
    const constraints = JSON.parse(await readFile(path.join(caseDir, '.copperhead', 'constraints.json'), 'utf8'));
    expect(constraints['pinout.strapping']?.forbidden).toEqual(['GPIO0', 'GPIO3', 'GPIO45', 'GPIO46']);

    const spec = await readFile(path.join(caseDir, 'docs', 'SPEC.md'), 'utf8');
    expect(spec).toContain('GPIO0');
    expect(spec).toContain('GPIO3');
    expect(spec).toContain('GPIO45');
    expect(spec).toContain('GPIO46');
  });

  // F8: pin-choice-strapping dual write test for pinout.rtc_capable
  it('strapping-pin case has documented rtc_capable constraint matching SPEC.md', async () => {
    const caseDir = path.join(EDITS_DIR, 'pin-choice-strapping');
    const constraints = JSON.parse(await readFile(path.join(caseDir, '.copperhead', 'constraints.json'), 'utf8'));
    expect(constraints['pinout.rtc_capable']).toBeDefined();
    expect(constraints['pinout.rtc_capable'].affects).toContain('KEY_IN');

    const spec = await readFile(path.join(caseDir, 'docs', 'SPEC.md'), 'utf8');
    expect(spec).toContain('rtc_capable');
    expect(spec).toContain('RTC-capable');
  });

  it('budget refusal case has documented 25 µA sleep current budget', async () => {
    const caseDir = path.join(EDITS_DIR, 'budget-refusal-pullup');
    const config = JSON.parse(await readFile(path.join(caseDir, '.copperhead', 'config.json'), 'utf8'));
    expect(config.budgets?.['power.sleep_current_uA']).toBe(25);

    const spec = await readFile(path.join(caseDir, 'docs', 'SPEC.md'), 'utf8');
    expect(spec).toMatch(/sleep_current_uA:\s*25/);
  });
});
