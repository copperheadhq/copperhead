import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Structural invariant over the sync-obligations ledger: an obligation that can
 * be opened must be closeable.
 *
 * The commit gate refuses while any obligation is open, so a kind that some
 * hook adds but nothing clears (and that `finish` does not exclude) would wedge
 * every run that triggers it. The failure is silent until the exact hook fires,
 * which is why this is asserted over the source rather than left to a scenario
 * test to stumble into.
 *
 * The sibling failure, a kind that is never opened at all, is what made this
 * worth pinning: `decision-log` sat in the union with a producer nothing
 * called, so wiring it up naively would have introduced exactly the wedge above.
 */

const SRC = path.resolve('src');

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every string literal passed to `.<method>(` across src. */
function literalArgs(source: string, method: string): string[] {
  const re = new RegExp(`\\.${method}\\(\\s*'([a-z-]+)'`, 'g');
  return [...source.matchAll(re)].map((m) => m[1]!);
}

describe('sync-obligations ledger is structurally satisfiable', () => {
  it('every obligation kind that can be opened can also be closed', async () => {
    const sources = await Promise.all((await tsFiles(SRC)).map((f) => readFile(f, 'utf8')));
    const all = sources.join('\n');

    const opened = new Set(literalArgs(all, 'add'));
    const cleared = new Set(literalArgs(all, 'clear'));
    // `finish` lets some kinds through because the commit path settles them itself
    const excluded = new Set([...all.matchAll(/o\.kind !== '([a-z-]+)'/g)].map((m) => m[1]!));

    expect(opened.size).toBeGreaterThan(0);

    const unsatisfiable = [...opened].filter((k) => !cleared.has(k) && !excluded.has(k)).sort();
    expect(unsatisfiable, `openable but never cleared or excluded: ${unsatisfiable.join(', ')}`).toEqual([]);
  });

  it('every declared obligation kind has a producer', async () => {
    const ledger = await readFile(path.join(SRC, 'agent', 'ledger.ts'), 'utf8');
    const union = ledger.slice(
      ledger.indexOf('export type ObligationKind'),
      ledger.indexOf(';', ledger.indexOf('export type ObligationKind')),
    );
    const declared = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);

    const sources = await Promise.all((await tsFiles(SRC)).map((f) => readFile(f, 'utf8')));
    const opened = new Set(literalArgs(sources.join('\n'), 'add'));

    expect(declared.length).toBeGreaterThan(0);

    const dead = declared.filter((k) => !opened.has(k)).sort();
    expect(dead, `declared but never opened: ${dead.join(', ')}`).toEqual([]);
  });
});
