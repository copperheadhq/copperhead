/**
 * Interactive agent shell (Claude Code–style). Default when `copperhead` is
 * invoked with no subcommand on a TTY: prompt → one `do`-equivalent run →
 * prompt again until /quit.
 */

import path from 'node:path';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import type { ProgressRenderer } from '../agent/render.js';
import { bold, copper, dim, err, ok, warn } from '../agent/theme.js';
import { fiducialMark } from '../agent/logo.js';
import { animateMarkAt, staggerWrite } from '../agent/animate.js';
import { runAgentLoop, type BudgetExhaustedStats, type RunResult } from '../agent/loop.js';
import type { ModelSource } from '../config.js';
import { loadConfig } from '../config.js';
import { branchName, headCommit, isDirty, isGitRepo, uncommittedCount } from '../util/git.js';
import { shortPath } from '../util/paths.js';
import { redactSecrets } from '../util/redact.js';
import { pickModel, type SelectItem } from '../util/select.js';
import { KeyReader, PASTE_OFF, PASTE_ON, promptWithSlashHints } from '../util/live-prompt.js';
import { TerminalDock } from '../util/dock.js';
import { DockRenderer } from '../agent/dock-renderer.js';
import { callout } from '../agent/box.js';
import { runCheck } from './check.js';
import { demoTourText } from './demo.js';
import {
  formatBomInspect,
  formatConfigInspect,
  formatConstraintsInspect,
  formatDriftInspect,
  formatGitInspect,
  formatLastInspect,
  formatNetsInspect,
  formatOpenSpecInspect,
  formatPartsInspect,
  formatRunsInspect,
  formatSyncInspect,
} from './repl-inspect.js';

export interface ReplOptions {
  repoRoot: string;
  model: string;
  modelSource: ModelSource;
  version: string;
  kicadCliVersion: string;
  maxTurns?: number;
  /**
   * Let each turn run on a dirty working tree. Off by default, exactly as for
   * `do`: a rollback hard-resets to the pre-run snapshot, so the preflight is
   * the thing standing between a failed turn and the user's uncommitted work.
   */
  allowDirty?: boolean;
  /** When set, pause for proposal approval inside each run. */
  interactive?: boolean;
  /** Optional first request before the prompt loop. */
  seed?: string;
  renderer: ProgressRenderer;
  log?: (line: string) => void;
  confirm?: (q: string) => Promise<boolean>;
  onBudgetExhausted?: (stats: BudgetExhaustedStats) => Promise<number>;
  /** Override streams (tests). Defaults to stdin/stdout. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Injected runner (tests / demo). Defaults to runAgentLoop. The second
   *  argument is the session logger: lines written through it land in the
   *  content region and the scrollable history. */
  runRequest?: (
    request: string,
    log?: (line: string) => void,
    renderer?: ProgressRenderer,
  ) => Promise<Pick<RunResult, 'outcome'>>;
  /** Injected /check (tests). */
  runCheckCmd?: (log?: (line: string) => void) => Promise<void>;
}

const QUIT = new Set(['/quit', '/exit', '/q']);

/** Slash commands shown in `/` dropdown, `/help`, and tab completion. */
export const SLASH_COMMANDS: SelectItem[] = [
  { value: '/demo', label: '/demo', description: 'what copperhead does + how to try it' },
  { value: '/examples', label: '/examples', description: 'example change-request prompts' },
  { value: '/status', label: '/status', description: 'repo, git, and config snapshot' },
  { value: '/check', label: '/check', description: 'ERC + DRC + drift — no LLM' },
  { value: '/parts', label: '/parts', description: 'refdes / value / footprint from schematic' },
  { value: '/nets', label: '/nets', description: 'net names and pin attachments' },
  { value: '/bom', label: '/bom', description: 'parsed docs/BOM.md (read-only)' },
  { value: '/sync', label: '/sync', description: 'doc↔board inconsistency report (verify only)' },
  { value: '/drift', label: '/drift', description: 'BOM/PINOUT vs schematic drift' },
  { value: '/constraints', label: '/constraints', description: 'open constraint registry' },
  { value: '/openspec', label: '/openspec', description: 'openspec validate (no LLM)' },
  { value: '/config', label: '/config', description: 'resolved .copperhead/config.json' },
  { value: '/git', label: '/git', description: 'branch + dirty file list' },
  { value: '/runs', label: '/runs', description: 'recent .copperhead/runs/' },
  { value: '/last', label: '/last', description: 'newest run summary preview' },
  { value: '/model', label: '/model', description: 'switch the session model (picker)' },
  { value: '/version', label: '/version', description: 'copperhead / kicad-cli / node' },
  { value: '/clear', label: '/clear', description: 'clear the screen' },
  { value: '/help', label: '/help', description: 'list commands' },
  { value: '/quit', label: '/quit', description: 'leave the shell' },
];

