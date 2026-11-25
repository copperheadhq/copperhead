/**
 * pcb-ir (RFC 11 Section 14.1): the layout records of RFC 11 Section 6, with
 * types generated from the published schemas, their canonical form and content
 * hashes, and the change views of Section 14.4.
 */
export * from './types.generated.js';
export { canonical, canonicalBytes, contentHash, encodeNumber, NotCanonicalizable, ORDERED_KEYS } from './canonical.js';
export { composePose, degrees, distanceNm, mm, rotatePoint, rotationMdeg, rotationOf } from './geometry.js';
export type { Rotation, Side } from './geometry.js';
export {
  compareRefdes,
  DEFAULT_PROTECTED_OWNERS,
  DiffInputError,
  placementDiff,
  type Change,
  type DiffAfter,
  type DiffOptions,
  type Owner,
  type ResultState,
} from './diff.js';
export { renderDiffText, type TextViewContext } from './textview.js';
export { boardText, boardTextOfFile, nmOf } from './textconv.js';
export { ADAPTER, Identifiers, importKicadBoard, uuid5, type ImportOptions } from './import-kicad.js';
