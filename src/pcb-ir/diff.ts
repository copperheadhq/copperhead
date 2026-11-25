import { contentHash } from './canonical.js';
import { composePose, distanceNm, sameRotation } from './geometry.js';
import type {
  BlockLayout,
  Candidate,
  ComponentChange,
  ConstraintChange,
  LayoutInput,
  Placed,
  PlacementDiff,
} from './types.generated.js';

/**
 * The placement diff (RFC 11 Section 6.11): what one board changes relative
 * to another. It compares a layout input with a candidate produced against it,
 * or with a later layout input. Components are matched by stable identifier,
 * never by reference designator or position.
 */

export type Change = ComponentChange['changes'][number];
export type Owner = ComponentChange['owner'];
export type ResultState = ConstraintChange['before'];

/** The order in which RFC 11 Section 6.11 lists the change kinds. */
const CHANGE_ORDER: readonly Change[] = [
  'placed',
  'unplaced',
  'moved',
  'rotated',
  'flipped',
  'footprint',
  'locked',
  'unlocked',
  'added',
  'removed',
];

/** RFC 12 Section 9.5 item 5: by default the policy protects a person's and an importer's placements. */
export const DEFAULT_PROTECTED_OWNERS: ReadonlySet<Owner> = new Set<Owner>(['person', 'import']);

export type DiffAfter = { candidate: Candidate; blockLayouts: Iterable<BlockLayout> } | { input: LayoutInput };

export interface DiffOptions {
  /** Constraint result states on each side; omit when a side was not checked. */
  constraints?: { before: Record<string, ResultState>; after: Record<string, ResultState> };
  /** The owners whose placements need approval to change. */
  protectedOwners?: ReadonlySet<Owner>;
}

interface AfterPlacement {
  placed: Placed;
  block?: string;
  basis?: ComponentChange['basis'];
  source?: string;
}

export class DiffInputError extends Error {}

/** Reference designators compared as people read them: R2 before R10. */
export function compareRefdes(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'variant' }) || (a < b ? -1 : a > b ? 1 : 0);
}

function placedOf(component: LayoutInput['components'][string] | undefined): Placed | undefined {
  return component?.pose ? { pose: component.pose, side: component.side } : undefined;
}

function candidatePlacements(
  candidate: Candidate,
  blockLayouts: Iterable<BlockLayout>,
): Map<string, AfterPlacement> {
  const layouts = new Map<string, BlockLayout>();
  for (const layout of blockLayouts) layouts.set(contentHash(layout), layout);
  const out = new Map<string, AfterPlacement>();
  for (const block of candidate.blocks) {
    const layout = layouts.get(block.layout);
    if (!layout) throw new DiffInputError(`block layout ${block.layout} was not given`);
    for (const member of layout.members) {
      out.set(member.component, {
        placed: { pose: composePose(block.transform, block.side, member.pose), side: block.side },
        block: layout.circuit,
        basis: member.basis,
        source: member.source,
      });
    }
  }
  for (const loose of candidate.loose) {
    out.set(loose.component, {
      placed: { pose: loose.pose, side: loose.side },
      basis: loose.basis,
      source: loose.source,
    });
  }
  return out;
}

export function placementDiff(before: LayoutInput, after: DiffAfter, options: DiffOptions = {}): PlacementDiff {
  const beforeHash = contentHash(before);
  const protectedOwners = options.protectedOwners ?? DEFAULT_PROTECTED_OWNERS;
  const isCandidate = 'candidate' in after;
  let afterComponents: LayoutInput['components'];
  let afterPlacements: Map<string, AfterPlacement>;
  if (isCandidate) {
    if (after.candidate.input !== beforeHash) {
      throw new DiffInputError(
        `the candidate ran against layout input ${after.candidate.input}, not ${beforeHash}`,
      );
    }
    afterComponents = before.components;
    afterPlacements = candidatePlacements(after.candidate, after.blockLayouts);
  } else {
    afterComponents = after.input.components;
    afterPlacements = new Map();
    for (const [id, component] of Object.entries(after.input.components)) {
      const placed = placedOf(component);
      if (placed) afterPlacements.set(id, { placed });
    }
  }

  const ids = new Set([...Object.keys(before.components), ...Object.keys(afterComponents)]);
  const rows: ComponentChange[] = [];
  for (const id of ids) {
    const b = before.components[id];
    const a = afterComponents[id];
    const bPlaced = placedOf(b);
    const aInfo = afterPlacements.get(id);
    const aPlaced = aInfo?.placed;
    const changes: Change[] = [];
    if (b && !a) changes.push('removed');
    else if (!b && a) changes.push('added');
    else {
      if (!bPlaced && aPlaced) changes.push('placed');
      if (bPlaced && !aPlaced) changes.push('unplaced');
      if (bPlaced && aPlaced) {
        if (bPlaced.pose.x !== aPlaced.pose.x || bPlaced.pose.y !== aPlaced.pose.y) changes.push('moved');
        if (!sameRotation(bPlaced.pose.rot, aPlaced.pose.rot)) changes.push('rotated');
        if (bPlaced.side !== aPlaced.side) changes.push('flipped');
      }
      if (b && a && b.footprint !== a.footprint) changes.push('footprint');
      if (b && a && b.locked !== a.locked) changes.push(a.locked ? 'locked' : 'unlocked');
    }
    if (changes.length === 0) continue;
    changes.sort((x, y) => CHANGE_ORDER.indexOf(x) - CHANGE_ORDER.indexOf(y));
    const owner: Owner = bPlaced ? (b?.owner ?? 'none') : 'none';
    const row: ComponentChange = {
      component: id,
      refdes: (a ?? b)!.refdes,
      changes: changes as ComponentChange['changes'],
      ...(bPlaced && { before: bPlaced }),
      ...(aPlaced && { after: aPlaced }),
      ...(bPlaced && aPlaced && {
        distance: distanceNm(bPlaced.pose.x, bPlaced.pose.y, aPlaced.pose.x, aPlaced.pose.y),
      }),
      ...(aInfo?.block && { block: aInfo.block }),
      ...(aInfo?.basis && { basis: aInfo.basis }),
      ...(aInfo?.source && { source: aInfo.source }),
      owner,
    };
    if (isCandidate) {
      const movesPlacement = changes.some((c) => c === 'moved' || c === 'rotated' || c === 'flipped' || c === 'unplaced');
      row.approval = b?.locked && movesPlacement ? 'refused' : protectedOwners.has(owner) ? 'required' : 'automatic';
    }
    rows.push(row);
  }
  rows.sort((x, y) => compareRefdes(x.refdes, y.refdes));

  const diff: PlacementDiff = {
    schema_version: '2.0',
    before: { input: beforeHash },
    after: isCandidate ? { candidate: contentHash(after.candidate) } : { input: contentHash(after.input) },
    components: rows,
  };
  if (options.constraints) {
    const { before: cb, after: ca } = options.constraints;
    const constraintIds = [...new Set([...Object.keys(cb), ...Object.keys(ca)])].sort();
    diff.constraints = constraintIds
      .filter((c) => (cb[c] ?? 'UNKNOWN') !== (ca[c] ?? 'UNKNOWN'))
      .map((c) => ({ constraint: c, before: cb[c] ?? 'UNKNOWN', after: ca[c] ?? 'UNKNOWN' }));
  }
  return diff;
}
