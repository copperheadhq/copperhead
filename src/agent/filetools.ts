import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveInRepo, isKicadFile } from '../util/paths.js';

export async function toolReadFile(
  repoRoot: string,
  p: string,
  startLine?: number,
  endLine?: number,
): Promise<string> {
  const abs = resolveInRepo(repoRoot, p);
  const text = await readFile(abs, 'utf8');
  if (startLine === undefined) return text;
  const lines = text.split('\n');
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, endLine ?? lines.length);
  return lines
    .slice(from - 1, to)
    .map((l, i) => `${from + i}: ${l}`)
    .join('\n');
}

/** New files only; refuses to overwrite anything and to create KiCad files (SPEC §4.2). */
export async function toolWriteFile(repoRoot: string, p: string, content: string): Promise<string> {
  const abs = resolveInRepo(repoRoot, p);
  if (isKicadFile(abs)) {
    throw new Error(`write_file refuses KiCad files (${p}); use edit_file with anchors instead`);
  }
  if (existsSync(abs)) {
    throw new Error(`write_file refuses to overwrite existing file ${p}; use edit_file`);
  }
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
  return `wrote ${p}`;
}

/**
 * Exact-match anchored replace; fails with an actionable error unless unique.
 * `replaceAll` replaces every occurrence (the rename case, AC-3.1) while still
 * being a surgical text edit on the s-expression source.
 */
export async function toolEditFile(
  repoRoot: string,
  p: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): Promise<string> {
  const abs = resolveInRepo(repoRoot, p);
  const text = await readFile(abs, 'utf8');
  const first = text.indexOf(oldString);
  if (first === -1) {
    throw new Error(`edit_file: anchor not found in ${p}; re-read the file and use an exact excerpt`);
  }
  const count = text.split(oldString).length - 1;
  if (replaceAll) {
    await writeFile(abs, text.split(oldString).join(newString), 'utf8');
    return `edited ${p} (${count} occurrence(s) replaced)`;
  }
  if (count > 1) {
    throw new Error(
      `edit_file: anchor matched ${count} times in ${p}; widen the anchor with surrounding lines until it is unique, or pass replace_all: true to replace every occurrence`,
    );
  }
  await writeFile(abs, text.slice(0, first) + newString + text.slice(first + oldString.length), 'utf8');
  return `edited ${p}`;
}

export interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.copperhead']);

/**
 * Longest match line returned to the model, in characters.
 *
 * The file-size bound in `toolSearch` (5 MB) bounds the file, not the line, and
 * on a one-object-per-line document those are very different limits. A
 * `transcript.jsonl` line is an entire `{ts, type, data}` record with tool
 * output inline, so a few matches inside one file can be hundreds of thousands
 * of tokens. A live run died on exactly that — `Prompt is too long · the
 * request is ~1003121 tokens (limit 1000000) but this conversation is only
 * ~403383 tokens`, the balance being search results — and it cost a stage
 * attempt. The agent had done nothing wrong: it searched the repo it was told
 * to work in, and a `run-logs/` directory happened to be sitting in it.
 *
 * A match is a pointer, not a payload — enough to see the hit and decide
 * whether to read the file. Truncation is marked so a clipped line is
 * distinguishable from a short one.
 */
const MAX_MATCH_CHARS = 400;

/** Clip one match line to `MAX_MATCH_CHARS`, marking it when clipped. */
function clipMatch(line: string): string {
  const t = line.trim();
  return t.length <= MAX_MATCH_CHARS ? t : `${t.slice(0, MAX_MATCH_CHARS)}… [+${t.length - MAX_MATCH_CHARS} chars]`;
}

export function globToRegex(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?'; // zero or more directories
      i += 2;
    } else if (glob.startsWith('**', i)) {
      out += '.*';
      i += 1;
    } else if (glob[i] === '*') {
      out += '[^/]*';
    } else if (glob[i] === '?') {
      out += '.';
    } else {
      out += glob[i]!.replace(/[.+^${}()|[\]\\]/, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}


/** ripgrep-style regex search implemented natively (no rg dependency). */
export async function toolSearch(
  repoRoot: string,
  pattern: string,
  glob?: string,
  maxMatches = 200,
): Promise<SearchMatch[]> {
  const re = new RegExp(pattern);
  const globRe = glob ? globToRegex(glob) : null;
  const matches: SearchMatch[] = [];
  async function walk(dir: string): Promise<void> {
    if (matches.length >= maxMatches) return;
    for (const entry of await readdir(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const abs = path.join(dir, entry);
      const rel = path.relative(repoRoot, abs);
      const st = await stat(abs);
      if (st.isDirectory()) {
        await walk(abs);
      } else if (st.size < 5_000_000 && (!globRe || globRe.test(rel))) {
        let text: string;
        try {
          text = await readFile(abs, 'utf8');
        } catch {
          continue;
        }
        if (text.includes('\u0000')) continue; // binary
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && matches.length < maxMatches; i++) {
          if (re.test(lines[i]!)) matches.push({ file: rel, line: i + 1, text: clipMatch(lines[i]!) });
        }
      }
      if (matches.length >= maxMatches) return;
    }
  }
  await walk(repoRoot);
  return matches;
}