/** Placeholder examples rotated through the empty input box. */
const EXAMPLE_REQUESTS = [
  'add reverse-polarity protection on VIN',
  'rename net KEY_DAH to KEY_DASH',
  'add a power LED on the 3V3 rail',
  'add ESD diodes on the USB data lines',
];

/** Bare words that must NOT start an agent run (common mistake: `clear` without `/`). */
const BARE_ALIASES: Record<string, string> = {
  quit: '/quit',
  exit: '/quit',
  q: '/quit',
  clear: '/clear',
  cls: '/clear',
  help: '/help',
  demo: '/demo',
  examples: '/examples',
  status: '/status',
  check: '/check',
  parts: '/parts',
  nets: '/nets',
  bom: '/bom',
  sync: '/sync',
  drift: '/drift',
  constraints: '/constraints',
  openspec: '/openspec',
  config: '/config',
  git: '/git',
  runs: '/runs',
  last: '/last',
  model: '/model',
  version: '/version',
};

/** Parse a slash command; returns null when the line is a normal request. */
export function parseSlash(line: string): { cmd: string; args: string } | null {
  const t = line.trim();
  if (!t) return null;

  // Bare aliases: `quit` / `clear` / … act like their slash forms so a typo
  // does not kick off a multi-minute agent turn.
  const bare = BARE_ALIASES[t.toLowerCase()];
  if (bare) return { cmd: bare, args: '' };

  if (!t.startsWith('/')) return null;
  // Bare `/` opens the command dropdown.
  if (t === '/') return { cmd: '/', args: '' };
  const sp = t.indexOf(' ');
  if (sp < 0) return { cmd: t.toLowerCase(), args: '' };
  return { cmd: t.slice(0, sp).toLowerCase(), args: t.slice(sp + 1).trim() };
}

/** Tab-completion matches for a partial slash command. */
export function completeSlash(partial: string): string[] {
  const p = partial.trim().toLowerCase();
  if (!p.startsWith('/')) return [];
  return SLASH_COMMANDS.map((c) => c.value).filter((c) => c.startsWith(p));
}

export { shortPath };

/** Exported for tests. */
export function helpText(): string {
  const rows: Array<[string, string]> = [
    ['/', 'type `/` to see live command suggestions'],
    ['<request>', 'run one gated agent change (same as `do`)'],
    ...SLASH_COMMANDS.map((c) => [c.label, c.description ?? ''] as [string, string]),
  ];
  const width = Math.max(...rows.map(([cmd]) => cmd.length));
  return [
    '',
    copper('  Commands'),
    '',
    ...rows.map(([cmd, desc]) => `  ${copper(cmd.padEnd(width))}  ${dim(desc)}`),
    '',
    dim('  Tip: type `/` to filter commands — ↑/↓ + Enter to pick, Tab to complete.'),
    dim('  Tip: run `copperhead demo` outside the shell for the full USB-C create pipeline.'),
    dim('  Tip: PgUp/PgDn scroll session history; the log mirrors to .copperhead/runs/repl-<ts>.log.'),
    '',
  ].join('\n');
}

export function examplesText(): string {
  return [
    '',
    copper('  Example prompts'),
    '',
    dim('  Drop any of these at the prompt (or use `copperhead do "…"`):'),
    '',
    `  ${copper('▸')} add reverse-polarity protection on VIN`,
    `  ${copper('▸')} rename net KEY_DAH to KEY_DASH`,
    `  ${copper('▸')} add a power LED on the 3V3 rail`,
    `  ${copper('▸')} move the key input to a different RTC-capable pin`,
    `  ${copper('▸')} add ESD diodes on the USB data lines`,
    '',
    dim('  Full board-from-brief demo:'),
    `  ${copper('copperhead demo')}  ${dim('— USB-C power breakout create pipeline')}`,
    '',
  ].join('\n');
}

