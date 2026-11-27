/** A candidate is written only over the board its run started from. */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyIfUnchanged } from '../src/pcb/engines/apply.js';

describe('applyIfUnchanged', () => {
  const setup = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pcb-apply-'));
    const board = path.join(dir, 'board.kicad_pcb');
    const candidate = path.join(dir, 'candidate.kicad_pcb');
    writeFileSync(board, '(kicad_pcb start)');
    writeFileSync(candidate, '(kicad_pcb placed)');
    return { board, candidate };
  };

  it('writes the candidate over the board the run started from', async () => {
    const { board, candidate } = setup();
    expect(await applyIfUnchanged(candidate, board, '(kicad_pcb start)', 'board.kicad_pcb')).toEqual({ applied: true });
    expect(readFileSync(board, 'utf8')).toBe('(kicad_pcb placed)');
  });

  it('keeps a save made while the run was going', async () => {
    const { board, candidate } = setup();
    writeFileSync(board, '(kicad_pcb saved in KiCad)');
    const res = await applyIfUnchanged(candidate, board, '(kicad_pcb start)', 'board.kicad_pcb');
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('board.kicad_pcb changed while the run was going; run again to work on the board as it is now');
    expect(readFileSync(board, 'utf8')).toBe('(kicad_pcb saved in KiCad)');
  });
});
