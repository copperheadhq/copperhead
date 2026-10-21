import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  verifyConstraintEvidence,
  type ConstraintRegistry,
  type EvidenceBackedConstraint,
} from '../src/memory/constraints.js';

describe('verifyConstraintEvidence (#232)', () => {
  it('passes when cached evidence exists, matches sha256, contains the verbatim quote, and cites the numeric bound', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-evidence-'));
    try {
      await mkdir(path.join(repo, 'docs', 'datasheets'), { recursive: true });
      const dsText =
        'Section 6.3 Electrical Characteristics\nUltra-low sleep current: 25 uA typical at 3.3 V.\n';
      const dsPath = path.join(repo, 'docs', 'datasheets', 'mcu.txt');
      await writeFile(dsPath, dsText, 'utf8');
      const sha256 = createHash('sha256').update(dsText, 'utf8').digest('hex');

      const registry: Record<string, EvidenceBackedConstraint> = {
        'power.sleep_current_uA': {
          max: 25,
          source: 'docs/datasheets/mcu.txt#section-6.3',
          affects: ['schematic', 'bom'],
          evidence: {
            path: 'docs/datasheets/mcu.txt',
            sha256,
            section: 'Section 6.3',
            quote: 'Ultra-low sleep current: 25 uA typical at 3.3 V.',
          },
        },
      };

      const violations = await verifyConstraintEvidence(repo, registry as ConstraintRegistry);
      expect(violations).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports drift on missing file, sha256 mismatch, altered quote, or unsubstantiated numeric bound', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-evidence-drift-'));
    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(
        path.join(repo, 'docs', 'spec.txt'),
        'Maximum sleep current is 40 uA in standby mode.\n',
        'utf8',
      );

      const registry: Record<string, EvidenceBackedConstraint> = {
        'power.missing_doc': {
          max: 10,
          source: 'docs/absent.txt',
          affects: ['bom'],
          evidence: {
            path: 'docs/absent.txt',
            quote: '10 uA',
          },
        },
        'power.bad_hash': {
          max: 40,
          source: 'docs/spec.txt',
          affects: ['bom'],
          evidence: {
            path: 'docs/spec.txt',
            sha256: 'deadbeef',
            quote: 'Maximum sleep current is 40 uA in standby mode.',
          },
        },
        'power.bound_drift': {
          max: 25,
          source: 'docs/spec.txt',
          affects: ['bom'],
          evidence: {
            path: 'docs/spec.txt',
            quote: 'Maximum sleep current is 40 uA in standby mode.',
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
      };

      const violations = await verifyConstraintEvidence(repo, registry as ConstraintRegistry);
      expect(violations.map((v) => v.key)).toEqual([
        'power.missing_doc',
        'power.bad_hash',
        'power.bound_drift',
        'power.escape_path',
      ]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
