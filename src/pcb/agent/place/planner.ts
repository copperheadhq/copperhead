/**
 * The model planner (add-reuse-placer, RFC 14 §9): the one place a model is
 * allowed to influence a placement, and it never writes a coordinate. It reads
 * what changed against the reference board and answers with a plan — which
 * parts belong together, roughly where each group sits, which relationships
 * are critical, and the order to build the board in. The deterministic packer
 * turns that into positions.
 *
 * Three rules make this safe to run unattended:
 *
 * - **the plan is validated before it is used.** A plan that names a part that
 *   is not on the board, puts a part in two subsystems, or leaves a movable
 *   part out of every phase is refused, and the rules' plan runs instead.
 * - **the model cannot raise a constraint's severity.** Relationships it adds
 *   arrive as advisory with capped confidence; a rule or the user's intent
 *   always outranks them.
 * - **every call is recorded by the hash of its input**, so a run can be
 *   replayed offline and two runs of the same board give the same plan.
 */
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Msg, Provider } from '../../../agent/types.js';
import { sha256 } from '../../ir/canonical.js';
import type { PcbDesign } from '../../ir/types.js';
import type { Classification, CriticalClass } from '../../intent/critical.js';
import type { Partition } from '../../intent/subsystems.js';
import { PHASE_ORDER } from '../../intent/critical.js';
import { bbox } from '../../ir/geometry.js';
import { defaultPlan, validatePlan, PLAN_SCHEMA, type PlacementPlan, type PlanCritical, type PlanFixed, type PlanPhase, type PlanRegion, type PlanSubsystem } from '../../engines/reuse/plan.js';
import { deltaTable, type Delta } from '../../engines/reuse/delta.js';

export const PLAN_PROMPT_VERSION = 'reuse-plan/1';

/** The prompt for a board with no reference to adapt: the intent is written from the netlist alone. */
export const INTENT_PROMPT_VERSION = 'layout-intent/1';

/** What the model may not exceed, whatever it asks for. */
export const MODEL_CONFIDENCE_CAP = 0.6;

export interface PlanRequest {
  design: PcbDesign;
  movableRefs: string[];
  partitions: Partition[];
  classification: Classification;
  /** What changed against the reference board; absent when there is no reference. */
  delta?: Delta;
  /** The reference board's name, for the prompt; absent when there is no reference. */
  referenceName?: string;
  /** Where the transfer would put each part, by refdes, in nanometres. */
  targets?: Map<string, { x: number; y: number }>;
  provider?: Provider | null;
  /** Directory holding request/response records, for replay. */
  recordDir?: string;
  maxTokens?: number;
  log?: (line: string) => void;
}

export interface PlanOutcome {
  plan: PlacementPlan;
  fromModel: boolean;
  /** Why the model's plan was or was not used. */
  reason: string;
  /** The hash its record is filed under. */
  inputHash: string;
  /** Validation problems with the model's plan, when there were any. */
  problems: string[];
}

const mmToNm = (v: number) => Math.round(v * 1e6);

