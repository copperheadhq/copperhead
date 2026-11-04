import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm, writeFile, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runCheck } from '../src/commands/check.js';
import { renderBomMarkdown } from '../src/kicad/parts/bom-renderer.js';
import type { ExpandedPart } from '../src/kicad/parts/manifest.js';

const DRAFT_FIXTURE = path.resolve('test/fixtures/draft');
const SYMLIB_FIXTURE = path.resolve('test/fixtures/symlib');

async function makeTestRepo() {
  process.env.KICAD_SYMBOL_DIR = SYMLIB_FIXTURE;
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-check-manifest-test-'));
  await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await writeFile(
    path.join(repo, '.copperhead', 'config.json'),
    JSON.stringify({ docs: 'docs/', origin: 'create' }),
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
  const fpTable = [
    '(fp_lib_table',
    '  (version 7)',
    '  (lib (name "Resistor_SMD")(type "KiCad")(uri "${KIPRJMOD}/Resistor_SMD.pretty")(options "")(descr ""))',
    '  (lib (name "Capacitor_SMD")(type "KiCad")(uri "${KIPRJMOD}/Capacitor_SMD.pretty")(options "")(descr ""))',
    ')',
  ].join('\n');
  await writeFile(path.join(repo, 'fp-lib-table'), fpTable, 'utf8');

  // Author a minimal SUBSYSTEMS.md with known headers
  await writeFile(
    path.join(repo, 'docs', 'SUBSYSTEMS.md'),
    '# Subsystems\n\n## Power\n\nPower supply.\n\n## MCU\n\nMicrocontroller.\n',
    'utf8',
  );

  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

describe('check command manifest verification (Finding 3)', () => {
  const validParts = [
    {
      ref: 'R1',
      value: '10k',
      package: '0603',
      group: 'Power',
      rationale: 'Pullup',
    },
    {
      ref: 'C1',
      value: '100nF',
      package: '0402',
      group: 'MCU',
      rationale: 'Decoupling',
    },
  ];

  const validExpanded: ExpandedPart[] = [
    {
      ref: 'R1',
      value: '10k',
      libId: 'Device:R',
      footprint: 'Resistor_SMD:R_0603_1608Metric',
      mpn: '',
      group: 'Power',
      rationale: 'Pullup',
      offBoard: false,
      verified: false,
    },
    {
      ref: 'C1',
      value: '100nF',
      libId: 'Device:C',
      footprint: 'Capacitor_SMD:C_0402_1005Metric',
      mpn: '',
      group: 'MCU',
      rationale: 'Decoupling',
      offBoard: false,
      verified: false,
    },
  ];

  it('1. Valid manifest and matching BOM: check passes', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      const manifest = { version: 1, parts: validParts };
      await writeFile(path.join(repo, 'docs', 'parts.intent.json'), JSON.stringify(manifest, null, 2), 'utf8');
      const bom = renderBomMarkdown(validExpanded);
      await writeFile(path.join(repo, 'docs', 'BOM.md'), bom, 'utf8');

      const logs: string[] = [];
      const res = await runCheck(repo, (s) => logs.push(s));
      expect(res.ok).toBe(true);
      expect(res.manifest).toBeDefined();
      expect(res.manifest?.ok).toBe(true);
      expect(res.manifest?.drift).toBe(false);
      expect(res.manifest?.errors).toEqual([]);
      expect(logs).toContain('parts manifest ✓');
    } finally {
      await cleanup();
    }
  });

  it('2. Valid manifest and out-of-sync BOM: check fails with drift', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      const manifest = { version: 1, parts: validParts };
      await writeFile(path.join(repo, 'docs', 'parts.intent.json'), JSON.stringify(manifest, null, 2), 'utf8');
      // Hand-edit BOM.md to create drift
      await writeFile(path.join(repo, 'docs', 'BOM.md'), '# Outdated BOM\n| Refdes |\n|---|\n| R1 |\n', 'utf8');

      const logs: string[] = [];
      const res = await runCheck(repo, (s) => logs.push(s));
      expect(res.ok).toBe(false);
      expect(res.manifest?.ok).toBe(false);
      expect(res.manifest?.drift).toBe(true);
      expect(res.manifest?.errors.some((e) => e.includes('out of sync'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('3. Invalid manifest schema: check fails', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      // Manifest is missing required 'parts' array
      const manifest = { version: 1, invalid: true };
      await writeFile(path.join(repo, 'docs', 'parts.intent.json'), JSON.stringify(manifest, null, 2), 'utf8');

      const res = await runCheck(repo, () => {});
      expect(res.ok).toBe(false);
      expect(res.manifest?.ok).toBe(false);
      expect(res.manifest?.errors.some((e) => e.includes('must contain a "parts" array'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('4. Subsystem heading mismatch: check fails', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      // Group "RF" is not in SUBSYSTEMS.md (which only has Power and MCU)
      const manifest = {
        version: 1,
        parts: [
          { ref: 'R1', value: '10k', package: '0603', group: 'RF', rationale: 'Antenna matching' },
        ],
      };
      await writeFile(path.join(repo, 'docs', 'parts.intent.json'), JSON.stringify(manifest, null, 2), 'utf8');

      const res = await runCheck(repo, () => {});
      expect(res.ok).toBe(false);
      expect(res.manifest?.ok).toBe(false);
      expect(res.manifest?.errors.some((e) => e.includes('does not match any SUBSYSTEMS.md heading'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('5. Unresolved symbol: check fails', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      const manifest = {
        version: 1,
        parts: [
          {
            ref: 'U1',
            value: 'FAKE_CHIP',
            libId: 'NonExistentLibrary:NoSuchSymbol_404',
            footprint: 'Resistor_SMD:R_0603_1608Metric',
            mpn: 'FAKE-CHIP-123',
            group: 'MCU',
            rationale: 'Invalid symbol test',
          },
          {
            ref: 'R1',
            value: '10k',
            package: '0603',
            group: 'Power',
            rationale: 'Pullup',
          },
        ],
      };
      await writeFile(path.join(repo, 'docs', 'parts.intent.json'), JSON.stringify(manifest, null, 2), 'utf8');

      const res = await runCheck(repo, () => {});
      expect(res.ok).toBe(false);
      expect(res.manifest?.ok).toBe(false);
      expect(res.manifest?.errors.some((e) => e.includes('not installed') || e.includes('does not exist'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('6. Missing BOM.md when manifest exists: check fails', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      const manifest = { version: 1, parts: validParts };
      await writeFile(path.join(repo, 'docs', 'parts.intent.json'), JSON.stringify(manifest, null, 2), 'utf8');
      // Ensure BOM.md does not exist
      await rm(path.join(repo, 'docs', 'BOM.md'), { force: true });

      const res = await runCheck(repo, () => {});
      expect(res.ok).toBe(false);
      expect(res.manifest?.ok).toBe(false);
      expect(res.manifest?.drift).toBe(true);
      expect(res.manifest?.errors.some((e) => e.includes('BOM.md is missing'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('7. Legacy repo without manifest: check preserves existing behavior', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      // Ensure parts.intent.json does NOT exist
      await rm(path.join(repo, 'docs', 'parts.intent.json'), { force: true });

      const res = await runCheck(repo, () => {});
      expect(res.manifest).toBeUndefined();
      expect(res.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('8. Empty 0-byte manifest: check strictly fails (Finding 1)', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      // Write a 0-byte parts.intent.json
      await writeFile(path.join(repo, 'docs', 'parts.intent.json'), '', 'utf8');

      const res = await runCheck(repo, () => {});
      expect(res.ok).toBe(false);
      expect(res.manifest).toBeDefined();
      expect(res.manifest?.ok).toBe(false);
      expect(res.manifest?.errors).toContain('parts.intent.json is empty');
    } finally {
      await cleanup();
    }
  });

  it('9. Whitespace-only manifest: check strictly fails (Finding 1)', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      // Write whitespace-only parts.intent.json
      await writeFile(path.join(repo, 'docs', 'parts.intent.json'), '   \n  \t  \n', 'utf8');

      const res = await runCheck(repo, () => {});
      expect(res.ok).toBe(false);
      expect(res.manifest).toBeDefined();
      expect(res.manifest?.ok).toBe(false);
      expect(res.manifest?.errors).toContain('parts.intent.json is empty');
    } finally {
      await cleanup();
    }
  });

  it('10. Malformed JSON manifest: check fails with syntax error (Finding 1)', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      await writeFile(path.join(repo, 'docs', 'parts.intent.json'), '{ "version": 1, "parts": [ truncated ', 'utf8');

      const res = await runCheck(repo, () => {});
      expect(res.ok).toBe(false);
      expect(res.manifest?.ok).toBe(false);
      expect(res.manifest?.errors.some((e) => e.includes('not valid JSON'))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('11. Unsupported manifest version: check fails (Finding 1)', async () => {
    const { repo, cleanup } = await makeTestRepo();
    try {
      await writeFile(path.join(repo, 'docs', 'parts.intent.json'), JSON.stringify({ version: 99, parts: validParts }), 'utf8');

      const res = await runCheck(repo, () => {});
      expect(res.ok).toBe(false);
      expect(res.manifest?.ok).toBe(false);
      expect(res.manifest?.errors.some((e) => e.includes('unsupported manifest version'))).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
