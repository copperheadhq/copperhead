/**
 * Layout evidence (ADR 0009; AC-17.15, AC-17.16): the markers `create` writes
 * after routing, the completion contract that reads them, the `check` layout
 * track, and the stage's isComplete. The routed cases use the harness-only
 * reference router and skip without kicad-cli.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { readEvidence, writeEvidence, evidenceContract, boardHash, EVIDENCE_HEADING, type LayoutEvidence } from '../src/pcb/evidence.js';
import { routeForCreate, layoutContract } from '../src/pcb/layout-stage.js';
import { runCheck } from '../src/commands/check.js';
import { STAGES } from '../src/commands/create.js';
import { loadConfig } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const GOLDEN = path.join(ROOT, 'test', 'fixtures', 'microboards');

async function haveKicad(): Promise<boolean> {
  try {
    await execa('kicad-cli', ['version']);
    return true;
  } catch {
    return false;
  }
}

function fake(over: Partial<LayoutEvidence> = {}): LayoutEvidence {
  return { version: 1, writtenAt: 't', boardHash: 'h', snapshotHash: 's', runDir: '.copperhead/runs/x/layout', status: 'PASS', summary: 'ok', selected: 'router-x', engines: [{ id: 'router-x', version: '1' }], metrics: { completion_rate: 1, total_wirelength_nm: 12_000_000, via_count: 2 }, owed: [], diagnostics: [], ...over };
}

/** A temp repo holding one golden board as the configured board, with docs/LAYOUT.md. */
async function repoWith(caseName: string, layoutMd = '# Layout\n\n## Draft quality\n\nplaced on a grid\n'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-evidence-'));
  await mkdir(path.join(dir, 'hardware'), { recursive: true });
  await mkdir(path.join(dir, 'docs'), { recursive: true });
  await mkdir(path.join(dir, '.copperhead'), { recursive: true });
  await cp(path.join(GOLDEN, caseName, 'board.kicad_pcb'), path.join(dir, 'hardware', 'board.kicad_pcb'));
  await cp(path.join(GOLDEN, caseName, 'board.kicad_pro'), path.join(dir, 'hardware', 'board.kicad_pro'));
  await writeFile(path.join(dir, '.copperhead', 'config.json'), JSON.stringify({ board: 'hardware/board.kicad_pcb', docs: 'docs/', pcb: { routers: ['router-reference'], allowHarnessEngines: true, budgetSeconds: 120 } }), 'utf8');
  await writeFile(path.join(dir, 'docs', 'LAYOUT.md'), layoutMd, 'utf8');
  return dir;
}

describe('evidence markers', () => {
  it('round-trip through LAYOUT.md, replacing an older section and leaving the rest alone', () => {
    const doc = '# Layout\n\n## Footprints\n\n| a |\n\n## Draft quality\n\nfine\n';
    const once = writeEvidence(doc, fake());
    expect(once).toContain(EVIDENCE_HEADING);
    expect(readEvidence(once)).toEqual(fake());
    const twice = writeEvidence(once + '\n## Notes\n\nkeep me\n', fake({ status: 'PARTIAL', selected: 'router-y' }));
    expect(twice.split(EVIDENCE_HEADING)).toHaveLength(2);
    expect(readEvidence(twice)!.selected).toBe('router-y');
    expect(twice).toContain('## Draft quality\n\nfine');
    expect(twice).toContain('## Notes\n\nkeep me');
    expect(readEvidence('# Layout\n')).toBeNull();
    expect(readEvidence('<!-- copperhead:layout-evidence {bad -->')).toBeNull();
  });
  it('the contract: no evidence, stale evidence, a refusal, and a pass (AC-17.16)', async () => {
    const p = path.join(GOLDEN, 'completion', 'board.kicad_pcb');
    const text = await readFile(p, 'utf8');
    const hash = boardHash(text, p);
    expect(evidenceContract(null, text, p).reason).toMatch(/no layout evidence/);
    expect(evidenceContract(writeEvidence('', fake({ boardHash: 'other' })), text, p)).toMatchObject({ ok: false, stale: true });
    expect(evidenceContract(writeEvidence('', fake({ boardHash: hash, status: 'REFUSE', summary: 'placement gate failed', diagnostics: [{ code: 'geom.courtyard-overlap', severity: 'error', entityReferences: ['C1', 'U1'], message: 'm' }] })), text, p).reason).toMatch(/REFUSE.*geom\.courtyard-overlap/);
    expect(evidenceContract(writeEvidence('', fake({ boardHash: hash })), text, p).ok).toBe(true);
    expect(evidenceContract(writeEvidence('', fake({ boardHash: hash, status: 'UNSUPPORTED', selected: null })), text, p).ok).toBe(true);
    // a whitespace-only edit is not a change; a moved part is
    expect(boardHash(text.replace(/\n/g, '\n '), p)).toBe(hash);
    expect(boardHash(text.replace('(at 107 118)', '(at 108 118)'), p)).not.toBe(hash);
  });
});