/** The board as the model sees it: never the whole file, only what a plan needs. */
export function planPrompt(req: PlanRequest): { system: string; user: string; input: unknown } {
  const b = bbox(req.design.board.outline);
  const refOf = new Map(req.design.components.map((c) => [c.id, c.reference]));
  const parts = req.design.components.map((c) => ({
    ref: c.reference,
    value: c.value,
    footprint: c.footprint.libId.split(':').pop() ?? c.footprint.libId,
    pads: c.pads.length,
    side: c.attributes.side,
    fixed: c.attributes.locked || !req.movableRefs.includes(c.reference),
    nets: [...new Set(c.pads.map((p) => p.netId).filter((n): n is string => !!n))].map((n) => req.design.nets.find((x) => x.id === n)?.name ?? n).slice(0, 8),
    ...(req.targets?.get(c.reference) ? { reference_at_mm: [Number((req.targets.get(c.reference)!.x / 1e6).toFixed(2)), Number((req.targets.get(c.reference)!.y / 1e6).toFixed(2))] } : {}),
  }));
  const fresh = !req.delta;
  const input = {
    prompt: fresh ? INTENT_PROMPT_VERSION : PLAN_PROMPT_VERSION,
    outline_mm: { x: Number((b.minX / 1e6).toFixed(2)), y: Number((b.minY / 1e6).toFixed(2)), w: Number(((b.maxX - b.minX) / 1e6).toFixed(2)), h: Number(((b.maxY - b.minY) / 1e6).toFixed(2)) },
    ...(req.referenceName ? { reference: req.referenceName } : {}),
    parts,
    partitions: req.partitions.map((p) => ({ key: p.key, subsystems: p.subsystems.map((s) => ({ id: s.id, anchor: s.anchor ? refOf.get(s.anchor) : null, members: s.members.map((m) => refOf.get(m)) })) })),
    critical_from_rules: req.classification.relations.map((r) => ({ class: r.class, refs: r.refs, ...(r.order ? { order: r.order } : {}), ...(r.against ? { against: r.against } : {}), why: r.cite ?? 'rule' })),
    ...(req.delta ? { delta: deltaTable(req.delta) } : {}),
    phases: PHASE_ORDER,
  };
  // With no reference board there is nothing to adapt, so the model is asked
  // for the intent itself: what belongs with what, which edge each connector
  // faces, which IC is the board's main one. The rules below are the ones a
  // hardware engineer applies in that order, and `placer-heuristic` is what
  // turns the answer into coordinates.
  const system = fresh
    ? [
        'You write the placement intent for a printed circuit board, the way a hardware engineer would before moving anything.',
        'You never give coordinates for individual parts: a deterministic engine computes those from your intent.',
        'Work in this order: connectors and mechanical parts belong on a board edge facing off the board; parts that work together are one subsystem; each subsystem has one main IC; the board\'s own main IC sits in the middle and everything else works around it; a subsystem\'s passives cluster around its main IC, closest where the relationship is tightest (decoupling first).',
        'Name the subsystem an intent group would have: power, mcu, analog, rf, usb, audio — never "group1".',
        'Reply with ONLY a JSON object, no prose, no code fence.',
      ].join(' ')
    : [
        'You plan the placement of a printed circuit board by adapting a reference board, the way a hardware engineer would.',
        'You never give coordinates for individual parts: a deterministic packer computes those from your plan.',
        'You decide which parts belong together, roughly where each group sits, which relationships are electrically critical, and the order the board is built in.',
        'The engineering order is: mechanical parts, then functional regions, then the main ICs, then the support parts their datasheets tie to them, then the current loops, then whatever separation demands, then the rest.',
        'Reply with ONLY a JSON object, no prose, no code fence.',
      ].join(' ');
  const user = [
    JSON.stringify(input),
    '',
    'Reply with this shape (millimetres; omit anything you have no opinion about):',
    '{"regions":[{"id":"power","x_mm":0,"y_mm":0,"w_mm":10,"h_mm":10,"why":"…"}],',
    '"subsystems":[{"id":"power","members":["U1","C1"],"anchor":"U1","region":"power"}],',
    '"fixed":[{"ref":"J1","edge":"south","why":"the USB cable reaches it from off the board"}],',
    '"orientation":[{"ref":"U1","rotation_deg":90,"why":"pins face the connector"}],',
    '"critical":[{"class":"supply-decoupling","refs":["C1","U1"],"max_mm":2,"why":"…"}],',
    '"phases":[{"kind":"mechanical","parts":["J1"]},{"kind":"anchors","parts":["U1"]}],',
    '"notes":["…"]}',
    '',
    'In "fixed", give an edge (north, south, west or east) for every connector, and nothing else: positions are not yours to give.',
    ...(fresh ? ['Every part belongs to exactly one subsystem, and every subsystem names the IC at its centre as its anchor.'] : []),
    `Every part that may move must appear in exactly one phase: ${req.movableRefs.join(', ')}.`,
    `Valid phase kinds: ${PHASE_ORDER.join(', ')}. Valid critical classes: supply-decoupling, bootstrap, config, crystal, hot-loop, output-chain, sensitive, channel, thermal, rf-keepout, mechanical, signal, low.`,
  ].join('\n');
  return { system, user, input };
}

