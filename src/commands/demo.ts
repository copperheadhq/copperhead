/**
 * End-to-end demo: scaffold a tiny git repo and run `create` against the
 * USB-C power breakout brief (same path as `npm run demo:simple`).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir, appendFile } from 'node:fs/promises';
import { execa } from 'execa';
import type { ProgressRenderer } from '../agent/render.js';
import type { RunMetaInput } from '../agent/runmeta.js';
import type { BudgetExhaustedStats } from '../agent/loop.js';
import { copper, dim, ok } from '../agent/theme.js';
import { traceRule } from '../agent/animate.js';
import { shortPath } from '../util/paths.js';
import { runCreate } from './create.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_BRIEF = path.join(PKG_ROOT, 'examples/simple/usb-c-breakout.md');

export interface DemoOptions {
  model: string;
  modelSource: RunMetaInput['modelSource'];
  version: string;
  kicadCliVersion: string;
  interactive?: boolean;
  /** Override demo repo (defaults to demo-runs/usb-c-breakout or COPPERHEAD_DEMO_DIR). */
  demoDir?: string;
  briefPath?: string;
  log?: (line: string) => void;
  renderer: ProgressRenderer;
  onBudgetExhausted?: (stats: BudgetExhaustedStats) => Promise<number>;
}

/** Resolve the packaged USB-C brief; throws a clear error if the install is incomplete. */
export function defaultBriefPath(): string {
  if (!existsSync(DEFAULT_BRIEF)) {
    throw new Error(
      `demo brief missing at ${DEFAULT_BRIEF}; reinstall copperhead or run from a full checkout`,
    );
  }
  return DEFAULT_BRIEF;
}

export function defaultDemoDir(): string {
  return (
    process.env.COPPERHEAD_DEMO_DIR ?? path.resolve(process.cwd(), 'demo-runs/usb-c-breakout')
  );
}

/** Marker identifying a directory scaffolded by `copperhead demo`. */
const DEMO_MARKER = path.join('.copperhead', 'demo-repo');

/**
 * Prepare a clean-enough git repo for the create pipeline (git init, ignore
 * runs/, baseline config + commit). Mirrors scripts/demo-simple.sh.
 */
export async function scaffoldDemoRepo(demoDir: string): Promise<void> {
  await mkdir(demoDir, { recursive: true });

  // Fail closed before touching git: only scaffold into an empty directory
  // or one this function created earlier (identified by the marker file).
  // Anything else risks git-initializing and committing into a directory
  // the user cares about.
  const entries = await readdir(demoDir);
  if (entries.length > 0 && !existsSync(path.join(demoDir, DEMO_MARKER))) {
    throw new Error(
      `refusing to scaffold the demo repo in ${demoDir}: the directory is not empty and was not created by copperhead demo; use an empty directory (or point COPPERHEAD_DEMO_DIR elsewhere)`,
    );
  }

  const git = async (...args: string[]) => execa('git', args, { cwd: demoDir });

  if (!existsSync(path.join(demoDir, '.git'))) {
    await git('init', '-q');
  }

  const hasName = await execa('git', ['config', 'user.name'], { cwd: demoDir, reject: false });
  if (hasName.exitCode !== 0) await git('config', 'user.name', 'copperhead demo');
  const hasEmail = await execa('git', ['config', 'user.email'], { cwd: demoDir, reject: false });
  if (hasEmail.exitCode !== 0) await git('config', 'user.email', 'demo@copperhead.local');

  const gi = path.join(demoDir, '.gitignore');
  if (!existsSync(gi)) await writeFile(gi, '', 'utf8');
  const giText = await readFile(gi, 'utf8');
  if (!giText.split('\n').includes('.copperhead/runs/')) {
    await appendFile(gi, (giText.endsWith('\n') || giText === '' ? '' : '\n') + '.copperhead/runs/\n');
  }

  const cfgDir = path.join(demoDir, '.copperhead');
  await mkdir(cfgDir, { recursive: true });
  const marker = path.join(demoDir, DEMO_MARKER);
  if (!existsSync(marker)) await writeFile(marker, 'created by copperhead demo\n', 'utf8');
  const cfg = path.join(cfgDir, 'config.json');
  if (!existsSync(cfg)) {
    // Create stages need a larger turn budget than a single `do` edit.
    await writeFile(
      cfg,
      `${JSON.stringify({ docs: 'docs/', maxTurns: 100, maxRepairCycles: 5 }, null, 2)}\n`,
      'utf8',
    );
  }

  await git('add', '.gitignore', '.copperhead/config.json');
  const head = await execa('git', ['rev-parse', '--verify', 'HEAD'], { cwd: demoDir, reject: false });
  if (head.exitCode !== 0) {
    await git('commit', '-q', '-m', 'demo: initialize repository');
  } else {
    const staged = await execa('git', ['diff', '--cached', '--quiet'], { cwd: demoDir, reject: false });
    if (staged.exitCode !== 0) {
      await git('commit', '-q', '-m', 'demo: update demo scaffolding');
    }
  }
}

