/**
 * Generate src/pcb-ir/types.generated.ts from the RFC 11 layout record schemas
 * vendored under src/pcb-ir/schemas/rfc11/.
 *
 * RFC 11 Section 6.13: implementations derive their types from the published
 * schemas, never the reverse. The schemas' $id URLs name the RFC repository;
 * every reference to one resolves to the vendored copy, so generation reads no
 * network. All schemas compile through one root so a shared definition (Pose,
 * Rotation, Hash, ...) is emitted once.
 *
 *   npx tsx scripts/gen-pcb-ir-types.ts          write the file
 *   npx tsx scripts/gen-pcb-ir-types.ts --check  exit 1 if it is out of date
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCHEMA_DIR = path.join(ROOT, 'src/pcb-ir/schemas/rfc11');
export const OUTPUT = path.join(ROOT, 'src/pcb-ir/types.generated.ts');
const ID_BASE = 'https://github.com/copperheadhq/copperhead-rfcs/schemas/rfc11/2.0/';

/** The top-level records, in the order their types are emitted. */
const RECORDS = [
  'footprint',
  'physical',
  'layout-input',
  'snapshot',
  'block-layout',
  'candidate',
  'placement-diff',
  'layout-ops',
  'intent',
];

/**
 * json-schema-to-typescript predates two things draft 2020-12 schemas say, so
 * each schema is rewritten for it, never for validation:
 * - a tuple is `prefixItems` (with `items: false` closing it); the generator
 *   reads the draft-07 spelling, `items` as an array with `additionalItems`
 * - a schema that only narrows a string (`{"pattern": ...}`, as a record's
 *   `id` does over the entity base) has no `type`, and would otherwise become
 *   an object
 */
export function forGenerator(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(forGenerator);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = forGenerator(v);
  if (Array.isArray(out.prefixItems)) {
    const rest = out.items;
    out.items = out.prefixItems;
    out.additionalItems = rest === undefined ? true : rest;
    delete out.prefixItems;
  }
  // Rules that only constrain which fields appear together (an anyOf of bare
  // `required` lists, if/then, dependentRequired, not) say nothing about a
  // field's type, and the generator turns them into loose index signatures.
  for (const key of ['anyOf', 'oneOf'] as const) {
    const parts = out[key];
    if (
      Array.isArray(parts) &&
      parts.every((p) => p && typeof p === 'object' && Object.keys(p).every((k) => k === 'required'))
    ) {
      delete out[key];
    }
  }
  for (const key of ['if', 'then', 'else', 'dependentRequired', 'not']) delete out[key];
  if (Array.isArray(out.allOf)) {
    const kept = out.allOf.filter((p) => !(p && typeof p === 'object' && Object.keys(p).length === 0));
    if (kept.length) out.allOf = kept;
    else delete out.allOf;
  }
  const shapes = ['type', '$ref', 'allOf', 'anyOf', 'oneOf', 'enum', 'const', 'properties', 'items'];
  if (('pattern' in out || 'minLength' in out) && !shapes.some((k) => k in out)) out.type = 'string';
  return out;
}

function vendoredName(url: string): string | null {
  const bare = url.split('#')[0]!;
  if (bare.startsWith(ID_BASE)) return bare.slice(ID_BASE.length);
  if (path.dirname(bare) === SCHEMA_DIR) return path.basename(bare);
  return null;
}

export async function generate(): Promise<string> {
  const root = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${ID_BASE}pcb-ir.schema.json`,
    title: 'PcbIrRecords',
    type: 'object',
    properties: Object.fromEntries(RECORDS.map((r) => [r, { $ref: `${r}.schema.json` }])),
    additionalProperties: false,
  };
  const body = await compile(root as never, 'PcbIrRecords', {
    cwd: SCHEMA_DIR,
    bannerComment: '',
    additionalProperties: false,
    declareExternallyReferenced: true,
    unreachableDefinitions: false,
    format: true,
    style: { singleQuote: true, printWidth: 120 },
    $refOptions: {
      resolve: {
        vendored: {
          order: 1,
          canRead: (file: { url: string }) => vendoredName(file.url) !== null,
          read: async (file: { url: string }) => {
            const text = await readFile(path.join(SCHEMA_DIR, vendoredName(file.url)!), 'utf8');
            return JSON.stringify(forGenerator(JSON.parse(text)));
          },
        },
        http: false,
      },
    } as never,
  });
  return (
    '/* eslint-disable */\n' +
    '/**\n' +
    ' * Generated from the RFC 11 layout record schemas in src/pcb-ir/schemas/rfc11/\n' +
    ' * by scripts/gen-pcb-ir-types.ts. Do not edit: change the schemas in the RFC\n' +
    ' * repository, vendor them again, and regenerate.\n' +
    ' */\n\n' +
    body
  );
}

async function main(): Promise<void> {
  const text = await generate();
  if (process.argv.includes('--check')) {
    const current = await readFile(OUTPUT, 'utf8').catch(() => '');
    if (current !== text) {
      console.error(`${path.relative(ROOT, OUTPUT)} is out of date; run npx tsx scripts/gen-pcb-ir-types.ts`);
      process.exit(1);
    }
    return;
  }
  await writeFile(OUTPUT, text);
  console.log(`wrote ${path.relative(ROOT, OUTPUT)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
