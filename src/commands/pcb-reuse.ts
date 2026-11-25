/**
 * `copperhead pcb reuse` (RFC 15 Section 16): place a board by copying a
 * reference board's placement and adapting it. The run screens every variant
 * in memory, materialises the survivors, verifies and probes them, and ends
 * with options the user chooses between — not one answer.
 *
 * The artifacts are the point of the command: `options.md` says what each
 * option traded away, `delta.md` says what changed against the reference,
 * every option keeps its own render and its placement diff against the board
 * (RFC 11 Section 6.11) beside its board, and `placement.md` (RFC 11 Section
 * 12.6) is the document a person reads.
 */
import path from 'node:path';
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { reuseRun, type ReuseRun, type ReuseRunOptions } from '../pcb/engines/reuse/run.js';
import type { PlacementPlan } from '../pcb/engines/reuse/plan.js';
import { importKicadBoard } from '../pcb-ir/import-kicad.js';
import { contentHash, placementDiff, renderDiffText, type Candidate, type LayoutInput, type PlacementDiff } from '../pcb-ir/index.js';
import { placementMarkdown, type PlacementDocCritical, type PlacementDocInput } from '../pcb-ir/placement-md.js';
import { planPlacement } from '../pcb/agent/place/planner.js';
import type { Provider } from '../agent/types.js';
import { writeBoardRender } from '../pcb/engines/render.js';
import type { Outcome } from '../pcb/ir/status.js';
import type { Diagnostic } from '../pcb/verify/diagnostic.js';

export interface PcbReuseOptions extends ReuseRunOptions {
  /** The model that writes the plan; without it the rules plan and the run is network-free. */
  provider?: Provider | null;
  /** Write the chosen option over the board file. */
  apply?: boolean;
  /** Which option to apply; the ranked winner when absent. */
  option?: string;
}

export interface PcbReuseResult {
  outcome: Outcome<Diagnostic>;
  run: ReuseRun;
  /** Per option: where its board, render, and placement diff live. */
  options: { id: string; engineId: string; dir: string; rank: number | null; selected: boolean; diff: PlacementDiff }[];
  applied: string | null;
  /** placement.md (RFC 11 Section 12.6). */
  placementDoc: string;
}

/**
 * A reuse option as an RFC 11 candidate (Section 6.10): every part placed
 * individually, with the basis of its pose. Options that keep the
 * reference's positions (the copy, and the A family) adapt a golden layout;
 * the others pack. A part the option's board does not hold is unplaced.
 */
export function candidateOf(
  optionId: string,
  engineId: string,
  before: LayoutInput,
  after: LayoutInput,
  record: { verified: boolean; findings: Diagnostic[]; metrics: Record<string, number | undefined> },
): Candidate {
  const basis = optionId === 'copy' || /^a\d/.test(optionId) ? 'golden-adapted' : 'packed';
  const loose: Candidate['loose'] = [];
  const unplaced: string[] = [];
  for (const id of Object.keys(before.components).sort()) {
    const a = after.components[id];
    if (!a?.pose) {
      unplaced.push(id);
      continue;
    }
    loose.push({ component: id, pose: a.pose, side: a.side, basis, source: engineId });
  }
  return {
    schema_version: '2.0',
    id: `reuse-${optionId}`,
    input: contentHash(before),
    variant: optionId,
    status: record.verified ? 'verified' : 'rejected',
    blocks: [],
    loose,
    unplaced,
    findings: record.findings.map((d) => ({ code: d.code, severity: d.severity, message: d.message, entity_references: d.entityReferences })),
    metrics: Object.fromEntries(Object.entries(record.metrics).filter((kv): kv is [string, number] => typeof kv[1] === 'number' && Number.isFinite(kv[1]))),
  };
}

/** The limit a critical relationship holds its parts to, as a reader says it. */
function limitOf(c: PlacementPlan['critical'][number]): string | undefined {
  if (c.max_mm !== undefined) return `within ${c.max_mm} mm`;
  if (c.min_mm !== undefined) return `at least ${c.min_mm} mm apart`;
  if (c.max_area_mm2 !== undefined) return `loop at most ${c.max_area_mm2} mm2`;
  if (c.order?.length) return `in the order ${c.order.join(' -> ')}`;
  return undefined;
}

