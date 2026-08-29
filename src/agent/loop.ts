import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { execa } from 'execa';
import type { Msg, Provider, Turn } from './types.js';
import { availableTools, dispatchToolResult, type RunContext } from './tools.js';
import { flatten } from './envelope.js';
import { CachingProvider } from './response-cache.js';
import { withTimeout, TurnTimeoutError } from './recovery.js';
import { buildSystemPrompt } from './prompts.js';
import { loadConstraints, reopenDeferredAffects } from '../memory/constraints.js';
import { isCreateProducedRepo, isEngineAuthoredSchematic } from '../kicad/fab.js';
import {
  loadConfig,
  CONFIG_DIR,
  DEFAULT_API_KEY_ENV,
  resolveCompatSettings,
  isCompatModel,
  type CompatSettings,
  type CopperheadConfig,
} from '../config.js';
import { Transcript, type ExitPath, type RunStats } from './transcript.js';
import { collectRunMeta, renderCliHeader, type RunMeta, type RunMetaInput } from './runmeta.js';
import { plainRenderer, fmtDuration, fmtTokens, type ProgressRenderer } from './render.js';
import { styleHeaderLines } from './theme.js';
import { ObligationsLedger } from './ledger.js';
import { gitPreflight, isDirty, snapshot, restore, commitAll, changedFiles, preserveFailedRun } from '../util/git.js';
import { withRetry, isRateLimit, sessionLimit } from '../util/retry.js';
import { openspecArchive } from '../openspec/cli.js';
import { existsSync } from 'node:fs';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { CodexProvider } from './providers/codex.js';
import { ClaudeCodeProvider } from './providers/claude-code.js';
import { CursorProvider } from './providers/cursor.js';

/** What the user sees at the moment they decide whether to keep going. */
export interface BudgetExhaustedStats {
  /** The run's original turn budget, before any extensions. */
  maxTurns: number;
  turnsUsed: number;
  tokensIn: number;
  tokensOut: number;
  filesTouched: string[];
  openObligations: number;
}

export interface RunOptions {
  repoRoot: string;
  request: string;
  model: string;
  maxTurns?: number;
  allowDirty?: boolean;
  dryRun?: boolean;
  interactive?: boolean;
  confirm?: (q: string) => Promise<boolean>;
  /**
   * Called when the turn budget runs out. Returns the number of extra turns to
   * grant (0 fails the run as before). Absent means non-interactive: fail.
   */
  onBudgetExhausted?: (stats: BudgetExhaustedStats) => Promise<number>;
  /** Extra prompt appended for pipeline stages (Mode A). */
  stagePrompt?: string;
  /** Test seam: bypass makeProvider. */
  provider?: Provider;
  log?: (line: string) => void;
  /** Progress renderer; defaults to a plain line renderer over `log`. */
  renderer?: ProgressRenderer;
  /** Caller-known run identity for the metadata block (design D2). */
  meta?: RunMetaInput;
}

export interface RunResult {
  outcome: 'success' | 'refused' | 'failure';
  exitPath: ExitPath;
  summary: string;
  transcriptDir: string;
  filesTouched: string[];
  commit: string | null;
  /** Cost/telemetry for this run. Surfaced by the create pipeline's per-stage
   *  cost table (5.2) so the expensive stages are obvious across runs. */
  stats: RunStats;
  /** Number of turns served from the on-disk response cache (5.2). */
  cacheHits: number;
}

