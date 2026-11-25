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

interface Board {
  spec: string;
  file: string;
  text: string;
}

/**
 * A board: a .kicad_pcb file, or one at a revision under version control
 * written `<revision>:<path>`.
 */
async function readBoard(spec: string): Promise<Board> {
  if (await exists(spec)) return { spec, file: spec, text: await readFile(spec, 'utf8') };
  const m = /^([^:]+):(.+)$/.exec(spec);
  if (!m) throw new PcbCommandError(`${spec}: no such board file`);
  try {
    const { stdout } = await promisify(execFile)('git', ['show', `${m[1]}:${m[2]}`], { maxBuffer: 256 * 1024 * 1024 });
    return { spec, file: m[2]!, text: stdout };
  } catch (err) {
    throw new PcbCommandError(`${spec}: ${(err as Error).message.split('\n')[0]}`);
  }
}

/** A board imported into a layout input (RFC 11 Section 5.1). */
function importBoard(board: Board, projectId: string): LayoutInput {
  try {
    return importKicadBoard(board.text, { projectId, path: board.spec });
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
  /** What the import of a board side could not represent, from its `lossy` field. */
  notes: string[];
}

/**
 * What <after> changes relative to <before>. The before side is a layout input
 * or a board; the after side is a candidate, a later layout input, or a board.
 * A board is a .kicad_pcb file or `<revision>:<path>`. Both boards are imported
 * with identifiers derived under one project, the first board's file name
 * unless `project` says otherwise, so the same part matches across files and
 * revisions.
 */
export async function pcbDiff(
  beforeFile: string,
  afterFile: string,
  opts: { blocks?: string; project?: string } = {},
): Promise<PcbDiffResult> {
  const load = async (spec: string) =>
    spec.endsWith('.kicad_pcb') ? readBoard(spec) : classify(spec, await readJson(spec));
  const loaded = [await load(beforeFile), await load(afterFile)] as const;
  const boards = loaded.filter((s): s is Board => 'text' in s);
  const project = opts.project ?? (boards[0] && path.basename(boards[0].file, '.kicad_pcb'));
  const sideOf = (s: Board | Side): Side => ('text' in s ? { kind: 'input', input: importBoard(s, project!) } : s);
  const before = sideOf(loaded[0]);
  if (before.kind !== 'input') throw new PcbCommandError(`${beforeFile}: the before side is a layout input or a board`);
  const after = sideOf(loaded[1]);
  const diff =
    after.kind === 'candidate'
      ? placementDiff(before.input, {
          candidate: after.candidate,
          blockLayouts: await blockLayoutsIn(opts.blocks ?? path.dirname(afterFile)),
        })
      : placementDiff(before.input, { input: after.input });
  const text = renderDiffText(diff, { before: before.input, ...(after.kind === 'input' && { after: after.input }) });
  // A note both boards share is said once; one only a side has names that side.
  const imported: Array<[string, LayoutInput]> = [];
  if ('text' in loaded[0]) imported.push([beforeFile, before.input]);
  if ('text' in loaded[1] && after.kind === 'input') imported.push([afterFile, after.input]);
  const sides = new Map<string, string[]>();
  for (const [spec, input] of imported) for (const note of input.board.lossy ?? []) sides.set(note, [...(sides.get(note) ?? []), spec]);
  const notes = [...sides]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([note, specs]) => (specs.length === imported.length ? note : `${specs.join(', ')}: ${note}`));
  return { diff, text, notes };
}

/** A .kicad_pcb as one fact per line, for git's textconv. */
export async function pcbTextconv(board: string): Promise<string> {
  return boardTextOfFile(board);
}