function docPlan(plan: PlacementPlan, source: 'model' | 'rules'): PlacementDocInput['plan'] {
  const regions = new Map(plan.regions.map((r) => [r.id, r]));
  return {
    source,
    blocks: plan.subsystems.map((s) => {
      const r = s.region ? regions.get(s.region) : undefined;
      return {
        id: s.id,
        members: s.members,
        anchor: s.anchor,
        region: r ? { id: r.id, x: r.x, y: r.y, w: r.w, h: r.h } : null,
        ...(s.flow ? { flow: s.flow } : {}),
      };
    }),
    phases: plan.phases.map((p) => ({ kind: p.kind, parts: p.parts, ...(p.note ? { note: p.note } : {}) })),
    rationale: plan.notes,
  };
}

/**
 * The intent findings that bear on each kind of critical relationship. A
 * relationship between parts takes a finding only about its own parts; one
 * about a single part (a radio module, a sensitive input) takes any finding
 * that names that part.
 */
const RELATION_CODES: Record<string, { codes: string[]; aboutOnePart?: boolean }> = {
  'supply-decoupling': { codes: ['intent.relative.attached'] },
  bootstrap: { codes: ['intent.relative.attached'] },
  config: { codes: ['intent.relative.attached'] },
  crystal: { codes: ['intent.relative.attached', 'intent.emc.edge-distance'] },
  'hot-loop': { codes: ['intent.emc.hot-loop', 'intent.relative.chain.'] },
  'output-chain': { codes: ['intent.relative.chain.'] },
  channel: { codes: ['intent.emc.channel', 'intent.relative.chain.'] },
  'rf-keepout': { codes: ['intent.rf.'], aboutOnePart: true },
  mechanical: { codes: ['intent.mechanical.'], aboutOnePart: true },
  thermal: { codes: ['intent.thermal.'], aboutOnePart: true },
  sensitive: { codes: ['intent.emc.isolation'], aboutOnePart: true },
  aggressor: { codes: ['intent.emc.isolation'], aboutOnePart: true },
};

/**
 * The plan's critical relationships, each with what the selected candidate's
 * intent checks found about it once there is one.
 */
function docCritical(plan: PlacementPlan, found?: Diagnostic[]): PlacementDocCritical[] {
  return plan.critical.map((c) => {
    const limit = limitOf(c);
    const rule = RELATION_CODES[c.class] ?? { codes: ['intent.'] };
    const hits = (found ?? []).filter(
      (d) =>
        rule.codes.some((code) => d.code.startsWith(code)) &&
        d.entityReferences.length > 0 &&
        (rule.aboutOnePart ? d.entityReferences.some((r) => c.refs.includes(r)) : d.entityReferences.every((r) => c.refs.includes(r))),
    );
    const result = found === undefined ? undefined : hits.length ? hits.map((d) => `${d.severity}: ${d.message}`).join('; ') : 'no violation found';
    return { kind: c.class, refs: c.refs, ...(limit ? { limit } : {}), ...(result ? { result } : {}), ...(c.why ? { rationale: c.why } : {}) };
  });
}

const mm = (nm: number) => (nm / 1e6).toFixed(1);

