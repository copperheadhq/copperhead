import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HANDLERS } from '../src/capabilities/handlers.js';
import { ObligationsLedger } from '../src/agent/ledger.js';
import type { RunContext } from '../src/agent/types.js';
import { runCheck } from '../src/commands/check.js';
import { syncVerify, formatSyncReport } from '../src/commands/sync.js';
import {
  loadConstraints,
  saveConstraints,
  verifyConstraintEvidence,
  type ConstraintRegistry,
  type EvidenceBackedConstraint,
} from '../src/memory/constraints.js';

describe('verifyConstraintEvidence (#232)', () => {
  it('passes on valid cached evidence, hyphenated ranges (1.8-3.6 V), index.json hashes, sidecarSha256, and numbers overrides', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-evidence-'));
    try {
      await mkdir(path.join(repo, '.copperhead', 'datasheets'), { recursive: true });
      const dsText = [
        'Section 6.3 Electrical Characteristics',
        'Ultra-low sleep current: 25 uA typical at Supply 3.30 V.',
        'VDD operating range 1.8-3.6 V across temperature.',
        'Operating temperature Range \u221240 to 85 C. Max 1,000 mA peak.',
        'Fixed reference clock: 32 MHz.',
      ].join('\n');
      const dsPath = path.join(repo, '.copperhead', 'datasheets', 'mcu.pdf');
      const pdfBytes = Buffer.from('%PDF-1.4 binary stub');
      const sidecarBytes = Buffer.from(dsText, 'utf8');
      await writeFile(dsPath, pdfBytes);
      await writeFile(`${dsPath}.txt`, sidecarBytes);
      const sha256 = createHash('sha256').update(pdfBytes).digest('hex');
      const sidecarSha256 = createHash('sha256').update(sidecarBytes).digest('hex');
      await writeFile(
        path.join(repo, '.copperhead', 'datasheets', 'index.json'),
        JSON.stringify([{ path: '.copperhead/datasheets/mcu.pdf', sha256 }], null, 2),
        'utf8',
      );

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
            sidecarSha256,
            section: 'Section 6.3',
            quote: 'Ultra-low sleep current: 25 uA typical at Supply 3.30 V.',
          },
        },
        'power.vdd_range': {
          min: 1.8,
          max: 3.6,
          source: '.copperhead/datasheets/mcu.pdf#section-6.3',
          affects: ['schematic'],
          evidence: {
            path: '.copperhead/datasheets/mcu.pdf',
            quote: 'VDD operating range 1.8-3.6 V across temperature.',
          },
        },
        'thermal.range': {
          min: -40,
          max: 1000,
          source: '.copperhead/datasheets/mcu.pdf#section-6.3',
          affects: ['bom'],
          evidence: {
            path: '.copperhead/datasheets/mcu.pdf',
            quote: 'Operating temperature Range \u221240 to 85 C. Max 1,000 mA peak.',
          },
        },
        // `max: 99` is NOT in the quote; `numbers: [32]` genuinely overrides the bound check.
        'clock.ref_mhz': {
          max: 99,
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

  it('catches missing files, sha256 mismatch, altered quote, string value drift, non-numeric numbers, missing PDF sidecar, and path escapes', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-evidence-drift-'));
    try {
      await mkdir(path.join(repo, '.copperhead', 'datasheets'), { recursive: true });
      await writeFile(path.join(repo, '.env'), 'OPENAI_API_KEY=sk-secret\n', 'utf8');
      await writeFile(
        path.join(repo, '.copperhead', 'datasheets', 'spec.txt'),
        'Maximum sleep current is 40 uA in standby mode. Clock 32 MHz.\n',
        'utf8',
      );
      await writeFile(
        path.join(repo, '.copperhead', 'datasheets', 'nosidecar.pdf'),
        Buffer.from('%PDF-1.4 no sidecar'),
      );

      const registry: Record<string, EvidenceBackedConstraint> = {
        'power.missing_doc': {
          max: 10,
          source: '.copperhead/datasheets/absent.txt',
          affects: ['bom'],
          evidence: { path: '.copperhead/datasheets/absent.txt', quote: '10 uA' },
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
        'power.string_value_drift': {
          value: '99',
          source: '.copperhead/datasheets/spec.txt',
          affects: ['bom'],
          evidence: {
            path: '.copperhead/datasheets/spec.txt',
            quote: 'Clock 32 MHz.',
          },
        },
        'power.non_numeric_value': {
          value: 'external-xtal',
          source: '.copperhead/datasheets/spec.txt',
          affects: ['bom'],
          evidence: {
            path: '.copperhead/datasheets/spec.txt',
            quote: 'Clock 32 MHz.',
          },
        },
        'power.non_numeric_numbers': {
          max: 99,
          source: '.copperhead/datasheets/spec.txt',
          affects: ['bom'],
          evidence: {
            path: '.copperhead/datasheets/spec.txt',
            quote: 'Clock 32 MHz.',
            numbers: ['abc'],
          },
        },
        'power.missing_pdf_sidecar': {
          max: 40,
          source: '.copperhead/datasheets/nosidecar.pdf',
          affects: ['bom'],
          evidence: {
            path: '.copperhead/datasheets/nosidecar.pdf',
            quote: '40 uA',
          },
        },
        'power.escape_path': {
          max: 25,
          source: '../outside.txt',
          affects: ['bom'],
          evidence: { path: '../outside.txt', quote: '25 uA' },
        },
        'power.env_probe': {
          source: '.env',
          affects: ['bom'],
          evidence: { path: '.env', quote: 'OPENAI_API_KEY=sk-secret' },
        },
      };

      const violations = await verifyConstraintEvidence(repo, registry as ConstraintRegistry);
      expect(violations.map((v) => v.key)).toEqual([
        'power.missing_doc',
        'power.bad_hash',
        'power.altered_quote',
        'power.string_value_drift',
        'power.non_numeric_numbers',
        'power.missing_pdf_sidecar',
        'power.escape_path',
        'power.env_probe',
      ]);
      expect(violations[3]?.description).toContain('bound "99" is not present');
      expect(violations[4]?.description).toContain('non-numeric');
      expect(violations[5]?.description).toContain('no extracted-text sidecar');
      // power.non_numeric_value is deliberately absent: its value is
      // qualitative ("external-xtal"), the cited quote matches verbatim, and
      // there is no bound to check. It is not a violation.
      expect(violations.some((v) => v.key === 'power.non_numeric_value')).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('checks a unit-suffixed value against the quote instead of rejecting it', async () => {
    // record_constraint declares `value` as a string, so "3.3 V" is the
    // natural thing for an agent to record. Reading it as non-numeric was a
    // permanent red check on a board whose quote plainly states 3.3 V.
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-evidence-unit-'));
    try {
      await mkdir(path.join(repo, '.copperhead', 'datasheets'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'datasheets', 'spec.txt'),
        'Supply 3.3 V nominal.\n',
        'utf8',
      );

      const registry: Record<string, EvidenceBackedConstraint> = {
        'power.unit_value': {
          value: '3.3 V',
          source: '.copperhead/datasheets/spec.txt',
          affects: ['bom'],
          evidence: { path: '.copperhead/datasheets/spec.txt', quote: 'Supply 3.3 V nominal.' },
        },
        'power.unit_value_wrong': {
          value: '5.0 V',
          source: '.copperhead/datasheets/spec.txt',
          affects: ['bom'],
          evidence: { path: '.copperhead/datasheets/spec.txt', quote: 'Supply 3.3 V nominal.' },
        },
      };

      const violations = await verifyConstraintEvidence(repo, registry as ConstraintRegistry);
      // 3.3 is in the quote; 5.0 is not, and must still be caught. So reading
      // a leading number cannot be satisfied by skipping the check entirely.
      expect(violations.map((v) => v.key)).toEqual(['power.unit_value_wrong']);
      expect(violations[0]?.description).toContain('bound "5" is not present');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('accepts a qualitative value whose quote matches verbatim', async () => {
    // "external-xtal" has no leading number and the quote has no numbers.
    // There is no bound to check; the verbatim quote match is the evidence.
    // Reporting a violation made it unsatisfiable: numbers: [] is rejected,
    // and any non-empty numbers must appear in a quote that has none at all.
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-evidence-qual-'));
    try {
      await mkdir(path.join(repo, '.copperhead', 'datasheets'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'datasheets', 'spec.txt'),
        'Use an external crystal.\n',
        'utf8',
      );

      const registry: Record<string, EvidenceBackedConstraint> = {
        'clock.qualitative': {
          value: 'external-xtal',
          source: '.copperhead/datasheets/spec.txt',
          affects: ['bom'],
          evidence: { path: '.copperhead/datasheets/spec.txt', quote: 'Use an external crystal.' },
        },
      };

      const violations = await verifyConstraintEvidence(repo, registry as ConstraintRegistry);
      expect(violations).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reports a failed evidence check in syncVerify too, not only runCheck', async () => {
    // syncVerify collected only forbidden-pin violations, and those sit
    // behind a `config.schematic` guard. On a docs-only repo it therefore
    // printed "no inconsistencies" and exited 0 on a repo where check fails,
    // which AC-7.5 permits only on a genuinely consistent repo. Nothing else
    // catches it during an agent run: record_constraint never verifies, and
    // in create the first check is the final one, with no repair turn left.
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-evidence-sync-'));
    try {
      await mkdir(path.join(repo, '.copperhead', 'datasheets'), { recursive: true });
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ docs: 'docs/' }, null, 2),
        'utf8',
      );
      await writeFile(
        path.join(repo, '.copperhead', 'datasheets', 'spec.txt'),
        'Maximum sleep current is 40 uA in standby mode.\n',
        'utf8',
      );
      await writeFile(
        path.join(repo, '.copperhead', 'constraints.json'),
        JSON.stringify(
          {
            'power.iq_uA': {
              max: 25,
              source: '.copperhead/datasheets/spec.txt',
              affects: ['U1'],
              evidence: {
                path: '.copperhead/datasheets/spec.txt',
                quote: 'Maximum sleep current is 40 uA in standby mode.',
              },
            },
          },
          null,
          2,
        ),
        'utf8',
      );

      const checkRes = await runCheck(repo, () => {});
      expect(checkRes.ok).toBe(false);
      expect(checkRes.constraints.violations[0]?.description).toContain('bound "25" is not present');

      const report = await syncVerify(repo);
      expect(report.violations).toHaveLength(1);
      expect(report.violations[0]?.kind).toBe('requirement-violation');
      expect(report.violations[0]?.description).toContain('bound "25" is not present');
      // Never auto-resolvable (AC-7.3): it must not appear under `resolvable`.
      expect(report.resolvable.some((r) => r.kind === 'requirement-violation')).toBe(false);
      expect(formatSyncReport(report)).not.toContain('no inconsistencies');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('handles null registry entries, directory paths, malformed fields, and symlink escapes cleanly', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-evidence-malformed-'));
    try {
      await mkdir(path.join(repo, 'docs', 'datasheets', 'subdir'), { recursive: true });
      await writeFile(path.join(repo, '.env'), 'SECRET=123\n', 'utf8');
      await writeFile(
        path.join(repo, 'docs', 'datasheets', 'valid.txt'),
        'Supply voltage 5 V nominal.\n',
        'utf8',
      );
      let symlinkCreated = false;
      try {
        await symlink(path.join(repo, '.env'), path.join(repo, 'docs', 'datasheets', 'env-link.txt'));
        symlinkCreated = true;
      } catch {
        symlinkCreated = false;
      }

      const registry: Record<string, unknown> = {
        null_entry: null,
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
        ...(symlinkCreated
          ? {
              link_escape: {
                source: 'docs/datasheets/env-link.txt',
                affects: ['bom'],
                evidence: { path: 'docs/datasheets/env-link.txt', quote: 'SECRET=123' },
              },
            }
          : {}),
        good: {
          value: '5',
          source: 'docs/datasheets/valid.txt',
          affects: ['bom'],
          evidence: { path: 'docs/datasheets/valid.txt', quote: 'Supply voltage 5 V nominal.' },
        },
      };

      const violations = await verifyConstraintEvidence(repo, registry as ConstraintRegistry);
      if (symlinkCreated) {
        expect(violations.map((v) => v.key)).toEqual(['bad_dir', 'bad_types', 'link_escape']);
        expect(violations[2]?.description).toContain('escapes');
      } else {
        expect(violations.map((v) => v.key)).toEqual(['bad_dir', 'bad_types']);
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('preserves existing evidence on record_constraint re-record and surfaces broken evidence in runCheck', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-evidence-wiring-'));
    try {
      await mkdir(path.join(repo, '.copperhead', 'datasheets'), { recursive: true });
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ docs: 'docs/' }, null, 2),
        'utf8',
      );
      await writeFile(
        path.join(repo, '.copperhead', 'datasheets', 'reg.txt'),
        'Quiescent current 18 uA max.\n',
        'utf8',
      );
      await saveConstraints(repo, {
        'power.iq_uA': {
          max: 18,
          source: '.copperhead/datasheets/reg.txt',
          affects: ['U1'],
          evidence: {
            path: '.copperhead/datasheets/reg.txt',
            quote: 'Quiescent current 18 uA max.',
          },
        },
      });

      const ctx: RunContext = {
        repoRoot: repo,
        config: { docs: 'docs/' } as RunContext['config'],
        transcript: { event: async () => {} } as unknown as RunContext['transcript'],
        ledger: new ObligationsLedger(),
        runId: 'test',
        interactive: false,
        confirm: async () => true,
        editsUnlocked: true,
        changeId: 'c1',
        proposalValidated: true,
        filesTouched: new Set(),
        decisions: [],
        lastErc: null,
        lastDrc: null,
        lastLegibility: null,
        lastScore: null,
        repairCycles: 0,
        finishRequest: null,
      };

      const recordHandler = HANDLERS.find((h) => h.schema.name === 'record_constraint')!;
      await recordHandler.handler(ctx, {
        key: 'power.iq_uA',
        max: 25,
        source: '.copperhead/datasheets/reg.txt',
        affects: ['U1'],
      });
      const saved = await loadConstraints(repo);
      expect(saved['power.iq_uA']?.evidence?.path).toBe('.copperhead/datasheets/reg.txt');

      const checkRes = await runCheck(repo, () => {});
      expect(checkRes.ok).toBe(false);
      expect(checkRes.constraints.ok).toBe(false);
      expect(checkRes.constraints.violations[0]?.description).toContain('bound "25" is not present');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
