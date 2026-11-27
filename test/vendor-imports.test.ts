/**
 * The vendored packer (src/vendor/calculate-packing) must stay self-contained:
 * nothing it imports may resolve outside its own directory, and the only
 * package it may depend on is @flatten-js/core (add-reuse-placer, spec
 * "Vendored geometry engine").
 */
import { describe, it, expect } from 'vitest';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'src/vendor/calculate-packing');
const ALLOWED_PACKAGES = new Set(['@flatten-js/core']);

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(p)));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function importsOf(text: string): string[] {
  const specifiers: string[] = [];
  for (const m of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specifiers.push(m[1]!);
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1]!);
  for (const m of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specifiers.push(m[1]!);
  for (const m of text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1]!);
  return specifiers;
}

const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

describe('vendored calculate-packing imports', () => {
  it('imports nothing outside the vendor directory, except @flatten-js/core', async () => {
    const files = await tsFiles(VENDOR);
    expect(files.length).toBeGreaterThan(30);

    for (const file of files) {
      for (const specifier of importsOf(await readFile(file, 'utf8'))) {
        if (!specifier.startsWith('.')) {
          expect(ALLOWED_PACKAGES.has(specifier), `${rel(file)} imports "${specifier}"`).toBe(true);
          continue;
        }
        const resolved = path.resolve(path.dirname(file), specifier);
        const inside = resolved === VENDOR || resolved.startsWith(VENDOR + path.sep);
        expect(inside, `${rel(file)} imports "${specifier}", which resolves to ${rel(resolved)}`).toBe(true);

        // NodeNext: a relative import carries the .js extension of the emitted file
        expect(specifier.endsWith('.js'), `${rel(file)} imports "${specifier}" without a .js extension`).toBe(true);
        const source = resolved.replace(/\.js$/, '.ts');
        await expect(access(source), `${rel(file)} imports "${specifier}", but ${rel(source)} does not exist`).resolves.toBeUndefined();
      }
    }
  });

  it('never reaches back into src/ or the repository root', async () => {
    for (const file of await tsFiles(VENDOR)) {
      const text = await readFile(file, 'utf8');
      for (const specifier of importsOf(text)) {
        expect(specifier.startsWith('/'), `${rel(file)} imports an absolute path`).toBe(false);
        expect(/(^|\/)src\//.test(specifier), `${rel(file)} imports "${specifier}"`).toBe(false);
      }
    }
  });
});