function optionsMarkdown(run: ReuseRun, ranked: Map<string, { rank: number; reason: string }>): string {
  const lines: string[] = [];
  lines.push('# Placement options', '');
  lines.push(`Reference matched ${(run.match.coverage * 100).toFixed(0)} % of the parts; the plan came from the ${run.planSource}.`, '');
  lines.push('| Option | What it did | Legal | Unplaced | HPWL | Intent | Score | Rank |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const v of run.screened) {
    if (v.sameAs) continue;
    const r = ranked.get(`placer-reuse-${v.id}`);
    const m = v.metrics;
    lines.push(`| ${v.id} | ${v.note} | ${m.legal ? 'yes' : 'no'} | ${m.unplaced} | ${mm(m.hpwlNm)} mm | ${m.intentHard} hard | ${v.score.toFixed(1)} | ${r ? r.rank : v.kept ? '-' : 'not materialised'} |`);
  }
  const same = run.screened.filter((v) => v.sameAs);
  if (same.length) lines.push('', `Identical placements, kept once: ${same.map((v) => `${v.id} = ${v.sameAs}`).join(', ')}.`);
  if (run.place) {
    lines.push('', '## After materialising', '');
    lines.push('| Option | Gates | DRC | Critical nets | Routability | Why |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const c of (run.ranking ?? run.place.ranking).candidates) {
      const cand = run.place.candidates.find((x) => x.engineId === c.id);
      const drc = cand?.verify.metrics.drc_critical_count;
      const completion = c.metrics?.routability_completion;
      const cr = run.criticalRoutes.get(c.id);
      const critical = cr
        ? cr.unavailable
          ? 'router unavailable'
          : `${cr.nets.length - cr.unrouted.length}/${cr.nets.length} routed, ${(Object.values(cr.lengthNm).reduce((a, b) => a + b, 0) / 1e6).toFixed(0)} mm, ${cr.drcCritical} DRC`
        : 'not routed';
      lines.push(`| ${c.id.replace('placer-reuse-', '')} | ${cand ? (cand.verify.gates.placement.passed ? 'pass' : 'fail') : '-'} | ${drc === undefined ? '-' : `${drc} critical`} | ${critical} | ${completion === undefined ? 'not probed' : `${(completion * 100).toFixed(0)} %`} | ${c.reason} |`);
    }
  }
  return lines.join('\n') + '\n';
}