export async function makeProvider(
  model: string,
  sessionResume = false,
  compat?: CompatSettings | undefined,
): Promise<Provider> {
  // OpenAI-compatible endpoint (Groq, OpenRouter, Gemini compat, local
  // Ollama). An explicit `compat` prefix is the opt-in: nothing else
  // consults baseURL, so a stray COPPERHEAD_BASE_URL cannot redirect a keyed
  // `gpt-5` run to a third party (design D2).
  if (isCompatModel(model)) {
    const compatModel = model.startsWith('compat:') ? model.slice('compat:'.length) : undefined;
    if (compatModel === '') {
      throw new Error('compat model override cannot be empty; use "compat:<model-id>"');
    }
    const settings = compat ?? { apiKeyEnv: DEFAULT_API_KEY_ENV };
    // Bare `compat` (no id) has no valid default: unlike gpt-5/claude, a
    // compatible endpoint serves whatever models its host chooses, so there is
    // no id that is ever correct to assume. Falling through here would build a
    // provider that silently sends the literal string "gpt-5" (OpenAIProvider's
    // own default) to a host that almost certainly does not serve it.
    if (!compatModel) {
      throw new Error(
        settings.baseURL
          ? `compat requires a model id; use "compat:<model-id>" (endpoint ${settings.baseURL} is configured, but has no default model)`
          : 'compat requires a model id and an endpoint; use "compat:<model-id>" and set baseURL (COPPERHEAD_BASE_URL or .copperhead/config.json)',
      );
    }
    if (!settings.baseURL) {
      throw new Error(
        `compat:${compatModel} requires an endpoint; set baseURL (COPPERHEAD_BASE_URL or "baseURL" in .copperhead/config.json) — without one this would silently fall back to the real OpenAI API.`,
      );
    }
    return new OpenAIProvider(compatModel, {
      baseURL: settings.baseURL,
      apiKeyEnv: settings.apiKeyEnv,
    });
  }
  if (model === 'codex' || model.startsWith('codex:')) {
    const codexModel = model.startsWith('codex:') ? model.slice('codex:'.length) : undefined;
    if (codexModel === '') throw new Error('codex model override cannot be empty; use "codex" or "codex:<model-id>"');
    const { Codex } = await import('@openai/codex-sdk').catch((err: unknown) => {
      throw new Error(
        'Codex provider requires the optional @openai/codex-sdk package; install it alongside Copperhead before using --model codex',
        { cause: err },
      );
    });
    return new CodexProvider({
      ...(codexModel ? { model: codexModel } : {}),
      client: new Codex({
        // Use the user's installed CLI and its saved login rather than a model API key.
        codexPathOverride: process.env.COPPERHEAD_CODEX_PATH || 'codex',
      }),
    });
  }
  // Match claude-code before the `claude*` prefix: both `claude-code` and
  // `claude-code:<id>` start with `claude` and would otherwise route to the
  // Anthropic API provider.
  if (model === 'claude-code' || model.startsWith('claude-code:')) {
    const claudeCodeModel = model.startsWith('claude-code:') ? model.slice('claude-code:'.length) : undefined;
    if (claudeCodeModel === '') {
      throw new Error('claude-code model override cannot be empty; use "claude-code" or "claude-code:<model-id>"');
    }
    return new ClaudeCodeProvider(claudeCodeModel, undefined, undefined, sessionResume);
  }
  // Saved-login Cursor Agent CLI (`agent login`). Matched as its own namespace.
  if (model === 'cursor' || model.startsWith('cursor:')) {
    const cursorModel = model.startsWith('cursor:') ? model.slice('cursor:'.length) : undefined;
    if (cursorModel === '') {
      throw new Error('cursor model override cannot be empty; use "cursor" or "cursor:<model-id>"');
    }
    return new CursorProvider(cursorModel, undefined, sessionResume);
  }
  if (model === 'claude' || model.startsWith('claude')) {
    return new AnthropicProvider(model === 'claude' ? undefined : model);
  }
  return new OpenAIProvider(model === 'gpt-5' ? undefined : model);
}

function otherProvider(current: Provider): Provider | null {
  // Only the two keyed providers fail over to each other. A rate-limited
  // 'claude-code' or 'cursor' run returns null here (no silent fallback to a paid API).
  if (current.name === 'openai' && process.env.ANTHROPIC_API_KEY) return new AnthropicProvider();
  if (current.name === 'anthropic' && process.env.OPENAI_API_KEY) return new OpenAIProvider();
  return null;
}

