import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  boardTextOfFile,
  placementDiff,
  renderDiffText,
  type BlockLayout,
  type Candidate,
  type LayoutInput,
  type PlacementDiff,
} from '../pcb-ir/index.js';

/**
 * `copperhead pcb diff` and `copperhead pcb textconv`: the views of RFC 11
 * Section 14.4. Both read files only: no model, network, or CAD-tool call, and
 * they write nothing.
 */

export class PcbCommandError extends Error {}

type Side = { kind: 'input'; input: LayoutInput } | { kind: 'candidate'; candidate: Candidate };

async function readJson(file: string): Promise<unknown> {
  if (file.endsWith('.kicad_pcb')) {
    throw new PcbCommandError(
      `${file}: importing a KiCad board into a layout input (RFC 11 Section 5.1) is not part of pcb diff yet; ` +
        'pass a layout input or candidate JSON, or compare boards with pcb textconv',
    );
  }
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new PcbCommandError(`${file}: ${(err as Error).message}`);
  }
}

function classify(file: string, record: unknown): Side {
  const r = record as Record<string, unknown>;
  if (r && typeof r === 'object' && 'components' in r && 'footprints' in r) return { kind: 'input', input: r as unknown as LayoutInput };
  if (r && typeof r === 'object' && 'blocks' in r && 'loose' in r && 'input' in r) {
    return { kind: 'candidate', candidate: r as unknown as Candidate };
  }
  throw new PcbCommandError(`${file}: neither a layout input nor a candidate (RFC 11 Sections 6.9 and 6.10)`);
}

async function blockLayoutsIn(dir: string): Promise<BlockLayout[]> {
  const out: BlockLayout[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue;
    try {
      const r = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
      if (r && typeof r === 'object' && 'circuit' in r && 'members' in r && 'envelope' in r) out.push(r as BlockLayout);
    } catch {
      // not JSON, or not a record: not a block layout
    }
  }
  return out;
}

export interface PcbDiffResult {
  diff: PlacementDiff;
  text: string;
}

/** What <after>, a candidate or a later layout input, changes relative to <before>, a layout input. */
export async function pcbDiff(beforeFile: string, afterFile: string, opts: { blocks?: string } = {}): Promise<PcbDiffResult> {
  const before = classify(beforeFile, await readJson(beforeFile));
  if (before.kind !== 'input') throw new PcbCommandError(`${beforeFile}: the before side is a layout input`);
  const after = classify(afterFile, await readJson(afterFile));
  const diff =
    after.kind === 'candidate'
      ? placementDiff(before.input, {
          candidate: after.candidate,
          blockLayouts: await blockLayoutsIn(opts.blocks ?? path.dirname(afterFile)),
        })
      : placementDiff(before.input, { input: after.input });
  const text = renderDiffText(diff, { before: before.input, ...(after.kind === 'input' && { after: after.input }) });
  return { diff, text };
}

/** A .kicad_pcb as one fact per line, for git's textconv. */
export async function pcbTextconv(board: string): Promise<string> {
  return boardTextOfFile(board);
}
