import { textResult, type ViewHint } from '../agent/envelope.js';
import { defineTool, type CatalogEntry, type CatalogTool } from './define.js';
import { HANDLERS } from './handlers.js';
import generateReport from './skills/generate-report.js';

export type { CatalogEntry, CatalogSkill, CatalogTool } from './define.js';
export { defineTool, defineSkill } from './define.js';

const HINT: Record<string, ViewHint> = {
  read_file: 'query',
  search: 'query',
  list_symbols: 'query',
  list_nets: 'query',
  propose_change: 'mutation',
  validate_change: 'diagnostic',
  edit_file: 'mutation',
  write_file: 'mutation',
  run_erc: 'diagnostic',
  search_symbols: 'query',
  symbol_pins: 'query',
  verify_symbols: 'diagnostic',
  draft_schematic: 'mutation',
  score_schematic: 'diagnostic',
  check_legibility: 'diagnostic',
  run_drc: 'diagnostic',
  export_svg: 'export',
  export_outputs: 'export',
  check_drift: 'diagnostic',
  record_constraint: 'mutation',
  resolve_affected: 'mutation',
  record_decision: 'mutation',
  finish: 'diagnostic',
};

function wrap(def: (typeof HANDLERS)[number]): CatalogTool {
  const viewHint = HINT[def.schema.name];
  if (!viewHint) throw new Error(`missing viewHint for ${def.schema.name}`);
  return defineTool({
    schema: def.schema,
    version: 1,
    viewHint,
    gate: def.requiresUnlock ? (ctx) => ctx.editsUnlocked : () => true,
    handler: async (ctx, args) => textResult(await def.handler(ctx, args), viewHint),
  });
}

/** Tools from HANDLERS + every skill module imported below (conformance checks skills/). */
export const catalog: CatalogEntry[] = [...HANDLERS.map(wrap), generateReport];
