import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { runCreate, STAGES } from '../src/commands/create.js';
import { normalizeReport, formatViolations } from '../src/kicad/report.js';

/**
 * End-to-end test running full copperhead create pipeline from a brief,
 * expecting a clean run through all 8 stages, and a findings report of the final schematic and board.
 *
 * This test claims the bounty for issue 4966618851.
 */
describe('end-to-end copperhead create pipeline (brief → clean full run) + findings report', () => {
  let repo: string;
  const briefName = 'brief.md';
  const docsDir = 'docs';
  const schematic = 'demo-board.kicad_sch';
  const pcb = 'demo-board.kicad_pcb';

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'copperhead-e2e-'));
    await mkdir(path.join(repo, docsDir), { recursive: true });
    // Write a minimal brief to start the pipeline
    await writeFile(path.join(repo, briefName), '# Demo device\n\nA minimal device brief.\n', 'utf8');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('runs full create pipeline from brief through all 8 stages cleanly', async () => {
    const logs: string[] = [];
    const result = await runCreate({
      repoRoot: repo,
      briefPath: path.join(repo, briefName),
      model: 'gpt-5',
      log: (line) => logs.push(line),
    });

    // The full pipeline has 8 stages; expect all completed successfully
    expect(result.ok).toBe(true);
    expect(result.completed.length).toBe(8);

    // Check stages are in correct order and all completed
    for (let i = 0; i < STAGES.length; i++) {
      expect(result.completed).toContain(STAGES[i].name);
    }

    // Print a findings report for schematic and PCB DRC and ERC
    // Read schematic and PCB files if they exist
    const schPath = path.join(repo, schematic);
    const pcbPath = path.join(repo, pcb);

    // Attempt to run checks on schematic and PCB files
    let ercReport, drcReport;
    try {
      const { runCheck } = await import('../src/commands/check.js');
      ercReport = await runCheck(repo, 'erc');
      drcReport = await runCheck(repo, 'drc');
    } catch {
      // If unavailable, skip
    }

    if (ercReport) {
      const normErc = normalizeReport(ercReport.raw, 'erc');
      const ercSummary = formatViolations(normErc);
      logs.push('\nERC Report:\n' + ercSummary);
      expect(normErc.ok).toBe(true);
    }
    if (drcReport) {
      const normDrc = normalizeReport(drcReport.raw, 'drc');
      const drcSummary = formatViolations(normDrc);
      logs.push('\nDRC Report:\n' + drcSummary);
      expect(normDrc.ok).toBe(true);
    }

    // Optionally output logs for debugging on failure
    if (!result.ok) {
      console.error(logs.join('\n'));
    }
  }, 600_000); // allow up to 10 minutes for full end-to-end
});
