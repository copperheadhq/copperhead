/**
 * Repair planner (implementation spec §9.2): one action from the catalog per
 * cycle, chosen over the normalized diagnostics only. With a provider, one
 * tool-less JSON-validated model call; without one, a deterministic policy.
 * A hard-constraint relaxation is never an option: only `request-user-action`.
 */
import type { Provider, Msg } from '../../../agent/types.js';
import type { Diagnostic } from '../../verify/diagnostic.js';
import type { Ranking } from '../../verify/scoring.js';
import { CATALOG, catalogEntry, estimate, type RepairAction } from './catalog.js';

export interface PlanInput {
  diagnostics: Diagnostic[];
  ranking: Ranking | null;
  budgetRemaining: { engineSeconds: number; wallSeconds: number };
  last: { routingSeconds: number; placementSeconds: number };
  history: RepairAction[];
  routers: string[];
  provider?: Provider | null;
}

export interface Plan {
  action: RepairAction | null;
  /** Why no action (budget, nothing left to try, or a hold). */
  reason: string;
  fromModel: boolean;
}

function counts(diags: Diagnostic[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of diags) if (d.severity === 'error' || d.code === 'conn.unrouted') out[d.code] = (out[d.code] ?? 0) + 1;
  return out;
}

/** The deterministic policy: cheapest plausible action not yet tried for the dominant error family. */
export function deterministicPlan(input: PlanInput): Plan {
  const c = counts(input.diagnostics);
  const tried = new Set(input.history.map((h) => `${h.type}:${JSON.stringify(h.parameters)}`));
  const propose = (a: RepairAction): Plan | null => {
    if (tried.has(`${a.type}:${JSON.stringify(a.parameters)}`)) return null;
    const e = estimate(a, input.last);
    if (e.engineSeconds > input.budgetRemaining.engineSeconds || e.wallSeconds > input.budgetRemaining.wallSeconds) return null;
    return { action: a, reason: a.reason, fromModel: false };
  };
  const unrouted = input.diagnostics.filter((d) => d.code === 'conn.unrouted').flatMap((d) => d.entityReferences.slice(0, 1));
  const shorts = input.diagnostics.filter((d) => d.code === 'conn.short').flatMap((d) => d.entityReferences);
  const drc = Object.keys(c).filter((k) => k.startsWith('drc.'));
  const intentHard = Object.keys(c).filter((k) => k.startsWith('intent.') && !k.startsWith('intent.routing.'));
  const routers = input.routers.filter((r) => !input.history.some((h) => h.type === 'select-router' && h.parameters.routerId === r));
  const candidates: (RepairAction | null)[] = [];
  if (shorts.length) candidates.push({ type: 'rip-up-nets', reason: `copper joins ${[...new Set(shorts)].slice(0, 3).join(', ')}: rip those nets up and route them again`, parameters: { nets: [...new Set(shorts)] } });
  if (c['intent.routing.width']) candidates.push({ type: 'rip-up-nets', reason: 'a net is narrower than its required width: rip it up and route it at the class width', parameters: { nets: input.diagnostics.filter((d) => d.code === 'intent.routing.width').flatMap((d) => d.entityReferences) } });
  if (unrouted.length) {
    // cheapest first: the copper so far stays, only what is owed is routed (a first pass the budget cut short is finished this way)
    candidates.push({ type: 'continue-routing', reason: `${unrouted.length} connection(s) owed: keep the copper and route those nets`, parameters: { nets: [...new Set(unrouted)] } });
    candidates.push({ type: 'tune-router', reason: `${unrouted.length} connection(s) owed: more passes`, parameters: { passes: 40 } });
    if (routers[0]) candidates.push({ type: 'select-router', reason: `${unrouted.length} connection(s) owed: try ${routers[0]}`, parameters: { routerId: routers[0] } });
    candidates.push({ type: 'change-net-priority', reason: 'route the owed nets first', parameters: { nets: [...new Set(unrouted)], first: true } });
  }
  if (drc.length && !shorts.length) {
    if (routers[0]) candidates.push({ type: 'select-router', reason: `${drc.join(', ')}: try ${routers[0]}`, parameters: { routerId: routers[0] } });
    candidates.push({ type: 'tune-router', reason: `${drc.join(', ')}: more passes`, parameters: { passes: 40 } });
  }
  if (input.ranking && input.ranking.candidates.filter((x) => x.eligible).length > 1) candidates.push({ type: 'use-ranked-candidate', reason: 'another eligible candidate exists', parameters: { rank: 2 } });
  for (const a of candidates) {
    const p = a && propose(a);
    if (p) return p;
  }
  if (intentHard.length) return { action: { type: 'request-user-action', reason: `${intentHard.join(', ')} cannot be met by the placers or the rule stages here`, parameters: { question: `The hard constraint(s) ${intentHard.join(', ')} are violated by every candidate. Relax them, move the parts by hand, or change the intent.` } }, reason: 'hard intent violated by every candidate', fromModel: false };
  return { action: null, reason: candidates.length ? 'every plausible action was tried or exceeds the budget' : 'nothing in the catalog answers the remaining findings', fromModel: false };
}

