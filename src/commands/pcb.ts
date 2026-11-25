import { execFile } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { importKicadBoard } from '../pcb-ir/import-kicad.js';
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

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

/**
 * A board side: a .kicad_pcb file, or one at a revision under version control
 * written `<revision>:<path>`, imported into a layout input (RFC 11 Section 5.1).
 */
async function boardSide(spec: string, projectId: string | undefined): Promise<Side> {
  let text: string;
  let file = spec;
  if (await exists(spec)) {
    text = await readFile(spec, 'utf8');
  } else {
    const m = /^([^:]+):(.+)$/.exec(spec);
    if (!m) throw new PcbCommandError(`${spec}: no such board file`);
    file = m[2]!;
    try {
      const { stdout } = await promisify(execFile)('git', ['show', `${m[1]}:${file}`], { maxBuffer: 256 * 1024 * 1024 });
      text = stdout;
    } catch (err) {
      throw new PcbCommandError(`${spec}: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  const project = projectId ?? path.basename(file, '.kicad_pcb');
  try {
    return { kind: 'input', input: importKicadBoard(text, { projectId: project, path: spec }) };
  } catch (err) {
    throw new PcbCommandError((err as Error).message);
  }
}

async function readJson(file: string): Promise<unknown> {
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

async function side(spec: string, projectId: string | undefined): Promise<Side> {
  return spec.endsWith('.kicad_pcb') ? boardSide(spec, projectId) : classify(spec, await readJson(spec));
}

/**
 * What <after> changes relative to <before>. The before side is a layout input
 * or a board; the after side is a candidate, a later layout input, or a board.
 * A board is a .kicad_pcb file or `<revision>:<path>`, imported with
 * identifiers derived under one project, the board file's name unless
 * `project` says otherwise, so the same part matches across revisions.
 */
export async function pcbDiff(
  beforeFile: string,
  afterFile: string,
  opts: { blocks?: string; project?: string } = {},
): Promise<PcbDiffResult> {
  const before = await side(beforeFile, opts.project);
  if (before.kind !== 'input') throw new PcbCommandError(`${beforeFile}: the before side is a layout input or a board`);
  const after = await side(afterFile, opts.project);
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
