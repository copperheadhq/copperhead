/**
 * `copperhead mcp` — a stdio MCP server exposing the gated pipeline to MCP
 * hosts as five opaque, outcome-level tools (design D1).
 *
 * The security boundary is tool granularity, not prompt wording. Hosts get
 * `check`, `do`, `sync` and `init` as whole-pipeline invocations, plus the
 * read-only `doctor` probe, and nothing finer: no file-edit tool, no raw KiCad
 * tool, no way to drive one step of the loop. There is therefore no sequence of MCP calls that skips the spec gate or
 * the verification gate, because every mutating path runs the same loop the CLI
 * runs. Safety rails are inherited rather than restated — this module is a
 * transport adapter over the existing command entry points, and deliberately
 * owns no policy of its own.
 *
 * Two rails are enforced here because they are properties of the transport
 * rather than of the pipeline: stdout carries only the JSON-RPC stream (every
 * human-readable byte goes to stderr, or the protocol corrupts), and mutating
 * calls are serialized per repo *within this server process*. That lock is
 * in-memory, so it does not interlock two separately spawned servers or a
 * concurrent CLI run — those are held apart by the loop's own dirty-tree
 * preflight, not by this.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

import { loadConfig, resolveModel, type ModelSource } from '../config.js';
import { runCheck } from '../commands/check.js';
import { syncVerify, syncResolve, formatSyncReport } from '../commands/sync.js';
import { runInit, InitError } from '../memory/scaffold.js';
import { SandboxError } from '../util/paths.js';
import { runDoctor } from '../commands/doctor.js';
import { runAgentLoop, type RunResult } from '../agent/loop.js';
import { kicadCliVersion } from '../kicad/cli.js';
import { seal, type ToolResult, type ToolErrorKind } from '../agent/envelope.js';
import { plainRenderer, type ProgressRenderer } from '../agent/render.js';

/** The copperhead package version, for run self-description (AC-8.1). This is
 *  deliberately not MCP_PROTOCOL_VERSION: run metadata records which copperhead
 *  produced a commit, and the transport's own version would be a false answer. */
const { version: COPPERHEAD_VERSION } = createRequire(import.meta.url)('../../package.json') as { version: string };

/**
 * Unstable by declaration (design D7). The `0.` major is load-bearing: it is
 * the signal to hosts that tool names, input schemas and result shapes may
 * change in any release, and it is what defers a registry listing until the
 * stabilization criteria in the proposal are met. A test asserts the `0.`, so
 * removing the experimental status is a deliberate edit rather than a drift.
 */
export const MCP_PROTOCOL_VERSION = '0.1.0';

/** The entire surface. Anything not on this list is not reachable over MCP. */
export const PIPELINE_TOOL_NAMES = [
  'copperhead_check',
  'copperhead_do',
  'copperhead_sync',
  'copperhead_init',
  'copperhead_doctor',
] as const;

export type PipelineToolName = (typeof PIPELINE_TOOL_NAMES)[number];

/**
 * Per-tool input schema versions, bumped when a tool's inputs change shape.
 * Separate from MCP_PROTOCOL_VERSION so one tool changing does not imply the
 * whole surface did.
 */
export const TOOL_SCHEMA_VERSIONS: Record<PipelineToolName, number> = {
  copperhead_check: 1,
  copperhead_do: 1,
  copperhead_sync: 1,
  copperhead_init: 1,
  copperhead_doctor: 1,
};

/** Human-readable output goes to stderr; stdout belongs to JSON-RPC alone. */
const note = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/** A sealed failure envelope. `seal` redacts, so a key can never ride out. */
export function failure(kind: ToolErrorKind, message: string): ToolResult {
  return seal({ ok: false, summary: message, error: { kind, message } });
}

/**
 * Resolve the model for an LLM-backed tool, converting the two ways model
 * resolution can fail into typed errors a host agent can act on: no credential
 * at all, and two credentials with nothing to choose between them. Neither is
 * an exception — a host that cannot run `do` should be told why in a result.
 */
