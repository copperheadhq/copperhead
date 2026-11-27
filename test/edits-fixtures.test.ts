import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSexp, listSymbols, pinNets } from '../src/kicad/sexp.js';
import { checkDrift } from '../src/memory/drift.js';

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

  it('budget refusal case has documented 25 µA sleep current budget', async () => {
    const caseDir = path.join(EDITS_DIR, 'budget-refusal-pullup');
    const config = JSON.parse(await readFile(path.join(caseDir, '.copperhead', 'config.json'), 'utf8'));
    expect(config.budgets?.['power.sleep_current_uA']).toBe(25);

    const spec = await readFile(path.join(caseDir, 'docs', 'SPEC.md'), 'utf8');
    expect(spec).toMatch(/sleep_current_uA:\s*25/);
  });
});