async function appendChangelog(
  repoRoot: string,
  config: CopperheadConfig,
  entry: { changeId: string | null; request: string; files: string[]; verification: string },
): Promise<void> {
  const p = path.join(repoRoot, config.docs, 'CHANGELOG.md');
  const date = new Date().toISOString().slice(0, 10);
  const block = [
    ``,
    `## ${date} — ${entry.request}`,
    ``,
    `- Change: ${entry.changeId ?? 'n/a'}`,
    `- Files: ${entry.files.join(', ') || '(none)'}`,
    `- Verification: ${entry.verification}`,
  ].join('\n');
  let text: string;
  try {
    text = await readFile(p, 'utf8');
  } catch {
    text = '# Design changelog\n\nAppend-only, newest first. One entry per committed copperhead run.\n';
  }
  // newest first: insert right after the header block (first blank line after content start)
  const lines = text.split('\n');
  let insertAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('## ')) {
      insertAt = i;
      break;
    }
  }
  lines.splice(insertAt, 0, ...block.split('\n').slice(1), '');
  await writeFile(p, lines.join('\n'), 'utf8');
}

export async function runAgentLoop(opts: RunOptions): Promise<RunResult> {
  const providers = new Set<Provider>();
  try {
    return await runWithProviders(opts, providers);
  } finally {
    for (const provider of providers) {
      try {
        await provider.close?.();
      } catch (err) {
        opts.log?.(`warning: ${provider.name} provider cleanup failed (${(err as Error).message})`);
      }
    }
  }
}

