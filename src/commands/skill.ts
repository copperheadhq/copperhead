import { loadConfig, resolveModel } from '../config.js';
import { flatten, type ToolResult } from '../agent/envelope.js';
import { makeProvider } from '../agent/loop.js';
import { dispatchToolResult, registry, type RunContext } from '../agent/tools.js';
import type { Provider } from '../agent/types.js';
import { Transcript } from '../agent/transcript.js';
import { ObligationsLedger } from '../agent/ledger.js';

export class SkillCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillCliError';
  }
}

export function catalogNameFromCli(name: string): string {
  return name.replace(/-/g, '_');
}

export async function listSkills(repoRoot: string): Promise<{ name: string; available: boolean; description: string }[]> {
  const ctx = await minimalCtx(repoRoot, false);
  const listed = new Set(registry.list(ctx).map((e) => e.name));
  return registry.skills().map((s) => ({
    name: s.name,
    available: listed.has(s.name),
    description: s.schema.description,
  }));
}

export async function runSkill(opts: {
  repoRoot: string;
  name: string;
  args?: Record<string, unknown>;
  provider: Provider;
}): Promise<ToolResult> {
  const catalogName = catalogNameFromCli(opts.name);
  const entry = registry.get(catalogName);
  if (!entry || entry.kind !== 'skill') throw new SkillCliError(`unknown skill "${opts.name}"`);
  const ctx = await minimalCtx(opts.repoRoot);
  if (!registry.list(ctx).some((e) => e.name === catalogName)) {
    throw new SkillCliError(`skill "${opts.name}" is not available in this repo`);
  }
  return dispatchToolResult(ctx, entry.name, opts.args ?? {}, { provider: opts.provider });
}

export async function providerForSkillRun(repoRoot: string, modelFlag?: string): Promise<{ provider: Provider; model: string }> {
  const config = await loadConfig(repoRoot);
  try {
    const { model } = resolveModel(modelFlag, config);
    return { provider: await makeProvider(model), model };
  } catch (err) {
    const msg = (err as Error).message;
    throw new SkillCliError(
      msg.includes('no model') || msg.includes('API_KEY') || msg.includes('configured')
        ? `${msg} — skill run needs OPENAI_API_KEY, ANTHROPIC_API_KEY, or --model for a saved-login provider (codex, claude-code, cursor).`
        : msg,
    );
  }
}

export function formatSkillEnvelope(result: ToolResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2);
  const body = flatten(result);
  return result.ok ? body : `error: ${body}`;
}

/**
 * One skill run plus the provider's lifecycle. A saved-login provider owns a
 * `mkdtemp` working directory (and, on some backends, an in-flight subprocess);
 * `runAgentLoop` closes it in a `finally` because leaving it behind orphans the
 * process and fills the disk (I8). `skill run` has no agent loop to inherit that
 * from, so the close lives here — around the throw path too, since an unknown or
 * unavailable skill must not leak the provider it already built. Returns the text
 * to print and the exit code, so the CLI's only job is `console.log` + `exit`.
 */
export async function runSkillCli(opts: {
  repoRoot: string;
  name: string;
  args?: Record<string, unknown>;
  provider: Provider;
  json: boolean;
  warn?: (line: string) => void;
}): Promise<{ text: string; code: number }> {
  try {
    const result = await runSkill({
      repoRoot: opts.repoRoot,
      name: opts.name,
      ...(opts.args ? { args: opts.args } : {}),
      provider: opts.provider,
    });
    return { text: formatSkillEnvelope(result, opts.json), code: result.ok ? 0 : 1 };
  } finally {
    try {
      await opts.provider.close?.();
    } catch (err) {
      (opts.warn ?? ((l: string) => console.error(l)))(
        `warning: ${opts.provider.name} provider cleanup failed (${(err as Error).message})`,
      );
    }
  }
}

async function minimalCtx(repoRoot: string, initializeTranscript = true): Promise<RunContext> {
  const transcript = new Transcript(repoRoot);
  if (initializeTranscript) await transcript.init();
  return {
    repoRoot,
    config: await loadConfig(repoRoot),
    transcript,
    ledger: new ObligationsLedger(),
    runId: 'skill',
    interactive: false,
    confirm: async () => true,
    editsUnlocked: false,
    changeId: null,
    proposalValidated: false,
    filesTouched: new Set(),
    decisions: [],
    lastErc: null,
    lastDrc: null,
    lastLegibility: null,
    lastScore: null,
    lastDrift: null,
    repairCycles: 0,
    finishRequest: null,
  };
}