async function resolveModelOrFail(
  repoRoot: string,
): Promise<{ model: string; source: ModelSource } | { error: ToolResult }> {
  try {
    const config = await loadConfig(repoRoot);
    const { model, source } = resolveModel(undefined, config);
    return { model, source };
  } catch (err) {
    // `unavailable` rather than `validation`: the call was well-formed, the
    // environment just cannot serve it.
    return { error: failure('unavailable', (err as Error).message) };
  }
}

/** kicad-cli is a hard precondition for every tool, exactly as in the CLI. */
async function requireKicad(): Promise<{ version: string } | { error: ToolResult }> {
  try {
    return { version: await kicadCliVersion() };
  } catch (err) {
    return {
      error: failure(
        'unavailable',
        `kicad-cli is not available: ${(err as Error).message}. Install KiCad 9+ and ensure kicad-cli is on PATH.`,
      ),
    };
  }
}

/**
 * Mutating tools are serialized per repo. Rejecting rather than queueing is
 * deliberate: a `do` run can take minutes, and a host blocked on an invisible
 * queue looks hung, while a typed busy error is something an agent can relay
 * and retry. Concurrent `check` calls are unrestricted — they mutate nothing.
 */
export class RepoLocks {
  private readonly busy = new Set<string>();

  tryAcquire(repoRoot: string): boolean {
    if (this.busy.has(repoRoot)) return false;
    this.busy.add(repoRoot);
    return true;
  }

  release(repoRoot: string): void {
    this.busy.delete(repoRoot);
  }

  isBusy(repoRoot: string): boolean {
    return this.busy.has(repoRoot);
  }
}

/** Progress sink: what the server needs from a host to report a long run. */
export interface ProgressSink {
  (update: { message: string; progress: number }): void;
}

/**
 * A ProgressRenderer that mirrors loop progress onto MCP progress
 * notifications. `progress` is a monotonically rising count of observed events
 * rather than a percentage: the loop cannot know how many turns a run will take,
 * and inventing a denominator would be a worse lie than an open-ended counter.
 */
export function mcpRenderer(sink: ProgressSink): ProgressRenderer {
  let ticks = 0;
  const emit = (message: string): void => {
    ticks += 1;
    sink({ message, progress: ticks });
  };
  const base = plainRenderer((line) => {
    note(line);
  });
  return {
    log: (line) => {
      base.log(line);
    },
    turnStart: (turn, maxTurns, tokensIn, tokensOut) => {
      base.turnStart(turn, maxTurns, tokensIn, tokensOut);
      emit(`turn ${turn}/${maxTurns}`);
    },
    toolResult: (name, firstLine, ok, viewHint) => {
      base.toolResult(name, firstLine, ok, viewHint);
      emit(`${name}: ${firstLine}`);
    },
    status: (text) => {
      base.status(text);
    },
    heartbeat: (info) => {
      base.heartbeat(info);
      emit('working');
    },
    finish: (line) => {
      base.finish(line);
      emit(line);
    },
  };
}

/**
 * Map a finished run onto the status vocabulary hosts see. `rolled_back` is the
 * honest default for every non-success exit path that is not a refusal: the
 * loop restores its git snapshot on the way out, so "the run failed" and "the
 * tree is back where it started" are the same fact.
 */
export function runStatus(res: RunResult, dryRun: boolean): 'committed' | 'rolled_back' | 'refused' | 'dry_run' {
  if (res.outcome === 'refused') return 'refused';
  if (res.outcome === 'success') return dryRun ? 'dry_run' : 'committed';
  return 'rolled_back';
}

export interface ServerOptions {
  repoRoot: string;
}

/**
 * Build the server and register the tools. Exported separately from
 * `startMcpServer` so tests can drive the tool surface without a transport.
 */
