/**
 * The run's render: every `place`, `route`, and `layout` run ends with a
 * `board.svg` at the top of its run directory, whatever its outcome. A run
 * that selected a candidate draws that candidate with its findings; a run
 * that refused, timed out, or had no engine draws the board it was given with
 * the diagnostics that explain the outcome, so a failure is as visible as a
 * pass. A render failure is logged and never fails the run.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { renderSvg } from '../ir/svg.js';
import type { PcbDesign } from '../ir/types.js';
import type { Diagnostic } from '../verify/diagnostic.js';

export const RENDER_FILE = 'board.svg';

export async function writeBoardRender(dir: string, design: PcbDesign, diagnostics: Diagnostic[], log: (line: string) => void = () => {}): Promise<string | null> {
  const file = path.join(dir, RENDER_FILE);
  try {
    await writeFile(file, renderSvg(design, { diagnostics, legend: false, scale: 12 }), 'utf8');
    return file;
  } catch (err) {
    log(`render failed: ${(err as Error).message}`);
    return null;
  }
}