async function runWithProviders(opts: RunOptions, providers: Set<Provider>): Promise<RunResult> {
  const r = opts.renderer ?? plainRenderer(opts.log ?? ((l: string) => console.log(l)));
  const log = (l: string): void => r.log(l);
  const repoRoot = opts.repoRoot;
  const config = await loadConfig(repoRoot);
  const maxTurns = opts.maxTurns ?? config.maxTurns;

  await gitPreflight(repoRoot, { allowDirty: opts.allowDirty ?? false });
  const snap = await snapshot(repoRoot);

  const transcript = new Transcript(repoRoot);
  await transcript.init();
  // Legibility gates finish only where copperhead authored the sheet; a
  // hand-drawn repo gets findings as information, never as a wedge (C6).
  // Both conditions matter: the create-origin marker scopes the gate to repos
  // this tool produced, and the generator stamp scopes it to sheets copperhead
  // still owns. A human taking the sheet over in KiCad re-saves it under
  // KiCad's generator, and from then on the gate must not defend a drawing
  // the engine can no longer regenerate. A create repo whose schematic is not
  // yet scaffolded keeps the gate: the sheet stage 4 will produce is
  // copperhead-authored by construction.
  let gateLegibility = isCreateProducedRepo(config);
  if (gateLegibility && config.schematic) {
    try {
      gateLegibility = isEngineAuthoredSchematic(await readFile(path.join(repoRoot, config.schematic), 'utf8'));
    } catch {
      // schematic configured but absent (pre-scaffold): keep the gate
    }
  }
  const ctx: RunContext = {
    repoRoot,
    config,
    transcript,
    ledger: new ObligationsLedger(gateLegibility),
    runId: path.basename(transcript.dir),
    interactive: opts.interactive ?? false,
    confirm: opts.confirm ?? (async () => true),
    editsUnlocked: false,
    changeId: null,
    proposalValidated: false,
    filesTouched: new Set(),
    decisions: [],
    lastErc: null,
    lastLegibility: null,
    lastScore: null,
    lastDrc: null,
    repairCycles: 0,
    finishRequest: null,
  };

  // Session resume for claude-code / cursor is only correct when the response
  // cache is off: the cache replays turns a resumed session never saw. So enable
  // it only when the env flag is set AND config.llmCache is disabled — the same
  // condition under which we skip the CachingProvider wrap below.
  const sessionResume = process.env.COPPERHEAD_CC_SESSION_RESUME === '1' && !config.llmCache;
  const compatSettings = resolveCompatSettings(config);
  let provider = opts.provider ?? (await makeProvider(opts.model, sessionResume, compatSettings));
  // Cache every turn's response so a retried/restarted stage replays what it
  // already paid for instead of re-calling the model (repo-scoped, cross-run).
  // Skip an injected provider (tests drive scripted providers directly).
  if (config.llmCache && !opts.provider) {
    // Mirrors makeProvider's own gate above (D2/AC-3.16): COPPERHEAD_BASE_URL
    // is consulted only for the explicit `compat:` route, so a gpt-5/claude
    // run's cache key must not vary with a variable that run never reads —
    // otherwise every non-compat cache entry gets orphaned each time the
    // endpoint used for compat testing changes.
    provider = new CachingProvider(
      provider,
      path.join(repoRoot, CONFIG_DIR, 'llm-cache'),
      log,
      opts.model,
      isCompatModel(opts.model) ? compatSettings.baseURL : undefined,
    );
  }
  providers.add(provider);
  // Held separately from `provider` (which is reassigned on failover) so the
  // final cache-hit count survives a mid-run provider switch (5.2).
  const cachingProvider = provider instanceof CachingProvider ? provider : null;
  const cacheHits = (): number => cachingProvider?.cacheHits ?? 0;

  // Deterministic, LLM-free metadata block: collected once, rendered onto all
  // three surfaces (run-start event, summary ## Environment, CLI header) so
  // they can never disagree (design D1, AC-8.1/8.4).
  const startMs = Date.now();
  const meta: RunMeta = await collectRunMeta({
    repoRoot,
    config,
    maxTurns,
    runId: path.basename(transcript.dir),
    request: opts.request,
    model: opts.model,
    provider: provider.name,
    interactive: opts.interactive ?? false,
    input: opts.meta,
  });
  for (const line of styleHeaderLines(renderCliHeader(meta))) log(line);
  // Revisit obligations deferred while their artifact didn't exist re-open now
  // if it does (must run before loadConstraints so the prompt sees the updated
  // registry). They land in this run's fresh ledger, so finish gates on them.
  const reopened = await reopenDeferredAffects(repoRoot, config, (key, item) =>
    ctx.ledger.add('affects-revisit', `${key} affects ${item}`, key),
  );
  if (reopened.length) {
    await transcript.event('deferred-affects-reopened', { reopened });
    log(`re-opened ${reopened.length} deferred constraint revisit obligation(s)`);
  }
  const constraints = await loadConstraints(repoRoot);
  let basePrompt = await buildSystemPrompt(repoRoot, config, constraints);
  if (reopened.length) {
    basePrompt += [
      '',
      '',
      '## Reopened constraint revisits',
      '',
      'These constraints were recorded before their target artifact existed; the artifact now exists.',
      'Revisit each against the design and close it with resolve_affected (batch the calls):',
      ...reopened.map((r) => `- ${r.key} affects ${r.item}`),
    ].join('\n');
  }
  const messages: Msg[] = [
    { role: 'system', content: basePrompt },
    { role: 'user', content: opts.stagePrompt ? `${opts.stagePrompt}\n\nRequest: ${opts.request}` : opts.request },
  ];
  await transcript.event('run-start', meta);

  let tokensIn = 0;
  let tokensOut = 0;
  let turnsUsed = 0;
  const perTurn: { turn: number; in: number; out: number }[] = [];
  let plan: string | null = null;
  let nudges = 0;
  let turnTimeouts = 0;
  const maxTurnTimeouts = 3;

  const stats = (exitPath: ExitPath): RunStats => ({
    exitPath,
    turnsUsed,
    maxTurns,
    repairCyclesUsed: ctx.repairCycles,
    maxRepairCycles: config.maxRepairCycles,
    tokensIn,
    tokensOut,
    perTurn,
    durationMs: Date.now() - startMs,
  });

  /** One outcome line, printed last at every terminal branch (AC-8.5). */
  const outcomeLine = (s: RunStats, extra?: string | null): string =>
    [
      s.exitPath,
      ctx.lastErc ? `ERC ${ctx.lastErc.ok ? 'clean' : 'failing'}` : 'ERC not run',
      ...(ctx.lastDrc ? [`DRC ${ctx.lastDrc.ok ? 'clean' : 'failing'}`] : []),
      ...(extra ? [extra] : []),
      fmtDuration(s.durationMs),
      `${fmtTokens(s.tokensIn)} in / ${fmtTokens(s.tokensOut)} out`,
    ].join(' · ');

  const fail = async (reason: string, exitPath: ExitPath): Promise<RunResult> => {
    await transcript.event('run-failed', { reason, exitPath });
    // Preserve the touched work as a stash entry before the rollback destroys
    // it, so a budget-exhaustion (or any) failure is recoverable (issue #15).
    const preserved = await preserveFailedRun(repoRoot, ctx.runId);
    if (preserved) await transcript.event('work-preserved', { stash: preserved });
    // The rollback itself can fail (git in a bad state). That must not become
    // an unhandled throw that skips run-end and summary.md — the summary is
    // most valuable exactly when the tree is left in an unknown state.
    let restoreError: string | null = null;
    try {
      await restore(repoRoot, snap);
    } catch (err) {
      restoreError = (err as Error).message;
      await transcript.event('restore-failed', { error: restoreError });
    }
    const runStats = stats(exitPath);
    await transcript.event('run-end', runStats);
    const summaryPath = await transcript.writeSummary({
      request: opts.request,
      changeId: ctx.changeId,
      plan,
      filesTouched: [...ctx.filesTouched],
      ercResult: ctx.lastErc ? (ctx.lastErc.ok ? 'clean' : `${ctx.lastErc.violations.length} violations`) : null,
      drcResult: ctx.lastDrc ? (ctx.lastDrc.ok ? 'clean' : `${ctx.lastDrc.violations.length} violations`) : null,
      legibilityResult: ctx.lastLegibility ? `${ctx.lastLegibility.error} error, ${ctx.lastLegibility.advisory} advisory` : null,
      scoreResult: ctx.lastScore !== null ? `${ctx.lastScore}/100` : null,
      decisions: ctx.decisions,
      tokensIn,
      tokensOut,
      outcome: 'failure',
      openObligations: ctx.ledger.isClear ? null : ctx.ledger.describe(),
      detail: restoreError ? `${reason}\n\nROLLBACK FAILED: ${restoreError} — the working tree may be in a partial state; inspect it with git status/git diff before rerunning` : reason,
      env: meta,
      stats: runStats,
    });
    log(`run failed: ${reason}`);
    if (restoreError) {
      log(`WARNING: rollback failed (${restoreError}); the working tree may be in a partial state`);
    } else {
      log(`working tree restored to pre-run snapshot`);
    }
    if (preserved) {
      log(
        `failed work preserved: git stash entry "copperhead failed run ${ctx.runId}" (${preserved.slice(0, 10)}); recover with \`git stash apply\`, discard with \`git stash drop\``,
      );
    }
    log(`transcript: ${transcript.jsonlPath}`);
    log(`summary: ${summaryPath}`);
    r.finish(outcomeLine(runStats));
    return {
      outcome: 'failure',
      exitPath,
      summary: reason,
      transcriptDir: transcript.dir,
      filesTouched: [],
      commit: null,
      stats: runStats,
      cacheHits: cacheHits(),
    };
  };

  let budget = maxTurns;
  for (let turn = 0; ; turn++) {
    if (turn >= budget) {
      // Budget exhausted. In an attended run this is a user decision made with
      // the cost visible, not an unconditional rollback (issue #15).
      const exhaustStats: BudgetExhaustedStats = {
        maxTurns,
        turnsUsed: turn,
        tokensIn,
        tokensOut,
        filesTouched: [...ctx.filesTouched],
        openObligations: ctx.ledger.openObligations.length,
      };
      let extra = 0;
      if (opts.onBudgetExhausted) {
        try {
          extra = Math.floor(await opts.onBudgetExhausted(exhaustStats));
        } catch {
          // A broken prompt (stdin closed mid-question, dying terminal) must
          // read as "declined" and take the preserve-and-restore path below,
          // not propagate past it and skip the rollback entirely.
          extra = 0;
        }
      }
      if (!Number.isFinite(extra) || extra <= 0) break;
      budget += extra;
      await transcript.event('budget-extended', { extraTurns: extra, budget, ...exhaustStats });
      log(`turn budget extended by ${extra} (now ${budget})`);
    }
    // Advertise EVERY tool each turn; dispatchTool enforces the edit-unlock gate
    // live at call time. Hiding locked edit tools from the turn catalog meant a
    // model that unlocked (validate_change) and edited in the SAME reply had its
    // edit silently dropped in parsing — the call named a tool the turn had not
    // advertised, so it was treated as prose, executed nothing, and returned no
    // error. The model then "verified" against an unchanged file (an empty
    // schematic even passes ERC) and finished believing it had succeeded.
    // Structural lock (SPEC.md §1.3 invariant 1): the edit tools stay OUT of the
    // advertised list until a proposal validates (`editsUnlocked`), so the model
    // is gated by omission, not by prompt text. `dispatchTool` re-checks the same
    // `availableTools(ctx)` live, so this is defense in depth. A premature edit is
    // simply not offered; once `validate_change` unlocks, the next turn advertises
    // the edit tools. (Earlier this advertised every tool to let a same-turn
    // propose→validate→edit batch through, but that traded the spec's structural
    // guarantee for one saved turn — not worth it.)
    const tools = availableTools(ctx).map((t) => t.schema);
    r.turnStart(turn + 1, maxTurns, tokensIn, tokensOut);
    r.status('thinking');
    let res: Turn;
    // Liveness heartbeat (5.1): a large-output turn can legitimately run several
    // minutes, which is otherwise indistinguishable from a hung subprocess until
    // the watchdog fires. Emit a periodic elapsed/streamed signal so an operator
    // can tell the two apart. Fires only after the first interval, so quick turns
    // stay silent; `unref` keeps it from holding the event loop open.
    const turnStartMs = Date.now();
    let streamedChars = 0;
    const heartbeat =
      config.heartbeatMs > 0
        ? setInterval(
            () => r.heartbeat({ elapsedMs: Date.now() - turnStartMs, streamedChars }),
            config.heartbeatMs,
          )
        : null;
    heartbeat?.unref?.();
    try {
      res = await withRetry(
        () =>
          withTimeout(
            () => provider.chat(messages, tools, { onStream: (chars) => (streamedChars = chars) }),
            config.turnTimeoutMs,
            () => provider.close?.(),
          ),
        { onRetry: (attempt) => log(`rate limited; retry ${attempt}`) },
      );
    } catch (err) {
      if (err instanceof TurnTimeoutError) {
        // A hung provider turn: the watchdog aborted the in-flight call and tore
        // down its subprocess. Retry the same turn a bounded number of times
        // before giving up, so a transient hang self-heals instead of stalling
        // the run forever.
        if (turnTimeouts++ < maxTurnTimeouts) {
          log(`turn exceeded ${config.turnTimeoutMs}ms; aborted the hung call and retrying (${turnTimeouts}/${maxTurnTimeouts})`);
          await transcript.event('turn-timeout', { ms: config.turnTimeoutMs, attempt: turnTimeouts });
          turn--;
          continue;
        }
        return fail(`provider turns timed out ${turnTimeouts}× (>${config.turnTimeoutMs}ms each)`, 'provider-error');
      }
      if (isRateLimit(err)) {
        const fallback = otherProvider(provider);
        if (fallback) {
          log(`failing over ${provider.name} → ${fallback.name}`);
          await transcript.event('provider-failover', { from: provider.name, to: fallback.name });
          provider = fallback;
          providers.add(provider);
          turn--;
          continue;
        }
      }
      // A saved-login session/usage limit is not a code bug and not a 429 (2.4,
      // I13): it names its own reset time and clears only then, and every turn
      // so far is already in the llm-cache — so re-running after the reset
      // replays them at ~0 tokens and resumes in place. Surface it as its own
      // exit path with the reset time and the resume instruction, rather than a
      // bare "provider error" the operator would read as a failure to debug.
      const limit = sessionLimit(err);
      if (limit) {
        const when = limit.resetsAt ? ` (resets ${limit.resetsAt})` : '';
        await transcript.event('session-limit', { resetsAt: limit.resetsAt, provider: provider.name });
        return fail(
          `${provider.name} session/usage limit reached${when} — this is a schedulable pause, not a bug. ` +
            `Wait for the reset, then re-run the same command: completed turns replay from the cache at ~0 tokens and the run resumes where it left off.`,
          'session-limit',
        );
      }
      return fail(`provider error: ${(err as Error).message}`, 'provider-error');
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      r.status(null);
    }
    turnsUsed = turn + 1;
    // A productive turn resets the timeout budget: maxTurnTimeouts is meant to
    // catch a turn that is genuinely, repeatedly stuck — not to cap the total
    // number of slow-but-recoverable turns across a whole stage. Without this a
    // long stage that merely has a few independent slow turns accumulates
    // timeouts and hard-fails even though every one of them recovered.
    turnTimeouts = 0;
    tokensIn += res.usage.inputTokens;
    tokensOut += res.usage.outputTokens;
    perTurn.push({ turn: turn + 1, in: res.usage.inputTokens, out: res.usage.outputTokens });
    await transcript.event('assistant', { text: res.text, toolCalls: res.toolCalls });

    if (res.text) {
      if (!plan) plan = res.text;
      log(res.text);
    }
    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });

    if (!res.toolCalls.length) {
      // Only *consecutive* tool-less turns are a stall. Providers emit the
      // occasional empty completion mid-run (observed live: three empties
      // spread across 31 productive turns); a cumulative counter turns those
      // into a full rollback of an otherwise-converging run.
      if (nudges++ >= 2) return fail('model stopped calling tools without finishing', 'stalled');
      messages.push({
        role: 'user',
        // A near-miss malformed tool call (#I10) gets a specific steer to re-emit
        // it; an ordinary tool-less turn gets the generic continue prompt.
        content: res.nudge ?? 'Continue using tools, or call finish({outcome, summary}) to end the run.',
      });
      continue;
    }
    nudges = 0;

    for (const call of res.toolCalls) {
      const envelope = await dispatchToolResult(ctx, call.name, call.args, { provider });
      const result = flatten(envelope);
      await transcript.event('tool', { name: call.name, args: call.args, result, envelope });
      r.toolResult(call.name, envelope.summary, envelope.ok);
      messages.push({ role: 'tool', toolCallId: call.id, content: result });
    }

    if (ctx.repairCycles > config.maxRepairCycles) {
      return fail(`repair cycles exhausted (${config.maxRepairCycles}); violations persist`, 'repair-cycles-exhausted');
    }

    const remaining = budget - turn - 1;
    if (remaining === 5 && !ctx.finishRequest) {
      messages.push({
        role: 'user',
        content:
          'Only 5 turns remain. Converge now: finish the minimal correct edit set, run run_erc (and run_drc if the board changed), run check_drift, then call finish. Batch independent tool calls in a single response (e.g. all resolve_affected calls at once) instead of one per turn.',
      });
    }

    if (ctx.finishRequest) {
      const { outcome, summary } = ctx.finishRequest;
      const files = [...ctx.filesTouched];
      if (outcome === 'refuse') {
        await restore(repoRoot, snap);
        await transcript.event('run-refused', { summary });
        const runStats = stats('refused');
        await transcript.event('run-end', runStats);
        await transcript.writeSummary({
          request: opts.request,
          changeId: ctx.changeId,
          plan,
          filesTouched: [],
          ercResult: null,
          drcResult: null,
          decisions: ctx.decisions,
          tokensIn,
          tokensOut,
          outcome: 'aborted',
          openObligations: null,
          detail: `REFUSED: ${summary}`,
          env: meta,
          stats: runStats,
        });
        log(`refused: ${summary}`);
        r.finish(outcomeLine(runStats));
        return {
          outcome: 'refused',
          exitPath: 'refused',
          summary,
          transcriptDir: transcript.dir,
          filesTouched: [],
          commit: null,
          stats: runStats,
          cacheHits: cacheHits(),
        };
      }

      const verification = [
        ctx.lastErc ? `ERC ${ctx.lastErc.ok ? 'clean' : 'FAILING'}` : 'ERC not required',
        ctx.lastDrc ? `DRC ${ctx.lastDrc.ok ? 'clean' : 'FAILING'}` : null,
      ]
        .filter(Boolean)
        .join(', ');

      if (opts.dryRun) {
        const { stdout: diff } = await execa('git', ['diff'], { cwd: repoRoot });
        const { stdout: untracked } = await execa('git', ['ls-files', '--others', '--exclude-standard'], {
          cwd: repoRoot,
        });
        log('--- dry run: proposed diff ---');
        log(diff || '(no diff)');
        if (untracked) log(`new files:\n${untracked}`);
        await restore(repoRoot, snap);
        const runStats = stats('done');
        await transcript.event('run-end', runStats);
        await transcript.writeSummary({
          request: opts.request,
          changeId: ctx.changeId,
          plan,
          filesTouched: files,
          ercResult: verification,
          drcResult: null,
          decisions: ctx.decisions,
          tokensIn,
          tokensOut,
          outcome: 'success',
          openObligations: null,
          detail: 'dry run: changes reverted',
          env: meta,
          stats: runStats,
        });
        r.finish(outcomeLine(runStats, 'dry run: changes reverted'));
        return {
          outcome: 'success',
          exitPath: 'done',
          summary,
          transcriptDir: transcript.dir,
          filesTouched: files,
          commit: null,
          stats: runStats,
          cacheHits: cacheHits(),
        };
      }

      // Bookkeeping must never cost the verified design its commit (2.1): the
      // KiCad work passed its ERC/DRC gates, so a failure appending the changelog
      // (a plain CHANGELOG.md read+write) is a warning, not a rollback. It stays
      // before commitAll so, on the normal path, the entry lands in the run's
      // single commit and a zero-edit "done" run still has something to commit;
      // if it throws, the design is committed without a changelog line rather
      // than sent through fail()'s rollback. The other bookkeeping — the openspec
      // archive — is already post-commit and non-fatal below.
      try {
        await appendChangelog(repoRoot, config, {
          changeId: ctx.changeId,
          request: opts.request,
          files,
          verification,
        });
        ctx.ledger.clear('changelog');
      } catch (err) {
        const message = (err as Error).message;
        log(`warning: changelog append failed (${message}); committing the verified design without a changelog entry`);
        await transcript.event('changelog-append-failed', { error: message });
      }

      const commitMsg = `copperhead: ${opts.request}\n\n${summary}\n\nVerification: ${verification}`;
      // A git failure here (e.g. `git add -A` exiting 128 on an embedded repo)
      // must land in summary.md as an outcome, not escape as a stack trace
      // (AC-8.6): roll back per the snapshot contract and report commit-failed.
      let commit: string;
      try {
        commit = await commitAll(repoRoot, commitMsg);
      } catch (err) {
        return fail(`commit failed: ${(err as Error).message}`, 'commit-failed');
      }
      if (ctx.changeId && existsSync(path.join(repoRoot, 'openspec', 'config.yaml'))) {
        // The verified commit already exists; discarding it because archive
        // housekeeping failed would be the worse trade, so this is a warning.
        try {
          const arch = await openspecArchive(repoRoot, ctx.changeId);
          await transcript.event('openspec-archive', { changeId: ctx.changeId, ok: arch.ok });
          if (arch.ok && (await isDirty(repoRoot))) {
            await commitAll(repoRoot, `copperhead: archive change ${ctx.changeId}`);
          }
        } catch (err) {
          const message = (err as Error).message;
          log(`warning: openspec archive failed (${message}); the run commit itself succeeded`);
          await transcript.event('openspec-archive-failed', { changeId: ctx.changeId, error: message });
        }
      }
      await transcript.event('run-committed', { commit, files });
      const runStats = stats('done');
      await transcript.event('run-end', runStats);
      await transcript.writeSummary({
        request: opts.request,
        changeId: ctx.changeId,
        plan,
        filesTouched: files,
        ercResult: ctx.lastErc ? (ctx.lastErc.ok ? 'clean' : 'FAILING') : 'not run',
        drcResult: ctx.lastDrc ? (ctx.lastDrc.ok ? 'clean' : 'FAILING') : 'not run',
        legibilityResult: ctx.lastLegibility ? `${ctx.lastLegibility.error} error, ${ctx.lastLegibility.advisory} advisory` : null,
        scoreResult: ctx.lastScore !== null ? `${ctx.lastScore}/100` : null,
        decisions: ctx.decisions,
        tokensIn,
        tokensOut,
        outcome: 'success',
        openObligations: null,
        env: meta,
        stats: runStats,
      });
      log(`committed ${commit.slice(0, 10)} (${files.length} file(s))`);
      r.finish(outcomeLine(runStats, `committed ${commit.slice(0, 10)}`));
      return {
        outcome: 'success',
        exitPath: 'done',
        summary,
        transcriptDir: transcript.dir,
        filesTouched: files,
        commit,
        stats: runStats,
        cacheHits: cacheHits(),
      };
    }
  }

  const filesAfter = await changedFiles(repoRoot, snap.head);
  return fail(
    `turn budget exhausted (${budget} turns, ${filesAfter.length} files touched but unverified)`,
    'turn-budget-exhausted',
  );
}
