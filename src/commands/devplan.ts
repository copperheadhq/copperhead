import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { execa } from 'execa';

/** A candidate written by an earlier stage is not a completed final-stage run. */
export async function devplanStageCommitted(root: string, docs: string): Promise<boolean> {
  const file = path.posix.join(docs, 'DEVPLAN.md');
  try {
    const { stdout } = await execa('git', ['log', '-1', '--format=%H%n%s', '--', file], { cwd: root });
    const [commit, subject] = stdout.trim().split('\n');
    if (!commit || subject !== 'copperhead: create pipeline stage: devplan') return false;
    const { stdout: committed } = await execa('git', ['show', `${commit}:${file}`], { cwd: root, stripFinalNewline: false });
    return committed === await readFile(path.join(root, file), 'utf8');
  } catch {
    return false;
  }
}

/** Reject a no-op final-stage finish before the agent's normal commit mechanism. */
export async function devplanReviewGap(root: string, docs: string, before: string | null): Promise<string | null> {
  const file = path.posix.join(docs, 'DEVPLAN.md');
  const text = await readFile(path.join(root, file), 'utf8').catch(() => null);
  if (!text || !/^#{1,6}\s/m.test(text) || !text.split('\n').some(l => l.trim() && !l.trim().startsWith('#'))) {
    return `${file} needs a nonempty development plan`;
  }
  return text === before
    ? `${file} is unchanged in this final-stage run. Review the actual design, outputs, build evidence and remaining risks, then improve the plan substantively before finish; do not add a dummy marker or an empty commit.`
    : null;
}
