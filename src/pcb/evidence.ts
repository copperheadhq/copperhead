/**
 * Layout evidence markers in docs/LAYOUT.md (ADR 0009, create-pipeline delta,
 * AC-17.15/AC-17.16): what `create` writes after routing a board through the
 * wrapped engines, and what `check` and the stage contract read back. Imports
 * only the IR so the `check` path never reaches an engine.
 */
import { importBoard } from './ir/kicad/import.js';
import { hashDesign } from './ir/canonical.js';
import type { LayoutStatus } from './ir/status.js';

export const EVIDENCE_HEADING = '## Layout evidence (machine-generated)';
const MARKER_OPEN = '<!-- copperhead:layout-evidence ';
const MARKER_CLOSE = ' -->';

export interface LayoutEvidence {
  version: 1;
  writtenAt: string;
  /** hashDesign of the board as it stood when the evidence was written (after applying the selected candidate). */
  boardHash: string;
  /** Hash of the immutable input snapshot the engines routed. */
  snapshotHash: string;
  runDir: string;
  status: LayoutStatus;
  summary: string;
  selected: string | null;
  engines: { id: string; version: string }[];
  metrics: Record<string, number>;
  /** Connections still owed on the selected candidate, by net name. */
  owed: string[];
  /** Error-severity diagnostics on the selected candidate (or the refusal), code and references. */
  diagnostics: { code: string; severity: string; entityReferences: string[]; message: string }[];
  /** Per-subsystem table (spec §10), when functional blocks were derived for the run. */
  blocks?: { id: string; anchor: string | null; members: string[]; spreadMm: number | null; budgetMm: number | null; unsatisfied: string[]; owed: number }[];
  /** Repair cycles of the closed loop that produced this board. */
  cycles?: { n: number; action: string | null; status: string; errors: number; owed: number }[];
}

/** Statuses under which the layout-draft stage may complete: routed, partly routed, or no engine to route with (said so). */
export const COMPLETING_STATUSES: LayoutStatus[] = ['PASS', 'PARTIAL', 'UNSUPPORTED'];

export function boardHash(boardText: string, boardPath: string, projectText?: string): string {
  return hashDesign(importBoard({ boardText, boardPath, ...(projectText ? { projectText } : {}), now: 'evidence' }).design);
}