export async function pcbReuse(opts: PcbReuseOptions): Promise<PcbReuseResult> {
  const log = opts.log ?? (() => {});
  const provider = opts.provider ?? null;
  const rel = (p: string) => path.relative(opts.repoRoot, p);
  // The board as it was before anything is applied, as the layout input of RFC
  // 11 Section 6.9: every option's placement diff is taken against it. Its
  // parts are owned by the import, so moving one needs approval (RFC 12
  // Section 9.5); --apply is that approval.
  const projectId = path.basename(opts.boardPath, '.kicad_pcb');
  const before: LayoutInput = importKicadBoard(await readFile(opts.boardPath, 'utf8'), { projectId, path: rel(opts.boardPath) });
  const title = `pcb reuse of ${rel(opts.boardPath)} against ${rel(opts.referencePath)}`;
  const docPath = path.join(opts.runDir, 'placement.md');
  const run = await reuseRun({
    ...opts,
    onPlan: async (plan, source) => {
      await mkdir(opts.runDir, { recursive: true });
      const doc: PlacementDocInput = {
        title,
        input: before,
        fabricationProfile: opts.profile ?? "the board project's",
        plan: docPlan(plan, source),
        critical: docCritical(plan),
        candidates: null,
        changes: null,
        remains: { unplaced: [], held: [], unknown: [], deviations: [], lossy: before.board.lossy ?? [] },
      };
      await writeFile(docPath, placementMarkdown(doc), 'utf8');
      log(`reuse: plan validated; ${rel(docPath)} written`);
    },
    ...(provider
      ? {
          planner: async (input) => {
            const outcome = await planPlacement({ ...input, provider, log });
            return { plan: outcome.plan, fromModel: outcome.fromModel, reason: outcome.reason, problems: outcome.problems };
          },
        }
      : {}),
  });
  const finalRanking = run.ranking ?? run.place?.ranking ?? null;
  const ranked = new Map((finalRanking?.candidates ?? []).map((c) => [c.id, { rank: c.rank, reason: c.reason }]));
  const selected = finalRanking?.selected ?? null;

  const options: PcbReuseResult['options'] = [];
  const texts = new Map<string, string>();
  const lossy = new Set(before.board.lossy ?? []);
  for (const cand of run.place?.candidates ?? []) {
    const id = cand.engineId.replace('placer-reuse-', '');
    const dir = path.join(opts.runDir, 'variants', id);
    await mkdir(dir, { recursive: true });
    await writeBoardRender(dir, cand.design, cand.verify.diagnostics, log);
    const board = path.join(dir, 'board.kicad_pcb');
    await copyFile(cand.pcbPath, board);
    // The option as an RFC 11 candidate against the board (Section 6.10), and
    // what it changes there (Section 6.11): a candidate is an engine's work, so
    // moving a part the import owns needs approval.
    const after = importKicadBoard(await readFile(board, 'utf8'), { projectId, path: rel(board) });
    for (const n of after.board.lossy ?? []) lossy.add(n);
    const scoredMetrics = finalRanking?.candidates.find((c) => c.id === cand.engineId)?.metrics ?? {};
    const candidate = candidateOf(id, cand.engineId, before, after, {
      verified: cand.verify.gates.preflight.passed && cand.verify.gates.placement.passed,
      findings: cand.verify.diagnostics,
      metrics: scoredMetrics,
    });
    await writeFile(path.join(dir, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n', 'utf8');
    const diff = placementDiff(before, { candidate, blockLayouts: [] });
    const text = renderDiffText(diff, { before });
    await writeFile(path.join(dir, 'placement-diff.json'), JSON.stringify(diff, null, 2) + '\n', 'utf8');
    await writeFile(path.join(dir, 'placement-diff.txt'), text, 'utf8');
    texts.set(cand.engineId, text);
    options.push({ id, engineId: cand.engineId, dir, rank: ranked.get(cand.engineId)?.rank ?? null, selected: cand.engineId === selected, diff });
  }
  await writeFile(path.join(opts.runDir, 'options.md'), optionsMarkdown(run, ranked), 'utf8');

  // placement.md, from the run's records, replacing the one written at plan time.
  const chosen = run.place?.candidates.find((c) => c.engineId === selected);
  const chosenOption = options.find((o) => o.selected);
  const refOf = new Map((chosen?.design.components ?? []).map((c) => [c.id, c.reference]));
  const unplacedIds = run.place?.invocations.find((i) => i.engineId === selected)?.result?.unplacedComponentIds ?? [];
  const doc: PlacementDocInput = {
    title,
    input: before,
    fabricationProfile: chosen?.verify.profile.id ?? opts.profile ?? "the board project's",
    plan: docPlan(run.plan, run.planSource),
    critical: docCritical(run.plan, chosen?.verify.diagnostics ?? []),
    candidates: (finalRanking?.candidates ?? []).map((c) => ({
      id: c.id.replace('placer-reuse-', ''),
      rank: c.rank,
      selected: c.id === selected,
      reason: c.reason,
      metrics: c.metrics,
    })),
    changes: chosenOption ? { diff: chosenOption.diff, text: texts.get(chosenOption.engineId)! } : null,
    remains: {
      unplaced: unplacedIds.map((id) => refOf.get(id) ?? id),
      held: run.place?.outcome.status === 'HOLD' ? [run.place.outcome.summary] : [],
      unknown: [],
      deviations: [],
      lossy: [...lossy].sort(),
    },
  };
  const placementDoc = placementMarkdown(doc);
  await writeFile(docPath, placementDoc, 'utf8');

  let applied: string | null = null;
  if (opts.apply) {
    const wanted = opts.option ? `placer-reuse-${opts.option}` : selected;
    const cand = run.place?.candidates.find((c) => c.engineId === wanted);
    if (cand && run.place && (run.place.outcome.status === 'PASS' || run.place.outcome.status === 'PARTIAL')) {
      await copyFile(cand.pcbPath, opts.boardPath);
      applied = cand.engineId.replace('placer-reuse-', '');
    }
  }

  const legal = run.screened.filter((v) => v.metrics.legal).length;
  const base = run.place?.outcome;
  const outcome: Outcome<Diagnostic> = base
    ? {
        ...base,
        summary: `${base.summary}; ${legal}/${run.screened.length} variant(s) legal before materialising`,
        detail: [
          `matched ${(run.match.coverage * 100).toFixed(0)} % of the parts against the reference (${Object.entries(run.match.byTier).filter(([, n]) => n > 0).map(([t, n]) => `T${t}:${n}`).join(' ')})`,
          `plan from the ${run.planSource}: ${run.plan.subsystems.length} subsystem(s), ${run.plan.critical.length} critical relationship(s), ${run.plan.phases.length} phase(s)`,
          ...(applied ? [`applied option ${applied}`] : []),
          ...base.detail,
        ],
      }
    : { status: 'PARTIAL', summary: 'no variant was worth materialising', detail: run.screened.map((v) => `${v.id}: ${v.metrics.legal ? 'legal' : 'illegal'}, score ${v.score.toFixed(1)}`), diagnostics: [] };
  return { outcome, run, options, applied, placementDoc };
}
