/**
 * A schematic attempt that refuses while draft_schematic still lists findings is
 * answered in code, within the attempt limit, instead of by the diagnosis model:
 * the findings are the stage's own work and each names its fix.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { refusalOverFindings } from '../src/commands/create.js';
import { lastToolResult } from '../src/agent/recovery.js';

const FINDINGS = 'intent validation: 8 finding(s) to reconcile:';

describe('refusalOverFindings', () => {
  it('answers a schematic refusal over draft findings with what they ask and what the Footprint column holds', () => {
    const g = refusalOverFindings('schematic', 'refused', FINDINGS);
    expect(g).toContain('still listed 8 finding(s) to reconcile.');
    expect(g).toContain('change it in BOM.md and the intent together, to the footprint it names');
    expect(g).toContain('never a symbol lib_id such as Connector:TestPoint');
  });

  it('leaves every other case to the diagnosis', () => {
    expect(refusalOverFindings('layout-draft', 'refused', FINDINGS)).toBeNull();
    expect(refusalOverFindings('schematic', 'failure', FINDINGS)).toBeNull();
    expect(refusalOverFindings('schematic', 'refused', null)).toBeNull();
    // the last draft was clean: a refusal then is over something else
    expect(refusalOverFindings('schematic', 'refused', 'drafted hardware/board.kicad_sch: 12 symbols, 0 ERC errors')).toBeNull();
  });
});

describe('lastToolResult', () => {
  it("returns the first line of the tool's last result, or null when it never ran", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-lasttool-'));
    try {
      const lines = [
        { type: 'tool', data: { name: 'draft_schematic', result: 'intent validation: 10 finding(s) to reconcile:\n  1. U1: …' } },
        { type: 'assistant', data: { text: 'mentions "draft_schematic" in prose' } },
        { type: 'tool', data: { name: 'check_footprints', result: 'OK  TestPoint:TestPoint_Pad_D1.0mm' } },
        { type: 'tool', data: { name: 'draft_schematic', result: `${FINDINGS}\n  1. U1: …` } },
      ];
      await writeFile(path.join(dir, 'transcript.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n', 'utf8');
      expect(await lastToolResult(dir, 'draft_schematic')).toBe(FINDINGS);
      expect(await lastToolResult(dir, 'run_erc')).toBeNull();
      expect(await lastToolResult(path.join(dir, 'missing'), 'draft_schematic')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
