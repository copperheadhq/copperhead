import { describe, it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { applyBaseline, formatViolations, violationKey, type CheckReport, type Violation } from '../src/kicad/report.js';
import { runDrc } from '../src/kicad/cli.js';
import { designBaseline, runAgentLoop } from '../src/agent/loop.js';
import type { Msg, Provider, Turn } from '../src/agent/types.js';
import { loadConfig, type CopperheadConfig } from '../src/config.js';
import { runInit } from '../src/memory/scaffold.js';
import { tempFixtureRepo } from './helpers.js';

const v = (type: string, items: string[], severity = 'warning', at = 0): Violation => ({
  severity,
  type,
  description: `${type} found`,
  items: items.map((description, i) => ({ description, x: at + i, y: at })),
});
const drc = (...violations: Violation[]): CheckReport => ({ ok: violations.length === 0, source: 'drc', violations, unrouted: 0, intrinsic: [] });

describe('a design copperhead did not create is held to no new violations (AC-3.22)', () => {
  it('passes when every finding was there at the start, and lists them as pre-existing', () => {
    const base = drc(v('silk_overlap', ['Text U1']), v('lib_footprint_issues', ['Footprint J3']));
    const r = applyBaseline(drc(v('lib_footprint_issues', ['Footprint J3']), v('silk_overlap', ['Text U1'])), base);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.preexisting?.map((x) => x.type).sort()).toEqual(['lib_footprint_issues', 'silk_overlap']);
  });

  it('fails on a finding the run added, even when it fixed another', () => {
    const base = drc(v('silk_overlap', ['Text U1']), v('clearance', ['Pad 1 of R1', 'Track GND']));
    const r = applyBaseline(drc(v('silk_overlap', ['Text U1']), v('clearance', ['Pad 2 of R2', 'Track VBUS'])), base);
    expect(r.ok).toBe(false);
    expect(r.violations.map((x) => x.items[0]?.description)).toEqual(['Pad 2 of R2']);
    expect(r.preexisting).toHaveLength(1);
  });

  it('matches one to one, so a second copy of a finding is new', () => {
    const base = drc(v('drill_out_of_range', ['Via [<no net>] on F.Cu - B.Cu']));
    const r = applyBaseline(drc(v('drill_out_of_range', ['Via [<no net>] on F.Cu - B.Cu']), v('drill_out_of_range', ['Via [<no net>] on F.Cu - B.Cu'], 'warning', 40)), base);
    expect(r.ok).toBe(false);
    expect(r.violations).toHaveLength(1);
    expect(r.preexisting).toHaveLength(1);
  });

  it('counts a raised severity as new', () => {
    const r = applyBaseline(drc(v('pin_to_pin', ['U1.4', 'U2.1'], 'error')), drc(v('pin_to_pin', ['U1.4', 'U2.1'], 'warning')));
    expect(r.ok).toBe(false);
  });

  it('ignores where an unchanged finding sits', () => {
    const a = v('courtyards_overlap', ['Footprint J1', 'Footprint J4'], 'error', 0);
    const b = v('courtyards_overlap', ['Footprint J1', 'Footprint J4'], 'error', 12);
    expect(violationKey(a)).toBe(violationKey(b));
    expect(applyBaseline(drc(b), drc(a)).ok).toBe(true);
  });

  it('excuses nothing without a baseline', () => {
    const now = drc(v('silk_overlap', ['Text U1']));
    expect(applyBaseline(now, null)).toBe(now);
    expect(applyBaseline(now, undefined).ok).toBe(false);
  });

  it('tells the model which findings are out of scope', () => {
    const r = applyBaseline(drc(v('silk_overlap', ['Text U1']), v('clearance', ['Pad 1 of R9'])), drc(v('silk_overlap', ['Text U1'])));
    const text = formatViolations(r);
    expect(text).toContain('DRC: 1 new violation(s)');
    expect(text).toContain('1 finding(s) the design already had when this run started');
    expect(formatViolations(applyBaseline(drc(v('silk_overlap', ['Text U1'])), drc(v('silk_overlap', ['Text U1']))))).toMatch(/^DRC: clean\n/);
    // a run with no baseline reads as before
    expect(formatViolations(drc(v('clearance', ['Pad 1 of R9'])))).toContain('DRC: 1 violation(s)');
  });

  it('records the design as found with kicad-cli, and a later DRC is held to it', { timeout: 300_000 }, async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const board = path.join(repo, 'hardware', 'open-key.kicad_pcb');
      const via = (x: number, n: number) => `\t(via (at ${x} 105) (size 0.6) (drill 0.2) (layers "F.Cu" "B.Cu") (net 0) (uuid "11111111-2222-3333-4444-55555555555${n}"))\n`;
      const add = async (x: number, n: number) => {
        const text = await readFile(board, 'utf8');
        await writeFile(board, text.slice(0, text.lastIndexOf(')')) + via(x, n) + ')\n', 'utf8');
      };
      // the design arrives with a finding of its own
      await add(105, 1);
      const config = { schematic: 'hardware/open-key.kicad_sch', board: 'hardware/open-key.kicad_pcb' } as unknown as CopperheadConfig;
      const base = await designBaseline(repo, config);
      expect(base.drc?.violations.map((x) => x.type)).toContain('drill_out_of_range');
      expect(base.erc).not.toBeNull();
      expect(applyBaseline(await runDrc(board), base.drc).ok).toBe(true);
      // the run adds a second one: that one fails
      await add(110, 2);
      const after = applyBaseline(await runDrc(board), base.drc);
      expect(after.ok).toBe(false);
      expect(after.violations.map((x) => x.type)).toEqual(['drill_out_of_range']);
      // a design that is not there gives no baseline, so nothing is excused
      expect(await designBaseline(repo, { schematic: 'missing.kicad_sch', board: null } as unknown as CopperheadConfig)).toEqual({ erc: null, drc: null });
    } finally {
      await cleanup();
    }
  });
});