interface RawPlan {
  regions?: { id?: string; x_mm?: number; y_mm?: number; w_mm?: number; h_mm?: number; why?: string }[];
  subsystems?: { id?: string; members?: string[]; anchor?: string | null; region?: string | null; flow?: string }[];
  fixed?: { ref?: string; x_mm?: number; y_mm?: number; rotation_deg?: number; edge?: string; why?: string }[];
  orientation?: { ref?: string; rotation_deg?: number; why?: string }[];
  critical?: { class?: string; refs?: string[]; pins?: string[]; order?: string[]; against?: string[]; kind?: string; max_mm?: number; min_mm?: number; max_area_mm2?: number; why?: string }[];
  phases?: { kind?: string; parts?: string[]; note?: string }[];
  notes?: string[];
}

const CLASSES = new Set(['mechanical', 'rf-keepout', 'supply-decoupling', 'bootstrap', 'config', 'crystal', 'hot-loop', 'output-chain', 'aggressor', 'sensitive', 'channel', 'thermal', 'signal', 'low']);

/** Turn the model's answer into a plan, keeping the rules' plan for everything it left out. */
export function planFromModel(raw: RawPlan, fallback: PlacementPlan): PlacementPlan {
  const regions: PlanRegion[] = (raw.regions ?? []).flatMap((r) => (r.id && typeof r.x_mm === 'number' && typeof r.y_mm === 'number' && typeof r.w_mm === 'number' && typeof r.h_mm === 'number'
    ? [{ id: r.id, x: mmToNm(r.x_mm), y: mmToNm(r.y_mm), w: mmToNm(r.w_mm), h: mmToNm(r.h_mm), ...(r.why ? { why: r.why } : {}) }]
    : []));
  const subsystems: PlanSubsystem[] = (raw.subsystems ?? []).flatMap((s) => (s.id && Array.isArray(s.members) && s.members.length
    ? [{ id: s.id, members: [...new Set(s.members.map(String))], anchor: s.anchor ? String(s.anchor) : null, region: s.region ? String(s.region) : null, ...(s.flow ? { flow: s.flow } : {}) }]
    : []));
  const orientation = (raw.orientation ?? []).flatMap((o) => (o.ref && typeof o.rotation_deg === 'number' ? [{ ref: String(o.ref), rotation_deg: o.rotation_deg, ...(o.why ? { why: o.why } : {}) }] : []));
  // A model may say which edge a connector faces — that is a decision about the
  // product, not a coordinate. Any position it also gave is dropped, and a part
  // the rules already fixed (locked in KiCad, fixed for the run) keeps theirs.
  const EDGES = new Set(['north', 'south', 'east', 'west']);
  const fixed: PlanFixed[] = (raw.fixed ?? []).flatMap((f) => (f.ref && f.edge && EDGES.has(String(f.edge)) && !fallback.fixed.some((x) => x.ref === String(f.ref))
    ? [{ ref: String(f.ref), edge: String(f.edge) as PlanFixed['edge'], why: `model: ${f.why ?? 'no reason given'}` }]
    : []));
  const critical: PlanCritical[] = (raw.critical ?? []).flatMap((c) => (c.class && CLASSES.has(c.class) && Array.isArray(c.refs) && c.refs.length
    ? [{
        class: c.class as CriticalClass,
        refs: c.refs.map(String),
        ...(c.pins ? { pins: c.pins.map(String) } : {}),
        ...(c.order ? { order: c.order.map(String) } : {}),
        ...(c.against ? { against: c.against.map(String) } : {}),
        ...(c.kind === 'switching' || c.kind === 'supply' || c.kind === 'output' ? { kind: c.kind } : {}),
        ...(typeof c.max_mm === 'number' ? { max_mm: c.max_mm } : {}),
        ...(typeof c.min_mm === 'number' ? { min_mm: c.min_mm } : {}),
        ...(typeof c.max_area_mm2 === 'number' ? { max_area_mm2: c.max_area_mm2 } : {}),
        why: `model: ${c.why ?? 'no reason given'}`,
      }]
    : []));
  const phases: PlanPhase[] = (raw.phases ?? []).flatMap((p) => (p.kind && PHASE_ORDER.includes(p.kind as PlanPhase['kind']) && Array.isArray(p.parts) && p.parts.length
    ? [{ kind: p.kind as PlanPhase['kind'], parts: [...new Set(p.parts.map(String))], ...(p.note ? { note: p.note } : {}) }]
    : []));
  return {
    schema: PLAN_SCHEMA,
    strategy: fallback.strategy,
    ...(fallback.reference ? { reference: fallback.reference } : {}),
    regions: regions.length ? regions : fallback.regions,
    subsystems: subsystems.length ? subsystems : fallback.subsystems,
    fixed: [...fallback.fixed, ...fixed],
    orientation: orientation.length ? orientation : fallback.orientation,
    // the rules' relationships always stand; the model may add to them, never replace them
    critical: [...fallback.critical, ...critical.filter((c) => !fallback.critical.some((f) => f.class === c.class && f.refs.join() === c.refs.join()))],
    phases: phases.length ? phases : fallback.phases,
    notes: [...(raw.notes ?? []).map(String), ...fallback.notes],
  };
}

