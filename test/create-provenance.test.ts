import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execa } from 'execa';
import { fileURLToPath } from 'node:url';
import { tempFixtureRepo } from './helpers.js';
import { writeBriefHash } from '../src/commands/create.js';
import { runCheck } from '../src/commands/check.js';
import { checkBriefProvenance, reconcileBriefHash } from '../src/memory/drift.js';
import { syncVerify } from '../src/commands/sync.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('writeBriefHash & brief provenance (#413)', () => {
  it('writes BRIEF.sha256 and never overwrites an existing BRIEF.sha256', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });

      await writeBriefHash(repo, 'docs', {
        path: 'brief.md',
        sha256: '111111',
      });

      await writeBriefHash(repo, 'docs', {
        path: 'other.md',
        sha256: '222222',
      });

      const text = await readFile(path.join(repo, 'docs', 'BRIEF.sha256'), 'utf8');
      expect(text).toContain('brief.md');
      expect(text).toContain('111111');
      expect(text).not.toContain('222222');
      expect(text).not.toContain('other.md');
    } finally {
      await cleanup();
    }
  });

  it('snapshots an external brief into docs/BRIEF.md, records the in-repo path, and recovers legacy external: records (M1)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      const content = '# External Brief\n- USB-C PD sink\n';
      const digest = createHash('sha256').update(content).digest('hex');
      await writeBriefHash(
        repo,
        'docs',
        { path: 'external:outside.md', sha256: digest },
        content,
      );

      expect(existsSync(path.join(repo, 'docs', 'BRIEF.md'))).toBe(true);
      const shaText = await readFile(path.join(repo, 'docs', 'BRIEF.sha256'), 'utf8');
      expect(shaText).toContain('brief: docs/BRIEF.md');
      const status = await checkBriefProvenance(repo, 'docs');
      expect(status?.ok).toBe(true);
      expect(status?.recorded).toBe(digest);

      // P2: non-external record `brief: brief.md` deleted while an unrelated `docs/BRIEF.md` exists -> MUST report `missing`
      await writeFile(path.join(repo, 'docs', 'BRIEF.sha256'), `brief: brief.md\nsha256: ${digest}\n`, 'utf8');
      await rm(path.join(repo, 'brief.md'), { force: true });
      const p2 = await checkBriefProvenance(repo, 'docs');
      expect(p2?.ok).toBe(false);
      expect(p2?.current).toBe('missing');

      // P3: legacy pre-PR repo with `brief: external:usb.md` and no `docs/BRIEF.md` -> missing with recovery hint, then adopts `docs/BRIEF.md`
      await rm(path.join(repo, 'docs', 'BRIEF.md'), { force: true });
      await writeFile(path.join(repo, 'docs', 'BRIEF.sha256'), `brief: external:usb.md\nsha256: ${digest}\n`, 'utf8');
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ docs: 'docs/' }, null, 2),
        'utf8',
      );
      const logs: string[] = [];
      const checkMissingLegacy = await runCheck(repo, (s) => logs.push(s));
      expect(checkMissingLegacy.ok).toBe(false);
      expect(checkMissingLegacy.brief?.current).toBe('missing');
      expect(logs.join('\n')).toContain('external:usb.md has no in-repo copy; copy it to docs/BRIEF.md and run copperhead sync --brief');

      // Copy brief into docs/BRIEF.md and run reconcileBriefHash -> adopts `brief: docs/BRIEF.md`
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), content, 'utf8');
      const adopted = await reconcileBriefHash(repo, 'docs');
      expect(adopted.ok).toBe(true);
      expect(adopted.path).toBe('docs/BRIEF.md');
      expect(await readFile(path.join(repo, 'docs', 'BRIEF.sha256'), 'utf8')).toContain('brief: docs/BRIEF.md');
    } finally {
      await cleanup();
    }
  });

  it('tolerates LF <-> CRLF checkout conversion without false divergence, while failing on real edits (M2)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      const lfBrief = '# Design Brief\n- 3.3V LDO regulator\n- ESD diode on VBUS\n';
      const lfHash = createHash('sha256').update(lfBrief, 'utf8').digest('hex');
      const crlfBrief = lfBrief.replace(/\n/g, '\r\n');
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), crlfBrief, 'utf8');
      await writeBriefHash(repo, 'docs', { path: 'docs/BRIEF.md', sha256: lfHash });

      const crlfStatus = await checkBriefProvenance(repo, 'docs');
      expect(crlfStatus?.ok).toBe(true);

      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), crlfBrief + '- Extra rail\r\n', 'utf8');
      const editedStatus = await checkBriefProvenance(repo, 'docs');
      expect(editedStatus?.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('reports changed/missing/invalid/outside-repo briefs in syncVerify.violations (never resolvable) and fails runCheck (H1, M3, L5)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ docs: 'docs/' }, null, 2),
        'utf8',
      );
      await writeFile(path.join(repo, 'docs', 'DECISIONS.md'), '# Decision log\n', 'utf8');
      await writeFile(path.join(repo, 'docs', 'CHANGELOG.md'), '# Design changelog\n', 'utf8');

      const initialBrief = '# Design Brief\n- 3.3V LDO regulator\n';
      const initialHash = createHash('sha256').update(initialBrief).digest('hex');
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), initialBrief, 'utf8');
      await writeBriefHash(repo, 'docs', {
        path: 'docs/BRIEF.md',
        sha256: initialHash.toUpperCase(),
      });

      const updatedBrief = initialBrief + '- 100 nF ceramic decoupling cap near U1\n';
      const updatedHash = createHash('sha256').update(updatedBrief).digest('hex');
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), updatedBrief, 'utf8');

      // H1: syncVerify reports changed brief in `violations`, NOT `resolvable`
      const syncReport = await syncVerify(repo);
      expect(syncReport.resolvable.some((item) => item.doc === 'docs/BRIEF.md')).toBe(false);
      expect(
        syncReport.violations.some(
          (v) => v.governedBy === 'docs/BRIEF.md' && v.description.includes('acknowledge with copperhead sync --brief'),
        ),
      ).toBe(true);

      // M3 + L5: runCheck fails (`ok: false`) and logs `brief ✗ ... changed`
      const checkLogs: string[] = [];
      const checkStale = await runCheck(repo, (s) => checkLogs.push(s));
      expect(checkStale.ok).toBe(false);
      expect(checkStale.brief?.ok).toBe(false);
      expect(checkLogs.join('\n')).toContain('brief ✗ docs/BRIEF.md changed');

      // Invalid & outside-repo cases in runCheck + syncVerify
      await writeFile(path.join(repo, 'docs', 'BRIEF.sha256'), 'brief: docs/BRIEF.md\nmalformed\n', 'utf8');
      const invalidLogs: string[] = [];
      const checkInvalid = await runCheck(repo, (s) => invalidLogs.push(s));
      expect(checkInvalid.ok).toBe(false);
      expect(checkInvalid.brief?.current).toBe('invalid');
      expect(invalidLogs.join('\n')).toContain('malformed (missing sha256 line)');

      await writeFile(
        path.join(repo, 'docs', 'BRIEF.sha256'),
        'brief: ../../../etc/passwd\nsha256: aabbccddeeff\n',
        'utf8',
      );
      const escLogs: string[] = [];
      const checkEscape = await runCheck(repo, (s) => escLogs.push(s));
      expect(checkEscape.ok).toBe(false);
      expect(checkEscape.brief?.current).toBe('outside-repo');
      expect(escLogs.join('\n')).toContain('outside the repository');

      // Restore valid record for acknowledgement check (L1)
      await writeFile(path.join(repo, 'docs', 'BRIEF.sha256'), `brief: docs/BRIEF.md\nsha256: ${initialHash}\n`, 'utf8');
      const reconciled = await reconcileBriefHash(repo, 'docs');
      expect(reconciled.ok).toBe(true);
      expect(reconciled.recorded).toBe(updatedHash);
      expect(reconciled.origin).toBe(initialHash);

      const decisions = await readFile(path.join(repo, 'docs', 'DECISIONS.md'), 'utf8');
      expect(decisions).toContain(updatedHash.slice(0, 8));
      expect(decisions).toContain('the design was not re-verified against it');
      expect(decisions.toLowerCase()).not.toContain('design state verified');
    } finally {
      await cleanup();
    }
  });

  it('exercises CLI sync --brief (--dry-run, acknowledgement rewrite, and refusal on other violations)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();

    try {
      await mkdir(path.join(repo, 'docs'), { recursive: true });
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ docs: 'docs/' }, null, 2),
        'utf8',
      );
      await writeFile(path.join(repo, 'docs', 'DECISIONS.md'), '# Decision log\n', 'utf8');
      await writeFile(path.join(repo, 'docs', 'CHANGELOG.md'), '# Design changelog\n', 'utf8');

      const b1 = '# Brief v1\n';
      const h1 = createHash('sha256').update(b1).digest('hex');
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), b1, 'utf8');
      await writeBriefHash(repo, 'docs', { path: 'docs/BRIEF.md', sha256: h1 });

      const b2 = '# Brief v2\n';
      const h2 = createHash('sha256').update(b2).digest('hex');
      await writeFile(path.join(repo, 'docs', 'BRIEF.md'), b2, 'utf8');
      const beforeShaFile = await readFile(path.join(repo, 'docs', 'BRIEF.sha256'), 'utf8');

      // 1. Plain `sync --dry-run` exits 2 because brief divergence is a requirement violation (H1)
      const plainDry = await execa(
        'npx',
        ['tsx', 'src/cli.ts', '--repo', repo, 'sync', '--dry-run'],
        { cwd: ROOT, reject: false, env: { NO_COLOR: '1' } },
      );
      expect(plainDry.exitCode).toBe(2);

      // 2. `sync --brief --dry-run` previews without writing
      const dryRes = await execa(
        'npx',
        ['tsx', 'src/cli.ts', '--repo', repo, '--json', 'sync', '--brief', '--dry-run'],
        { cwd: ROOT, reject: false, env: { NO_COLOR: '1' } },
      );
      expect(dryRes.exitCode).toBe(0);
      const parsed = JSON.parse(dryRes.stdout) as { brief?: { ok: boolean; recorded: string; current: string } };
      expect(parsed.brief?.ok).toBe(false);
      expect(parsed.brief?.recorded).toBe(h1);
      expect(await readFile(path.join(repo, 'docs', 'BRIEF.sha256'), 'utf8')).toBe(beforeShaFile);

      // 3. `sync --brief` acknowledges without claiming verification
      const ackRes = await execa(
        'npx',
        ['tsx', 'src/cli.ts', '--repo', repo, 'sync', '--brief'],
        { cwd: ROOT, reject: false, env: { NO_COLOR: '1' } },
      );
      expect(ackRes.exitCode).toBe(0);
      expect(ackRes.stdout).toContain(`brief acknowledged: docs/BRIEF.md (${h1.slice(0, 8)} -> ${h2.slice(0, 8)}); the design was not re-verified against it`);
      const afterShaFile = await readFile(path.join(repo, 'docs', 'BRIEF.sha256'), 'utf8');
      expect(afterShaFile).toContain(`sha256: ${h2}`);
      expect(afterShaFile).toContain(`origin_sha256: ${h1}`);
      const decisions = await readFile(path.join(repo, 'docs', 'DECISIONS.md'), 'utf8');
      expect(decisions).not.toMatch(/(?<!re-)verified/i);
      expect(decisions).toContain('the design was not re-verified against it');

      // 4. `sync --brief` refuses with exit 2 when BRIEF.sha256 points outside repo
      await writeFile(
        path.join(repo, 'docs', 'BRIEF.sha256'),
        'brief: ../../../etc/passwd\nsha256: deadbeef\n',
        'utf8',
      );
      const refuseRes = await execa(
        'npx',
        ['tsx', 'src/cli.ts', '--repo', repo, 'sync', '--brief'],
        { cwd: ROOT, reject: false, env: { NO_COLOR: '1' } },
      );
      expect(refuseRes.exitCode).toBe(2);
    } finally {
      await cleanup();
    }
  }, 60_000);
});
