/**
 * Intent compiler (RFC 11 §7.4, implementation spec §7.4). Seven steps; only
 * steps 1 and 3 call a model, through the existing provider abstraction with
 * no tools, and every model answer is validated before it touches the
 * registry. Steps 2, 4 to 7 are deterministic. Output: registry entries plus
 * `intent-report.md`.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Provider, Msg } from '../../../agent/types.js';
import type { Constraint } from '../../../memory/constraints.js';
import type { PcbDesign } from '../../ir/types.js';
import { deriveBlocks, blocksToConstraints, type Block } from '../../intent/blocks.js';
import { parseIntent, intentToRegistry, type ParsedIntent } from '../../intent/language.js';
import { ecadConstraints, mergeEcad, ECAD_SOURCE } from '../../intent/ecad.js';

export interface CompileInput {
  repoRoot: string;
  design: PcbDesign;
  /** The explicit intent file's text, when one exists. */
  intentText?: string | null;
  subsystemsMd?: string | null;
  schematicIntent?: { parts: { ref: string; group?: string }[] } | null;
  bomMd?: string | null;
  /** Cached datasheet texts by part reference, for step 3's citations. */
  datasheets?: Record<string, string>;
  /** Existing registry (hand entries survive; compiler and ecad entries are replaced). */
  registry?: Record<string, Constraint>;
  provider?: Provider | null;
  runDir?: string;
}

export interface CompileResult {
  registry: Record<string, Constraint>;
  blocks: Block[];
  roles: Record<string, string[]>;
  holds: string[];
  report: string;
  /** Model-proposed rules that were rejected, with why. */
  rejected: { rule: string; reason: string }[];
}

const AUTHORITY: Record<string, number> = { user: 4, intent: 4, [ECAD_SOURCE]: 3, datasheet: 2, 'intent-compiler': 1, blocks: 1, physics: 2 };

function authority(c: Constraint): number {
  // the source's family is the part before the first colon: 'intent-compiler:datasheet U1 p.12' -> 'intent-compiler'
  const s = (c.approvedBy ?? c.source ?? '').split(':')[0]!;
  return AUTHORITY[s] ?? 1;
}

