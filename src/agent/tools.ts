import type { CatalogEntry, CatalogSkill } from '../capabilities/index.js';
import { corruptionError } from '../capabilities/helpers.js';
import { flatten, failResult, seal, unavailable, type ToolResult } from './envelope.js';
import { registry } from './registry.js';
import { withRetry, isRateLimit } from '../util/retry.js';
import type { RunContext } from './context.js';
import type { Msg, Provider } from './types.js';

export type { RunContext, FinishRequest } from './context.js';
export type { CatalogEntry, CatalogSkill };
export { corruptionError, registry };

export function availableTools(ctx: RunContext): CatalogEntry[] {
  return registry.list(ctx);
}

export interface DispatchOpts {
  provider?: Provider;
  /** Skill sub-run: only these names may dispatch (never `finish`). */
  only?: ReadonlySet<string>;
}

export async function dispatchToolResult(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  opts: DispatchOpts = {},
): Promise<ToolResult> {
  if (opts.only && !opts.only.has(name)) return unavailable(name, ctx.editsUnlocked);
  const entry = availableTools(ctx).find((e) => e.name === name);
  if (!entry) return unavailable(name, ctx.editsUnlocked);
  if (entry.kind === 'skill') {
    if (!opts.provider) return failResult('validation', `skill "${name}" requires a provider`, 'diagnostic');
    return runSkillSubRun({ ctx, skill: entry, args, provider: opts.provider });
  }
  try {
    // Unified retry policy (design D10): a thrown 429 backs off through the
    // same withRetry/isRateLimit pair the provider path uses. Typed envelope
    // failures (validation/refusal/unavailable) return, so they never retry;
    // local tool errors are not 429s, so they surface on the first throw.
    return await withRetry(() => entry.handler(ctx, args), { isRetryable: isRateLimit, baseMs: 250 });
  } catch (err) {
    return failResult('exception', `error: ${(err as Error).message}`);
  }
}

export async function dispatchTool(
  ctx: RunContext,
  name: string,
  args: Record<string, unknown>,
  opts: DispatchOpts = {},
): Promise<string> {
  return flatten(await dispatchToolResult(ctx, name, args, opts));
}

export async function runSkillSubRun(opts: {
  ctx: RunContext;
  skill: CatalogSkill;
  args: Record<string, unknown>;
  provider: Provider;
}): Promise<ToolResult> {
  const { ctx, skill, args, provider } = opts;
  const savedFinish = ctx.finishRequest;
  const only = new Set(skill.tools.filter((n) => n !== 'finish'));
  const results = new Map<string, ToolResult>();
  const messages: Msg[] = [
    { role: 'system', content: skill.prompt(ctx, args) },
    { role: 'user', content: 'Execute this skill. Use the available tools, then stop when the report is complete.' },
  ];

  try {
    for (let turn = 0; turn < (skill.maxTurns ?? 8); turn++) {
      if (await skill.isComplete(ctx, args)) break;
      const tools = registry.list(ctx).filter((e) => e.kind === 'tool' && only.has(e.name)).map((e) => e.schema);
      const res = await provider.chat(messages, tools);
      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
      if (!res.toolCalls.length) {
        if (await skill.isComplete(ctx, args)) break;
        messages.push({ role: 'user', content: 'Continue using tools until the report is complete.' });
        continue;
      }
      for (const call of res.toolCalls) {
        const envelope = await dispatchToolResult(ctx, call.name, call.args, { only });
        results.set(call.name, envelope);
        const flat = flatten(envelope);
        await ctx.transcript.event('skill-tool', {
          skill: skill.name,
          name: call.name,
          args: call.args,
          result: flat,
          envelope,
        });
        messages.push({ role: 'tool', toolCallId: call.id, content: flat });
      }
    }
  } finally {
    ctx.finishRequest = savedFinish;
  }

  const detail =
    skill.tools
      .filter((n) => results.has(n))
      .map((n) => `${n}:\n${flatten(results.get(n)!)}`)
      .join('\n\n') || 'no tool results';
  const complete = await skill.isComplete(ctx, args);
  return seal({
    ok: complete,
    summary: complete ? 'design report' : 'design report incomplete',
    detail,
    viewHint: 'diagnostic',
  });
}
