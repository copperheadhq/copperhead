/**
 * placement.md (RFC 11 Section 12.6): the layout document a person reads,
 * generated from a run's records and never read as an input. It is written
 * twice: once the plan has been validated, so a person can stop a run whose
 * plan is wrong, and when the run ends, replacing the first.
 *
 * Everything here is a function of its input: no clock, no randomness, no
 * file system, so the same records produce the same bytes. Text a model wrote
 * appears only as a plan's rationale and is marked as the model's.
 */
import type { LayoutInput, PlacementDiff } from './types.generated.js';

export interface PlacementDocBlock {
  id: string;
  members: string[];
  anchor?: string | null;
  /** The block's region on the board, in nanometres, when the plan gives one. */
  region?: { id: string; x: number; y: number; w: number; h: number } | null;
  flow?: string;
}

export interface PlacementDocCritical {
  kind: string;
  refs: string[];
  /** The limit the relationship holds the parts to, as text: "within 2 mm". */
  limit?: string;
  /** What the selected candidate did with it; absent at plan time. */
  result?: string;
  /** The document, page or figure, and quote it rests on, when one is recorded (RFC 4). */
  citation?: string;
  rationale?: string;
}

export interface PlacementDocCandidate {
  id: string;
  rank: number | null;
  selected: boolean;
  reason: string;
  metrics: Record<string, number | undefined>;
}

export interface PlacementDocInput {
  /** What the run is: "pcb reuse of board.kicad_pcb against reference.kicad_pcb". */
  title: string;
  /** The layout input the run places: the board as it was before the run. */
  input: LayoutInput;
  fabricationProfile: string;
  plan: {
    source: 'model' | 'rules';
    blocks: PlacementDocBlock[];
    phases: Array<{ kind: string; parts: string[]; note?: string }>;
    rationale: string[];
  };
  critical: PlacementDocCritical[];
  /** Null at plan time: nothing has been measured yet. */
  candidates: PlacementDocCandidate[] | null;
  /** The placement diff of the selected candidate and its text view (RFC 11 Section 14.4). */
  changes: { diff: PlacementDiff; text: string } | null;
  remains: {
    unplaced: string[];
    held: string[];
    unknown: string[];
    deviations: string[];
    /** What the import of a board could not represent. */
    lossy: string[];
  };
}

const mm = (nm: number, digits = 1) => (nm / 1e6).toFixed(digits);

function area(ring: Array<{ x: number; y: number }>): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a / 2);
}

function boardSection(input: LayoutInput, profile: string): string[] {
  const outline = input.board.outline as Array<{ x: number; y: number }>;
  const xs = outline.map((p) => p.x);
  const ys = outline.map((p) => p.y);
  const cutouts = ((input.board.cutouts ?? []) as Array<{ outline: Array<{ x: number; y: number }> }>).map((c) => c.outline);
  const boardArea = area(outline) - cutouts.reduce((s, c) => s + area(c), 0);
  let parts = 0;
  let without = 0;
  for (const c of Object.values(input.components)) {
    const ring = input.footprints[c.footprint]?.courtyard?.outline as Array<{ x: number; y: number }> | undefined;
    if (ring) parts += area(ring);
    else without++;
  }
  const layers = (input.board.layers as Array<{ name: string; layer_kind: string }>).filter((l) => l.layer_kind === 'copper').map((l) => l.name);
  const share = boardArea > 0 ? `${((parts / boardArea) * 100).toFixed(0)} %` : 'unknown';
  return [
    '## 1. The board',
    '',
    `- Outline: ${mm(Math.max(...xs) - Math.min(...xs))} x ${mm(Math.max(...ys) - Math.min(...ys))} mm, ${outline.length} vertices${cutouts.length ? `, ${cutouts.length} cutout(s)` : ''}`,
    `- Copper layers, top to bottom: ${layers.join(', ') || 'none'}`,
    `- Fabrication profile: ${profile}`,
    `- Components: ${Object.keys(input.components).length}, their courtyards taking ${share} of the board's area${without ? ` (${without} without a courtyard, not counted)` : ''}`,
    '',
  ];
}

