import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Optional `legibility` block: checker thresholds and per-family severity
 * overrides (`off` disables a family). Unknown keys and invalid values are
 * ignored by the checker's own sanitizer, so a config typo cannot crash a run.
 */
export interface LegibilityUserConfig {
  thresholds?: {
    gridPitch?: number;
    minPitch?: number;
    utilization?: number;
    maxWireLength?: number;
    familyCap?: number;
  };
  severity?: Record<string, 'error' | 'advisory' | 'off'>;
  /** Scorer tuning: per-metric weights and the known-good composite floor. */
  score?: {
    weights?: Record<string, number>;
    floor?: number;
  };
}

export interface CopperheadConfig {
  schematic: string | null;
  board: string | null;
  /** Schematic legibility checker thresholds and severity overrides. */
  legibility?: LegibilityUserConfig;
  docs: string;
  model: string | null;
  maxTurns: number;
  /** Per-stage overrides for the create pipeline, keyed by stage name. */
  stageMaxTurns?: Record<string, number>;
  maxRepairCycles: number;
  budgets: Record<string, number>;
  /** Per-turn watchdog (ms). A provider turn exceeding this is aborted and
   * retried, so a hung call can't stall the run forever. <=0 disables it. */
  turnTimeoutMs: number;
  /** How often (ms) to emit a liveness heartbeat while a provider turn is in
   * flight, so a slow large-output turn is distinguishable from a hung one
   * (5.1). Fires only after the first interval, so quick turns stay silent.
   * <=0 disables it. */
  heartbeatMs: number;
  /** How many times the create pipeline may auto-retry a stage that failed or
   * ended without meeting its contract, gated by an LLM diagnosis each time. */
  maxStageRetries: number;
  /** Cache each turn's LLM response to disk and replay it on identical inputs,
   * so retries/restarts reuse work already paid for. Default on. */
  llmCache: boolean;
  /**
   * Trim settled history out of each request so a long stage does not re-send
   * (and re-pay for) every earlier file read and edit payload on every turn.
   * Affects only what is sent to the provider; the transcript keeps full
   * fidelity. Default on - turn it off to reproduce a run's exact prompts.
   */
  historyCap: boolean;
  /**
   * Base URL of an OpenAI-compatible endpoint (Groq, OpenRouter, Gemini's
   * compat endpoint, a local Ollama). Consulted only by the `compat`
   * route (design D2), so a stray value never redirects a plain `gpt-5` run.
   */
  baseURL?: string;
  /**
   * Name of the environment variable holding the compat endpoint's key, e.g.
   * `GROQ_API_KEY`. The *name*, never the key itself: credentials stay in the
   * environment (AC-4.1).
   */
  apiKeyEnv?: string;
  /** Content hashes of generated docs, for init idempotency (AC-1.4). */
  generatedHashes?: Record<string, string>;
  /**
   * How the repo was bootstrapped. `"create"` marks a Mode A pipeline repo
   * (fab gate requires DEVPLAN.md). Written by `copperhead create`; absent on
   * init-only / hand-maintained repos.
   */
  origin?: 'create' | 'init';
}

export const CONFIG_DIR = '.copperhead';

export const DEFAULTS: Omit<CopperheadConfig, 'schematic' | 'board'> = {
  docs: 'docs/',
  model: null,
  maxTurns: 40,
  maxRepairCycles: 5,
  budgets: {},
  // 10 min. A single large capture turn (a full lib_symbols + instances edit,
  // ~40k output tokens) on the claude-code provider legitimately runs several
  // minutes; the old 5-min deadline killed those mid-flight and, because the
  // watchdog budget is spent per stage, could fail a stage that was only slow,
  // not hung. 10 min clears the largest observed turns while still catching a
  // genuinely stuck subprocess.
  turnTimeoutMs: 600000,
  // 30s: within one interval an operator knows a turn is alive, and a full
  // 10-min turn emits ~20 lines — enough to distinguish slow from hung without
  // flooding the log. Quick turns (< 30s) emit nothing.
  heartbeatMs: 30000,
  maxStageRetries: 2,
  llmCache: true,
  historyCap: true,
};

export function configPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_DIR, 'config.json');
}