/** Plays each turn in order, repeating the last one; keeps every prompt it saw. */
function scriptedProvider(turns: Partial<Turn>[]): Provider & { seen: Msg[][] } {
  let i = 0;
  const seen: Msg[][] = [];
  return {
    name: 'scripted',
    seen,
    async chat(messages: Msg[]): Promise<Turn> {
      seen.push([...messages]);
      const t = turns[Math.min(i, turns.length - 1)]!;
      i++;
      return {
        text: t.text ?? null,
        toolCalls: (t.toolCalls ?? []).map((c, j) => ({ ...c, id: `call-${i}-${j}` })),
        usage: t.usage ?? { inputTokens: 100, outputTokens: 10 },
      };
    },
  };
}

/**
 * An initialized fixture whose committed board carries a DRC finding of its
 * own (a via drilled under the minimum), as an imported design does; `origin`
 * marks it create-produced or not.
 */
async function designWithAFinding(origin: 'create' | null): Promise<{ repo: string; board: string; cleanup: () => Promise<void> }> {
  const { repo, cleanup } = await tempFixtureRepo();
  await runInit({ repoRoot: repo, installHooks: false });
  const board = (await loadConfig(repo)).board;
  if (!board) throw new Error('fixture has no board');
  const file = path.join(repo, board);
  const text = await readFile(file, 'utf8');
  const via = '\t(via (at 105 105) (size 0.6) (drill 0.2) (layers "F.Cu" "B.Cu") (net 0) (uuid "11111111-2222-3333-4444-555555555551"))\n';
  await writeFile(file, text.slice(0, text.lastIndexOf(')')) + via + ')\n', 'utf8');
  if (origin) {
    const cfgPath = path.join(repo, '.copperhead', 'config.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8')) as Record<string, unknown>;
    await writeFile(cfgPath, JSON.stringify({ ...cfg, origin }, null, 2) + '\n', 'utf8');
  }
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'design as imported'], { cwd: repo });
  return { repo, board, cleanup };
}

// the board counts as the run's own edit (AC-15.43), so finishing needs a passing DRC
const verifyThenFinish: Partial<Turn>[] = [
  { toolCalls: [{ name: 'run_erc', args: {} }, { name: 'run_drc', args: {} }, { name: 'check_drift', args: {} }] },
  { toolCalls: [{ name: 'finish', args: { outcome: 'done', summary: 'nothing added' } }] },
];

describe('the run records the design as found and holds its checks to it (AC-3.22)', () => {
  it('a run on an imported design with findings of its own finishes and says what it left', { timeout: 300_000 }, async () => {
    const { repo, board, cleanup } = await designWithAFinding(null);
    try {
      const provider = scriptedProvider(verifyThenFinish);
      const res = await runAgentLoop({ repoRoot: repo, request: 'touch nothing', model: 'gpt-5', provider, maxTurns: 4, preTouched: [board], log: () => {} });
      const seen = provider.seen.flat().map((m) => JSON.stringify(m)).join('\n');
      expect(seen).toContain('the design already had when this run started');
      expect(res.outcome).toBe('success');
      const events = (await readFile(path.join(res.transcriptDir, 'transcript.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; data: { drc?: number | null } });
      expect(events.find((e) => e.type === 'check-baseline')?.data.drc).toBeGreaterThan(0);
      expect(await readFile(path.join(res.transcriptDir, 'summary.md'), 'utf8')).toMatch(/- DRC: clean \(\d+ pre-existing left as found\)/);
    } finally {
      await cleanup();
    }
  });

  it('a create-produced design keeps the zero gate', { timeout: 300_000 }, async () => {
    const { repo, board, cleanup } = await designWithAFinding('create');
    try {
      const provider = scriptedProvider(verifyThenFinish);
      const res = await runAgentLoop({ repoRoot: repo, request: 'touch nothing', model: 'gpt-5', provider, maxTurns: 4, preTouched: [board], log: () => {} });
      expect(res.outcome).not.toBe('success');
      const seen = provider.seen.flat().map((m) => JSON.stringify(m)).join('\n');
      expect(seen).toContain('drill_out_of_range');
      expect(seen).not.toContain('the design already had when this run started');
      const events = await readFile(path.join(res.transcriptDir, 'transcript.jsonl'), 'utf8');
      expect(events).not.toContain('"check-baseline"');
    } finally {
      await cleanup();
    }
  });
});