function metaRow(label: string, value: string): string {
  return `  ${dim(label.padEnd(10))} ${value}`;
}

/** Exported for tests. Claude Code-style lockup: mark left, three meta lines right. */
export function banner(opts: ReplOptions): string[] {
  const repo = shortPath(path.resolve(opts.repoRoot));
  const mark = fiducialMark();
  const info = [
    `${bold('copperhead')} ${dim(`v${opts.version}`)}`,
    dim(`${opts.model} via ${opts.modelSource} · kicad-cli ${opts.kicadCliVersion}`),
    dim(repo),
  ];
  const lines = ['', ...mark.map((m, i) => `${copper(m)}  ${info[i]!}`), ''];
  if (!existsSync(path.join(path.resolve(opts.repoRoot), '.copperhead'))) {
    lines.push(
      ...callout('info', 'New repository?', [
        ' `copperhead init` scaffolds docs/ from an existing schematic',
        ' `copperhead demo` runs the USB-C breakout create pipeline',
        copper('Docs: https://docs.copperhead.sh'),
      ]),
      '',
    );
  }
  return lines;
}

/** Plain prompt text; the input area paints it copper (nbsp after ❯, like Claude Code). */
const PROMPT = '❯ ';

function isTtyStream(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): boolean {
  return Boolean((input as NodeJS.ReadStream).isTTY) && Boolean((output as NodeJS.WriteStream).isTTY);
}

async function statusText(opts: ReplOptions): Promise<string> {
  const repo = path.resolve(opts.repoRoot);
  const lines = [
    '',
    copper('  Status'),
    '',
    metaRow('repo', shortPath(repo)),
    metaRow('model', `${opts.model}  ${dim(`via ${opts.modelSource}`)}`),
    metaRow('kicad-cli', opts.kicadCliVersion),
    metaRow('node', process.version),
  ];

  if (await isGitRepo(repo)) {
    const [branch, commit, dirty, n] = await Promise.all([
      branchName(repo).catch(() => 'unknown'),
      headCommit(repo).catch(() => 'unknown'),
      isDirty(repo).catch(() => null),
      uncommittedCount(repo).catch(() => null),
    ]);
    const state =
      dirty === null ? 'unknown' : dirty ? `dirty (${n ?? '?'} file(s))` : ok('clean');
    lines.push(metaRow('git', `${branch}@${commit.slice(0, 7)}  ${state}`));
  } else {
    lines.push(metaRow('git', warn('not a git repository')));
  }

  try {
    const config = await loadConfig(repo);
    lines.push(metaRow('schematic', config.schematic ?? dim('null')));
    lines.push(metaRow('board', config.board ?? dim('null')));
    lines.push(metaRow('docs', config.docs));
    lines.push(metaRow('maxTurns', String(opts.maxTurns ?? config.maxTurns)));
  } catch {
    lines.push(metaRow('config', dim('no .copperhead/config.json yet — try `copperhead init`')));
  }

  if (!existsSync(path.join(repo, '.copperhead'))) {
    lines.push('');
    lines.push(dim('  Hint: `copperhead init` scaffolds docs/ from an existing schematic.'));
  }

  lines.push('');
  return lines.join('\n');
}

function defaultRunner(opts: ReplOptions, log: (l: string) => void) {
  return (request: string) =>
    runAgentLoop({
      repoRoot: opts.repoRoot,
      request,
      model: opts.model,
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      allowDirty: opts.allowDirty ?? false,
      interactive: opts.interactive ?? false,
      confirm: opts.confirm,
      ...(opts.onBudgetExhausted ? { onBudgetExhausted: opts.onBudgetExhausted } : {}),
      renderer: opts.renderer,
      log,
      meta: {
        command: 'repl',
        modelSource: opts.modelSource,
        version: opts.version,
        kicadCliVersion: opts.kicadCliVersion,
      },
    });
}

/**
 * Run the interactive shell. Resolves when the user quits.
 * Returns ok:false when the shell could not start (non-TTY without a usable seed).
 */
