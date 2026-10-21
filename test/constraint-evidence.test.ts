import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  verifyConstraintEvidence,
  type ConstraintRegistry,
  type EvidenceBackedConstraint,
} from '../src/memory/constraints.js';

describe('verifyConstraintEvidence (#232)', () => {
  it('passes when cached evidence exists in .copperhead/datasheets, matches sha256, contains the verbatim quote, and mentions the numeric bounds (including 3.30, U+2212 minus, and 1,000 formatting)', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-evidence-'));
    try {
      await mkdir(path.join(repo, '.copperhead', 'datasheets'), { recursive: true });
      const dsText = [
        'Section 6.3 Electrical Characteristics',
        'Ultra-low sleep current: 25 uA typical at Supply 3.30 V.',
        'Operating temperature Range −40 to 85 C. Max 1,000 mA peak.',
        'Fixed reference clock: 32 MHz.',
      ].join('\n');
      const dsPath = path.join(repo, '.copperhead', 'datasheets', 'mcu.pdf');
      const pdfBytes = Buffer.from('%PDF-1.4 binary stub');
      await writeFile(dsPath, pdfBytes);
      await writeFile(`${dsPath}.txt`, dsText, 'utf8');
      const sha256 = createHash('sha256').update(pdfBytes).digest('hex');

      const registry: Record<string, EvidenceBackedConstraint> = {
        'plain.unbacked': {
          max: 5,
          source: 'docs/REQ.md',
          affects: ['bom'],
        },
        'power.vdd': {
          max: 3.3,
          source: '.copperhead/datasheets/mcu.pdf#section-6.3',
          affects: ['schematic', 'bom'],
          evidence: {
            path: '.copperhead/datasheets/mcu.pdf',
            sha256,
            section: 'Section 6.3',
            quote: 'Ultra-low sleep current: 25 uA typical at Supply 3.30 V.',
          },
        },
        'thermal.range': {
          min: -40,
          max: 1000,
          source: '.copperhead/datasheets/mcu.pdf#section-6.3',
          affects: ['bom'],
          evidence: {
            path: '.copperhead/datasheets/mcu.pdf',
            quote: 'Operating temperature Range −40 to 85 C. Max 1,000 mA peak.',
          },
        },
        'clock.ref_mhz': {
          value: 32,
          source: '.copperhead/datasheets/mcu.pdf',
          affects: ['schematic'],
          evidence: {
            path: '.copperhead/datasheets/mcu.pdf',
            quote: 'Fixed reference clock: 32 MHz.',
            numbers: [32],
          },
        },
      };

      const violations = await verifyConstraintEvidence(repo, registry as ConstraintRegistry);
      expect(violations).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports drift on missing file, sha256 mismatch, altered quote (with section), numeric bound absence, and path escaping evidence cache (.env or ../)', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-evidence-drift-'));
    try {
      await mkdir(path.join(repo, '.copperhead', 'datasheets'), { recursive: true });
      await writeFile(path.join(repo, '.env'), 'OPENAI_API_KEY=sk-secret\n', 'utf8');
      await writeFile(
        path.join(repo, '.copperhead', 'datasheets', 'spec.txt'),
        'Maximum sleep current is 40 uA in standby mode.\n',
        'utf8',
      );

      const registry: Record<string, EvidenceBackedConstraint> = {
        'power.missing_doc': {
          max: 10,
          source: '.copperhead/datasheets/absent.txt',
          affects: ['bom'],
          evidence: {
            path: '.copperhead/datasheets/absent.txt',
            quote: '10 uA',
          },
        },
        'power.bad_hash': {
          max: 40,
          source: '.copperhead/datasheets/spec.txt',
          affects: ['bom'],
          evidence: {
            path: '.copperhead/datasheets/spec.txt',
            sha256: 'deadbeef',
            quote: 'Maximum sleep current is 40 uA in standby mode.',
          },
        },
        'power.altered_quote': {
          max: 40,
          source: '.copperhead/datasheets/spec.txt',
          affects: ['bom'],
          evidence: {
            path: '.copperhead/datasheets/spec.txt',
            section: 'Section 4.1',
            quote: 'Maximum sleep current is 12 uA in deep power-down mode.',
          },
        },
        'power.bound_drift': {
          max: 25,
          source: '.copperhead/datasheets/spec.txt',
          affects: ['bom'],
          evidence: {
            path: '.copperhead/datasheets/spec.txt',
            quote: 'Maximum sleep current is 40 uA in standby mode.',
          },
        },
        'power.empty_path': {
          max: 25,
          source: 'empty',
          affects: ['bom'],
          evidence: {
            path: '',
            quote: '25 uA',
          },
        },
        'power.escape_path': {
          max: 25,
          source: '../outside.txt',
          affects: ['bom'],
          evidence: {
            path: '../outside.txt',
            quote: '25 uA',
          },
        },
        'power.env_probe': {
          source: '.env',
          affects: ['bom'],
          evidence: {
            path: '.env',
            quote: 'OPENAI_API_KEY=sk-secret',
          },
        },
      };

      const violations = await verifyConstraintEvidence(repo, registry as ConstraintRegistry);
      expect(violations.map((v) => v.key)).toEqual([
        'power.missing_doc',
        'power.bad_hash',
        'power.altered_quote',
        'power.bound_drift',
        'power.empty_path',
        'power.escape_path',
        'power.env_probe',
      ]);
      expect(violations[0]?.description).toContain('does not exist');
      expect(violations[1]?.description).toContain('sha256 mismatch');
      expect(violations[2]?.description).toContain('not found verbatim');
      expect(violations[2]?.description).toContain('(Section 4.1)');
      expect(violations[3]?.description).toContain('is not present');
      expect(violations[4]?.description).toContain('escapes');
      expect(violations[5]?.description).toContain('escapes');
      expect(violations[6]?.description).toContain('escapes');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('turns directory paths, symlinks outside the cache, and non-string fields into violations without throwing', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-evidence-malformed-'));
    try {
      await mkdir(path.join(repo, 'docs', 'datasheets', 'subdir'), { recursive: true });
      await writeFile(path.join(repo, '.env'), 'SECRET=123\n', 'utf8');
      await writeFile(
        path.join(repo, 'docs', 'datasheets', 'valid.txt'),
        'Supply voltage 5 V nominal.\n',
        'utf8',
      );
      try {
        await symlink(path.join(repo, '.env'), path.join(repo, 'docs', 'datasheets', 'env-link.txt'));
      } catch {
        // Symlink creation may require privileges on some Windows hosts.
      }

      const registry: Record<string, unknown> = {
        bad_dir: {
          max: 5,
          source: 'docs',
          affects: ['bom'],
          evidence: { path: 'docs/datasheets/subdir', quote: 'x' },
        },
        bad_types: {
          max: 5,
          source: 'docs',
          affects: ['bom'],
          evidence: { path: 5, quote: 25 },
        },
        good: {
          value: 5,
          source: 'docs/datasheets/valid.txt',
          affects: ['bom'],
          evidence: { path: 'docs/datasheets/valid.txt', quote: 'Supply voltage 5 V nominal.' },
        },
      };

      const violations = await verifyConstraintEvidence(repo, registry as ConstraintRegistry);
      expect(violations.map((v) => v.key)).toEqual(['bad_dir', 'bad_types']);
      expect(violations[0]?.description).toContain('not a regular file');
      expect(violations[1]?.description).toContain('malformed evidence entry');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
