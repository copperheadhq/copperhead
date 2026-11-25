// Generate JSON Schemas for the engine contracts from the TypeScript types
// (ADR 0005). Committed under schemas/pcb/; a test regenerates and diffs.
import { createGenerator } from 'ts-json-schema-generator';
import { writeFileSync, mkdirSync } from 'node:fs';

const TYPES = ['EngineManifest', 'PlacementJob', 'PlacementResult', 'RoutingJob', 'RoutingResult'];
mkdirSync('schemas/pcb', { recursive: true });
for (const type of TYPES) {
  const gen = createGenerator({ path: 'src/pcb/engines/contracts.ts', tsconfig: 'tsconfig.json', type, skipTypeCheck: true, additionalProperties: false, expose: 'export', topRef: true });
  const schema = gen.createSchema(type);
  const out = `schemas/pcb/${type}.schema.json`;
  writeFileSync(out, JSON.stringify(schema, null, 2) + '\n');
  console.log(`wrote ${out}`);
}