export async function runRepl(opts: ReplOptions): Promise<{ ok: boolean; turns: number }> {
  const baseLog = opts.log ?? ((l: string) => console.log(l));
  // Every durable content line lands in the session history so PgUp/PgDn can
  // scroll back through it (the alt screen has no native scrollback), and is
  // mirrored to a session log file by default (plain text, run through the
  // shared AC-4.1 redactor so this new persisted file is no weaker than the
  // transcripts beside it). Injected loggers (tests/embeds) own their sinks:
  // no file then.
  const history: string[] = [];
  const HISTORY_CAP = 5000;
  const SGR_RE = /\x1b\[[0-9;]*m/g;
  let logFile: { write(chunk: string): unknown; end(): void } | null = null;
  let logFilePath: string | null = null;
  /**
   * Append one already-redacted chunk to the session log. Takes the whole
   * message rather than a line: multi-line secrets (a PEM private-key block)
   * only match their pattern intact, so redacting after a split would write
   * the body out verbatim. The chunk carries its own newlines, so the bytes
   * are identical to writing each line separately.
   */
  const fileChunk = (text: string): void => {
    try {
      if (!logFile) {
        const dir = path.join(path.resolve(opts.repoRoot), '.copperhead', 'runs');
        mkdirSync(dir, { recursive: true });
        logFilePath = path.join(dir, `repl-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
        logFile = createWriteStream(logFilePath, { flags: 'a' });
      }
      logFile.write(text + '\n');
    } catch {
      // Best-effort: the shell never fails because the log file cannot.
    }
  };
  const log = (l: string): void => {
    const raw = String(l);
    // Redact the whole message BEFORE splitting (AC-4.1): the history and the
    // terminal keep the raw text, only the persisted file is redacted.
    if (!opts.log) fileChunk(redactSecrets(raw.replace(SGR_RE, '')));
    for (const line of raw.split('\n')) history.push(line);
    if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP);
    baseLog(l);
  };
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const seed = opts.seed?.trim() || undefined;
  const tty = isTtyStream(input, output);

  const runOne = opts.runRequest ?? defaultRunner(opts, log);
  const checkCmd =
    opts.runCheckCmd ??
    (async () => {
      const res = await runCheck(opts.repoRoot, log);
      log(res.ok ? ok('check: all green') : warn('check: failures reported above'));
    });

  if (!tty) {
    if (!seed) {
      log(
        err(
          'copperhead: interactive shell requires a TTY. Use `copperhead do "<request>"` for one-shot runs.',
        ),
      );
      return { ok: false, turns: 0 };
    }
    try {
      const res = await runOne(seed, log, opts.renderer);
      return { ok: res.outcome !== 'failure', turns: 1 };
    } catch (e) {
      log(err((e as Error).message));
      return { ok: false, turns: 0 };
    }
  }

  // Own the full window (htop-style): switch to the alternate screen buffer,
  // so the shell underneath stays untouched, the viewport cannot scroll into
  // old shell content, and quitting restores the terminal exactly as it was.
  // Bracketed paste goes on with it, so a pasted multi-line request arrives as
  // one delimited blob instead of submitting itself at the first newline.
  (output as NodeJS.WritableStream).write(`\x1b[?1049h\x1b[2J\x1b[H${PASTE_ON}`);
  const restoreScreen = (): void => {
    // Reset the scroll region too: it survives the alt-screen switch on some
    // terminals and would leave the user's shell fenced to a partial window.
    (output as NodeJS.WritableStream).write(`${PASTE_OFF}\x1b[r\x1b[?1049l\x1b[?25h`);
  };
  // Ctrl+C during an agent turn terminates the process (PR semantics); make
  // sure the terminal is never left stranded in the alternate buffer.
  const onSigint = (): void => {
    restoreScreen();
    process.exit(130);
  };
  process.on('SIGINT', onSigint);
  process.once('exit', restoreScreen);

  // Load the full screen first (banner now, dock right after); the mark
  // animation plays in place once the prompt is up. First run in a repo
  // (no .copperhead/ yet) uses the slow, recordable timing.
  const firstRun = !existsSync(path.join(path.resolve(opts.repoRoot), '.copperhead'));
  for (const line of banner(opts)) log(line);

  let turns = 0;
  const handleRequest = async (request: string): Promise<void> => {
    try {
      const res = await runOne(request, log, opts.renderer);
      turns++;
      if (res.outcome === 'failure') {
        log(dim('(session continues — fix the issue or try another request)'));
      }
    } catch (e) {
      log(err((e as Error).message));
      log(dim('(session continues)'));
    }
  };

  if (seed) {
    log(`  ${copper('→')} ${seed}`);
    log('');
    await handleRequest(seed);
  }

  const keys = new KeyReader(input as NodeJS.ReadStream);
  const dock = new TerminalDock(output as NodeJS.WriteStream);

  /** Feed the session KeyReader into option pickers (selectMenu). */
  async function* sessionKeys(): AsyncGenerator<string> {
    for (;;) {
      const k = await keys.next();
      if (k === null) return;
      yield k;
    }
  }

  const runSlash = async (cmd: string): Promise<'quit' | 'continue'> => {
    if (QUIT.has(cmd)) return 'quit';
    if (cmd === '/help' || cmd === '/h' || cmd === '/?') {
      await staggerWrite(helpText().split('\n'), log);
      return 'continue';
    }
    if (cmd === '/demo') {
      await staggerWrite(demoTourText().split('\n'), log);
      return 'continue';
    }
    if (cmd === '/examples') {
      await staggerWrite(examplesText().split('\n'), log);
      return 'continue';
    }
    if (cmd === '/status') {
      log(await statusText(opts));
      return 'continue';
    }
    if (cmd === '/version') {
      log('');
      log(metaRow('copperhead', opts.version));
      log(metaRow('kicad-cli', opts.kicadCliVersion));
      log(metaRow('node', process.version));
      log('');
      return 'continue';
    }
    if (cmd === '/clear' || cmd === '/cls') {
      (output as NodeJS.WritableStream).write('\x1b[2J\x1b[H');
      for (const line of banner(opts)) log(line);
      return 'continue';
    }
    if (cmd === '/model') {
      // Claude Code-style option picker: switch the session model in place.
      log('');
      const chosen = await pickModel({
        output: output as NodeJS.WriteStream,
        keys: sessionKeys(),
      });
      if (chosen && chosen !== opts.model) {
        opts.model = chosen;
        opts.modelSource = 'picker';
        log(ok(`  model switched to ${chosen}`));
      } else {
        log(metaRow('model', `${opts.model}  ${dim(`via ${opts.modelSource}`)}`));
      }
      log('');
      return 'continue';
    }
    if (cmd === '/check') {
      log('');
      try {
        await checkCmd(log);
      } catch (e) {
        log(err((e as Error).message));
      }
      log('');
      return 'continue';
    }
    if (cmd === '/sync') {
      try {
        log(await formatSyncInspect(opts.repoRoot));
      } catch (e) {
        log(err((e as Error).message));
      }
      return 'continue';
    }
    if (cmd === '/drift') {
      try {
        log(await formatDriftInspect(opts.repoRoot));
      } catch (e) {
        log(err((e as Error).message));
      }
      return 'continue';
    }
    if (cmd === '/constraints') {
      try {
        log(await formatConstraintsInspect(opts.repoRoot));
      } catch (e) {
        log(err((e as Error).message));
      }
      return 'continue';
    }
    if (cmd === '/config') {
      try {
        log(await formatConfigInspect(opts.repoRoot));
      } catch (e) {
        log(err((e as Error).message));
      }
      return 'continue';
    }
    if (cmd === '/git') {
      try {
        log(await formatGitInspect(opts.repoRoot));
      } catch (e) {
        log(err((e as Error).message));
      }
      return 'continue';
    }
    if (cmd === '/runs') {
      try {
        log(await formatRunsInspect(opts.repoRoot));
      } catch (e) {
        log(err((e as Error).message));
      }
      return 'continue';
    }
    if (cmd === '/parts') {
      try {
        log(await formatPartsInspect(opts.repoRoot));
      } catch (e) {
        log(err((e as Error).message));
      }
      return 'continue';
    }
    if (cmd === '/nets') {
      try {
        log(await formatNetsInspect(opts.repoRoot));
      } catch (e) {
        log(err((e as Error).message));
      }
      return 'continue';
    }
    if (cmd === '/bom') {
      try {
        log(await formatBomInspect(opts.repoRoot));
      } catch (e) {
        log(err((e as Error).message));
      }
      return 'continue';
    }
    if (cmd === '/openspec') {
      try {
        log(await formatOpenSpecInspect(opts.repoRoot));
      } catch (e) {
        log(err((e as Error).message));
      }
      return 'continue';
    }
    if (cmd === '/last') {
      try {
        log(await formatLastInspect(opts.repoRoot));
      } catch (e) {
        log(err((e as Error).message));
      }
      return 'continue';
    }
    log(warn(`  unknown command ${cmd} — type / to see commands`));
    return 'continue';
  };

  // Status-bar segments; git state refreshes after each agent turn.
  let gitSeg = '';
  const refreshGit = async (): Promise<void> => {
    if (!(await isGitRepo(opts.repoRoot))) {
      gitSeg = '';
      return;
    }
    const [branch, dirty] = await Promise.all([
      branchName(opts.repoRoot).catch(() => ''),
      isDirty(opts.repoRoot).catch(() => false),
    ]);
    gitSeg = branch ? `${branch}${dirty ? '*' : ''}` : '';
  };
  await refreshGit();

  const metaLine = (): string =>
    `${copper('●')} ${dim([opts.model, gitSeg].filter(Boolean).join(' · '))}`;

  let asked = 0;
  const ask = (): Promise<string | null> => {
    const example = EXAMPLE_REQUESTS[asked++ % EXAMPLE_REQUESTS.length]!;
    return promptWithSlashHints({
      prompt: PROMPT,
      commands: SLASH_COMMANDS,
      output: output as NodeJS.WriteStream,
      dock,
      placeholder: `Try "${example}"`,
      status: () => ({
        left: dim('/ for commands · pgup history · ctrl+c twice to quit'),
        right: dim(`In ${path.basename(path.resolve(opts.repoRoot))}`),
      }),
      meta: metaLine,
      echo: (line) => log(line),
      history: () => history,
      readKey: () => keys.next(),
      drainPrintable: () => keys.drainPrintable(),
    });
  };

  // Agent turns render through the dock too: durable lines into the content
  // region + history, the live observability row pinned inside the dock.
  opts.renderer = new DockRenderer(dock, log, () => ({
    meta: metaLine(),
    hints: dim('ctrl+c interrupts the run · output above scrolls into history'),
  }));

  // The banner mark sits at screen rows 2-4 (row 1 is the blank line after
  // the alt-screen clear); pulse it once the first prompt has painted.
  let markAnimated = false;

  try {
    for (;;) {
      const pending = ask();
      if (!markAnimated) {
        markAnimated = true;
        void animateMarkAt(output as NodeJS.WriteStream, 2, { slow: firstRun }).then(() =>
          dock.repaint(),
        );
      }
      const raw = await pending;
      if (raw === null) break;
      const line = raw.trim();
      if (!line) continue;

      const slash = parseSlash(line);
      if (slash) {
        // Live prompt already resolves bare `/` to a concrete command via Enter.
        if (slash.cmd === '/') continue;
        // Echo again above command output so history stays readable after
        // long tours (/demo) push the prompt line out of the first viewport.
        log(dim(`  → ${slash.cmd}`));
        const result = await runSlash(slash.cmd);
        if (result === 'quit') break;
        continue;
      }

      // Pause raw-mode so Ctrl+C is a real SIGINT during the agent turn.
      log('');
      keys.pause();
      try {
        await handleRequest(line);
      } finally {
        keys.resume();
      }
      await refreshGit();
      log('');
    }
  } finally {
    keys.close();
    dock.release();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('exit', restoreScreen);
    restoreScreen();
  }

  // Printed after the screen restore, so it lands in the normal buffer where
  // the user's shell resumes.
  log(dim('  copperhead session ended'));
  if (logFilePath) log(dim(`  session log: ${shortPath(logFilePath)}`));
  // Cast: TS narrows the closure-assigned handle to its initializer here.
  (logFile as { end(): void } | null)?.end();

  return { ok: true, turns };
}
