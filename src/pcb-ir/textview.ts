import { compareRefdes } from './diff.js';
import { degrees, mm } from './geometry.js';
import type { ComponentChange, LayoutInput, PlacementDiff } from './types.generated.js';

/**
 * The text view of a placement diff (RFC 11 Section 14.4): one line per row.
 * A component line begins with + for a component placed or added, - for one
 * unplaced or removed, and ~ for any other change, marked ! where the change
 * requires approval and x where it is refused. Lines that need a decision come
 * first; each group is sorted by refdes; constraint and finding lines follow.
 * Positions are millimetres and rotations degrees, written exactly.
 */

function short(hash: string): string {
  return hash.replace(/^sha256:/, '').slice(0, 8);
}

function point(p: { x: number; y: number }): string {
  return `(${mm(p.x)}, ${mm(p.y)})`;
}

function describe(row: ComponentChange): string {
  const parts: string[] = [];
  const { before: b, after: a } = row;
  for (const change of row.changes) {
    switch (change) {
      case 'placed':
      case 'added':
        parts.push(a ? `${change} ${point(a.pose)} ${degrees(a.pose.rot)}${a.side === 'back' ? ' back' : ''}` : change);
        break;
      case 'moved':
        parts.push(`moved ${mm(row.distance ?? 0)} mm ${point(b!.pose)} -> ${point(a!.pose)}`);
        break;
      case 'rotated':
        parts.push(`rotated ${degrees(b!.pose.rot)} -> ${degrees(a!.pose.rot)}`);
        break;
      case 'flipped':
        parts.push(`flipped ${b!.side} -> ${a!.side}`);
        break;
      case 'footprint':
        parts.push('footprint changed');
        break;
      default:
        parts.push(change);
    }
  }
  return parts.join(', ');
}

function marker(row: ComponentChange): string {
  const first = row.changes[0];
  return first === 'placed' || first === 'added' ? '+' : first === 'unplaced' || first === 'removed' ? '-' : '~';
}

function decision(row: ComponentChange): string {
  return row.approval === 'required' ? '!' : row.approval === 'refused' ? 'x' : ' ';
}

export interface TextViewContext {
  /** The layout input on the before side, for component values. */
  before: LayoutInput;
  /** The later layout input, when the after side is one. */
  after?: LayoutInput;
}

export function renderDiffText(diff: PlacementDiff, context: TextViewContext): string {
  const value = (id: string): string =>
    context.after?.components[id]?.value ?? context.before.components[id]?.value ?? '';
  const rows = diff.components;
  const required = rows.filter((r) => r.approval === 'required').length;
  const refused = rows.filter((r) => r.approval === 'refused').length;
  const afterLabel =
    'candidate' in diff.after ? `candidate ${short(diff.after.candidate)}` : `input ${short(diff.after.input)}`;
  let header = `diff ${short(diff.before.input)} -> ${afterLabel}: ${rows.length} changed`;
  if (required) header += `, ${required} ${required === 1 ? 'needs' : 'need'} approval`;
  if (refused) header += `, ${refused} refused`;
  if (diff.copper) header += `, copper +${diff.copper.added.length} -${diff.copper.removed.length}`;
  const lines = [header];

  const names = new Map(rows.map((r) => [r.component, `${r.refdes} ${value(r.component)}`.trimEnd()]));
  const nameWidth = Math.max(0, ...[...names.values()].map((n) => n.length)) + 1;
  const decided = rows.filter((r) => r.approval === 'required' || r.approval === 'refused');
  const rest = rows.filter((r) => r.approval !== 'required' && r.approval !== 'refused');
  for (const group of [decided, rest]) {
    group.sort((x, y) => compareRefdes(x.refdes, y.refdes));
    const descriptions = new Map(group.map((r) => [r.component, describe(r)]));
    const width = Math.max(0, ...[...descriptions.values()].map((d) => d.length)) + 3;
    for (const row of group) {
      const tail = row.block ?? row.basis ?? '';
      const line = `${decision(row)} ${marker(row)} ${names.get(row.component)!.padEnd(nameWidth)}${descriptions
        .get(row.component)!
        .padEnd(tail ? width : 0)}${tail}`;
      lines.push(line.trimEnd());
    }
  }
  for (const c of diff.constraints ?? []) lines.push(`    ${c.constraint}  ${c.before} -> ${c.after}`);
  for (const f of diff.drc?.added ?? []) lines.push(`    drc + ${[f.code, ...f.entities].join(' ')}`);
  for (const f of diff.drc?.resolved ?? []) lines.push(`    drc - ${[f.code, ...f.entities].join(' ')}`);
  for (const id of diff.copper?.added ?? []) lines.push(`    copper + ${id}`);
  for (const id of diff.copper?.removed ?? []) lines.push(`    copper - ${id}`);
  return lines.join('\n') + '\n';
}
