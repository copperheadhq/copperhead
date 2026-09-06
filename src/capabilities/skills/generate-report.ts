import { defineSkill } from '../define.js';

export default defineSkill({
  schema: {
    name: 'generate_report',
    description:
      'Read-only report of the current design: ERC, DRC (if a board exists), drift, nets, and an optional SVG path. Does not edit files.',
    parameters: {
      type: 'object',
      properties: { scope: { type: 'string', enum: ['power', 'all'], description: 'Report scope (default all)' } },
      required: [],
    },
  },
  version: 1,
  viewHint: 'diagnostic',
  tools: ['read_file', 'search', 'list_nets', 'run_erc', 'run_drc', 'export_svg', 'check_drift'],
  maxTurns: 8,
  prompt: (_ctx, args) => `You are generating a read-only design report (scope: ${args.scope === 'power' ? 'power' : 'all'}).
Call the available tools to gather ERC, DRC (only if a board is configured; otherwise skip), drift, and the net list. Optionally export an SVG of the schematic.
Do not edit any file. Do not call finish. When you have those results, stop calling tools.`,
  isComplete: (ctx) =>
    (!ctx.config.schematic || ctx.lastErc !== null) &&
    (!ctx.config.board || ctx.lastDrc !== null) &&
    (!ctx.config.schematic || ctx.lastDrift != null),
});
