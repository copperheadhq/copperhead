#!/usr/bin/env node
import { Command } from 'commander';
import { setMaxListeners } from 'node:events';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { loadConfig, resolveModel, type ModelSource } from './config.js';
import { pickModel } from './util/select.js';
import { runInit, InitError } from './memory/scaffold.js';
import { runCheck } from './commands/check.js';
import { runDoctor, formatDoctor } from './commands/doctor.js';
import { syncVerify, syncResolve, formatSyncReport } from './commands/sync.js';
import { runCreate } from './commands/create.js';
import { runDemo, demoTourText } from './commands/demo.js';
import { runRepl } from './commands/repl.js';
import {
  runExportBom,
  parseSupplier,
  parseBoards,
  parseSpares,
  ExportError,
} from './commands/export.js';
import { DEFAULT_BOARDS, DEFAULT_SPARES } from './kicad/bom-export.js';
import { runAgentLoop, type BudgetExhaustedStats } from './agent/loop.js';
import { makeRenderer } from './agent/render.js';
import { kicadCliVersion } from './kicad/cli.js';
import { loadEnvFile } from './util/env.js';
import { budgetExtraTurns, budgetPromptText, parseMaxTurns, repoOf, reviewProviderFactory } from './util/cli-args.js';

// Read .env from the working directory before any command resolves a model or a
// provider. Loaded here rather than per-command so `check` behaves identically,
// though check never reads a key: it stays LLM-free and network-free either way.
// A real environment variable always beats the file.
loadEnvFile(process.cwd());

// Single source of truth for the version. Both src/cli.ts (via tsx) and
// dist/cli.js sit one level below the package root, so the path holds either
// way, and a release can never ship a version string that disagrees with the
// package it was published as.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

const program = new Command();