function planSection(plan: PlacementDocInput['plan']): string[] {
  const out = ['## 2. The plan', '', `Written by ${plan.source === 'model' ? 'a model, then validated' : 'the rules'}.`, ''];
  if (plan.blocks.length) {
    out.push('| Block | Members | Anchor | Region | Flow |', '| --- | --- | --- | --- | --- |');
    for (const b of plan.blocks) {
      const region = b.region ? `${b.region.id}: ${mm(b.region.w)} x ${mm(b.region.h)} mm at (${mm(b.region.x)}, ${mm(b.region.y)})` : '-';
      out.push(`| ${b.id} | ${b.members.join(', ')} | ${b.anchor ?? '-'} | ${region} | ${b.flow ?? '-'} |`);
    }
    out.push('');
  } else out.push('No functional blocks.', '');
  out.push('This run places by reuse and packing; it produces no block layouts (RFC 11 Section 6.10).', '');
  if (plan.phases.length) {
    out.push('Phases, in the order they are packed:', '');
    plan.phases.forEach((p, i) => out.push(`${i + 1}. ${p.kind}: ${p.parts.join(', ') || 'nothing'}${p.note ? ` (${p.note})` : ''}`));
    out.push('');
  }
  if (plan.rationale.length) {
    out.push(plan.source === 'model' ? 'Rationale, written by a model:' : 'Rationale:', '');
    for (const r of plan.rationale) out.push(`> ${r}`);
    out.push('');
  }
  return out;
}

function criticalSection(critical: PlacementDocCritical[], measured: boolean): string[] {
  const out = ['## 3. Critical constraints', ''];
  if (!measured) out.push('Nothing has been measured yet; these are what will be checked.', '');
  if (!critical.length) return [...out, 'None.', ''];
  out.push('| Relationship | Parts | Limit | Result | Basis |', '| --- | --- | --- | --- | --- |');
  for (const c of critical) {
    const basis = c.citation ?? (c.rationale ? `${c.rationale} (no citation recorded)` : 'no citation recorded');
    out.push(`| ${c.kind} | ${c.refs.join(', ')} | ${c.limit ?? '-'} | ${measured ? (c.result ?? 'not measured') : 'not yet measured'} | ${basis} |`);
  }
  out.push('');
  return out;
}

function candidatesSection(candidates: PlacementDocCandidate[] | null): string[] {
  const out = ['## 4. Candidates offered', ''];
  if (!candidates) return [...out, 'Nothing has been measured yet: candidates are produced after this plan.', ''];
  if (!candidates.length) return [...out, 'None: no candidate survived screening.', ''];
  const metric = (m: Record<string, number | undefined>, k: string, f: (v: number) => string) => (m[k] === undefined ? '-' : f(m[k]!));
  out.push('| Rank | Candidate | Critical nets | Loop area | Routability | HPWL | Why |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const c of [...candidates].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || (a.id < b.id ? -1 : 1))) {
    out.push(
      `| ${c.rank ?? '-'}${c.selected ? ' (selected)' : ''} | ${c.id} | ${metric(c.metrics, 'critical_completion', (v) => `${(v * 100).toFixed(0)} %`)} | ${metric(c.metrics, 'loop_area_mm2', (v) => `${v.toFixed(1)} mm2`)} | ${metric(c.metrics, 'routability_completion', (v) => `${(v * 100).toFixed(0)} %`)} | ${metric(c.metrics, 'hpwl_nm', (v) => `${mm(v)} mm`)} | ${c.reason} |`,
    );
  }
  out.push('');
  return out;
}

function changesSection(changes: PlacementDocInput['changes'], measured: boolean): string[] {
  const out = ['## 5. The changes', ''];
  if (!measured) return [...out, 'Nothing has been measured yet: the selected candidate is compared with this board when the run ends.', ''];
  if (!changes) return [...out, 'No candidate was selected, so the board is unchanged.', ''];
  return [...out, 'The selected candidate against the board as it was, changes that need approval first (RFC 11 Section 14.4):', '', '```text', changes.text.replace(/\n$/, ''), '```', ''];
}

function remainsSection(r: PlacementDocInput['remains']): string[] {
  const out = ['## 6. What remains', ''];
  const list = (label: string, items: string[]) => out.push(`- ${label}: ${items.length ? items.join('; ') : 'none'}`);
  list('Unplaced components', r.unplaced);
  list('Held items', r.held);
  list('Results that are UNKNOWN', r.unknown);
  list('Deviations and their waivers', r.deviations);
  list('What the board import could not represent', r.lossy);
  out.push('');
  return out;
}

/** The document, from the records it describes. */
export function placementMarkdown(doc: PlacementDocInput): string {
  const measured = doc.candidates !== null;
  const lines = [
    '# Placement',
    '',
    `${doc.title}. ${measured ? 'The run has ended.' : 'The plan has been validated; the run is still going.'}`,
    '',
    ...boardSection(doc.input, doc.fabricationProfile),
    ...planSection(doc.plan),
    ...criticalSection(doc.critical, measured),
    ...candidatesSection(doc.candidates),
    ...changesSection(doc.changes, measured),
    ...remainsSection(doc.remains),
  ];
  return lines.join('\n');
}