export function createMcpServer(opts: ServerOptions): McpServer {
  const { repoRoot } = opts;
  const locks = new RepoLocks();

  const server = new McpServer(
    { name: 'copperhead', version: MCP_PROTOCOL_VERSION },
    {
      instructions:
        'EXPERIMENTAL, UNSTABLE SURFACE: tool names, inputs and result shapes may change in any release. ' +
        'Use these tools to change or verify a KiCad project instead of editing .kicad_sch / .kicad_pcb files ' +
        'directly. Every mutation runs a spec-gated, verified, rollback-on-failure pipeline; editing the files ' +
        'yourself bypasses all of it.',
    },
  );

  const toMcp = (result: ToolResult): { content: { type: 'text'; text: string }[]; isError?: boolean } => ({
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    ...(result.ok ? {} : { isError: true }),
  });

  server.registerTool(
    'copperhead_check',
    {
      title: 'Verify the KiCad project',
      description:
        'Run ERC, DRC, doc-drift and spec validation on the project. Makes no model call and no network call, ' +
        'and changes nothing. Safe to call at any time, including concurrently.',
      inputSchema: {},
      _meta: { schemaVersion: TOOL_SCHEMA_VERSIONS.copperhead_check },
    },
    async () => {
      const kicad = await requireKicad();
      if ('error' in kicad) return toMcp(kicad.error);
      try {
        const res = await runCheck(repoRoot, (s) => {
          note(s);
        });
        return toMcp(
          seal({
            ok: res.ok,
            summary: res.ok ? 'check passed' : 'check found violations',
            viewHint: 'diagnostic',
            data: res,
          }),
        );
      } catch (err) {
        return toMcp(failure('exception', (err as Error).message));
      }
    },
  );

  server.registerTool(
    'copperhead_doctor',
    {
      title: 'Check that this host can run copperhead',
      description:
        'Probe the environment copperhead needs: node, kicad-cli, git, openspec, and whether a model credential ' +
        'resolves. Makes no model call and no network call, and changes nothing. Call this first when another ' +
        'tool reports that something is unavailable.',
      inputSchema: {},
      _meta: { schemaVersion: TOOL_SCHEMA_VERSIONS.copperhead_doctor },
    },
    async () => {
      // Deliberately no requireKicad() preflight. A missing kicad-cli is the
      // single most likely thing a host needs told about, and gating this tool
      // on it would make the diagnostic fail in exactly the case it exists for;
      // runDoctor probes kicad-cli and reports it as a failed check instead.
      try {
        const report = await runDoctor({ repoRoot });
        const failed = report.checks.filter((c) => c.status === 'fail');
        return toMcp(
          seal({
            ok: report.ok,
            summary: report.ok
              ? 'environment is ready'
              : `${failed.length} check(s) failed: ${failed.map((c) => c.name).join(', ')}`,
            viewHint: 'diagnostic',
            data: report,
          }),
        );
      } catch (err) {
        return toMcp(failure('exception', (err as Error).message));
      }
    },
  );

  server.registerTool(
    'copperhead_init',
    {
      title: 'Scaffold design docs from the schematic',
      description:
        'Generate the docs/ memory scaffold from an existing schematic. Also installs a git pre-commit hook ' +
        'that runs copperhead check before each commit. Idempotent, and refuses rather than overwriting docs ' +
        'a human has hand-edited.',
      inputSchema: {
        path: z.string().optional().describe('where to look for KiCad files, relative to the repo root'),
      },
      _meta: { schemaVersion: TOOL_SCHEMA_VERSIONS.copperhead_init },
    },
    async ({ path: searchPath }) => {
      const kicad = await requireKicad();
      if ('error' in kicad) return toMcp(kicad.error);
      if (!locks.tryAcquire(repoRoot)) {
        return toMcp(failure('unavailable', 'another copperhead run is in progress for this repo; retry shortly'));
      }
      try {
        const res = await runInit({
          repoRoot,
          ...(searchPath ? { searchPath } : {}),
          force: false,
          installHooks: true,
        });
        const refused = res.refused.length > 0;
        return toMcp(
          seal({
            ok: !refused,
            summary: refused
              ? `init refused ${res.refused.length} hand-edited doc(s)`
              : `init wrote ${res.created.length} file(s)`,
            viewHint: 'mutation',
            data: res,
          }),
        );
      } catch (err) {
        // A missing schematic is the user's situation, not a crash: report it
        // as a validation failure so the host can ask for a path.
        // A missing schematic and a path that escapes the repo are both the
        // caller's situation, not a crash: report them as validation failures
        // so the host can correct the input rather than retrying blindly.
        const kind: ToolErrorKind =
          err instanceof InitError || err instanceof SandboxError ? 'validation' : 'exception';
        return toMcp(failure(kind, (err as Error).message));
      } finally {
        locks.release(repoRoot);
      }
    },
  );

  server.registerTool(
    'copperhead_do',
    {
      title: 'Make a verified change to the project',
      description:
        'Run the full gated pipeline for a change request: propose, spec-gate, edit, verify with ERC/DRC, repair, ' +
        'and commit — or roll back to the pre-run state if verification cannot be satisfied. This is the only way ' +
        'to change the project. Long-running; progress is streamed. Requires an API key in the environment.',
      inputSchema: {
        request: z.string().min(1).describe('the change request, in natural language'),
        dry_run: z.boolean().optional().describe('propose the change and write nothing'),
      },
      _meta: { schemaVersion: TOOL_SCHEMA_VERSIONS.copperhead_do },
    },
    async ({ request, dry_run: dryRun }, extra) => {
      const kicad = await requireKicad();
      if ('error' in kicad) return toMcp(kicad.error);
      const resolved = await resolveModelOrFail(repoRoot);
      if ('error' in resolved) return toMcp(resolved.error);
      if (!locks.tryAcquire(repoRoot)) {
        return toMcp(failure('unavailable', 'another copperhead run is in progress for this repo; retry shortly'));
      }
      const progressToken = extra?._meta?.progressToken;
      const sink: ProgressSink = (update): void => {
        if (progressToken === undefined) return;
        void extra
          ?.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: update.progress, message: update.message },
          })
          .catch(() => {
            // A host that stopped listening must not fail the run.
          });
      };
      try {
        const res = await runAgentLoop({
          repoRoot,
          request,
          model: resolved.model,
          // allowDirty is deliberately not exposed: it is a safety rail, and a
          // tool input that switches a rail off is a rail a host can bypass.
          allowDirty: false,
          dryRun: dryRun ?? false,
          // No confirm callback and no budget-extension prompt: there is no
          // human on this transport, so the loop must fail rather than block.
          interactive: false,
          renderer: mcpRenderer(sink),
          meta: {
            command: 'do',
            modelSource: resolved.source,
            version: COPPERHEAD_VERSION,
            kicadCliVersion: kicad.version,
          },
        });
        const status = runStatus(res, dryRun ?? false);
        return toMcp(
          seal({
            // A rollback is a successful tool call whose result says the run
            // did not land (design D6). Only `refused` is reported as not-ok,
            // because that is the pipeline declining rather than failing.
            ok: status !== 'refused',
            summary: `${status}: ${res.summary}`,
            viewHint: 'mutation',
            data: {
              status,
              commit: res.commit,
              filesTouched: res.filesTouched,
              transcriptDir: res.transcriptDir,
              exitPath: res.exitPath,
              stats: res.stats,
            },
          }),
        );
      } catch (err) {
        return toMcp(failure('exception', (err as Error).message));
      } finally {
        locks.release(repoRoot);
      }
    },
  );

  server.registerTool(
    'copperhead_sync',
    {
      title: 'Verify design-state consistency, and optionally resolve drift',
      description:
        'Run the deterministic consistency check across docs, constraints and the KiCad files. With resolve=true, ' +
        'additionally run the gated loop to fix the drift it found. Requirement violations are always reported and ' +
        'never auto-resolved — those are for a human. resolve=true requires an API key in the environment.',
      inputSchema: {
        resolve: z.boolean().optional().describe('run the LLM resolve phase for resolvable drift'),
      },
      _meta: { schemaVersion: TOOL_SCHEMA_VERSIONS.copperhead_sync },
    },
    async ({ resolve }, extra) => {
      const kicad = await requireKicad();
      if ('error' in kicad) return toMcp(kicad.error);
      let report;
      try {
        report = await syncVerify(repoRoot);
      } catch (err) {
        return toMcp(failure('exception', (err as Error).message));
      }
      const verdict = (summary: string, ok = true): ToolResult =>
        seal({ ok, summary, viewHint: resolve ? 'mutation' : 'diagnostic', data: report });

      if (!resolve) return toMcp(verdict(formatSyncReport(report)));

      // Truth precedence (design D14): a requirement violation is never
      // silently resolved, so the resolve phase does not start when one exists.
      if (report.violations.length) {
        return toMcp(
          verdict(
            `${report.violations.length} requirement violation(s) found; these are never auto-resolved. ` +
              `Resolve them by hand or change the requirement.\n\n${formatSyncReport(report)}`,
            false,
          ),
        );
      }
      if (!report.resolvable.length) return toMcp(verdict('design state is consistent; nothing to resolve'));

      const resolved = await resolveModelOrFail(repoRoot);
      if ('error' in resolved) return toMcp(resolved.error);
      if (!locks.tryAcquire(repoRoot)) {
        return toMcp(failure('unavailable', 'another copperhead run is in progress for this repo; retry shortly'));
      }
      // The report above was computed before the lock was held, so another run
      // may have rewritten the tree in between. Re-verify now that nothing else
      // can move, rather than asking the loop to fix drift that is already gone.
      const fresh = await syncVerify(repoRoot);
      if (fresh.violations.length || !fresh.resolvable.length) {
        locks.release(repoRoot);
        return toMcp(
          seal({
            ok: !fresh.violations.length,
            summary: fresh.violations.length
              ? `${fresh.violations.length} requirement violation(s) found; these are never auto-resolved.`
              : 'design state is consistent; nothing to resolve',
            viewHint: 'diagnostic',
            data: fresh,
          }),
        );
      }
      const progressToken = extra?._meta?.progressToken;
      const sink: ProgressSink = (update): void => {
        if (progressToken === undefined) return;
        void extra
          ?.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: update.progress, message: update.message },
          })
          .catch(() => {
            // A host that stopped listening must not fail the run.
          });
      };
      try {
        const res = await syncResolve(
          repoRoot,
          fresh,
          resolved.model,
          (s) => {
            note(s);
          },
          {
            renderer: mcpRenderer(sink),
            meta: {
              command: 'sync',
              modelSource: resolved.source,
              version: COPPERHEAD_VERSION,
              kicadCliVersion: kicad.version,
            },
          },
        );
        return toMcp(
          seal({
            ok: res.ok,
            summary: res.ok ? 'drift resolved and verified' : `resolve did not land: ${res.run.summary}`,
            viewHint: 'mutation',
            data: {
              resolved: res.ok,
              report: fresh,
              commit: res.run.commit,
              filesTouched: res.run.filesTouched,
              transcriptDir: res.run.transcriptDir,
              exitPath: res.run.exitPath,
            },
          }),
        );
      } catch (err) {
        return toMcp(failure('exception', (err as Error).message));
      } finally {
        locks.release(repoRoot);
      }
    },
  );

  return server;
}

/** Start the server on stdio and serve until the host closes the transport. */
export async function startMcpServer(opts: ServerOptions): Promise<void> {
  if (!existsSync(opts.repoRoot)) {
    throw new Error(`repo not found: ${opts.repoRoot}`);
  }
  const server = createMcpServer(opts);
  note(
    `copperhead mcp ${MCP_PROTOCOL_VERSION} (EXPERIMENTAL — unstable surface: tool names, inputs and results may ` +
      `change in any release)`,
  );
  note(`repo: ${opts.repoRoot}`);
  await server.connect(new StdioServerTransport());
}
