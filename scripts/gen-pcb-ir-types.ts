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
          canRead: (file: { url: string }) => file.url.startsWith(ID_BASE),
          read: async (file: { url: string }) => {
            const name = file.url.slice(ID_BASE.length).split('#')[0]!;
            return readFile(path.join(SCHEMA_DIR, name), 'utf8');
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
