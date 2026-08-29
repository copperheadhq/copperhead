/**
 * Live progress rendering for agent-loop runs (design D7). Two modes chosen
 * once at startup: interactive (TTY, no --json/--plain) pins a status line to
 * the bottom of the terminal and redraws it in place; plain emits line-oriented
 * output with zero ANSI escapes — the mode CI, pipes, and tests see.
 *
 * Interactive mode adds subtle SGR chrome (copper accent, dim secondary text).
 * Plain mode never emits color (AC-8.9).
 */

import { copper, dim, setColorEnabled, styleOutcome, toolLine, warn } from './theme.js';

export interface ProgressRenderer {
  log(line: string): void;
  /** Called at the start of each turn with cumulative token totals so far. */
  turnStart(turn: number, maxTurns: number, tokensIn: number, tokensOut: number): void;
  toolResult(name: string, firstLine: string, ok?: boolean): void;
  /** Busy text while a provider call is in flight; null when idle. */
  status(text: string | null): void;
  /**
   * Liveness signal emitted periodically while a provider turn is in flight
   * (5.1): distinguishes a slow turn from a hung one. `elapsedMs` is time since
   * this turn's provider call began; `streamedChars` is cumulative streamed
   * output (0 when the provider doesn't stream — the elapsed time still tells
   * the operator the turn is alive).
   */
  heartbeat(info: { elapsedMs: number; streamedChars: number }): void;
  /** Final outcome line; replaces the status line in interactive mode. */
  finish(line: string): void;
}

/** Compact token count: 850 -> "850", 12300 -> "12.3k". */
export function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

/** Compact duration: 42s, 1m32s, 1h04m. */
export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function turnMarker(turn: number, maxTurns: number, tokensIn: number, tokensOut: number): string {
  return `[turn ${turn}/${maxTurns} · ${fmtTokens(tokensIn)} in / ${fmtTokens(tokensOut)} out]`;
}