export async function loadConfig(repoRoot: string): Promise<CopperheadConfig> {
  const p = configPath(repoRoot);
  if (!existsSync(p)) {
    return { schematic: null, board: null, ...DEFAULTS };
  }
  const raw = JSON.parse(await readFile(p, 'utf8')) as Partial<CopperheadConfig>;
  // A zero/negative/non-integer stage budget would exhaust the stage on turn 0;
  // drop such entries rather than let a config typo stall the pipeline.
  const stageMaxTurns = Object.fromEntries(
    Object.entries(raw.stageMaxTurns ?? {}).filter(([, v]) => Number.isInteger(v) && v > 0),
  );
  return {
    schematic: raw.schematic ?? null,
    board: raw.board ?? null,
    docs: raw.docs ?? DEFAULTS.docs,
    model: raw.model ?? null,
    maxTurns: raw.maxTurns ?? DEFAULTS.maxTurns,
    ...(Object.keys(stageMaxTurns).length ? { stageMaxTurns } : {}),
    maxRepairCycles: raw.maxRepairCycles ?? DEFAULTS.maxRepairCycles,
    budgets: raw.budgets ?? {},
    turnTimeoutMs: typeof raw.turnTimeoutMs === 'number' ? raw.turnTimeoutMs : DEFAULTS.turnTimeoutMs,
    heartbeatMs: typeof raw.heartbeatMs === 'number' ? raw.heartbeatMs : DEFAULTS.heartbeatMs,
    maxStageRetries:
      Number.isInteger(raw.maxStageRetries) && (raw.maxStageRetries as number) >= 0
        ? (raw.maxStageRetries as number)
        : DEFAULTS.maxStageRetries,
    llmCache: raw.llmCache !== false,
    historyCap: raw.historyCap !== false,
    ...(typeof raw.baseURL === 'string' && raw.baseURL.trim() ? { baseURL: raw.baseURL.trim() } : {}),
    ...(typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv.trim() ? { apiKeyEnv: raw.apiKeyEnv.trim() } : {}),
    ...(raw.generatedHashes ? { generatedHashes: raw.generatedHashes } : {}),
    ...(raw.origin === 'create' || raw.origin === 'init' ? { origin: raw.origin } : {}),
    ...(raw.legibility && typeof raw.legibility === 'object' ? { legibility: raw.legibility } : {}),
  };
}

/** Which level of the model-selection precedence chain won. */
export type ModelSource = 'flag' | 'env' | 'config' | 'openai-key' | 'anthropic-key' | 'picker';

export interface ResolvedModel {
  model: string;
  source: ModelSource;
}

/**
 * Model selection precedence: flag > COPPERHEAD_MODEL > config > available key.
 * The winning source is returned alongside the model so run metadata can
 * record why a run used the model it did (AC-8.1/8.2).
 *
 * Accepted values (same set for `--model`, COPPERHEAD_MODEL, and `model` in
 * .copperhead/config.json):
 *
 * - `cursor`          : the Cursor Agent CLI using saved login (`agent login`).
 * - `cursor:<id>`     : the same provider on a specific model id.
 * - `claude-code`     : the Claude Code saved-login provider on its default
 *                       model. Needs NO API key — it reuses the logged-in Claude
 *                       Code CLI / CLAUDE_CODE_OAUTH_TOKEN via the Agent SDK.
 * - `claude-code:<id>`: the same provider on a specific model id.
 * - `claude`  : the Anthropic API provider on its default model.
 * - `claude-*`: any Anthropic API model id, passed through verbatim, e.g.
 *               `claude-opus-4-5`. Anything starting with `claude` routes here.
 * - `codex`   : the locally installed Codex CLI using its saved ChatGPT login.
 * - `codex:*` : Codex CLI with an explicit model id, e.g. `codex:gpt-5.6`.
 * - `gpt-5`   : the OpenAI provider on its default model.
 * - anything else: sent to the OpenAI provider verbatim as a model id, e.g.
 *               `gpt-5-mini` or `o3`.
 *
 * Routing is prefix-based, not a fixed list (see makeProvider in agent/loop.ts),
 * matched top to bottom: `claude-code`/`claude-code:<id>` is checked BEFORE the
 * `claude*` prefix, so it is never captured by the Anthropic API route. A model
 * released after this build still works without a code change. The cost is that
 * a typo like `claud-sonnet-5` silently routes to OpenAI and fails there.
 * Anthropic and direct OpenAI providers require their API keys; `codex` requires
 * a locally installed and authenticated Codex CLI, and `claude-code` requires a
 * Claude Code login (CLAUDE_CODE_OAUTH_TOKEN); `cursor` requires `agent login`.
 * None of the saved-login providers need a model API key.
 */