export function readEvidence(layoutMd: string): LayoutEvidence | null {
  const i = layoutMd.indexOf(MARKER_OPEN);
  if (i < 0) return null;
  const j = layoutMd.indexOf(MARKER_CLOSE, i);
  if (j < 0) return null;
  try {
    const parsed = JSON.parse(layoutMd.slice(i + MARKER_OPEN.length, j)) as LayoutEvidence;
    return parsed.version === 1 && typeof parsed.boardHash === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function renderSection(e: LayoutEvidence): string {
  const m = e.metrics;
  const pct = (v: number | undefined) => (v === undefined ? '—' : `${Math.round(v * 100)} %`);
  const mm = (v: number | undefined) => (v === undefined ? '—' : `${(v / 1e6).toFixed(1)} mm`);
  const lines = [
    EVIDENCE_HEADING,
    '',
    `Routed by copperhead through its wrapped engines on ${e.writtenAt}; nothing here was drawn by a model. Status **${e.status}**: ${e.summary}`,
    '',
    `- Engines run: ${e.engines.length ? e.engines.map((x) => `${x.id} ${x.version}`).join(', ') : 'none'}`,
    `- Selected: ${e.selected ?? 'none'}`,
    `- Completion ${pct(m.completion_rate)}, ${e.owed.length} connection(s) owed, ${m.shorts ?? 0} short(s), ${m.drc_error_count ?? 0} KiCad DRC error(s)`,
    `- Wirelength ${mm(m.total_wirelength_nm)}, ${m.via_count ?? 0} via(s), ${m.bend_count ?? 0} bend(s)`,
    `- Evidence bundle: \`${e.runDir}\` (snapshot ${e.snapshotHash.slice(0, 12)}, board ${e.boardHash.slice(0, 12)})`,
  ];
  if (e.owed.length) lines.push(`- Owed: ${e.owed.slice(0, 20).join(', ')}${e.owed.length > 20 ? ', …' : ''}`);
  if (e.blocks?.length) {
    lines.push('', '| block | anchor | parts | spread / budget | unsatisfied | owed |', '| --- | --- | --- | --- | --- | --- |');
    for (const b of e.blocks) lines.push(`| ${b.id} | ${b.anchor ?? '—'} | ${b.members.length} | ${b.spreadMm !== null && b.budgetMm !== null ? `${b.spreadMm.toFixed(1)} / ${b.budgetMm.toFixed(1)} mm` : '—'} | ${b.unsatisfied.length ? b.unsatisfied.join(', ') : 'none'} | ${b.owed} |`);
    lines.push('');
  }
  if (e.cycles?.length) lines.push(`- Repair cycles: ${e.cycles.map((c) => `${c.n}${c.action ? ` ${c.action}` : ''} → ${c.status} (${c.errors} error(s), ${c.owed} owed)`).join('; ')}`);
  if (e.diagnostics.length) {
    lines.push('- Findings:');
    for (const d of e.diagnostics.slice(0, 20)) lines.push(`  - ${d.severity} ${d.code}${d.entityReferences.length ? ` [${d.entityReferences.slice(0, 4).join(', ')}]` : ''}: ${d.message}`);
  }
  lines.push('', `${MARKER_OPEN}${JSON.stringify(e)}${MARKER_CLOSE}`, '');
  return lines.join('\n');
}

/** Replace (or append) the evidence section of LAYOUT.md. Everything else in the doc is left alone. */
export function writeEvidence(layoutMd: string, e: LayoutEvidence): string {
  const section = renderSection(e);
  const start = layoutMd.indexOf(EVIDENCE_HEADING);
  if (start < 0) return `${layoutMd.replace(/\s*$/, '')}\n\n${section}`;
  // the section runs to the next H2 or the end of the doc
  const rest = layoutMd.slice(start + EVIDENCE_HEADING.length);
  const next = rest.search(/\n## /);
  const end = next < 0 ? layoutMd.length : start + EVIDENCE_HEADING.length + next + 1;
  return `${layoutMd.slice(0, start)}${section}${layoutMd.slice(end)}`;
}

export interface ContractVerdict {
  ok: boolean;
  /** One line naming the gap, for the stage's resume hint. */
  reason: string;
  evidence: LayoutEvidence | null;
  stale: boolean;
}

/** The layout-draft completion contract: evidence exists for exactly this board and ended in a completing status. */
export function evidenceContract(layoutMd: string | null, boardText: string, boardPath: string, projectText?: string): ContractVerdict {
  const evidence = layoutMd ? readEvidence(layoutMd) : null;
  if (!evidence) return { ok: false, reason: 'docs/LAYOUT.md carries no layout evidence; copperhead routes the board after the placement stage and records it there', evidence: null, stale: false };
  const hash = boardHash(boardText, boardPath, projectText);
  if (hash !== evidence.boardHash) return { ok: false, reason: `the board changed after the evidence was written (board ${hash.slice(0, 12)}, evidence ${evidence.boardHash.slice(0, 12)}); re-run copperhead pcb route or copperhead create to refresh it`, evidence, stale: true };
  if (!COMPLETING_STATUSES.includes(evidence.status)) {
    const codes = [...new Set(evidence.diagnostics.map((d) => d.code))];
    return { ok: false, reason: `routing ended ${evidence.status}: ${evidence.summary}${codes.length ? ` (${codes.join(', ')})` : ''}`, evidence, stale: false };
  }
  return { ok: true, reason: '', evidence, stale: false };
}
