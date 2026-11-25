/**
 * `copperhead pcb plan`: write the placement plan for a board — which parts are
 * one subsystem, which IC is at each subsystem's centre, which edge each
 * connector faces, which relationships are critical, and the order the board
 * is built in.
 *
 * This is the only step a model takes part in, and it never produces a
 * coordinate: the plan is data, and `copperhead pcb place --plan` turns it
 * into positions deterministically. That split is what keeps `pcb place`
 * LLM-free and network-free while still letting a model decide the things
 * rules read badly — what a subsystem is for, which connector faces the user.
 *
 * With no `--model` the rules write the same shape from the board's own
 * partitions and the critical-relationship classifier, so the command works
 * offline and the placer has an intent either way.
 */
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { importBoard } from '../pcb/ir/kicad/import.js';
import { partitions } from '../pcb/intent/subsystems.js';
import { classifyCritical } from '../pcb/intent/critical.js';
import { validatePlan, type PlacementPlan } from '../pcb/engines/reuse/plan.js';
import { planPlacement } from '../pcb/agent/place/planner.js';
import type { Provider } from '../agent/types.js';

export interface PcbPlanOptions {
  repoRoot: string;
  boardPath: string;
  /** Where the plan is written (default: beside the board, `<board>.plan.json`). */
  outPath?: string;
  /** Refdes the placement may move; default every part not locked in KiCad. */
  movableReferences?: string[];
  /** The model that writes the plan; without one the rules write it. */
  provider?: Provider | null;
  /** Directory holding request/response records, so a run replays offline. */
  recordDir?: string;
  log?: (line: string) => void;
}

export interface PcbPlanResult {
  plan: PlacementPlan;
  outPath: string;
  /** 'model' or 'rules'. */
  source: 'model' | 'rules';
  reason: string;
  warnings: string[];
  summary: string;
}

export async function pcbPlan(opts: PcbPlanOptions): Promise<PcbPlanResult> {
  const log = opts.log ?? (() => {});
  const projectPath = opts.boardPath.replace(/\.kicad_pcb$/, '.kicad_pro');
  const { design, warnings } = importBoard({
    boardText: await readFile(opts.boardPath, 'utf8'),
    boardPath: path.relative(opts.repoRoot, opts.boardPath),
    ...(existsSync(projectPath) ? { projectText: await readFile(projectPath, 'utf8'), projectPath: path.relative(opts.repoRoot, projectPath) } : {}),
  });
  for (const w of warnings) log(`import: ${w}`);

  const wanted = opts.movableReferences ? new Set(opts.movableReferences) : null;
  const movableRefs = design.components.filter((c) => !c.attributes.locked && (!wanted || wanted.has(c.reference))).map((c) => c.reference);
  const all = partitions(design);
  if (!all.length) throw new Error('the board has no subsystem partition to plan with: it needs nets, or a docs/SUBSYSTEMS.md');
  const classification = classifyCritical(design);
  log(`plan: ${movableRefs.length} movable part(s), ${all.length} partition(s) (first: ${all[0]!.key}), ${classification.relations.length} critical relationship(s) from the rules`);

  const outcome = await planPlacement({
    design,
    movableRefs,
    partitions: all,
    classification,
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.recordDir ? { recordDir: opts.recordDir } : {}),
    log,
  });
  const check = validatePlan(outcome.plan, design, movableRefs);
  for (const w of check.warnings) log(`plan: ${w}`);

  const outPath = opts.outPath ?? `${opts.boardPath.replace(/\.kicad_pcb$/, '')}.plan.json`;
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(outcome.plan, null, 2), 'utf8');

  const anchors = outcome.plan.subsystems.filter((s) => s.anchor).length;
  const edges = outcome.plan.fixed.filter((f) => f.edge).length;
  return {
    plan: outcome.plan,
    outPath,
    source: outcome.fromModel ? 'model' : 'rules',
    reason: outcome.reason,
    warnings: check.warnings,
    summary: `${outcome.plan.subsystems.length} subsystem(s), ${anchors} with an anchor IC, ${edges} connector edge(s), ${outcome.plan.critical.length} critical relationship(s), ${outcome.plan.phases.length} phase(s)`,
  };
}
