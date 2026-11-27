/**
 * Writing a candidate over the user's board. A run starts from the board's
 * bytes and takes minutes; if the board was saved in KiCad meanwhile, the
 * candidate was made from a board that no longer exists, and writing it would
 * throw the save away. So a candidate is written only over the bytes its run
 * started from.
 */
import { copyFile, readFile } from 'node:fs/promises';

export interface ApplyResult {
  applied: boolean;
  /** Why nothing was written, when nothing was. */
  reason?: string;
}

export async function applyIfUnchanged(candidatePath: string, boardPath: string, startText: string, boardName: string): Promise<ApplyResult> {
  if ((await readFile(boardPath, 'utf8')) !== startText) {
    return { applied: false, reason: `${boardName} changed while the run was going; run again to work on the board as it is now` };
  }
  await copyFile(candidatePath, boardPath);
  return { applied: true };
}
