/**
 * Test-tree alias for the product netlist extractor.
 *
 * The implementation lives in `src/kicad/netlist.ts` so the corpus tooling
 * and the product share one extractor and cannot drift apart. This module
 * re-exports it for existing imports (see draft-real-corpus tooling).
 */
export {
  parseNetlist,
  netlistToIntent,
  netPartition,
  classifyRefusal,
  type Netlist,
  type NetlistPart,
  type NetlistNet,
  type NetlistNode,
  type RefusalKind,
} from '../../src/kicad/netlist.js';
