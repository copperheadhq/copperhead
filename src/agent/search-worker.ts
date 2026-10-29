/**
 * Worker-thread entry for `toolSearch` (issue #366).
 *
 * A user- or model-supplied regex can contain nested quantifiers such as
 * `(a+)+$` that make V8's backtracking engine run effectively forever. V8 has
 * no regex timeout, and a synchronous `re.test` on the main thread would block
 * the whole agent (and any MCP host awaiting the tool). The only way to bound
 * that work is to run it on its own thread and terminate the thread when the
 * budget expires, so the caller gets a bounded failure instead of a hang.
 *
 * The body is a self-contained script (no imports of this package) spawned with
 * `new Worker(source, { eval: true })`: that keeps the worker identical in dev
 * (`tsx`), tests (vitest), and the compiled `dist/` tree, where a sibling
 * `.js`/`.ts` path would not resolve in all three. It is CommonJS, so it uses
 * `require`. Do not introduce `${...}` here: the source is a String.raw template.
 *
 * Maintenance note: upstream search changes that touch this walk (symlink
 * containment from PRs #88/#330, path-separator handling from PR #261) must be
 * ported into this eval'd body, not just into the surrounding `toolSearch`.
 */

export interface SearchWorkerRequest {
  repoRoot: string;
  pattern: string;
  /** `globToRegex(glob).source`, or null when no glob filter was given. */
  globSource: string | null;
  maxMatches: number;
  maxMatchChars: number;
}

export interface SearchWorkerMatch {
  file: string;
  line: number;
  text: string;
}

export type SearchWorkerResponse =
  | { ok: true; matches: SearchWorkerMatch[] }
  | { ok: false; code: 'invalid-pattern' | 'error'; message: string };

export const SEARCH_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { readFile, readdir, stat } = require('node:fs/promises');
const path = require('node:path');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.copperhead']);
const MAX_FILE_BYTES = 5000000;

function clip(line, max) {
  const t = line.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + '\u2026 [+' + (t.length - max) + ' chars]';
}

async function main() {
  const req = workerData;
  let re;
  try {
    re = new RegExp(req.pattern);
  } catch (err) {
    parentPort.postMessage({ ok: false, code: 'invalid-pattern', message: (err && err.message) || String(err) });
    return;
  }
  const globRe = req.globSource ? new RegExp(req.globSource) : null;
  const matches = [];

  async function walk(dir) {
    if (matches.length >= req.maxMatches) return;
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const abs = path.join(dir, entry);
      const rel = path.relative(req.repoRoot, abs);
      let st;
      try {
        st = await stat(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(abs);
      } else if (st.size < MAX_FILE_BYTES && (!globRe || globRe.test(rel))) {
        let text;
        try {
          text = await readFile(abs, 'utf8');
        } catch {
          continue;
        }
        if (text.indexOf('\u0000') !== -1) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && matches.length < req.maxMatches; i++) {
          if (re.test(lines[i])) matches.push({ file: rel, line: i + 1, text: clip(lines[i], req.maxMatchChars) });
        }
      }
      if (matches.length >= req.maxMatches) return;
    }
  }

  await walk(req.repoRoot);
  parentPort.postMessage({ ok: true, matches: matches });
}

main().catch(function (err) {
  parentPort.postMessage({ ok: false, code: 'error', message: (err && err.message) || String(err) });
});
`;
