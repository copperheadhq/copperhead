import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { validatePartsManifest } from '../src/kicad/parts/validator.js';
import { MANIFEST_VERSION, compareRefdes } from '../src/kicad/parts/manifest.js';
import type { FootprintResolver } from '../src/kicad/footprints.js';

describe('Phase 3 — Parts Manifest Validator (Adversarial Coverage)', () => {
  it('rejects malformed JSON', async () => {
    const res = await validatePartsManifest('{ not valid json');
    expect(res.ok).toBe(false);
    expect(res.findings[0].detail).toContain('manifest is not valid JSON');
  });

  it('rejects non-object manifest', async () => {
    const res = await validatePartsManifest('["array"]');
    expect(res.ok).toBe(false);
    expect(res.findings[0].detail).toContain('manifest must be a JSON object');
  });

  it('rejects missing or unsupported version', async () => {
    const resMissing = await validatePartsManifest(JSON.stringify({ parts: [] }));
    expect(resMissing.ok).toBe(false);
    expect(resMissing.findings.some((f) => f.detail.includes('unsupported manifest version'))).toBe(true);

    const resFuture = await validatePartsManifest(JSON.stringify({ version: 99, parts: [] }));
    expect(resFuture.ok).toBe(false);
    expect(resFuture.findings.some((f) => f.detail.includes('unsupported manifest version 99'))).toBe(true);
  });

  it('rejects empty parts array', async () => {
    const res = await validatePartsManifest(JSON.stringify({ version: MANIFEST_VERSION, parts: [] }));
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.detail.includes('"parts" array cannot be empty'))).toBe(true);
  });

  it('rejects duplicate and case-colliding refdes', async () => {
    const manifest = {
      version: 1,
      parts: [
        { ref: 'R1', value: '10k', package: '0603' },
        { ref: 'r1', value: '20k', package: '0603' },
        { ref: 'R2', value: '10k', package: '0603' },
        { ref: 'R2', value: '10k', package: '0603' },
      ],
    };
    const res = await validatePartsManifest(manifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.detail.includes('duplicate refdes "r1" collides case-insensitively with "R1"'))).toBe(true);
    expect(res.findings.some((f) => f.detail.includes('duplicate refdes "R2"'))).toBe(true);
  });

  it('rejects grouped or compound refdes', async () => {
    const manifest = {
      version: 1,
      parts: [
        { ref: 'R1-R4', value: '10k', package: '0603' },
        { ref: 'C1, C2', value: '100nF', package: '0603' },
        { ref: 'SW1..SW4', value: 'SPST', libId: 'Switch:SW_Push', footprint: 'Button_Switch_SMD:SW_SPST_PTS645' },
      ],
    };
    const res = await validatePartsManifest(manifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
    expect(res.ok).toBe(false);
    expect(res.findings.filter((f) => f.detail.includes('grouped or compound refdes')).length).toBe(3);
  });

  it('rejects reserved property names and invalid identifier formats', async () => {
    const manifest = {
      version: 1,
      parts: [
        { ref: '__proto__', value: '10k', package: '0603' },
        { ref: 'constructor', value: '10k', package: '0603' },
        { ref: '123R', value: '10k', package: '0603' },
        { ref: 'R!', value: '10k', package: '0603' },
      ],
    };
    const res = await validatePartsManifest(manifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.detail.includes('reserved property name'))).toBe(true);
    expect(res.findings.some((f) => f.detail.includes('invalid identifier format'))).toBe(true);
  });

  it('rejects prose descriptions in the value field', async () => {
    const manifest = {
      version: 1,
      parts: [
        {
          ref: 'BT1',
          value: '1S Li-Po cell, 500 mAh, bare leads',
          offBoard: true,
          rationale: 'External power',
        },
      ],
    };
    const res = await validatePartsManifest(manifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.detail.includes('looks like a prose description rather than a component value'))).toBe(true);
  });

  it('expands passive packages deterministically into standard libId and footprint', async () => {
    const manifest = {
      version: 1,
      parts: [
        { ref: 'R1', value: '10k', package: '0603', group: 'Sensors' },
        { ref: 'C1', value: '100nF', package: '0402', group: 'Power' },
        { ref: 'L1', value: '2.2uH', package: '0805', group: 'Power' },
        { ref: 'D1', value: '1N4148', package: 'SOD-123', group: 'Protection' },
        { ref: 'LED1', value: 'Red', package: '0603', group: 'UI' },
      ],
    };
    const res = await validatePartsManifest(manifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
    expect(res.ok).toBe(true);
    expect(res.expandedParts.length).toBe(5);

    const r1 = res.expandedParts.find((p) => p.ref === 'R1')!;
    expect(r1.libId).toBe('Device:R');
    expect(r1.footprint).toBe('Resistor_SMD:R_0603_1608Metric');

    const c1 = res.expandedParts.find((p) => p.ref === 'C1')!;
    expect(c1.libId).toBe('Device:C');
    expect(c1.footprint).toBe('Capacitor_SMD:C_0402_1005Metric');

    const d1 = res.expandedParts.find((p) => p.ref === 'D1')!;
    expect(d1.libId).toBe('Device:D');
    expect(d1.footprint).toBe('Diode_SMD:D_SOD-123');
  });

  it('rejects unsupported passive packages and mismatched non-passive package declarations', async () => {
    const manifest = {
      version: 1,
      parts: [
        { ref: 'R1', value: '10k', package: 'BGA-256' },
        { ref: 'U1', value: 'MCU', package: '0603' },
      ],
    };
    const res = await validatePartsManifest(manifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.detail.includes('unsupported passive package "BGA-256"'))).toBe(true);
    expect(res.findings.some((f) => f.detail.includes('is not a recognized passive prefix'))).toBe(true);
  });

  it('enforces off-board rationale, forbids PCB footprints on off-board parts', async () => {
    // Missing rationale for off-board part
    const resNoRationale = await validatePartsManifest(
      {
        version: 1,
        parts: [{ ref: 'BT1', value: '500mAh Li-Po', offBoard: true }],
      },
      { skipLibraryResolution: true },
    );
    expect(resNoRationale.ok).toBe(false);
    expect(resNoRationale.findings.some((f) => f.detail.includes('off-board parts must provide a "rationale"'))).toBe(true);

    // Off-board part falsely specifying a PCB footprint
    const resPcbFp = await validatePartsManifest(
      {
        version: 1,
        parts: [{ ref: 'BT1', value: '500mAh Li-Po', offBoard: true, footprint: 'Battery:BatteryHolder_Keystone_1058_1x2032', rationale: 'External' }],
      },
      { skipLibraryResolution: true },
    );
    expect(resPcbFp.ok).toBe(false);
    expect(resPcbFp.findings.some((f) => f.detail.includes('off-board part cannot specify a PCB "footprint"'))).toBe(true);

    // Valid off-board part with rationale
    const resValid = await validatePartsManifest(
      {
        version: 1,
        parts: [{ ref: 'BT1', value: '500mAh Li-Po', offBoard: true, rationale: 'Bare leads to J1 off-board' }],
      },
      { skipLibraryResolution: true, skipSubsystemsCoverage: true },
    );
    expect(resValid.ok).toBe(true);
    expect(resValid.expandedParts[0].offBoard).toBe(true);
    expect(resValid.expandedParts[0].footprint).toBe('(off-board)');
  });

  it('prohibits model-manufactured verified: true (Finding 1: remove model-controlled verification authority)', async () => {
    const manifest = {
      version: 1,
      parts: [
        {
          ref: 'U1',
          value: 'STM32F103C8T6',
          libId: 'MCU_ST_STM32F1:STM32F103C8Tx',
          footprint: 'Package_QFP:LQFP-48_7x7mm_P0.5mm',
          mpn: 'STM32F103C8T6',
          verified: true, // Model attempting to manufacture verification
        },
      ],
    };
    const res = await validatePartsManifest(manifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.detail.includes("model cannot assert 'verified: true'"))).toBe(true);

    // When verified is omitted or false, MPN defaults to unverified and passes validation
    const unverifiedManifest = {
      version: 1,
      parts: [
        {
          ref: 'U1',
          value: 'STM32F103C8T6',
          libId: 'MCU_ST_STM32F1:STM32F103C8Tx',
          footprint: 'Package_QFP:LQFP-48_7x7mm_P0.5mm',
          mpn: 'STM32F103C8T6',
        },
      ],
    };
    const resUnverified = await validatePartsManifest(unverifiedManifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
    expect(resUnverified.ok).toBe(true);
    expect(resUnverified.expandedParts[0].verified).toBe(false);
  });

  it('validates subsystems group coverage bidirectionally', async () => {
    const headings = ['Power Supply', 'Microcontroller', 'Sensors'];
    const manifest = {
      version: 1,
      parts: [
        { ref: 'U1', value: 'STM32F103C8T6', libId: 'MCU_ST_STM32F1:STM32F103C8Tx', footprint: 'Package_QFP:LQFP-48_7x7mm_P0.5mm', mpn: 'STM32F103C8T6', group: 'Microcontroller' },
        { ref: 'C1', value: '100nF', package: '0603', group: 'UnknownGroup' },
      ],
    };

    const res = await validatePartsManifest(manifest, {
      subsystemsHeadings: headings,
      skipLibraryResolution: true,
    });
    expect(res.ok).toBe(false);
    // C1 names unknown group
    expect(res.findings.some((f) => f.detail.includes('group "UnknownGroup" does not match any SUBSYSTEMS.md heading'))).toBe(true);
    // Headings 'Power Supply' and 'Sensors' have no parts assigned
    expect(res.findings.some((f) => f.detail.includes('subsystem heading "Power Supply" has no parts assigned'))).toBe(true);
    expect(res.findings.some((f) => f.detail.includes('subsystem heading "Sensors" has no parts assigned'))).toBe(true);
  });

  it('validates substitutions structure and references', async () => {
    const manifest = {
      version: 1,
      parts: [
        { ref: 'U1', value: 'IR2104', libId: 'Driver_Motor:IR2104', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', mpn: 'IR2104' },
        { ref: 'U2', value: 'IR2104', libId: 'Driver_Motor:IR2104', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', mpn: 'IR2104' },
      ],
      substitutions: [
        { ref: 'U1', wanted: 'DRV8701', chosen: 'IR2104', reason: 'No installed KiCad symbol for DRV8701' },
        { ref: 'U99', wanted: 'X', chosen: 'Y', reason: 'Part does not exist' }, // non-existent part
        { ref: 'U2', wanted: 'DRV8701', chosen: 'IR2104', reason: '' }, // empty reason
      ],
    };
    const res = await validatePartsManifest(manifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
    expect(res.ok).toBe(false);
    expect(res.findings.some((f) => f.detail.includes('substitution names ref "U99", which is not present'))).toBe(true);
    expect(res.findings.some((f) => f.detail.includes('requires non-empty "ref", "wanted", "chosen", and "reason"'))).toBe(true);
  });

  describe('Substitution Contract Enforcement (Task 1)', () => {
    it('passes for a valid selected substitution where part.mpn matches chosen', async () => {
      const manifest = {
        version: 1,
        parts: [
          { ref: 'R1', value: '10k', package: '0603', mpn: 'RC0603FR-0710KL' },
        ],
        substitutions: [
          { ref: 'R1', wanted: 'CRCW060310K0FKEA', chosen: 'RC0603FR-0710KL', reason: 'Distributor stock availability' },
        ],
      };
      const res = await validatePartsManifest(manifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
      expect(res.ok).toBe(true);
      expect(res.substitutions).toHaveLength(1);
      expect(res.substitutions[0].chosen).toBe('RC0603FR-0710KL');
      expect(res.expandedParts[0].mpn).toBe('RC0603FR-0710KL');
    });

    it('rejects substitution with chosen MPN when canonical part has no MPN', async () => {
      const manifest = {
        version: 1,
        parts: [
          { ref: 'R1', value: '10k', package: '0603' }, // no mpn
        ],
        substitutions: [
          { ref: 'R1', wanted: 'CRCW060310K0FKEA', chosen: 'RC0603FR-0710KL', reason: 'Stock shortage' },
        ],
      };
      const res = await validatePartsManifest(manifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
      expect(res.ok).toBe(false);
      expect(res.findings.some((f) =>
        f.detail.includes('substitution specifies chosen MPN "RC0603FR-0710KL", but canonical part has no "mpn" declared')
      )).toBe(true);
    });

    it('rejects substitution when chosen MPN conflicts with canonical part MPN', async () => {
      const manifest = {
        version: 1,
        parts: [
          { ref: 'R1', value: '10k', package: '0603', mpn: 'CRCW060310K0FKEA' },
        ],
        substitutions: [
          { ref: 'R1', wanted: 'CRCW060310K0FKEA', chosen: 'RC0603FR-0710KL', reason: 'Cheaper' },
        ],
      };
      const res = await validatePartsManifest(manifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
      expect(res.ok).toBe(false);
      expect(res.findings.some((f) =>
        f.detail.includes('canonical part mpn "CRCW060310K0FKEA" conflicts with substitution chosen MPN "RC0603FR-0710KL"')
      )).toBe(true);
    });

    it('preserves unverified provenance for chosen substitute', async () => {
      const manifest = {
        version: 1,
        parts: [
          { ref: 'R1', value: '10k', package: '0603', mpn: 'RC0603FR-0710KL' },
        ],
        substitutions: [
          { ref: 'R1', wanted: 'CRCW060310K0FKEA', chosen: 'RC0603FR-0710KL', reason: 'Stock shortage' },
        ],
      };
      const res = await validatePartsManifest(manifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
      expect(res.ok).toBe(true);
      expect(res.expandedParts[0].verified).toBe(false);
    });

    it('passes cleanly when manifest contains no substitutions (legacy/direct selection)', async () => {
      const manifest = {
        version: 1,
        parts: [
          { ref: 'R1', value: '10k', package: '0603', mpn: 'RC0603FR-0710KL' },
        ],
      };
      const res = await validatePartsManifest(manifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
      expect(res.ok).toBe(true);
      expect(res.substitutions).toHaveLength(0);
    });

    it('rejects multiple substitutions for one refdes', async () => {
      const manifest = {
        version: 1,
        parts: [
          { ref: 'R1', value: '10k', package: '0603', mpn: 'RC0603FR-0710KL' },
        ],
        substitutions: [
          { ref: 'R1', wanted: 'W1', chosen: 'RC0603FR-0710KL', reason: 'First choice' },
          { ref: 'R1', wanted: 'W2', chosen: 'RC0603FR-0710KL', reason: 'Second choice' },
        ],
      };
      const res = await validatePartsManifest(manifest, {
      skipLibraryResolution: true,
      skipSubsystemsCoverage: true,
    });
      expect(res.ok).toBe(false);
      expect(res.findings.some((f) =>
        f.detail.includes('duplicate substitution for refdes "R1"; each refdes may have at most one substitution record')
      )).toBe(true);
    });
  });

  it('natural refdes sorting behaves consistently', () => {
    const refs = ['C10', 'C1', 'C2', 'R1', 'R10', 'R2', 'U1', 'BT1'];
    refs.sort(compareRefdes);
    expect(refs).toEqual(['BT1', 'C1', 'C2', 'C10', 'R1', 'R2', 'R10', 'U1']);
  });

  describe('Source Review Regression Tests (Findings 1-3)', () => {
    it('fails closed when symbolDirs is empty or footprint resolver is unavailable (Finding 1)', async () => {
      const manifest = {
        version: 1,
        parts: [
          {
            ref: 'U1',
            value: 'Nonexistent',
            libId: 'Nonexistent:NonexistentSymbol',
            footprint: 'Nonexistent:NonexistentFootprint',
            group: 'MCU',
          },
        ],
      };
      const res = await validatePartsManifest(manifest, {
        symbolDirs: [],
        footprints: undefined,
        subsystemsHeadings: ['MCU'],
      });
      expect(res.ok).toBe(false);
      expect(
        res.findings.some((f) =>
          f.detail.includes('symbol "Nonexistent:NonexistentSymbol" cannot be verified: no symbol library directories available'),
        ),
      ).toBe(true);
      expect(
        res.findings.some((f) =>
          f.detail.includes('footprint "Nonexistent:NonexistentFootprint" cannot be verified: no footprint resolver available'),
        ),
      ).toBe(true);
    });

    it('fails closed when subsystemsHeadings is null or empty (Finding 2)', async () => {
      const manifest = {
        version: 1,
        parts: [
          { ref: 'R1', value: '10k', package: '0603', group: 'Sensors' },
        ],
      };

      const resNull = await validatePartsManifest(manifest, {
        subsystemsHeadings: null,
        skipLibraryResolution: true,
      });
      expect(resNull.ok).toBe(false);
      expect(
        resNull.findings.some((f) =>
          f.detail.includes('missing or empty subsystem definitions; manifest parts require valid SUBSYSTEMS.md headings'),
        ),
      ).toBe(true);

      const resEmpty = await validatePartsManifest(manifest, {
        subsystemsHeadings: [],
        skipLibraryResolution: true,
      });
      expect(resEmpty.ok).toBe(false);
      expect(
        resEmpty.findings.some((f) =>
          f.detail.includes('missing or empty subsystem definitions; manifest parts require valid SUBSYSTEMS.md headings'),
        ),
      ).toBe(true);
    });

    it('fails validation when footprint has unexplained unpinned signal pads (Finding 3)', async () => {
      const tempDir = await mkdtemp(path.join(tmpdir(), 'copperhead-fp-test-'));
      try {
        const modPath = path.join(tempDir, 'Test_3Pad.kicad_mod');
        await writeFile(
          modPath,
          '(footprint "Test_3Pad" (version 20240108) (generator kicad) (pad "1" smd roundrect (at -1 0)) (pad "2" smd roundrect (at 1 0)) (pad "3" smd roundrect (at 0 1)))',
          'utf8',
        );

        const mockFootprints: FootprintResolver = {
          resolve: async () => ({
            ok: true,
            file: modPath,
            near: [],
          }),
          variantCovering: async () => null,
          check: async () => ({ missing: [], available: [] }),
        };

        const manifest = {
          version: 1,
          parts: [
            {
              ref: 'R1',
              value: '10k',
              libId: 'Device:R',
              footprint: 'Test:Test_3Pad',
              group: 'Passive',
            },
          ],
        };

        const res = await validatePartsManifest(manifest, {
          symbolDirs: [path.resolve('test/fixtures/symlib')],
          footprints: mockFootprints,
          subsystemsHeadings: ['Passive'],
        });

        expect(res.ok).toBe(false);
        expect(
          res.findings.some(
            (f) =>
              f.detail.includes('pad(s) 3 of footprint Test:Test_3Pad have no symbol pin') &&
              f.detail.includes('diverge'),
          ),
        ).toBe(true);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