async function confirmTty(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * Attended runs get a decision point instead of a rollback when the turn
 * budget runs out (issue #15). Non-TTY (CI, pipes) keeps fail-and-restore.
 */
function budgetContinuePrompt(): ((stats: BudgetExhaustedStats) => Promise<number>) | undefined {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return async (stats) =>
    (await confirmTty(budgetPromptText(stats))) ? budgetExtraTurns(stats) : 0;
}

program
  .name('copperhead')
  .description('Cursor for circuit boards: an AI agent for real KiCad repositories')
  .version(version)
  .option('--repo <path>', 'target repository (default: cwd)')
  .option('--json', 'machine-readable output')
  .option('--plain', 'plain log-style output (no interactive status line)');

const rendererOf = () =>
  makeRenderer({ json: Boolean(program.opts().json), plain: Boolean(program.opts().plain) });

program
  .command('repl', { isDefault: true })
  .description('interactive agent shell (default when no command is given)')
  .argument('[request...]', 'optional first change request before the prompt loop')
  .option('--model <model>', 'codex | cursor | gpt-5 | claude | claude-code (or a provider-specific model id)')
  .option('--max-turns <n>', 'turn budget per request')
  .option('--allow-dirty', 'let turns run on a dirty working tree')
  .option('--interactive', 'pause for approval after each proposal validates')
  .action(
    async (
      requestParts: string[],
      opts: { model?: string; maxTurns?: string; allowDirty?: boolean; interactive?: boolean },
    ) => {
      const repo = repoOf(program.opts());
      if (program.opts().json) {
        console.error(
          'copperhead: --json is not supported with the interactive shell. Use `copperhead do "<request>" --json`.',
        );
        process.exit(1);
      }
      try {
        const kicadVer = await kicadCliVersion();
        const config = await loadConfig(repo);
        const renderer = rendererOf();
        let model: string;
        let source: ModelSource;
        try {
          ({ model, source } = resolveModel(opts.model, config));
        } catch (err) {
          // No model anywhere (flag, COPPERHEAD_MODEL, config, .env keys):
          // on a TTY, offer an interactive pick instead of refusing to start.
          if (!process.stdin.isTTY || !process.stdout.isTTY) throw err;
          console.log('No model configured for this session, pick one:');
          const chosen = await pickModel();
          if (!chosen) throw err;
          model = chosen;
          source = 'picker';
        }
        const continuePrompt = budgetContinuePrompt();
        const seed = requestParts.length ? requestParts.join(' ') : undefined;
        const res = await runRepl({
          repoRoot: repo,
          model,
          modelSource: source,
          version,
          kicadCliVersion: kicadVer,
          ...(opts.maxTurns ? { maxTurns: parseMaxTurns(opts.maxTurns) } : {}),
          allowDirty: opts.allowDirty ?? false,
          interactive: opts.interactive ?? false,
          ...(seed ? { seed } : {}),
          confirm: confirmTty,
          ...(continuePrompt ? { onBudgetExhausted: continuePrompt } : {}),
          renderer,
        });
        process.exit(res.ok ? 0 : 1);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    },
  );

program
  .command('init')
  .description('scaffold docs/ from an existing schematic; idempotent')
  .option('--path <dir>', 'where to look for KiCad files', '.')
  .option('--force', 'overwrite hand-edited generated docs')
  .option('--no-hooks', 'skip git pre-commit hook installation')
  .action(async (opts: { path: string; force?: boolean; hooks: boolean }) => {
    const repo = repoOf(program.opts());
    try {
      await kicadCliVersion();
      const res = await runInit({
        repoRoot: repo,
        searchPath: opts.path,
        force: opts.force ?? false,
        installHooks: opts.hooks,
      });
      if (program.opts().json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        for (const f of res.created) console.log(`created ${f}`);
        for (const f of res.skipped) console.log(`unchanged ${f}`);
        for (const f of res.refused) console.log(`REFUSED (hand-edited; use --force): ${f}`);
      }
      process.exit(res.refused.length ? 1 : 0);
    } catch (err) {
      console.error(err instanceof InitError ? err.message : (err as Error).message);
      process.exit(1);
    }
  });

const checkAction = async (): Promise<void> => {
  const repo = repoOf(program.opts());
  const json = Boolean(program.opts().json);
  try {
    await kicadCliVersion();
    const res = await runCheck(repo, json ? () => {} : (s) => console.log(s));
    if (json) console.log(JSON.stringify(res, null, 2));
    process.exit(res.ok ? 0 : 1);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
};

program
  .command('check')
  .alias('verify')
  .description('ERC + DRC + doc-drift + spec validation; no LLM calls; CI-safe')
  .action(checkAction);

program
  .command('explain')
  .description('look up a refdes, net, or pin in the schematic and docs; no LLM, no network')
  .argument('<query>', 'refdes (U1), net (GND), or pin (U1.GPIO14 / R2.1)')
  .action(async (query: string) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { runExplain } = await import('./commands/explain.js');
      const { result, text } = await runExplain(repo, query);
      if (json) console.log(JSON.stringify(result, null, 2));
      else process.stdout.write(text.startsWith('\n') ? text.slice(1) : text);
      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      const message = (err as Error).message;
      if (json) console.log(JSON.stringify({ ok: false, error: message, suggestions: [] }, null, 2));
      else console.error(message);
      process.exit(1);
    }
  });

// `draft` and `score` are command groups taking the artifact as a noun
// (`draft schematic` today, `draft pcb` when layout drafting exists), so the
// verb alone never has to guess what it applies to.
const draftGroup = program
  .command('draft')
  .description('deterministically draft an artifact from its declared intent; no LLM, no network');
draftGroup
  .command('schematic')
  .description('draft the schematic from schematic.intent.json')
  .option('--intent <path>', 'repo-relative intent file (default: schematic.intent.json beside the schematic)')
  .action(async (opts: { intent?: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { loadConfig } = await import('./config.js');
      const { draftSchematic, defaultIntentPath, formatSchematicDraftReport } = await import('./kicad/draft/draft.js');
      const config = await loadConfig(repo);
      if (!config.schematic) {
        console.error('no schematic configured in .copperhead/config.json');
        process.exit(1);
      }
      const res = await draftSchematic({
        repoRoot: repo,
        schematic: config.schematic,
        intentPath: opts.intent ?? defaultIntentPath(config.schematic),
        docsDir: config.docs,
      });
      if (!res.ok) {
        if (json) console.log(JSON.stringify({ ok: false, findings: res.findings }, null, 2));
        else console.error(res.message);
        process.exit(1);
      }
      if (json) console.log(JSON.stringify({ ok: true, report: res.report }, null, 2));
      else console.log(formatSchematicDraftReport(res.report));
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

const scoreGroup = program
  .command('score')
  .description('quantitative quality score for an artifact; advisory exit code; no LLM, no network');
scoreGroup
  .command('schematic')
  .description('legibility and layout score for the schematic')
  .option('--file <path>', 'score this .kicad_sch instead of the configured schematic (any sheet, no repo needed)')
  .action(async (opts: { file?: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { loadConfig } = await import('./config.js');
      const { scoreSchematic, formatScore } = await import('./kicad/score.js');
      const path = await import('node:path');
      if (opts.file) {
        const report = await scoreSchematic(path.resolve(opts.file), { docsDir: null });
        console.log(json ? JSON.stringify(report, null, 2) : formatScore(report));
        process.exit(0);
      }
      const config = await loadConfig(repo);
      if (!config.schematic) {
        console.error('no schematic configured in .copperhead/config.json');
        process.exit(1);
      }
      const report = await scoreSchematic(path.join(repo, config.schematic), {
        docsDir: path.join(repo, config.docs),
        ...(config.legibility ? { config: config.legibility } : {}),
      });
      console.log(json ? JSON.stringify(report, null, 2) : formatScore(report));
      process.exit(0); // the exit code never depends on the composite (AC-16.26 family)
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// RFC 11 Section 14.4: the views of a change to a board. They read files only:
// no LLM, no network, no CAD tool, and they write nothing.
const pcbGroup = program
  .command('pcb')
  .description('PCB layout (RFC 11, RFC 15): import, place, reuse, route, verify, render, diff; no LLM or network unless --model');
pcbGroup
  .command('diff <before> <after>')
  .description(
    'what <after> changes relative to <before>: each a layout input, a candidate (after only), a .kicad_pcb, or <rev>:<path>.kicad_pcb',
  )
  .option('--blocks <dir>', 'where the block layouts a candidate places are (default: beside <after>)')
  .option('--project <id>', 'project identifiers are derived under for a board (default: the board file name)')
  .option('--json', 'print the placement diff record (RFC 11 Section 6.11)')
  .action(async (before: string, after: string, opts: { blocks?: string; project?: string; json?: boolean }) => {
    try {
      const { pcbDiff } = await import('./commands/pcb.js');
      const res = await pcbDiff(before, after, {
        ...(opts.blocks && { blocks: opts.blocks }),
        ...(opts.project && { project: opts.project }),
        cwd: repoOf(program.opts()),
      });
      // What an import could not represent goes to stderr, so --json stays one record.
      for (const note of res.notes) console.error(`note: ${note}`);
      if (opts.json || program.opts().json) console.log(JSON.stringify(res.diff, null, 2));
      else process.stdout.write(res.text);
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('textconv <board>')
  .description('print a .kicad_pcb one fact per line, for git diff: set diff.copperhead-pcb.textconv to this command')
  .action(async (board: string) => {
    try {
      const { pcbTextconv } = await import('./commands/pcb.js');
      process.stdout.write(await pcbTextconv(board));
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

const pcbExit = (status: string): never => {
  const codes: Record<string, number> = { PASS: 0, PARTIAL: 0, HOLD: 2, REFUSE: 3, UNSUPPORTED: 4, TIMEOUT: 5, ENGINE_ERROR: 6, INVALID_OUTPUT: 7 };
  process.exit(codes[status] ?? 1);
};
const pcbBoard = async (repo: string, boardOpt?: string): Promise<{ boardPath: string; config: Awaited<ReturnType<typeof import('./config.js')['loadConfig']>> }> => {
  const { loadConfig } = await import('./config.js');
  const path = await import('node:path');
  const config = await loadConfig(repo);
  const rel = boardOpt ?? config.board;
  if (!rel) {
    console.error('no board configured; pass --board or set "board" in .copperhead/config.json');
    process.exit(1);
  }
  return { boardPath: path.resolve(repo, rel), config };
};
pcbGroup
  .command('import')
  .description('read the board into the canonical IR and report what it holds')
  .option('--board <path>', 'board to import (default: the configured board)')
  .action(async (opts: { board?: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { boardPath } = await pcbBoard(repo, opts.board);
      const { importBoard } = await import('./pcb/ir/kicad/import.js');
      const { readFile } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const proPath = boardPath.replace(/\.kicad_pcb$/, '.kicad_pro');
      const { design, ecad, warnings } = importBoard({ boardText: await readFile(boardPath, 'utf8'), boardPath, ...(existsSync(proPath) ? { projectText: await readFile(proPath, 'utf8') } : {}) });
      const copper = design.board.layers.filter((l) => l.kind === 'copper').map((l) => l.id);
      const summary = { hash: design.source.contentHash, fileVersion: design.source.boardFileVersion, netDialect: design.source.netDialect, components: design.components.length, nets: design.nets.length, copperLayers: copper, segments: design.routing.segments.length, vias: design.routing.vias.length, zones: design.routing.zones.length, keepouts: design.board.keepouts.length, netClasses: ecad.netClasses.map((c) => c.name), druRules: ecad.druRules.length, lossy: design.lossy, warnings };
      if (json) console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(`imported ${design.components.length} component(s), ${design.nets.length} net(s), ${copper.join('/')} copper, ${design.routing.segments.length} segment(s), ${design.routing.vias.length} via(s), ${design.routing.zones.length} zone(s); file version ${design.source.boardFileVersion} (${design.source.netDialect} nets); hash ${design.source.contentHash.slice(0, 12)}`);
        for (const l of design.lossy) console.log(`  lossy: ${l}`);
        for (const w of warnings) console.log(`  warning: ${w}`);
      }
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('route')
  .description('route the board with local engines, verify every candidate, and select one')
  .option('--board <path>', 'board to route (default: the configured board)')
  .option('--routers <ids>', 'comma-separated engine ids in preference order (default: config or every built-in router)')
  .option('--mode <mode>', 'single | race | ensemble | staged (default: config or single)')
  .option('--critical-nets <names>', 'staged mode: comma-separated nets routed after power and before the bulk')
  .option('--layer-pref <specs>', 'comma-separated <layer>=<horizontal|vertical|any|off>, e.g. F.Cu=horizontal,B.Cu=vertical')
  .option('--nets <names>', 'comma-separated net names to route (default: all)')
  .option('--preserve', 'keep the copper already on the board', false)
  .option('--seed <n>', 'seed for seeded engines', '0')
  .option('--budget-seconds <n>', 'engine-second and wall-clock budget')
  .option('--allow-harness-engines', 'let the reference router compete (harness fixtures only)', false)
  .option('--apply', 'write the selected candidate over the board file', false)
  .option('--run-dir <path>', 'where to write the run (default: .copperhead/runs/<ts>/layout)')
  .action(async (opts: { board?: string; routers?: string; mode?: string; nets?: string; criticalNets?: string; layerPref?: string; preserve: boolean; seed: string; budgetSeconds?: string; allowHarnessEngines: boolean; apply: boolean; runDir?: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { boardPath, config } = await pcbBoard(repo, opts.board);
      const { routeBoard } = await import('./pcb/engines/route.js');
      const path = await import('node:path');
      const { copyFile } = await import('node:fs/promises');
      const pcb = config.pcb ?? {};
      const budget = Number(opts.budgetSeconds ?? pcb.budgetSeconds ?? 600);
      const runDir = opts.runDir ? path.resolve(repo, opts.runDir) : path.join(repo, '.copperhead', 'runs', new Date().toISOString().replace(/[:.]/g, '-'), 'layout');
      const routers = opts.routers?.split(',').map((s) => s.trim()).filter(Boolean) ?? pcb.routers;
      const mode = (opts.mode ?? pcb.mode ?? 'single') as 'single' | 'race' | 'ensemble' | 'staged';
      const layerPreferences = (opts.layerPref ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((spec) => {
        const [layerId, m] = spec.split('=');
        if (!layerId || !['horizontal', 'vertical', 'any', 'off'].includes(m ?? '')) throw new Error(`--layer-pref: expected <layer>=<horizontal|vertical|any|off>, got "${spec}"`);
        return { layerId, mode: m as 'horizontal' | 'vertical' | 'any' | 'off' };
      });
      const res = await routeBoard({
        repoRoot: repo, boardPath, runDir, ...(routers ? { routers } : {}), mode, ...(opts.nets ? { netNames: opts.nets.split(',').map((s) => s.trim()) } : {}), ...(opts.criticalNets ? { criticalNetNames: opts.criticalNets.split(',').map((s) => s.trim()) } : {}), ...(layerPreferences.length ? { layerPreferences } : {}), preserveExistingRoutes: opts.preserve, seed: Number(opts.seed), limits: { engineSeconds: budget, wallSeconds: budget }, ...(pcb.profile ? { profile: pcb.profile } : {}), ...(pcb.scoring ? { scoring: pcb.scoring } : {}), ...(pcb.maxParallelEngines ? { maxParallel: pcb.maxParallelEngines } : {}),
        policy: { network: pcb.allowRemoteEngines ? 'required' : 'optional', allowHarnessEngines: opts.allowHarnessEngines, denyLicenses: [] },
        log: json ? () => {} : (l) => console.error(l),
      });
      if (opts.apply) {
        const sel = res.ranking.selected ? res.candidates.find((c) => c.engineId === res.ranking.selected) : undefined;
        if (sel && (res.outcome.status === 'PASS' || res.outcome.status === 'PARTIAL')) {
          await copyFile(sel.pcbPath, boardPath);
          res.outcome.detail.push(`applied ${res.ranking.selected} to ${path.relative(repo, boardPath)}`);
        } else res.outcome.detail.push('nothing applied; the board is unchanged');
        // the evidence in docs/LAYOUT.md is what `check` re-verifies against (ADR 0009); a refusal is evidence too
        const { evidenceFromRun, recordEvidence } = await import('./pcb/layout-stage.js');
        const verdict = await recordEvidence(repo, config.docs, boardPath, await evidenceFromRun(repo, boardPath, res));
        res.outcome.detail.push(`evidence recorded in ${path.join(config.docs, 'LAYOUT.md')}${verdict.ok ? '' : ` (${verdict.reason})`}`);
      }
      if (json) console.log(JSON.stringify({ ...res.outcome, diagnostics: res.outcome.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message })), runDir: res.runDir, ranking: res.ranking, ineligible: res.ineligible }, null, 2));
      else {
        console.log(`${res.outcome.status}: ${res.outcome.summary}`);
        for (const d of res.outcome.detail) console.log(`  ${d}`);
        console.log(`  run: ${path.relative(repo, res.runDir)}; render ${path.relative(repo, path.join(res.runDir, "board.svg"))}`);
      }
      pcbExit(res.outcome.status);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('place')
  .description('place the board through the wrapped placers, verify every candidate, and rank them (no model)')
  .option('--board <path>', 'board to place (default: the configured board)')
  .option('--placers <ids>', 'comma-separated engine ids in preference order (default: config or every built-in placer)')
  .option('--plan <path>', 'placement plan written by copperhead pcb plan (subsystems, anchors, connector edges); read as data, so this command stays LLM-free')
  .option('--mode <mode>', 'single | race | ensemble (default: config or single)')
  .option('--movable <refs>', 'comma-separated refdes to move (default: every part not locked in KiCad)')
  .option('--seed <n>', 'seed for seeded engines', '0')
  .option('--budget-seconds <n>', 'engine-second and wall-clock budget')
  .option('--no-probe', 'skip the routability probe on each candidate')
  .option('--probe-router <id>', 'router for the probe', 'router-freerouting')
  .option('--allow-harness-engines', 'let the reference placer and router compete (harness fixtures only)', false)
  .option('--blocks', 'staged plan: derive functional blocks from docs/SUBSYSTEMS.md and schematic.intent.json, place each block anchor in its signal-flow slot first', false)
  .option('--references', 'apply the approved (or permissively licensed) cached reference block per anchor as stage 3; implies --blocks', false)
  .option('--apply', 'write the selected candidate over the board file', false)
  .option('--run-dir <path>', 'where to write the run (default: .copperhead/runs/<ts>/placement)')
  .action(async (opts: { board?: string; placers?: string; plan?: string; mode?: string; movable?: string; seed: string; budgetSeconds?: string; probe: boolean; probeRouter: string; allowHarnessEngines: boolean; blocks: boolean; references: boolean; apply: boolean; runDir?: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { boardPath, config } = await pcbBoard(repo, opts.board);
      const { placeBoard } = await import('./pcb/engines/place.js');
      const path = await import('node:path');
      const { copyFile } = await import('node:fs/promises');
      const pcb = config.pcb ?? {};
      const budget = Number(opts.budgetSeconds ?? pcb.budgetSeconds ?? 600);
      const runDir = opts.runDir ? path.resolve(repo, opts.runDir) : path.join(repo, '.copperhead', 'runs', new Date().toISOString().replace(/[:.]/g, '-'), 'placement');
      const placers = opts.placers?.split(',').map((s) => s.trim()).filter(Boolean) ?? pcb.placers;
      const mode = (opts.mode ?? (pcb.mode === 'staged' ? 'single' : pcb.mode) ?? 'single') as 'single' | 'race' | 'ensemble';
      let layoutPlan;
      if (opts.plan) {
        const { readFile } = await import('node:fs/promises');
        layoutPlan = JSON.parse(await readFile(path.resolve(repo, opts.plan), 'utf8')) as import('./pcb/engines/reuse/plan.js').PlacementPlan;
        if (!json) console.error(`plan: ${layoutPlan.subsystems.length} subsystem(s), ${layoutPlan.fixed.filter((f) => f.edge).length} connector edge(s) from ${opts.plan}`);
      }
      let blocks;
      if (opts.blocks || opts.references) {
        const { readFile } = await import('node:fs/promises');
        const { existsSync } = await import('node:fs');
        const { importBoard } = await import('./pcb/ir/kicad/import.js');
        const { deriveBlocks } = await import('./pcb/intent/blocks.js');
        const subsystems = path.join(repo, config.docs, 'SUBSYSTEMS.md');
        const intentPath = config.schematic ? path.join(path.dirname(path.join(repo, config.schematic)), 'schematic.intent.json') : null;
        const { design } = importBoard({ boardText: await readFile(boardPath, 'utf8'), boardPath });
        blocks = deriveBlocks({ design, subsystemsMd: existsSync(subsystems) ? await readFile(subsystems, 'utf8') : null, schematicIntent: intentPath && existsSync(intentPath) ? JSON.parse(await readFile(intentPath, 'utf8')) : null });
        if (!json) for (const b of blocks) console.error(`block ${b.id}: ${b.members.length} part(s), anchor ${b.anchor ? design.components.find((c) => c.id === b.anchor)!.reference : 'none'}, region ${b.region ? 'assigned' : 'none'}${b.notes.length ? ` (${b.notes.join('; ')})` : ''}`);
      }
      let reuse: import('./pcb/engines/placers/layout-reuse/adapter.js').LayoutBlockSpec[] | undefined;
      let attached: { ref: string; to: string; max_distance_nm: number }[] | undefined;
      if (pcb.layoutBlocks?.length) {
        const { specFromBoard } = await import('./pcb/engines/placers/layout-reuse/adapter.js');
        reuse = await Promise.all(pcb.layoutBlocks.map((b) => specFromBoard(b, repo)));
        if (!json) for (const r of reuse) console.error(`layout block ${r.id}: ${r.members.length} member(s) around ${r.anchor} from ${r.source}`);
      }
      if (opts.references && blocks) {
        const refs = await import('./pcb/intent/references.js');
        const cached = await refs.readCache(repo);
        const usable = refs.applicable(cached.filter((b) => blocks!.some((k) => k.anchor === b.target.anchorId)));
        const holds = cached.filter((b) => blocks!.some((k) => k.anchor === b.target.anchorId) && !refs.applicable([b]).length);
        for (const b of usable) {
          const inputs = refs.toStageInputs(b);
          reuse = [...(reuse ?? []), inputs.reuse];
          attached = [...(attached ?? []), ...inputs.attached];
          if (!json) console.error(`reference ${b.id.slice(0, 8)}: ${b.members.length} member(s) around ${b.target.anchorRef} from ${b.source.kind} ${path.relative(repo, b.source.locator)}`);
        }
        if (!usable.length && holds.length) {
          const { EXIT_CODE } = await import('./pcb/ir/status.js');
          const msg = `HOLD: ${holds.length} cached reference block(s) need approval before they apply (${holds.slice(0, 3).map((h) => `${h.id.slice(0, 8)} ${h.source.license}`).join(', ')}); run copperhead pcb references --approve <id>`;
          if (json) console.log(JSON.stringify({ status: 'HOLD', summary: msg, holds: holds.map((h) => h.id) }));
          else console.log(msg);
          process.exit(EXIT_CODE.HOLD);
        }
      }
      const res = await placeBoard({
        repoRoot: repo, boardPath, runDir, ...(placers ? { placers } : {}), ...(layoutPlan ? { layoutPlan } : {}), mode, ...(opts.movable ? { movableReferences: opts.movable.split(',').map((s) => s.trim()) } : {}), ...(reuse?.length ? { reuse } : {}), seed: Number(opts.seed), limits: { engineSeconds: budget, wallSeconds: budget }, ...(pcb.profile ? { profile: pcb.profile } : {}), ...(pcb.maxParallelEngines ? { maxParallel: pcb.maxParallelEngines } : {}),
        policy: { network: pcb.allowRemoteEngines ? 'required' : 'optional', allowHarnessEngines: opts.allowHarnessEngines || (pcb.allowHarnessEngines ?? false), denyLicenses: [] },
        probe: opts.probe ? { routerId: opts.probeRouter } : false,
        ...(blocks ? { blocks } : {}), ...(attached?.length ? { attached } : {}), docsDir: path.join(repo, config.docs), intentPath: pcb.intentPath ?? null,
        log: json ? () => {} : (l) => console.error(l),
      });
      if (opts.apply) {
        const sel = res.ranking.selected ? res.candidates.find((c) => c.engineId === res.ranking.selected) : undefined;
        if (sel && (res.outcome.status === 'PASS' || res.outcome.status === 'PARTIAL')) {
          await copyFile(sel.pcbPath, boardPath);
          res.outcome.detail.push(`applied ${res.ranking.selected} to ${path.relative(repo, boardPath)}`);
        } else res.outcome.detail.push('nothing applied; the board is unchanged');
      }
      if (json) console.log(JSON.stringify({ ...res.outcome, diagnostics: res.outcome.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message })), runDir: res.runDir, ranking: res.ranking, ineligible: res.ineligible, movable: res.movableIds.length, ...(res.plan ? { plan: { stages: res.plan.stages.map((st) => ({ name: st.name, engineId: st.engineId, parts: st.componentIds.length })), blocks: res.plan.blocks.map((b) => ({ id: b.id, members: b.members.length, region: !!b.region })) } } : {}) }, null, 2));
      else {
        console.log(`${res.outcome.status}: ${res.outcome.summary}`);
        for (const d of res.outcome.detail) console.log(`  ${d}`);
        console.log(`  run: ${path.relative(repo, res.runDir)}; render ${path.relative(repo, path.join(res.runDir, "board.svg"))}`);
      }
      const { EXIT_CODE } = await import('./pcb/ir/status.js');
      process.exit(EXIT_CODE[res.outcome.status]);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('plan')
  .description('write the layout intent: subsystems, the IC at each one\'s centre, the edge each connector faces, the critical relationships (a model writes it with --model; the rules write it without, and it never contains coordinates)')
  .option('--board <path>', 'board to plan (default: the configured board)')
  .option('--movable <refs>', 'comma-separated refdes the placement may move (default: every part not locked in KiCad)')
  .option('--model <route>', 'let a model write the intent; without this the rules write it and the run is network-free')
  .option('--out <path>', 'where to write the plan (default: <board>.plan.json beside the board)')
  .option('--record-dir <path>', 'where request/response records are kept, so the same board plans the same way twice')
  .action(async (opts: { board?: string; movable?: string; model?: string; out?: string; recordDir?: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { boardPath, config } = await pcbBoard(repo, opts.board);
      const path = await import('node:path');
      const { pcbPlan } = await import('./commands/pcb-plan.js');
      let provider = null;
      if (opts.model) {
        const { makeProvider } = await import('./agent/loop.js');
        const { resolveCompatSettings } = await import('./config.js');
        provider = await makeProvider(opts.model, false, resolveCompatSettings(config));
      }
      const res = await pcbPlan({
        repoRoot: repo,
        boardPath,
        ...(opts.out ? { outPath: path.resolve(repo, opts.out) } : {}),
        ...(opts.movable ? { movableReferences: opts.movable.split(',').map((s) => s.trim()) } : {}),
        ...(provider ? { provider } : {}),
        ...(opts.recordDir ? { recordDir: path.resolve(repo, opts.recordDir) } : {}),
        log: json ? () => {} : (l) => console.error(l),
      });
      if (provider) await provider.close?.();
      if (json) console.log(JSON.stringify({ source: res.source, reason: res.reason, out: path.relative(repo, res.outPath), summary: res.summary, warnings: res.warnings }, null, 2));
      else {
        console.log(`plan from the ${res.source}: ${res.summary}`);
        console.log(`  ${res.reason}`);
        for (const w of res.warnings) console.log(`  warning: ${w}`);
        console.log(`  written to ${path.relative(repo, res.outPath)}; place with: copperhead pcb place --placers placer-heuristic --plan ${path.relative(repo, res.outPath)}`);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('reuse')
  .description('place the board by adapting a reference board\'s placement: screen variants, verify and probe the survivors, and end with options (no model unless --model)')
  .option('--board <path>', 'board to place (default: the configured board)')
  .option('--reference <path>', 'the board whose placement is reused (required)')
  .option('--movable <refs>', 'comma-separated refdes to move (default: every part not locked in KiCad)')
  .option('--keep <n>', 'how many screened variants to materialise', '8')
  .option('--budget <kind>', 'quick | screen (how many variants to generate)', 'screen')
  .option('--seed <n>', 'seed for seeded engines', '0')
  .option('--budget-seconds <n>', 'engine-second and wall-clock budget')
  .option('--no-probe', 'skip the routability probe on each option')
  .option('--probe-router <id>', 'router for the probe', 'router-freerouting')
  .option('--no-critical-route', 'skip routing the critical nets of each option')
  .option('--critical-budget <n>', 'seconds for each critical-net routing run', '120')
  .option('--critical-candidates <n>', 'how many options get their critical nets routed (RFC 15: five)', '5')
  .option('--apply', 'write the chosen option over the board file', false)
  .option('--option <id>', 'which option to apply (default: the ranked winner)')
  .option('--model <route>', 'let a model write the placement plan (it never gives coordinates); without this the rules plan and the run is network-free')
  .option('--run-dir <path>', 'where to write the run (default: .copperhead/runs/<ts>/reuse)')
  .action(async (opts: { board?: string; reference?: string; movable?: string; keep: string; budget: string; seed: string; budgetSeconds?: string; probe: boolean; probeRouter: string; criticalRoute: boolean; criticalBudget: string; criticalCandidates: string; apply: boolean; option?: string; model?: string; runDir?: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      if (!opts.reference) throw new Error('pcb reuse needs --reference <path>: the board whose placement is being reused');
      const { boardPath, config } = await pcbBoard(repo, opts.board);
      const path = await import('node:path');
      const { pcbReuse } = await import('./commands/pcb-reuse.js');
      const pcb = config.pcb ?? {};
      const budget = Number(opts.budgetSeconds ?? pcb.budgetSeconds ?? 600);
      const runDir = opts.runDir ? path.resolve(repo, opts.runDir) : path.join(repo, '.copperhead', 'runs', new Date().toISOString().replace(/[:.]/g, '-'), 'reuse');
      let provider = null;
      if (opts.model) {
        const { makeProvider } = await import('./agent/loop.js');
        const { resolveCompatSettings } = await import('./config.js');
        provider = await makeProvider(opts.model, false, resolveCompatSettings(config));
      }
      const res = await pcbReuse({
        repoRoot: repo,
        boardPath,
        referencePath: path.resolve(repo, opts.reference),
        runDir,
        ...(opts.movable ? { movableReferences: opts.movable.split(',').map((s) => s.trim()) } : {}),
        keep: Number(opts.keep),
        budget: opts.budget === 'quick' ? 'quick' : 'screen',
        seed: Number(opts.seed),
        limits: { engineSeconds: budget, wallSeconds: budget },
        ...(pcb.profile ? { profile: pcb.profile } : {}),
        probe: opts.probe ? { routerId: opts.probeRouter } : false,
        criticalRoute: opts.criticalRoute ? { budgetSeconds: Number(opts.criticalBudget), maxCandidates: Number(opts.criticalCandidates) } : false,
        apply: opts.apply,
        ...(opts.option ? { option: opts.option } : {}),
        ...(provider ? { provider } : {}),
        log: json ? () => {} : (l) => console.error(l),
      });
      if (provider) await provider.close?.();
      if (json) console.log(JSON.stringify({ ...res.outcome, diagnostics: res.outcome.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message })), runDir, options: res.options.map((o) => ({ id: o.id, rank: o.rank, selected: o.selected, dir: path.relative(repo, o.dir), changed: o.diff.components.length })), applied: res.applied, placementDoc: path.relative(repo, path.join(runDir, "placement.md")), screened: res.run.screened.map((v) => ({ id: v.id, legal: v.metrics.legal, score: v.score, kept: v.kept, ...(v.sameAs ? { sameAs: v.sameAs } : {}) })) }, null, 2));
      else {
        console.log(`${res.outcome.status}: ${res.outcome.summary}`);
        for (const d of res.outcome.detail) console.log(`  ${d}`);
        console.log(`  plan from the ${res.run.planSource}; options: ${path.relative(repo, path.join(runDir, 'options.md'))}; delta: ${path.relative(repo, path.join(runDir, 'delta.md'))}`);
        console.log(`  read ${path.relative(repo, path.join(runDir, 'placement.md'))}; each option's placement diff is beside its board in variants/`);
        const chosen = res.options.find((o) => (res.applied ? o.id === res.applied : o.selected));
        if (chosen) {
          const s = chosen.diff.components.length;
          console.log(`  ${res.applied ? 'applied' : 'selected'} option ${chosen.id} changes ${s} part(s)${res.applied ? '' : '; --apply writes it'}`);
        }
      }
      const { EXIT_CODE } = await import('./pcb/ir/status.js');
      process.exit(EXIT_CODE[res.outcome.status]);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('references')
  .description('find reference layouts for each block anchor in local sources (KiCad demos, PCBench, the repo\'s reference boards, pcb.referenceDesigns, pcb.teardownCorpus); no model, no network')
  .option('--board <path>', 'board (default: the configured board)')
  .option('--refresh', 'search again for anchors that already have cached blocks', false)
  .option('--approve <id>', 'record the approval of a cached block whose license needs one')
  .option('--approver <who>', 'who approves (default: user)', 'user')
  .action(async (opts: { board?: string; refresh: boolean; approve?: string; approver: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const path = await import('node:path');
      const { readFile } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const refs = await import('./pcb/intent/references.js');
      if (opts.approve) {
        const b = await refs.approveReference(repo, opts.approve, opts.approver);
        if (!b) throw new Error(`no cached reference block ${opts.approve} (see .copperhead/layout-refs/index.json)`);
        if (json) console.log(JSON.stringify({ approved: b.id, approvedBy: b.approvedBy, license: b.source.license }));
        else console.log(`approved ${b.id} (${b.source.license}) by ${b.approvedBy}: ${b.members.length} member(s) around ${b.target.anchorRef} from ${b.source.locator}`);
        process.exit(0);
      }
      const { boardPath, config } = await pcbBoard(repo, opts.board);
      const { importBoard } = await import('./pcb/ir/kicad/import.js');
      const { deriveBlocks } = await import('./pcb/intent/blocks.js');
      const pcb = config.pcb ?? {};
      const { design } = importBoard({ boardText: await readFile(boardPath, 'utf8'), boardPath });
      const subsystems = path.join(repo, config.docs, 'SUBSYSTEMS.md');
      const intentPath = config.schematic ? path.join(path.dirname(path.join(repo, config.schematic)), 'schematic.intent.json') : null;
      const blocks = deriveBlocks({ design, subsystemsMd: existsSync(subsystems) ? await readFile(subsystems, 'utf8') : null, schematicIntent: intentPath && existsSync(intentPath) ? JSON.parse(await readFile(intentPath, 'utf8')) : null });
      const licenses: Record<string, string> = {};
      const suite = path.join(repo, 'bench', 'suites', 'pcbench-qual.json');
      if (existsSync(suite)) for (const b of (JSON.parse(await readFile(suite, 'utf8')) as { boards: { id: string; license?: string }[] }).boards) if (b.license) licenses[b.id] = b.license;
      const sources = [new refs.LocalDesignSource(await refs.localBoards(repo, { referenceDesigns: pcb.referenceDesigns ?? [], pcbenchLicenses: licenses })), new refs.TeardownSource((pcb.teardownCorpus ?? []).map((d) => (path.isAbsolute(d) ? d : path.join(repo, d))))];
      const res = await refs.findReferences(design, blocks, { repoRoot: repo, sources, refresh: opts.refresh });
      const usable = refs.applicable(res.blocks);
      if (json) console.log(JSON.stringify({ status: res.holds.length && !usable.length ? 'HOLD' : 'PASS', blocks: res.blocks.map((b) => ({ id: b.id, anchor: b.target.anchorRef, source: b.source.locator, kind: b.source.kind, score: b.similarity.score, members: b.members.length, license: b.source.license, approvedBy: b.approvedBy ?? null, applicable: usable.some((u) => u.id === b.id) })), holds: res.holds.map((b) => b.id), searched: res.searched, fromCache: res.fromCache }, null, 2));
      else {
        console.log(`${res.blocks.length} reference block(s) for ${blocks.filter((b) => b.anchor && b.id !== 'unassigned').length} anchor(s) (${res.searched} searched, ${res.fromCache} from cache); ${usable.length} applicable, ${res.holds.length} on hold`);
        for (const b of res.blocks) console.log(`  ${usable.some((u) => u.id === b.id) ? 'apply' : b.approvedBy ? 'ok   ' : 'HOLD '} ${b.id.slice(0, 8)} ${b.target.anchorRef}: ${b.members.length} member(s), score ${b.similarity.score.toFixed(2)}, ${b.source.kind} ${path.relative(repo, b.source.locator)} (${b.source.license}${b.approvedBy ? `, approved by ${b.approvedBy}` : ''})`);
        if (res.holds.length) console.log(`  approve with: copperhead pcb references --approve <id>`);
      }
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('infer-intent')
  .description('compile layout intent (RFC 11 §7.4): blocks, the intent file, the board\'s own rules, and (with a model) roles and datasheet-derived rules, merged into .copperhead/constraints.json with an intent report')
  .option('--board <path>', 'board (default: the configured board)')
  .option('--model <model>', 'model for the two model steps (roles, derived rules); without one the compile is deterministic')
  .option('--intent <path>', 'intent file (default: pcb.intentPath or docs/LAYOUT.intent.yaml)')
  .option('--run-dir <path>', 'where intent-report.md goes (default: .copperhead/runs/<ts>/intent)')
  .option('--dry-run', 'print the report, write nothing', false)
  .action(async (opts: { board?: string; model?: string; intent?: string; runDir?: string; dryRun: boolean }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { boardPath, config } = await pcbBoard(repo, opts.board);
      const path = await import('node:path');
      const { readFile } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const { importBoard } = await import('./pcb/ir/kicad/import.js');
      const { compileIntent, cachedDatasheets } = await import('./pcb/agent/intent/compiler.js');
      const { loadConstraints: loadRegistry, saveConstraints } = await import('./memory/constraints.js');
      const read = async (p: string) => (existsSync(p) ? readFile(p, 'utf8') : Promise.resolve(null));
      const intentPath = opts.intent ? path.resolve(repo, opts.intent) : path.join(repo, config.pcb?.intentPath ?? path.join(config.docs, 'LAYOUT.intent.yaml'));
      const schematicIntentPath = config.schematic ? path.join(path.dirname(path.join(repo, config.schematic)), 'schematic.intent.json') : null;
      const runDir = opts.runDir ? path.resolve(repo, opts.runDir) : path.join(repo, '.copperhead', 'runs', new Date().toISOString().replace(/[:.]/g, '-'), 'intent');
      let provider = null;
      if (opts.model) {
        const { makeProvider } = await import('./agent/loop.js');
        const { resolveCompatSettings } = await import('./config.js');
        provider = await makeProvider(opts.model, false, resolveCompatSettings(config));
      }
      const { design } = importBoard({ boardText: await readFile(boardPath, 'utf8'), boardPath });
      const res = await compileIntent({
        repoRoot: repo, design, intentText: await read(intentPath), subsystemsMd: await read(path.join(repo, config.docs, 'SUBSYSTEMS.md')),
        schematicIntent: schematicIntentPath && existsSync(schematicIntentPath) ? JSON.parse(await readFile(schematicIntentPath, 'utf8')) : null,
        bomMd: await read(path.join(repo, config.docs, 'BOM.md')), datasheets: await cachedDatasheets(repo), registry: await loadRegistry(repo), provider, ...(opts.dryRun ? {} : { runDir }),
      });
      if (provider) await provider.close?.();
      if (!opts.dryRun) await saveConstraints(repo, res.registry);
      const layout = Object.entries(res.registry).filter(([, c]) => c.class);
      if (json) console.log(JSON.stringify({ status: res.holds.length ? 'HOLD' : 'PASS', constraints: layout.length, blocks: res.blocks.map((b) => ({ id: b.id, members: b.members.length, region: !!b.region })), roles: res.roles, holds: res.holds, rejected: res.rejected, runDir: opts.dryRun ? null : path.relative(repo, runDir), written: !opts.dryRun }, null, 2));
      else {
        console.log(res.report);
        if (!opts.dryRun) console.log(`\nwrote ${layout.length} layout constraint(s) to .copperhead/constraints.json; report in ${path.relative(repo, runDir)}/intent-report.md`);
      }
      const { EXIT_CODE } = await import('./pcb/ir/status.js');
      process.exit(res.holds.length ? EXIT_CODE.HOLD : 0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('layout')
  .description('the closed loop: place, route, verify, repair within a budget, record the evidence (RFC 11 §12); the model appears only in the repair planner')
  .option('--board <path>', 'board (default: the configured board)')
  .option('--no-place', 'route the board as placed')
  .option('--no-route', 'place only')
  .option('--budget-seconds <n>', 'engine-second and wall-clock budget for the whole loop (default: config or 600)')
  .option('--max-repair-cycles <n>', 'repair cycles after the first pass (default: config maxRepairCycles or 3)')
  .option('--model <model>', 'model for the repair planner; without one a deterministic policy picks the action')
  .option('--seed <n>', 'seed for seeded engines', '0')
  .option('--allow-harness-engines', 'let the reference placer and router compete (harness fixtures only)', false)
  .option('--apply', 'write the result over the board file and record the evidence in docs/LAYOUT.md', false)
  .option('--run-dir <path>', 'where to write the run (default: .copperhead/runs/<ts>/layout)')
  .action(async (opts: { board?: string; place: boolean; route: boolean; budgetSeconds?: string; maxRepairCycles?: string; model?: string; seed: string; allowHarnessEngines: boolean; apply: boolean; runDir?: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { boardPath, config } = await pcbBoard(repo, opts.board);
      const path = await import('node:path');
      const { layoutBoard } = await import('./pcb/agent/orchestrate.js');
      const pcb = config.pcb ?? {};
      let provider = null;
      if (opts.model) {
        const { makeProvider } = await import('./agent/loop.js');
        const { resolveCompatSettings } = await import('./config.js');
        provider = await makeProvider(opts.model, false, resolveCompatSettings(config));
      }
      const runDir = opts.runDir ? path.resolve(repo, opts.runDir) : path.join(repo, '.copperhead', 'runs', new Date().toISOString().replace(/[:.]/g, '-'), 'layout');
      const res = await layoutBoard({
        repoRoot: repo, config, boardPath, runDir, place: opts.place, route: opts.route, ...(opts.budgetSeconds ? { budgetSeconds: Number(opts.budgetSeconds) } : {}), ...(opts.maxRepairCycles ? { maxRepairCycles: Number(opts.maxRepairCycles) } : {}), seed: Number(opts.seed), provider,
        policy: { network: pcb.allowRemoteEngines ? 'required' : 'optional', allowHarnessEngines: opts.allowHarnessEngines || (pcb.allowHarnessEngines ?? false), denyLicenses: [] }, apply: opts.apply,
        ...(opts.allowHarnessEngines ? { probeRouter: 'router-reference' } : {}),
        log: json ? () => {} : (l) => console.error(l),
      });
      if (provider) await provider.close?.();
      if (json) console.log(JSON.stringify({ ...res.outcome, diagnostics: res.outcome.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message })), runDir: path.relative(repo, res.runDir), applied: res.applied, cycles: res.cycles, holds: res.holds, evidence: res.evidence ? { status: res.evidence.status, selected: res.evidence.selected, boardHash: res.evidence.boardHash } : null }, null, 2));
      else {
        console.log(`${res.outcome.status}: ${res.outcome.summary}`);
        for (const d of res.outcome.detail) console.log(`  ${d}`);
        console.log(`  run: ${path.relative(repo, res.runDir)}; render ${path.relative(repo, path.join(res.runDir, "board.svg"))}${res.applied ? `; applied to ${path.relative(repo, boardPath)}, evidence in ${path.join(config.docs, 'LAYOUT.md')}` : ''}`);
      }
      const { EXIT_CODE } = await import('./pcb/ir/status.js');
      process.exit(EXIT_CODE[res.outcome.status]);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('verify')
  .description('verify one board file: pre-flight, geometry, connectivity, return path, KiCad DRC')
  .argument('[board]', 'board file (default: the configured board)')
  .option('--no-kicad', 'skip kicad-cli (no DRC, no zone refill)')
  .option('--intent <path>', 'intent file (default: pcb.intentPath, <board dir>/intent.yaml, or docs/LAYOUT.intent.yaml)')
  .action(async (board: string | undefined, opts: { kicad: boolean; intent?: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const { boardPath, config } = await pcbBoard(repo, board);
      const path = await import('node:path');
      const { readFile, mkdtemp, cp, rm } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { importBoard } = await import('./pcb/ir/kicad/import.js');
      const { refillZones, extractFills } = await import('./pcb/ir/kicad/zones.js');
      const { verifyDesign } = await import('./pcb/verify/index.js');
      const { EXIT_CODE } = await import('./pcb/ir/status.js');
      const proPath = boardPath.replace(/\.kicad_pcb$/, '.kicad_pro');
      const projectText = existsSync(proPath) ? await readFile(proPath, 'utf8') : undefined;
      let text = await readFile(boardPath, 'utf8');
      let drc;
      if (opts.kicad) {
        // refill on a copy so verify never mutates the user's file
        const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-verify-'));
        try {
          await cp(path.dirname(boardPath), dir, { recursive: true });
          const copy = path.join(dir, path.basename(boardPath));
          drc = await refillZones(copy);
          text = await readFile(copy, 'utf8');
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      const { design } = importBoard({ boardText: text, boardPath, ...(projectText ? { projectText } : {}) });
      const { loadConstraints } = await import('./pcb/intent/load.js');
      const { registry: constraints, intentPath, holds } = await loadConstraints(design, boardPath, { intentPath: config.pcb?.intentPath ?? opts.intent ?? null, docsDir: path.join(repo, config.docs), repoRoot: repo });
      const v = verifyDesign({ design, fills: extractFills(text), ...(drc ? { drc } : {}), constraints });
      const errors = v.diagnostics.filter((d) => d.severity === 'error');
      const status = holds.length ? 'HOLD' : !v.gates.preflight.passed || !v.gates.placement.passed ? 'REFUSE' : errors.length ? 'PARTIAL' : (v.metrics.unrouted_count ?? 0) > 0 ? 'PARTIAL' : 'PASS';
      if (json) console.log(JSON.stringify({ status, intent: intentPath ? path.relative(repo, intentPath) : null, holds, metrics: v.metrics, gates: { preflight: v.gates.preflight.passed, placement: v.gates.placement.passed, routing: v.gates.routing.passed }, disagreements: v.disagreements, diagnostics: v.diagnostics.map((d) => ({ code: d.code, severity: d.severity, entityReferences: d.entityReferences, message: d.message })) }, null, 2));
      else {
        if (intentPath) console.log(`intent: ${path.relative(repo, intentPath)} (${Object.keys(constraints).length} constraint(s) with the board's own rules)`);
        for (const h of holds) console.log(`  HOLD ${h}`);
        console.log(`${status}: ${v.metrics.routed_nets ?? 0} net(s) routed, ${v.metrics.unrouted_count ?? 0} owed, ${v.metrics.shorts ?? 0} short(s), ${v.metrics.drc_error_count ?? 0} KiCad error(s); gates preflight ${v.gates.preflight.passed ? 'pass' : 'FAIL'}, placement ${v.gates.placement.passed ? 'pass' : 'FAIL'}, routing ${v.gates.routing.passed ? 'pass' : 'FAIL'}`);
        for (const d of v.diagnostics.filter((d) => d.severity !== 'info')) console.log(`  ${d.severity} ${d.code}${d.entityReferences.length ? ` [${d.entityReferences.slice(0, 4).join(', ')}]` : ''}: ${d.message}`);
        for (const x of v.disagreements) console.log(`  disagreement ${x.code}: ${x.a.checker} says ${x.a.says}; ${x.b.checker} says ${x.b.says}`);
      }
      process.exit(EXIT_CODE[status]);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('render')
  .description('render one board file to SVG (with the verify diagnostics marked unless --plain)')
  .argument('[board]', 'board file (default: the configured board)')
  .option('--out <path>', 'output .svg (default: beside the board)')
  .option('--plain', 'no diagnostics, no legend (thumbnail mode)', false)
  .option('--no-legend', 'keep the diagnostic markers on the board but drop the legend under it')
  .option('--scale <n>', 'pixels per millimetre', '14')
  .action(async (board: string | undefined, opts: { out?: string; plain: boolean; legend: boolean; scale: string }) => {
    const repo = repoOf(program.opts());
    try {
      const { boardPath, config } = await pcbBoard(repo, board);
      const path = await import('node:path');
      const { readFile, writeFile } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const { importBoard } = await import('./pcb/ir/kicad/import.js');
      const { extractFills } = await import('./pcb/ir/kicad/zones.js');
      const { verifyDesign } = await import('./pcb/verify/index.js');
      const { renderSvg } = await import('./pcb/ir/svg.js');
      const { loadConstraints } = await import('./pcb/intent/load.js');
      const proPath = boardPath.replace(/\.kicad_pcb$/, '.kicad_pro');
      const projectText = existsSync(proPath) ? await readFile(proPath, 'utf8') : undefined;
      const text = await readFile(boardPath, 'utf8');
      const { design } = importBoard({ boardText: text, boardPath, ...(projectText ? { projectText } : {}) });
      const plain = opts.plain || Boolean(program.opts().plain); // the global --plain (log style) swallows the flag when it precedes the subcommand
      // intent markers too: the same registry verify and check use
      const constraints = plain ? {} : (await loadConstraints(design, boardPath, { intentPath: config.pcb?.intentPath ?? null, docsDir: path.join(repo, config.docs), repoRoot: repo })).registry;
      const diagnostics = plain ? [] : verifyDesign({ design, fills: extractFills(text), constraints }).diagnostics;
      const out = opts.out ? path.resolve(repo, opts.out) : boardPath.replace(/\.kicad_pcb$/, '.svg');
      await writeFile(out, renderSvg(design, { diagnostics, scale: Number(opts.scale), legend: !plain && opts.legend !== false }), 'utf8');
      if (Boolean(program.opts().json)) console.log(JSON.stringify({ out, diagnostics: diagnostics.filter((d) => d.severity !== 'info').length }));
      else console.log(out);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });
pcbGroup
  .command('score')
  .description('re-rank the candidates of a run directory')
  .argument('<run-dir>', 'a run directory written by pcb route')
  .option('--scoring <profile>', 'scoring profile', 'default-low-speed-2-layer')
  .action(async (runDir: string, opts: { scoring: string }) => {
    const json = Boolean(program.opts().json);
    try {
      const path = await import('node:path');
      const { readFile, readdir, writeFile } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const { rank } = await import('./pcb/verify/scoring.js');
      const { loadScoringProfile } = await import('./pcb/verify/profiles/scoring/index.js');
      const dir = path.resolve(runDir);
      const candidates = path.join(dir, 'candidates');
      const inputs = [];
      for (const d of existsSync(candidates) ? await readdir(candidates) : []) {
        const mp = path.join(candidates, d, 'metrics.json');
        const dp = path.join(candidates, d, 'diagnostics.json');
        if (!existsSync(mp)) continue;
        const metrics = JSON.parse(await readFile(mp, 'utf8'));
        const diags = existsSync(dp) ? (JSON.parse(await readFile(dp, 'utf8')) as { code: string; severity: string }[]) : [];
        const gateFailures = diags.filter((x) => x.severity === 'error' && !x.code.startsWith('conn.unrouted') && !x.code.startsWith('drc.') && !x.code.startsWith('quality.')).map((x) => x.code);
        inputs.push({ id: d.replace(/-\d+$/, ''), metrics, gatesPassed: gateFailures.length === 0 && (metrics.drc_critical_count ?? 0) === 0, gateFailures });
      }
      const ranking = rank(inputs, loadScoringProfile(opts.scoring));
      await writeFile(path.join(dir, 'ranking.json'), JSON.stringify(ranking, null, 2), 'utf8');
      if (json) console.log(JSON.stringify(ranking, null, 2));
      else for (const c of ranking.candidates) console.log(`${c.rank}. ${c.id}${c.eligible ? '' : ' (ineligible)'}: ${c.reason}`);
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('doctor')
  .description('env preflight: kicad-cli, git, node, and the model provider credential; no LLM, no network')
  .option('--model <model>', 'model to check the provider credential for (default: resolved like a run)')
  .action(async (opts: { model?: string }) => {
    const repo = repoOf(program.opts());
    // Unlike other commands, doctor never gates on kicad-cli being present:
    // runDoctor probes it and reports a failure instead of throwing, so a user
    // with a missing tool still gets the full report.
    const report = await runDoctor({ repoRoot: repo, model: opts.model });
    if (program.opts().json) console.log(JSON.stringify(report, null, 2));
    else {
      const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
      // || not ??: some non-interactive ptys report columns as 0.
      for (const line of formatDoctor(report, process.stdout.columns || 80, color)) console.log(line);
    }
    process.exit(report.ok ? 0 : 1);
  });

program
  .command('do')
  .description('the core loop: propose, edit, verify, propagate, commit')
  .argument('<request>', 'the change request in natural language')
  .option('--model <model>', 'codex | cursor | gpt-5 | claude | claude-code | compat:<id> (or a provider-specific model id)')
  .option('--max-turns <n>', 'turn budget for this run')
  .option('--allow-dirty', 'allow a dirty tree (snapshot via git stash create)')
  .option('--dry-run', 'propose the diff, write nothing')
  .option('--interactive', 'pause for approval after the proposal validates')
  .action(
    async (
      request: string,
      opts: { model?: string; maxTurns?: string; allowDirty?: boolean; dryRun?: boolean; interactive?: boolean },
    ) => {
      const repo = repoOf(program.opts());
      try {
        const kicadVer = await kicadCliVersion();
        const config = await loadConfig(repo);
        const { model, source } = resolveModel(opts.model, config);
        const continuePrompt = budgetContinuePrompt();
        const res = await runAgentLoop({
          repoRoot: repo,
          request,
          model,
          ...(opts.maxTurns ? { maxTurns: parseMaxTurns(opts.maxTurns) } : {}),
          allowDirty: opts.allowDirty ?? false,
          dryRun: opts.dryRun ?? false,
          interactive: opts.interactive ?? false,
          confirm: confirmTty,
          ...(continuePrompt ? { onBudgetExhausted: continuePrompt } : {}),
          renderer: rendererOf(),
          meta: { command: 'do', modelSource: source, version, kicadCliVersion: kicadVer },
        });
        if (program.opts().json) console.log(JSON.stringify(res, null, 2));
        process.exit(res.outcome === 'failure' ? 1 : 0);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    },
  );

const skillCmd = program.command('skill').description('run a registered skill (nested tool loop; no git commit)');

skillCmd
  .command('list')
  .description('list registered skills (LLM-free, network-free)')
  .action(async () => {
    const repo = repoOf(program.opts());
    try {
      const { listSkills } = await import('./commands/skill.js');
      const skills = await listSkills(repo);
      if (program.opts().json) console.log(JSON.stringify(skills, null, 2));
      else {
        for (const s of skills) {
          console.log(`${s.available ? '·' : '×'} ${s.name.replaceAll('_', '-')}  ${s.description.split('\n')[0]}`);
        }
      }
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

skillCmd
  .command('run')
  .description('run a skill by name (generate-report)')
  .argument('<name>', 'skill name (kebab or underscore)')
  .option('--model <model>', 'codex | cursor | gpt-5 | claude | claude-code | compat:<id>')
  .option('--scope <scope>', 'generate-report scope: power | all', 'all')
  .action(async (name: string, opts: { model?: string; scope?: string }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    // `process.exit` skips pending finally blocks, so the provider close has to
    // finish before the exit call — hence the code is carried out, not exited on.
    let code = 1;
    try {
      const { runSkillCli, providerForSkillRun } = await import('./commands/skill.js');
      const { provider } = await providerForSkillRun(repo, opts.model);
      const res = await runSkillCli({
        repoRoot: repo,
        name,
        args: { scope: opts.scope === 'power' ? 'power' : 'all' },
        provider,
        json,
      });
      console.log(res.text);
      code = res.code;
    } catch (err) {
      console.error((err as Error).message);
      code = 1;
    }
    process.exit(code);
  });

program
  .command('sync')
  .description('verify the whole design state for inconsistencies and resolve drift')
  .option('--model <model>', 'model for the resolve phase')
  .option('--dry-run', 'print the inconsistency report, write nothing')
  .action(async (opts: { model?: string; dryRun?: boolean }) => {
    const repo = repoOf(program.opts());
    try {
      const kicadVer = await kicadCliVersion();
      const report = await syncVerify(repo);
      const json = Boolean(program.opts().json);
      if (json) console.log(JSON.stringify(report, null, 2));
      else console.log(formatSyncReport(report));
      if (opts.dryRun) {
        process.exit(report.violations.length ? 2 : 0);
      }
      if (report.violations.length) {
        // requirement violations are never auto-resolved (AC-7.3)
        process.exit(2);
      }
      if (!report.resolvable.length) {
        process.exit(0);
      }
      const config = await loadConfig(repo);
      const { model, source } = resolveModel(opts.model, config);
      const res = await syncResolve(repo, report, model, json ? () => {} : (s) => console.log(s), {
        renderer: rendererOf(),
        meta: { command: 'sync', modelSource: source, version, kicadCliVersion: kicadVer },
      });
      process.exit(res.ok ? 0 : 1);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('review')
  .description('EXPERIMENTAL: grounded design review: a deterministic sweep, model passes that propose, verifiers that decide (RFC 17)')
  .argument('[design]', 'the design directory (default: --repo or cwd); never written')
  .option('--out <dir>', 'a new directory, outside the design, for the review record')
  .option('--source <path...>', 'retained sources a citation may name: datasheet text, documents, firmware (repeatable; directories are walked)')
  .option('--fab <path...>', 'fabrication outputs to review with the design: Gerber and drill directories or zips, BOM and placement files')
  .option('--fab-profile <path>', 'a manufacturer capability profile for fab-rules')
  .option('--model <model>', 'claude-code | claude | codex | gpt-5 (or a provider-specific model id)')
  .option('--domains <list>', 'comma-separated domains: P power, M MCU, S storage/IO, F firmware, L physical, R routing, G fabrication outputs, B BOM', 'P,M,S,F,L,R,G,B')
  .option('--max-turns <n>', 'turn budget per domain pass', '40')
  .option('--max-minutes <n>', 'wall-clock budget per domain pass', '45')
  .option('--parallel <n>', 'domain passes run at once', '3')
  .option('--label <text>', 'the design name shown in the report')
  .option('--sweep <dir>', 'reuse a copperhead-tools review record instead of running the sweep')
  .option('--tools <path>', 'copperhead-tools cli.js or executable (default: COPPERHEAD_TOOLS, then PATH)')
  .option('--replay <dir>', 're-verify a recorded review with no model and compare its report byte for byte; run it from the directory the review ran in')
  .option('--resume', 'continue the record in --out that a killed run left: keep its sweep, bundle and ended passes')
  .addHelpText(
    'after',
    '\nExit codes: 0 every pass ended and the report was written; 2 the report was written but a pass failed\n' +
      '(rerun it with --resume); 1 an error, or a replay that differs; 130 or 143 cancelled by SIGINT or SIGTERM.',
  )
  .action(
    async (
      designArg: string | undefined,
      opts: { out?: string; source?: string[]; fab?: string[]; fabProfile?: string; model?: string; domains: string; maxTurns: string; maxMinutes: string; parallel: string; label?: string; sweep?: string; tools?: string; replay?: string; resume?: boolean },
    ) => {
      const json = Boolean(program.opts().json);
      const log = (line: string) => console.error(line);
      // Cancelling stops the passes and the copperhead-tools processes, keeps every sample saved so
      // far (a later --resume reruns the interrupted passes), and exits 128 + the signal number.
      const cancel = new AbortController();
      // Every pass and copperhead-tools process listens on it; --parallel 8 passes more than the default ten.
      setMaxListeners(0, cancel.signal);
      let cancelCode = 0;
      const onSignal = (sig: NodeJS.Signals) => {
        if (cancelCode) process.exit(cancelCode);
        cancelCode = sig === 'SIGINT' ? 130 : 143;
        console.error(`review: ${sig}: cancelling`);
        cancel.abort();
        setTimeout(() => process.exit(cancelCode), 10_000).unref();
      };
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      try {
        const { runReview, replayReview } = await import('./review/run.js');
        if (opts.replay) {
          const r = await replayReview(opts.replay, { ...(opts.tools ? { tools: opts.tools } : {}), log, signal: cancel.signal });
          if (cancelCode) throw new Error('cancelled');
          if (json) console.log(JSON.stringify(r, null, 2));
          else console.log(r.identical ? `replay identical: ${r.replayReport}` : `replay DIFFERS: compare ${r.report} with ${r.replayReport} (a replay runs from the directory the review ran in)`);
          process.exit(r.identical ? 0 : 1);
        }
        if (!opts.out) throw new Error('--out is required (a new directory for the review record)');
        const design = designArg ?? repoOf(program.opts());
        const config = await loadConfig(design);
        const { model } = resolveModel(opts.model, config);
        const { makeProvider } = await import('./agent/loop.js');
        const res = await runReview({
          design,
          out: opts.out,
          sources: opts.source ?? [],
          model,
          domains: opts.domains.split(',').map((d) => d.trim().toUpperCase()).filter(Boolean),
          maxTurns: Number(opts.maxTurns),
          maxMinutes: Number(opts.maxMinutes),
          parallel: Number(opts.parallel),
          ...(opts.label ? { label: opts.label } : {}),
          ...(opts.sweep ? { sweep: opts.sweep } : {}),
          ...(opts.fab ? { fab: opts.fab } : {}),
          ...(opts.fabProfile ? { fabProfile: opts.fabProfile } : {}),
          ...(opts.resume ? { resume: true } : {}),
          ...(opts.tools ? { tools: opts.tools } : {}),
          makeProvider: reviewProviderFactory(config, makeProvider),
          log,
          signal: cancel.signal,
        });
        if (cancelCode) throw new Error('cancelled');
        if (json) console.log(JSON.stringify(res, null, 2));
        else {
          console.log(`report: ${res.report}`);
          console.log(`verification: ${JSON.stringify(res.summary)}`);
          for (const p of res.passes) console.log(`  ${p.domain}: ${p.outcome}, ${p.turns} turns, ${p.proposals} proposals, ${p.seconds} s${p.error ? ` (${p.error})` : ''}`);
        }
        const failed = res.passes.filter((p) => p.outcome === 'failed').map((p) => p.domain);
        if (failed.length) console.error(`review: ${failed.length} pass(es) failed (${failed.join(', ')}); the report covers the rest. Rerun them with --resume.`);
        process.exit(failed.length ? 2 : 0);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(cancelCode || 1);
      }
    },
  );

program
  .command('mcp')
  .description('EXPERIMENTAL: serve the gated pipeline to MCP hosts over stdio (unstable surface)')
  // `--repo` is also a global flag, but a host config reads as
  // `args: ["mcp", "--repo", "/path"]`, so the command accepts it locally too.
  .option('--repo <path>', 'target repository (default: cwd)')
  .action(async (opts: { repo?: string }) => {
    const repo = repoOf(opts.repo ? { repo: opts.repo } : program.opts());
    try {
      // Imported lazily, like `skill`: the MCP SDK and zod are a ~150ms load
      // that every other command — including the pre-commit `check` — would
      // otherwise pay, and a resolution failure here would take down the whole
      // CLI rather than just this command.
      const { startMcpServer } = await import('./mcp/server.js');
      // Never returns until the host closes stdio. Nothing is printed to
      // stdout here or anywhere downstream: it carries JSON-RPC alone.
      await startMcpServer({ repoRoot: repo });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('demo')
  .description('tour of what copperhead does, or run the USB-C breakout create pipeline')
  .option('--model <model>', 'codex | cursor | gpt-5 | claude | claude-code (or a provider-specific model id)')
  .option('--interactive', 're-enable the human gates (spec approval, pre-export)')
  .option('--dir <path>', 'demo repo directory (default: demo-runs/usb-c-breakout)')
  .option('--tour', 'print the overview only; do not run the pipeline')
  .action(async (opts: { model?: string; interactive?: boolean; dir?: string; tour?: boolean }) => {
    if (opts.tour) {
      const { setColorEnabled } = await import('./agent/theme.js');
      if (program.opts().json) {
        // --json is a contract, not a suggestion: a script that passes it
        // unconditionally must never get prose back. Plain lines, no SGR.
        setColorEnabled(false);
        console.log(JSON.stringify({ tour: demoTourText().split('\n') }, null, 2));
        process.exit(0);
      }
      // Color on for attended TTY tours even without a renderer.
      setColorEnabled(Boolean(process.stdout.isTTY) && !program.opts().plain && !process.env.NO_COLOR);
      console.log(demoTourText());
      process.exit(0);
    }
    try {
      const kicadVer = await kicadCliVersion();
      // Resolve model from the caller's cwd config / env / flag; the demo repo
      // is scaffolded next and typically has no model of its own yet.
      const config = await loadConfig(repoOf(program.opts()));
      const { model, source } = resolveModel(opts.model, config);
      const continuePrompt = budgetContinuePrompt();
      const res = await runDemo({
        model,
        modelSource: source,
        version,
        kicadCliVersion: kicadVer,
        interactive: opts.interactive ?? false,
        ...(opts.dir ? { demoDir: opts.dir } : {}),
        ...(continuePrompt ? { onBudgetExhausted: continuePrompt } : {}),
        log: (s) => console.log(s),
        renderer: rendererOf(),
      });
      process.exit(res.ok ? 0 : 1);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('create')
  .description(
    'Mode A: full pipeline from a product brief to the output package. Stops for a decision on a verified constraint conflict or a footprint that is not installed; re-run to resume at that stage',
  )
  .requiredOption('--brief <file>', 'product brief (markdown)')
  .option('--model <model>', 'codex | cursor | gpt-5 | claude | claude-code | compat:<id> (or a provider-specific model id)')
  .option('--interactive', 're-enable the human gates (spec approval, pre-export)')
  .action(async (opts: { brief: string; model?: string; interactive?: boolean }) => {
    const repo = repoOf(program.opts());
    try {
      const kicadVer = await kicadCliVersion();
      const config = await loadConfig(repo);
      const { model, source } = resolveModel(opts.model, config);
      const continuePrompt = budgetContinuePrompt();
      const res = await runCreate({
        repoRoot: repo,
        briefPath: opts.brief,
        model,
        interactive: opts.interactive ?? false,
        ...(continuePrompt ? { onBudgetExhausted: continuePrompt } : {}),
        log: (s) => console.log(s),
        renderer: rendererOf(),
        meta: { command: 'create', modelSource: source, version, kicadCliVersion: kicadVer },
      });
      process.exit(res.ok ? 0 : 1);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

const exportCmd = program
  .command('export')
  .description('emit supplier-ready files from repo state (deterministic; no LLM, no network)');

exportCmd
  .command('bom')
  .description('write a supplier-format BOM (jlcpcb | digikey | mouser) from docs/BOM.md')
  .requiredOption('--supplier <name>', 'jlcpcb | digikey | mouser')
  .option('--boards <n>', 'number of boards to order', String(DEFAULT_BOARDS))
  .option('--spares <percent>', 'spare parts percentage', String(DEFAULT_SPARES))
  .option('--include-unverified', 'include UNVERIFIED rows that carry an MPN (never MPN-less rows)')
  .action(async (opts: { supplier: string; boards: string; spares: string; includeUnverified?: boolean }) => {
    const repo = repoOf(program.opts());
    const json = Boolean(program.opts().json);
    try {
      const supplier = parseSupplier(opts.supplier);
      const boards = parseBoards(opts.boards);
      const spares = parseSpares(opts.spares);
      const res = await runExportBom({
        repoRoot: repo,
        supplier,
        boards,
        spares,
        includeUnverified: opts.includeUnverified ?? false,
      });
      // Warnings go to stderr so a `> file` redirect of stdout stays clean and
      // the excluded-rows report is still seen.
      for (const w of res.warnings) console.error(w);
      if (json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`wrote ${res.outPath} (${res.included.length} part(s), ${res.excluded.length} excluded)`);
      }
      process.exit(0);
    } catch (err) {
      // ExportError carries an actionable message (bad flag, missing BOM, drift);
      // anything else is unexpected. Both exit non-zero with no stack trace.
      console.error(err instanceof ExportError ? err.message : (err as Error).message);
      process.exit(1);
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