export function resolveModel(flag: string | undefined, config: CopperheadConfig, env = process.env): ResolvedModel {
  if (flag) return { model: flag, source: 'flag' };
  if (env.COPPERHEAD_MODEL) return { model: env.COPPERHEAD_MODEL, source: 'env' };
  if (config.model) return { model: config.model, source: 'config' };
  // Auto-fallback is only safe when exactly one credential is present: guessing
  // is a convenience when there is nothing to guess wrong. With two or more
  // keys set (a common dev setup once a compat endpoint's key sits alongside
  // OPENAI_API_KEY/ANTHROPIC_API_KEY), silently favoring whichever is checked
  // first can send a request to the wrong provider with no signal — including
  // a paid one when a free key was what was actually intended. Refuse instead
  // of guessing; the compat route itself is never a fallback candidate here,
  // since it is opt-in only via an explicit `compat:` prefix (design D2).
  const available: { keyVar: string; model: string; source: ModelSource }[] = [
    ...(env.OPENAI_API_KEY ? [{ keyVar: 'OPENAI_API_KEY', model: 'gpt-5', source: 'openai-key' as const }] : []),
    ...(env.ANTHROPIC_API_KEY ? [{ keyVar: 'ANTHROPIC_API_KEY', model: 'claude', source: 'anthropic-key' as const }] : []),
  ];
  if (available.length === 1) return { model: available[0]!.model, source: available[0]!.source };
  if (available.length > 1) {
    throw new Error(
      `ambiguous: ${available.length} credentials found (${available.map((a) => a.keyVar).join(', ')}) and no model was ` +
        'selected; pass --model, set COPPERHEAD_MODEL, or set "model" in .copperhead/config.json.',
    );
  }
  throw new Error(
    'no model configured: pass --model, set COPPERHEAD_MODEL, or export an API key; see https://docs.copperhead.sh/reference/configuration/',
  );
}

/** Where an OpenAI-compatible run points, and which variable holds its key. */
export interface CompatSettings {
  /** Endpoint base URL; undefined means the client's own default (OpenAI). */
  baseURL?: string;
  /** Name of the env var holding the key. Never the key itself. */
  apiKeyEnv: string;
}

/** The credential variable used when nothing else is configured. */
export const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY';

/**
 * Resolve the compatible-endpoint settings: environment wins over config, the
 * same direction as `resolveModel`'s chain. These are *settings*, not a
 * provider selector — only the `compat` route reads them (design D1/D2), so an
 * exported COPPERHEAD_BASE_URL never silently redirects a `gpt-5` run.
 */
export function resolveCompatSettings(config: CopperheadConfig, env = process.env): CompatSettings {
  const baseURL = env.COPPERHEAD_BASE_URL?.trim() || config.baseURL?.trim();
  const apiKeyEnv = env.COPPERHEAD_API_KEY_ENV?.trim() || config.apiKeyEnv?.trim() || DEFAULT_API_KEY_ENV;
  return { ...(baseURL ? { baseURL } : {}), apiKeyEnv };
}

/**
 * True when a resolved model id routes through the `compat` provider (D1/D2).
 * The single source of truth for that gate: `makeProvider` uses it to decide
 * whether to consult `CompatSettings` at all, and the response cache (loop.ts)
 * uses it to decide whether a run's cache key may depend on `baseURL` — a
 * non-compat run (gpt-5, claude, ...) never reads COPPERHEAD_BASE_URL, so its
 * cache key must not vary with it either, or every entry gets orphaned each
 * time the endpoint used for unrelated compat testing changes.
 */
export function isCompatModel(model: string): boolean {
  return model === 'compat' || model.startsWith('compat:');
}

/**
 * True when the endpoint is loopback, i.e. a local server such as Ollama.
 * Those need no credential (design D4); a remote endpoint always does.
 */
export function isLocalEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    const h = new URL(baseURL).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.local');
  } catch {
    return false; // an unparseable URL is not a local endpoint; the run fails later with a clearer error
  }
}