/** What copperhead is — printed by `/demo` and `copperhead demo --tour`. */
export function demoTourText(): string {
  return [
    '',
    copper('  What copperhead does'),
    traceRule(28),
    '',
    dim('  Cursor for circuit boards. You describe a change; the agent edits'),
    dim('  real KiCad files, keeps design docs in sync, and verifies with'),
    dim('  kicad-cli ERC/DRC before anything is committed.'),
    '',
    copper('  The loop'),
    traceRule(16),
    '',
    `  ${copper('1.')} ${dim('Propose')}   write an OpenSpec change (edit tools stay locked until it validates)`,
    `  ${copper('2.')} ${dim('Edit')}      anchored edits to .kicad_sch / .kicad_pcb + docs`,
    `  ${copper('3.')} ${dim('Verify')}    run ERC (and DRC if the board changed); repair or roll back`,
    `  ${copper('4.')} ${dim('Remember')}  DECISIONS.md + CHANGELOG + a run summary next to the transcript`,
    '',
    copper('  Try it'),
    traceRule(14),
    '',
    `  ${copper('copperhead demo')}              ${dim('full create pipeline (USB-C breakout)')}`,
    `  ${copper('copperhead')}                   ${dim('interactive shell — type a change request')}`,
    `  ${copper('copperhead do "add an LED"')}    ${dim('one-shot edit on the current repo')}`,
    '',
    copper('  Example prompts'),
    traceRule(22),
    '',
    dim('  • add reverse-polarity protection on VIN'),
    dim('  • rename net KEY_DAH to KEY_DASH'),
    dim('  • move the key input to a different RTC-capable pin'),
    '',
  ].join('\n');
}

export async function runDemo(opts: DemoOptions): Promise<{ ok: boolean; demoDir: string }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const demoDir = path.resolve(opts.demoDir ?? defaultDemoDir());
  const briefPath = path.resolve(opts.briefPath ?? defaultBriefPath());

  log('');
  log(`  ${copper('copperhead demo')}  ${dim('USB-C power breakout')}`);
  log(`  ${dim('repo')}   ${shortPath(demoDir)}`);
  log(`  ${dim('brief')}  ${shortPath(briefPath)}`);
  log('');

  await scaffoldDemoRepo(demoDir);
  log(ok('  scaffold ready'));
  log('');

  const res = await runCreate({
    repoRoot: demoDir,
    briefPath,
    model: opts.model,
    interactive: opts.interactive ?? false,
    ...(opts.onBudgetExhausted ? { onBudgetExhausted: opts.onBudgetExhausted } : {}),
    log,
    renderer: opts.renderer,
    meta: {
      command: 'create',
      modelSource: opts.modelSource,
      version: opts.version,
      kicadCliVersion: opts.kicadCliVersion,
    },
  });

  return { ok: res.ok, demoDir };
}