export async function planRepair(input: PlanInput): Promise<Plan> {
  if (!input.provider) return deterministicPlan(input);
  const fallback = deterministicPlan(input);
  const c = counts(input.diagnostics);
  const system = 'You pick ONE repair action for an automated PCB layout loop from a fixed catalog. You may not relax a hard constraint; if nothing in the catalog can fix a hard intent violation, choose request-user-action. Reply with ONLY a JSON object, no prose.';
  const user = `Findings (error-severity, with counts): ${JSON.stringify(c)}\nSample: ${input.diagnostics.filter((d) => d.severity === 'error').slice(0, 8).map((d) => `${d.code} [${d.entityReferences.slice(0, 3).join(',')}] ${d.message}`).join(' | ')}\nRouters available: ${input.routers.join(', ')}\nBudget left: ${Math.round(input.budgetRemaining.engineSeconds)} engine s, ${Math.round(input.budgetRemaining.wallSeconds)} wall s. Last routing run ${Math.round(input.last.routingSeconds)} s, last placement ${Math.round(input.last.placementSeconds)} s.\nAlready tried: ${input.history.map((h) => `${h.type} ${JSON.stringify(h.parameters)}`).join('; ') || 'nothing'}\nCatalog: ${CATALOG.map((e) => `${e.type} (${e.summary}; parameters ${JSON.stringify(e.parameters)}; reruns ${e.reruns})`).join('\n')}\nDeterministic suggestion: ${fallback.action ? `${fallback.action.type} ${JSON.stringify(fallback.action.parameters)}` : 'none'}\nReply: {"type": "<catalog type>", "reason": "<one sentence>", "parameters": {...}}`;
  const messages: Msg[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
  try {
    const turn = await input.provider.chat(messages, []);
    const m = /\{[\s\S]*\}/.exec(turn.text ?? '');
    if (!m) return { ...fallback, reason: `model answer was not JSON; ${fallback.reason}` };
    const v = JSON.parse(m[0]) as { type?: string; reason?: string; parameters?: Record<string, unknown> };
    const entry = v.type ? catalogEntry(v.type as RepairAction['type']) : undefined;
    if (!entry) return { ...fallback, reason: `model chose "${v.type}", not in the catalog; ${fallback.reason}` };
    const params: RepairAction['parameters'] = {};
    for (const [k, t] of Object.entries(entry.parameters)) {
      const val = v.parameters?.[k];
      if (t === 'string[]' && Array.isArray(val)) params[k] = val.map(String);
      else if (t === 'number' && typeof val === 'number') params[k] = val;
      else if (t === 'boolean' && typeof val === 'boolean') params[k] = val;
      else if (t === 'string' && typeof val === 'string') params[k] = val;
    }
    if (entry.type === 'select-router' && (!params.routerId || !input.routers.includes(String(params.routerId)))) return { ...fallback, reason: `model named an unknown router; ${fallback.reason}` };
    const action: RepairAction = { type: entry.type, reason: typeof v.reason === 'string' ? v.reason : entry.summary, parameters: params };
    const e = estimate(action, input.last);
    if (e.engineSeconds > input.budgetRemaining.engineSeconds || e.wallSeconds > input.budgetRemaining.wallSeconds) return { ...fallback, reason: `model's action does not fit the budget; ${fallback.reason}` };
    if (input.history.some((h) => h.type === action.type && JSON.stringify(h.parameters) === JSON.stringify(action.parameters))) return { ...fallback, reason: `model repeated a tried action; ${fallback.reason}` };
    return { action, reason: action.reason, fromModel: true };
  } catch (e) {
    return { ...fallback, reason: `planner call failed (${(e as Error).message}); ${fallback.reason}` };
  }
}