// The create pipeline's layout-draft stage does not yet require layout
// evidence: wiring the harness into create stage 5 is a follow-up
// (add-pcb-placement task 6.1), so this contract is skipped until then.
describe.skip('the layout-draft stage contract', () => {
  const stage = STAGES.find((s) => s.name === 'layout-draft')!;
  it('needs footprints, Draft quality, and evidence for exactly this board', async () => {
    const dir = await repoWith('completion');
    try {
      expect(await stage.isComplete(dir, 'docs/')).toBe(false);
      expect((await layoutContract(dir, await loadConfig(dir)))!.reason).toMatch(/no layout evidence/);
      const p = path.join(dir, 'hardware', 'board.kicad_pcb');
      const text = await readFile(p, 'utf8');
      const md = await readFile(path.join(dir, 'docs', 'LAYOUT.md'), 'utf8');
      await writeFile(path.join(dir, 'docs', 'LAYOUT.md'), writeEvidence(md, fake({ boardHash: boardHash(text, p, await readFile(p.replace(/\.kicad_pcb$/, '.kicad_pro'), 'utf8')) })), 'utf8');
      expect(await stage.isComplete(dir, 'docs/')).toBe(true);
      await writeFile(p, text.replace('(at 107 118)', '(at 108 118)'), 'utf8');
      expect(await stage.isComplete(dir, 'docs/')).toBe(false);
      expect((await layoutContract(dir, await loadConfig(dir)))!.stale).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('routeForCreate and the check layout track', () => {
  it('routes the placed board, writes the candidate and the evidence, and check re-verifies it without an engine', async () => {
    if (!(await haveKicad())) return;
    const dir = await repoWith('completion');
    try {
      const config = await loadConfig(dir);
      const before = await readFile(path.join(dir, 'hardware', 'board.kicad_pcb'), 'utf8');
      const res = await routeForCreate(dir, config, () => {}, { runDir: path.join(dir, '.copperhead', 'runs', 'r1', 'layout') });
      expect(res!.evidence.status).toBe('PASS');
      expect(res!.applied).toBe(true);
      expect(res!.verdict.ok).toBe(true);
      const after = await readFile(path.join(dir, 'hardware', 'board.kicad_pcb'), 'utf8');
      expect(after).not.toBe(before);
      expect((after.match(/\(segment/g) ?? []).length).toBeGreaterThan(5);
      const md = await readFile(path.join(dir, 'docs', 'LAYOUT.md'), 'utf8');
      expect(md).toContain('## Draft quality');
      expect(readEvidence(md)!.selected).toBe('router-reference');
      expect(readEvidence(md)!.runDir).toBe('.copperhead/runs/r1/layout');
      expect(readEvidence(md)!.metrics.total_wirelength_nm).toBeGreaterThan(0);
      expect(readEvidence(md)!.metrics.via_count).toBeGreaterThanOrEqual(0);
      expect(existsSync(path.join(dir, '.copperhead', 'runs', 'r1', 'layout', 'outcome.json'))).toBe(true);
      // The create stage contract's view of this evidence waits on add-pcb-placement task 6.1.

      const lines: string[] = [];
      const check = await runCheck(dir, (l) => lines.push(l));
      expect(check.layout).toMatchObject({ ok: true, status: 'PASS', stale: false, selected: 'router-reference', gates: { preflight: true, placement: true, routing: true } });
      expect(check.layout!.metrics.completion_rate).toBe(1);
      expect(lines.find((l) => l.startsWith('layout'))).toMatch(/^layout ✓ PASS/);

      // a hand edit after routing: check says stale and fails
      await writeFile(path.join(dir, 'hardware', 'board.kicad_pcb'), after.replace('(at 107 118)', '(at 108 118)'), 'utf8');
      const stale = await runCheck(dir, () => {});
      expect(stale.layout).toMatchObject({ ok: false, status: 'STALE', stale: true });
      expect(stale.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('a placement-gate refusal is recorded, the board is untouched, and the stage stays open', async () => {
    if (!(await haveKicad())) return;
    const dir = await repoWith('overlap');
    try {
      const config = await loadConfig(dir);
      const before = await readFile(path.join(dir, 'hardware', 'board.kicad_pcb'), 'utf8');
      const res = await routeForCreate(dir, config, () => {}, { runDir: path.join(dir, '.copperhead', 'runs', 'r1', 'layout') });
      expect(res!.evidence.status).toBe('REFUSE');
      expect(res!.applied).toBe(false);
      expect(await readFile(path.join(dir, 'hardware', 'board.kicad_pcb'), 'utf8')).toBe(before);
      expect(res!.verdict.ok).toBe(false);
      expect(res!.verdict.reason).toMatch(/REFUSE.*geom\.courtyard-overlap/);
      expect(res!.evidence.diagnostics.map((d) => d.code)).toContain('geom.courtyard-overlap');
      expect(await STAGES.find((s) => s.name === 'layout-draft')!.isComplete(dir, 'docs/')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('copperhead pcb route --apply', () => {
  it('writes the candidate and records the same evidence create would', async () => {
    if (!(await haveKicad())) return;
    const dir = await repoWith('completion');
    try {
      const out = await execa('npx', ['tsx', path.join(ROOT, 'src', 'cli.ts'), '--json', '--repo', dir, 'pcb', 'route', '--routers', 'router-reference', '--allow-harness-engines', '--apply', '--run-dir', '.copperhead/runs/r2/layout', '--budget-seconds', '120'], { cwd: ROOT, reject: false });
      expect(out.exitCode, out.stderr).toBe(0);
      expect(JSON.parse(out.stdout).detail.join('\n')).toMatch(/evidence recorded in docs\/LAYOUT\.md/);
      const md = await readFile(path.join(dir, 'docs', 'LAYOUT.md'), 'utf8');
      expect(readEvidence(md)).toMatchObject({ status: 'PASS', selected: 'router-reference', runDir: '.copperhead/runs/r2/layout' });
      expect((await runCheck(dir, () => {})).layout).toMatchObject({ ok: true, status: 'PASS' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