async function chatJson<T>(provider: Provider, system: string, user: string, validate: (v: unknown) => T | null): Promise<{ value: T | null; raw: string }> {
  const messages: Msg[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const turn = await provider.chat(messages, []);
  const text = turn.text ?? '';
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return { value: null, raw: text };
  try {
    return { value: validate(JSON.parse(m[0])), raw: text };
  } catch {
    return { value: null, raw: text };
  }
}

const ROLES = ['mcu', 'regulator', 'decoupling', 'bulk-cap', 'crystal', 'load-cap', 'connector', 'esd', 'led', 'pull-up', 'pull-down', 'sense', 'switch', 'inductor', 'diode', 'mounting', 'test-point', 'sensor', 'driver', 'transceiver', 'other'];

/** Step 1: roles per part and a block proposal, validated against the design's refdes. */
async function stepRoles(input: CompileInput, blocks: Block[]): Promise<{ roles: Record<string, string[]>; note: string }> {
  const refs = input.design.components.map((c) => c.reference);
  if (!input.provider) return { roles: {}, note: 'no model: roles left to the deterministic block derivation' };
  const parts = input.design.components.map((c) => `${c.reference}: ${c.value} (${c.footprint.libId}, ${c.pads.length} pads)`).join('\n');
  const system = 'You classify PCB components for a layout harness. Reply with ONLY a JSON object, no prose.';
  const user = `Parts on the board:\n${parts}\n\nSubsystems (blocks) derived deterministically: ${blocks.map((b) => `${b.id}[${b.members.map((id) => refs[input.design.components.findIndex((c) => c.id === id)]).join(',')}]`).join(' ')}\n\nAssign each refdes one or more roles from: ${ROLES.join(', ')}.\nReply: {"roles": {"<ref>": ["<role>", ...], ...}}. Use only refdes listed above.`;
  const { value, raw } = await chatJson(input.provider, system, user, (v) => {
    const o = (v as { roles?: Record<string, unknown> })?.roles;
    if (!o || typeof o !== 'object') return null;
    const out: Record<string, string[]> = {};
    for (const [ref, rs] of Object.entries(o)) if (refs.includes(ref) && Array.isArray(rs)) out[ref] = rs.map(String).filter((r) => ROLES.includes(r));
    return out;
  });
  if (!value) return { roles: {}, note: `step 1: the model's answer was not the JSON asked for (${raw.slice(0, 80).replace(/\n/g, ' ')}…); roles left empty` };
  return { roles: value, note: `step 1: ${Object.keys(value).length} part(s) given roles by the model` };
}

/** Step 3: candidate rules as intent YAML, each citing a fact-base entry; validated through the language parser. */
async function stepDerive(input: CompileInput, roles: Record<string, string[]>): Promise<{ entries: ParsedIntent['entries']; rejected: { rule: string; reason: string }[]; note: string }> {
  if (!input.provider) return { entries: [], rejected: [], note: 'no model: no derived rules' };
  const facts: string[] = [];
  if (input.bomMd) facts.push(`BOM.md:\n${input.bomMd.slice(0, 4000)}`);
  for (const [ref, text] of Object.entries(input.datasheets ?? {})) facts.push(`datasheet ${ref}:\n${text.slice(0, 3000)}`);
  if (!facts.length) return { entries: [], rejected: [], note: 'step 3: no fact base (no BOM.md, no cached datasheets); no rules derived' };
  const system = 'You derive PCB placement rules for a layout harness from the facts given. Every rule must cite the fact it comes from. Reply with ONLY a JSON object, no prose.';
  const user = `Roles: ${JSON.stringify(roles)}\n\nFacts:\n${facts.join('\n\n')}\n\nPropose placement rules in this intent YAML language (keys: placement.attachments[{component, target:{component, pins[]}, max_distance_mm, priority}], placement.groups[{id, components[]}], placement.separation[{groups[2], minimum_mm}], placement.keepouts[{region, prohibit[]}]).\nReply: {"rules": [{"yaml": "<one rule as YAML under placement:>", "cite": "<BOM.md row or datasheet ref and page>", "confidence": 0..1}]}. Only rules the facts support; decoupling within 2 mm of the pin it decouples is the common one.`;
  const refs = new Set(input.design.components.map((c) => c.reference));
  const { value, raw } = await chatJson(input.provider, system, user, (v) => {
    const rules = (v as { rules?: unknown[] })?.rules;
    return Array.isArray(rules) ? (rules as { yaml?: unknown; cite?: unknown; confidence?: unknown }[]) : null;
  });
  if (!value) return { entries: [], rejected: [], note: `step 3: the model's answer was not the JSON asked for (${raw.slice(0, 80).replace(/\n/g, ' ')}…)` };
  const entries: ParsedIntent['entries'] = [];
  const rejected: { rule: string; reason: string }[] = [];
  for (const r of value) {
    const yaml = typeof r.yaml === 'string' ? r.yaml : '';
    const cite = typeof r.cite === 'string' && r.cite.trim() ? r.cite.trim() : null;
    const confidence = typeof r.confidence === 'number' ? Math.max(0, Math.min(1, r.confidence)) : 0.5;
    if (!cite) {
      rejected.push({ rule: yaml.slice(0, 80), reason: 'no citation' });
      continue;
    }
    let parsed: ParsedIntent;
    try {
      parsed = parseIntent(yaml, `intent-compiler:${cite}`);
    } catch (e) {
      rejected.push({ rule: yaml.slice(0, 80), reason: `not valid intent YAML (${(e as Error).message.split('\n')[0]})` });
      continue;
    }
    if (parsed.unknown.length || parsed.errors.length || !parsed.entries.length) {
      rejected.push({ rule: yaml.slice(0, 80), reason: [...parsed.unknown.map((u) => `unknown key ${u}`), ...parsed.errors].join('; ') || 'no rule in it' });
      continue;
    }
    for (const e of parsed.entries) {
      const bad = (e.scope?.refs ?? []).filter((x) => !refs.has(x));
      if (bad.length) {
        rejected.push({ rule: e.key, reason: `names parts not on the board: ${bad.join(', ')}` });
        continue;
      }
      // a derived rule is never hard on its own (step 7 works the other way: it never downgrades a user's hard one)
      entries.push({ ...e, severity: e.severity === 'hard' ? 'soft' : e.severity, confidence, approvedBy: undefined, source: `intent-compiler:${cite}` } as ParsedIntent['entries'][number]);
    }
  }
  return { entries, rejected, note: `step 3: ${entries.length} rule(s) derived, ${rejected.length} rejected` };
}

export async function compileIntent(input: CompileInput): Promise<CompileResult> {
  const holds: string[] = [];
  const notes: string[] = [];
  // 1. blocks (deterministic) and roles (model)
  const blocks = deriveBlocks({ design: input.design, subsystemsMd: input.subsystemsMd ?? null, schematicIntent: input.schematicIntent ?? null });
  const { roles, note: n1 } = await stepRoles(input, blocks);
  notes.push(n1);
  // 2. explicit requirements, unmodified
  let explicit: Record<string, Constraint> = {};
  if (input.intentText) {
    const parsed = parseIntent(input.intentText, 'intent');
    explicit = intentToRegistry(parsed);
    for (const u of parsed.unknown) holds.push(`intent file: unknown key ${u}`);
    for (const e of parsed.errors) holds.push(`intent file: ${e}`);
    notes.push(`step 2: ${Object.keys(explicit).length} explicit constraint(s)`);
  } else notes.push('step 2: no intent file');
  // 3. derived candidates
  const { entries: derived, rejected, note: n3 } = await stepDerive(input, roles);
  notes.push(n3);
  // 4. merge by authority and priority: blocks < derived < explicit; ECAD replaces its own keys and reports contradictions
  const registry: Record<string, Constraint> = {};
  for (const [k, v] of Object.entries(input.registry ?? {})) if (v.source !== ECAD_SOURCE && !v.source?.startsWith('intent-compiler') && v.source !== 'blocks' && v.source !== 'intent') registry[k] = v;
  const put = (key: string, c: Constraint) => {
    const cur = registry[key];
    if (cur && (authority(cur) > authority(c) || (authority(cur) === authority(c) && (cur.priority ?? 50) >= (c.priority ?? 50)))) {
      if (JSON.stringify(cur.parameters) !== JSON.stringify(c.parameters)) holds.push(`${key}: kept the ${cur.source} entry over ${c.source} (authority)`);
      return;
    }
    registry[key] = c;
  };
  for (const [k, v] of Object.entries(blocksToConstraints(blocks, input.design))) put(k, v);
  for (const { key, ...c } of derived) put(key, c);
  for (const [k, v] of Object.entries(explicit)) put(k, v);
  const merged = mergeEcad(registry, ecadConstraints(input.design));
  for (const c of merged.contradictions) holds.push(`${c.key}: the board's own rules contradict the ${c.theirs} entry`);
  // 5. HOLD on anything uncertain: low-confidence derived rules stay advisory
  for (const [k, v] of Object.entries(merged.registry)) if (v.source?.startsWith('intent-compiler') && (v.confidence ?? 1) < 0.5 && v.severity !== 'advisory') {
    merged.registry[k] = { ...v, severity: 'advisory' };
    holds.push(`${k}: derived at confidence ${v.confidence}; advisory until approved`);
  }
  // 7. never silently downgrade a hard constraint: an explicit hard entry is exactly what the user wrote
  for (const [k, v] of Object.entries(explicit)) if (v.severity === 'hard' && merged.registry[k]?.severity !== 'hard') holds.push(`${k}: a hard requirement was not kept hard`);
  // 6. the explanation
  const refOf = (id: string) => input.design.components.find((c) => c.id === id)?.reference ?? id;
  const report = [
    '# Intent report',
    '',
    `Compiled ${new Date().toISOString().slice(0, 10)} for ${input.design.source.files.board}: ${Object.keys(merged.registry).length} constraint(s), ${holds.length} hold(s).`,
    '',
    '## Steps',
    '',
    ...notes.map((n) => `- ${n}`),
    `- step 4: merged by authority (user > board rules > datasheet > compiler) and priority`,
    `- step 5: ${holds.length} item(s) on hold`,
    `- step 7: hard requirements kept hard`,
    '',
    '## Blocks',
    '',
    ...blocks.map((b) => `- **${b.id}**: ${b.members.map(refOf).join(', ')}; anchor ${b.anchor ? refOf(b.anchor) : 'none'}; region ${b.region ? 'assigned' : 'none'}; spread budget ${(b.spreadBudgetNm / 1e6).toFixed(1)} mm${b.notes.length ? ` (${b.notes.join('; ')})` : ''}`),
    '',
    '## Roles',
    '',
    ...(Object.keys(roles).length ? Object.entries(roles).map(([r, rs]) => `- ${r}: ${rs.join(', ')}`) : ['- none assigned']),
    '',
    '## Constraints',
    '',
    '| key | class | severity | source | scope | parameters |',
    '| --- | --- | --- | --- | --- | --- |',
    ...Object.entries(merged.registry).filter(([, c]) => c.class).map(([k, c]) => `| \`${k}\` | ${c.class} | ${c.severity} | ${c.source} | ${[...(c.scope?.refs ?? []), ...(c.scope?.nets ?? [])].join(', ')} | ${Object.entries(c.parameters ?? {}).map(([pk, pv]) => `${pk}=${typeof pv === 'string' && pv.length > 40 ? pv.slice(0, 37) + '…' : Array.isArray(pv) ? pv.join('/') : String(pv)}`).join('; ')} |`),
    '',
    ...(rejected.length ? ['## Rejected proposals', '', ...rejected.map((r) => `- ${r.rule}: ${r.reason}`), ''] : []),
    ...(holds.length ? ['## Holds', '', ...holds.map((h) => `- ${h}`), ''] : []),
  ].join('\n');
  if (input.runDir) {
    await mkdir(input.runDir, { recursive: true });
    await writeFile(path.join(input.runDir, 'intent-report.md'), report, 'utf8');
  }
  return { registry: merged.registry, blocks, roles, holds, report, rejected };
}

/** Cached datasheet texts under .copperhead/datasheets/<ref or mpn>.txt|.md, keyed by file stem. */
export async function cachedDatasheets(repoRoot: string): Promise<Record<string, string>> {
  const dir = path.join(repoRoot, '.copperhead', 'datasheets');
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const f of await readdir(dir)) if (/\.(txt|md)$/.test(f)) out[f.replace(/\.(txt|md)$/, '')] = await readFile(path.join(dir, f), 'utf8');
  return out;
}