/** Wrap a bare log function into the plain (non-interactive) renderer. */
export function plainRenderer(log: (line: string) => void): ProgressRenderer {
  return {
    log,
    turnStart: (turn, maxTurns, tokensIn, tokensOut) => log(turnMarker(turn, maxTurns, tokensIn, tokensOut)),
    toolResult: (name, firstLine) => log(`  [${name}] ${firstLine}`),
    status: () => {},
    heartbeat: ({ elapsedMs, streamedChars }) =>
      log(
        `  … still working — ${fmtDuration(elapsedMs)} elapsed` +
          (streamedChars ? `, ~${fmtTokens(streamedChars)} chars streamed` : ' (no output yet)'),
      ),
    finish: (line) => log(line),
  };
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\r\x1b[2K';

/** Minimal writable surface so tests can drive a fake TTY. */
export interface TtyLike {
  write(chunk: string): unknown;
  columns?: number;
}

/**
 * The interactive renderer. Everything printed goes above the status line
 * (clear -> print -> redraw) so the scrollback stays a complete log; only the
 * status line itself is ever redrawn in place (AC-8.8).
 */
export class InteractiveRenderer implements ProgressRenderer {
  private readonly out: TtyLike;
  private startMs = Date.now();
  private turn = 0;
  private maxTurns = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private streamedChars = 0;
  private busy: string | null = null;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private statusShown = false;
  /**
   * True between runs: no status line is owned and log lines pass straight
   * through. finish() suspends rather than destroys, because a multi-stage
   * `create` pipeline reuses one renderer across its stages; the next
   * turnStart() re-arms it.
   */
  private idle = true;
  private readonly cleanup = (): void => this.teardown();
  private readonly onSigint = (): void => {
    this.teardown();
    process.exit(130);
  };

  constructor(out: TtyLike = process.stdout) {
    this.out = out;
    process.on('exit', this.cleanup);
    process.on('SIGINT', this.onSigint);
  }

  private statusText(): string {
    // Raw (uncolored) segments once; both the colored line and the
    // narrow-terminal fallback are assembled from these.
    const spinner = this.busy ? FRAMES[this.frame % FRAMES.length]! : '·';
    const turn = `turn ${this.turn}/${this.maxTurns}`;
    const tokens = `${fmtTokens(this.tokensIn)} in / ${fmtTokens(this.tokensOut)} out`;
    const elapsed = fmtDuration(Date.now() - this.startMs);
    // Fold streamed-output volume into the busy segment so a large turn's
    // status line visibly grows — a hung one stays frozen (5.1).
    const busy = this.busy
      ? this.streamedChars
        ? `${this.busy} ~${fmtTokens(this.streamedChars)} ch`
        : this.busy
      : undefined;
    const parts = [turn, dim(tokens), dim(elapsed), ...(busy ? [warn(busy)] : [])];
    const line = `${this.busy ? copper(spinner) : dim(spinner)} ${parts.join(dim(' · '))}`;
    // Truncate by visible length roughly: strip SGR when measuring so color
    // codes don't eat the column budget and clip the readable text early.
    const width = this.out.columns ?? 80;
    const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
    if (visible.length <= width) return line;
    // Fall back to an uncolored truncated line when the terminal is too narrow.
    const plain = [spinner, turn, tokens, elapsed, ...(busy ? [busy] : [])].join(' · ');
    return plain.length > width ? plain.slice(0, width - 1) : plain;
  }

  private redraw(): void {
    if (this.idle) return;
    if (!this.statusShown) {
      this.out.write(HIDE_CURSOR);
      this.statusShown = true;
    }
    this.out.write(CLEAR_LINE + this.statusText());
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame++;
      this.redraw();
    }, 80);
    this.timer.unref?.();
  }

  /** Print above the status line: clear it, write, redraw it. */
  log(line: string): void {
    if (this.statusShown) this.out.write(CLEAR_LINE);
    this.out.write(line + '\n');
    this.redraw();
  }

  turnStart(turn: number, maxTurns: number, tokensIn: number, tokensOut: number): void {
    if (this.idle) {
      this.idle = false;
      this.startMs = Date.now(); // elapsed time is per run, not per renderer
    }
    this.turn = turn;
    this.maxTurns = maxTurns;
    this.tokensIn = tokensIn;
    this.tokensOut = tokensOut;
    this.streamedChars = 0; // per-turn: reset so last turn's volume doesn't linger
    this.ensureTimer();
    this.redraw();
  }

  toolResult(name: string, firstLine: string, ok?: boolean): void {
    this.log(toolLine(name, firstLine, ok));
  }

  status(text: string | null): void {
    this.busy = text;
    if (!text) this.streamedChars = 0; // turn's provider call ended
    if (text && !this.idle) this.ensureTimer();
    this.redraw();
  }

  heartbeat({ streamedChars }: { elapsedMs: number; streamedChars: number }): void {
    // The spinner timer already advances elapsed time in place; the heartbeat's
    // job here is to fold in the latest streamed-output volume and redraw.
    this.streamedChars = streamedChars;
    this.redraw();
  }

  finish(line: string): void {
    if (this.statusShown) this.out.write(CLEAR_LINE);
    this.out.write(styleOutcome(line) + '\n');
    this.suspend();
  }

  /** Release the status line (stop the spinner, restore the cursor) but stay usable. */
  private suspend(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.statusShown) {
      this.out.write(CLEAR_LINE + SHOW_CURSOR);
      this.statusShown = false;
    }
    this.busy = null;
    this.frame = 0;
    this.idle = true;
  }

  /** Process is going away (exit/SIGINT): suspend and drop the listeners. */
  private teardown(): void {
    this.suspend();
    process.removeListener('exit', this.cleanup);
    process.removeListener('SIGINT', this.onSigint);
  }
}

/**
 * Pick the renderer for a CLI invocation: interactive only on a real TTY with
 * neither --json nor --plain (AC-8.8/8.9); plain mode is the safe fallback.
 * Under --json, progress goes to stderr so stdout stays machine-parseable
 * (AC-2.4): the only thing a --json invocation writes to stdout is its JSON.
 */
export function makeRenderer(opts: { json: boolean; plain: boolean }): ProgressRenderer {
  const interactive = !opts.json && !opts.plain && Boolean(process.stdout.isTTY);
  // Color tracks the interactive path so --plain / pipes stay zero-ANSI (AC-8.9).
  setColorEnabled(interactive && !process.env.NO_COLOR);
  if (opts.json) return plainRenderer((line) => console.error(line));
  if (interactive) return new InteractiveRenderer();
  return plainRenderer((line) => console.log(line));
}