/**
 * Plan with the model when there is one, and with the rules otherwise. A
 * recorded call is replayed rather than re-made, so the same board plans the
 * same way twice and a benchmark run can be repeated offline.
 */
export async function planPlacement(req: PlanRequest): Promise<PlanOutcome> {
  const log = req.log ?? (() => {});
  const partition = req.partitions[0];
  if (!partition) throw new Error('the board has no subsystem partition to plan with');
  const fallback = defaultPlan({
    design: req.design,
    movableRefs: req.movableRefs,
    partition,
    classification: req.classification,
    ...(req.targets ? { transferred: req.design.components.filter((c) => req.targets!.has(c.reference)).map((c) => ({ id: c.id, at: req.targets!.get(c.reference)!, rotation: c.rotation, side: c.attributes.side })) } : {}),
  });
  const { system, user, input } = planPrompt(req);
  // the prompt carries millimetres, which the IR's canonical hash refuses; the object is
  // built in a fixed order, so stringifying it is a stable key for replay
  const inputHash = sha256(JSON.stringify({ input, movable: req.movableRefs })).slice(0, 16);
  const recordPath = req.recordDir ? path.join(req.recordDir, `${inputHash}.json`) : null;

  let text: string | null = null;
  if (recordPath && existsSync(recordPath)) {
    text = (JSON.parse(await readFile(recordPath, 'utf8')) as { response?: string }).response ?? null;
    log(`plan: replayed the recorded answer for ${inputHash}`);
  } else if (req.provider) {
    const messages: Msg[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
    try {
      const turn = await req.provider.chat(messages, [], { maxTokens: req.maxTokens ?? 8000 });
      text = turn.text ?? null;
      if (recordPath) {
        await mkdir(path.dirname(recordPath), { recursive: true });
        await writeFile(recordPath, JSON.stringify({ prompt: PLAN_PROMPT_VERSION, inputHash, input, response: text }, null, 2), 'utf8');
      }
    } catch (e) {
      return { plan: fallback, fromModel: false, reason: `the planner call failed (${(e as Error).message}); the rules planned instead`, inputHash, problems: [] };
    }
  }
  if (!text) return { plan: fallback, fromModel: false, reason: 'no model configured; the rules planned', inputHash, problems: [] };

  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return { plan: fallback, fromModel: false, reason: 'the model\'s answer was not JSON; the rules planned instead', inputHash, problems: [] };
  let raw: RawPlan;
  try {
    raw = JSON.parse(m[0]) as RawPlan;
  } catch (e) {
    return { plan: fallback, fromModel: false, reason: `the model's JSON did not parse (${(e as Error).message}); the rules planned instead`, inputHash, problems: [] };
  }
  const plan = planFromModel(raw, fallback);
  const check = validatePlan(plan, req.design, req.movableRefs);
  for (const w of check.warnings) log(`plan: ${w}`);
  if (check.errors.length) {
    return { plan: fallback, fromModel: false, reason: `the model's plan did not validate (${check.errors.length} problem(s)); the rules planned instead`, inputHash, problems: check.errors };
  }
  return { plan, fromModel: true, reason: `the model planned ${plan.subsystems.length} subsystem(s) and ${plan.phases.length} phase(s)`, inputHash, problems: [] };
}
