import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  parseSlash,
  runRepl,
  shortPath,
  helpText,
  banner,
  examplesText,
  completeSlash,
  SLASH_COMMANDS,
} from '../src/commands/repl.js';
import { demoTourText, scaffoldDemoRepo, defaultBriefPath } from '../src/commands/demo.js';
import { pickModel, selectMenu } from '../src/util/select.js';
import {
  keySequence,
  inputRowRows,
  KeyReader,
  promptWithSlashHints,
  pushKeys,
  suggestionLines,
} from '../src/util/live-prompt.js';
import { fiducialBootFrames, prefersAnimation } from '../src/agent/animate.js';
import { plainRenderer } from '../src/agent/render.js';
import { setColorEnabled } from '../src/agent/theme.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

function fakeTty(): { input: PassThrough; output: PassThrough; lines: string[] } {
  const input = new PassThrough();
  const output = new PassThrough();
  (input as unknown as { isTTY: boolean }).isTTY = true;
  (output as unknown as { isTTY: boolean }).isTTY = true;
  const lines: string[] = [];
  return { input, output, lines };
}

function baseOpts(extra: Partial<Parameters<typeof runRepl>[0]> = {}) {
  const { input, output, lines } = fakeTty();
  return {
    input,
    output,
    lines,
    opts: {
      repoRoot: '/tmp/repo',
      model: 'gpt-5',
      modelSource: 'flag' as const,
      version: '0.7.0',
      kicadCliVersion: '9.0.0',
      renderer: plainRenderer((l) => lines.push(l)),
      log: (l: string) => lines.push(l),
      input,
      output,
      runRequest: vi.fn(async () => ({ outcome: 'success' as const })),
      runCheckCmd: vi.fn(async () => {
        lines.push('check ok');
      }),
      ...extra,
    },
  };
}

describe('parseSlash', () => {
  it('detects slash commands and leaves normal requests alone', () => {
    expect(parseSlash('add an LED')).toBeNull();
    expect(parseSlash('/')).toEqual({ cmd: '/', args: '' });
    expect(parseSlash('/quit')).toEqual({ cmd: '/quit', args: '' });
    expect(parseSlash('/help me')).toEqual({ cmd: '/help', args: 'me' });
  });

  it('maps bare quit/clear/help so they never start an agent run', () => {
    expect(parseSlash('quit')).toEqual({ cmd: '/quit', args: '' });
    expect(parseSlash('clear')).toEqual({ cmd: '/clear', args: '' });
    expect(parseSlash('help')).toEqual({ cmd: '/help', args: '' });
    expect(parseSlash('EXIT')).toEqual({ cmd: '/quit', args: '' });
  });

  it('tab-completes slash commands', () => {
    expect(completeSlash('/d')).toContain('/demo');
    expect(completeSlash('/d')).toContain('/drift');
    expect(completeSlash('/st')).toEqual(['/status']);
    expect(completeSlash('/sy')).toEqual(['/sync']);
    expect(completeSlash('/con')).toEqual(expect.arrayContaining(['/config', '/constraints']));
    expect(completeSlash('add')).toEqual([]);
  });

  it('lists the new inspect slash commands', () => {
    const values = SLASH_COMMANDS.map((c) => c.value);
    for (const cmd of [
      '/sync',
      '/drift',
      '/constraints',
      '/config',
      '/git',
      '/runs',
      '/parts',
      '/nets',
      '/bom',
      '/openspec',
      '/last',
    ]) {
      expect(values).toContain(cmd);
      expect(helpText()).toContain(cmd);
    }
  });
});

describe('selectMenu', () => {
  it('returns the item selected with Enter after ↓', async () => {
    setColorEnabled(false);
    const output = new PassThrough();
    async function* keys() {
      yield '\x1b[B'; // down
      yield '\r';
    }
    const chosen = await selectMenu({
      title: 'Commands',
      items: [
        { value: '/demo', label: '/demo' },
        { value: '/quit', label: '/quit' },
      ],
      output: output as unknown as NodeJS.WriteStream,
      keys: keys(),
    });
    expect(chosen).toBe('/quit');
  });

  it('cancels on Esc', async () => {
    setColorEnabled(false);
    const output = new PassThrough();
    async function* keys() {
      yield '\x1b';
    }
    const chosen = await selectMenu({
      title: 'Commands',
      items: [{ value: '/demo', label: '/demo' }],
      output: output as unknown as NodeJS.WriteStream,
      keys: keys(),
    });
    expect(chosen).toBeNull();
  });

  it('leaves the input stream alive after a pick (regression: for-await destroyed stdin)', async () => {
    setColorEnabled(false);
    const input = new PassThrough();
    const output = new PassThrough();
    const picking = selectMenu({
      title: 'M',
      items: [{ value: 'a', label: 'a' }],
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });
    input.write('\r');
    const chosen = await picking;
    expect(chosen).toBe('a');
    expect((input as unknown as { destroyed: boolean }).destroyed).toBe(false);
    // The stream must still deliver data to a later consumer.
    const next = new Promise<string>((resolve) => input.once('data', (c) => resolve(String(c))));
    input.write('later');
    input.resume();
    expect(await next).toBe('later');
  });

  it('pickModel offers the provider choices and returns the selection', async () => {
    setColorEnabled(false);
    const output = new PassThrough();
    let painted = '';
    output.on('data', (c) => {
      painted += String(c);
    });
    async function* keys() {
      yield '\x1b[B'; // down: claude-code -> codex
      yield '\r';
    }
    const chosen = await pickModel({
      output: output as unknown as NodeJS.WriteStream,
      keys: keys(),
    });
    expect(chosen).toBe('codex');
    expect(painted).toContain('claude-code');
    expect(painted).toContain('Cursor CLI');
  });
});

describe('animation helpers', () => {
  it('fiducial boot has growing frames and respects NO_ANIM', () => {
    setColorEnabled(true);
    const prev = process.env.COPPERHEAD_NO_ANIM;
    process.env.COPPERHEAD_NO_ANIM = '1';
    expect(prefersAnimation()).toBe(false);
    if (prev === undefined) delete process.env.COPPERHEAD_NO_ANIM;
    else process.env.COPPERHEAD_NO_ANIM = prev;
    const frames = fiducialBootFrames();
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames[frames.length - 1]!.join('\n')).toContain('▟');
    setColorEnabled(false);
  });
});

describe('repl chrome', () => {
  it('shortens home paths and keeps banner / help readable', () => {
    setColorEnabled(false);
    process.env.COPPERHEAD_NO_ANIM = '1';
    expect(shortPath(`${process.env.HOME}/OpenSource/circuits/copperhead`)).toMatch(/^~/);
    const text = banner({
      repoRoot: '/tmp/demo-board',
      model: 'cursor',
      modelSource: 'flag',
      version: '0.7.0',
      kicadCliVersion: '10.0.5',
      renderer: plainRenderer(() => {}),
    }).join('\n');
    expect(text).toContain('copperhead');
    expect(text).toContain('v0.7.0');
    expect(text).toContain('███  ███'); // brand via block mark (favicon.svg)
    expect(text).toContain('cursor');
    expect(text).toContain('kicad-cli');
    expect(helpText()).toContain('/check');
    expect(helpText()).toContain('/demo');
    expect(helpText()).toContain('/status');
    expect(helpText()).toContain('live command');
    expect(helpText()).toContain('<request>');
    expect(demoTourText()).toContain('What copperhead does');
    expect(examplesText()).toContain('add reverse-polarity');
  });
});

describe('promptWithSlashHints', () => {
  it('shows hovered command description above the list', () => {
    setColorEnabled(false);
    const lines = suggestionLines(
      [
        { value: '/demo', label: '/demo', description: 'tour text' },
        { value: '/quit', label: '/quit', description: 'leave the shell' },
      ],
      1,
    );
    const joined = lines.join('\n');
    expect(joined).toContain('/quit');
    expect(joined).toContain('leave the shell');
  });

  it('counts wrap rows for long pasted lines', () => {
    expect(inputRowRows('> ', 'x'.repeat(20), 10)).toBeGreaterThan(1);
  });

  it('coalesces paste via drainPrintable', async () => {
    setColorEnabled(false);
    const output = new PassThrough();
    (output as unknown as { columns: number }).columns = 40;
    const queued = ['p', 'p', 'e', 'n', 'd'];
    let i = 0;
    const seq = ['A', ...queued, '\r'];
    const line = await promptWithSlashHints({
      prompt: '> ',
      commands: SLASH_COMMANDS,
      output: output as unknown as NodeJS.WriteStream,
      readKey: async () => (i < seq.length ? seq[i++]! : null),
      drainPrintable: () => {
        let out = '';
        while (queued.length) out += queued.shift()!;
        i += out.length; // skip drained keys in readKey sequence
        return out;
      },
    });
    expect(line).toBe('Append');
  });

  it('shows matches as soon as / is typed and Enter picks the highlight', async () => {
    setColorEnabled(false);
    const output = new PassThrough();
    let painted = '';
    output.on('data', (c) => {
      painted += String(c);
    });
    const line = await promptWithSlashHints({
      prompt: '> ',
      commands: SLASH_COMMANDS,
      output: output as unknown as NodeJS.WriteStream,
      readKey: keySequence(['/', 'd', '\r']),
    });
    expect(line).toBe('/demo');
    expect(painted).toContain('/demo');
    // Final committed line in scrollback must show the selected command.
    expect(painted).toMatch(/> \/demo\n/);
  });

  it('↓ moves the highlight before Enter', async () => {
    setColorEnabled(false);
    const output = new PassThrough();
    let painted = '';
    output.on('data', (c) => {
      painted += String(c);
    });
    const line = await promptWithSlashHints({
      prompt: '> ',
      commands: SLASH_COMMANDS,
      output: output as unknown as NodeJS.WriteStream,
      readKey: keySequence(['/', '\x1b[B', '\r']),
    });
    expect(line).toBe('/examples');
    expect(painted).toContain('example change-request prompts');
  });

  it('assembles arrow keys that arrive split across chunks', () => {
    const pending = { buf: '' };
    const keys: string[] = [];
    pushKeys(pending, '\x1b', (k) => keys.push(k));
    expect(keys).toEqual([]); // ambiguous: could still become an arrow
    pushKeys(pending, '[B', (k) => keys.push(k));
    expect(keys).toEqual(['\x1b[B']);
  });

  it('delivers a lone Escape once the disambiguation timer fires', async () => {
    // Regression: a bare Esc was held in the assembler forever, because it is
    // also the first byte of every arrow key. The dismiss handler therefore
    // only fired one keystroke late, if at all.
    vi.useFakeTimers();
    try {
      const input = new PassThrough();
      (input as unknown as { isTTY: boolean }).isTTY = true;
      const reader = new KeyReader(input as unknown as NodeJS.ReadStream, 40);
      const first = reader.next();
      input.write('\x1b');
      await vi.advanceTimersByTimeAsync(39);
      // Still ambiguous, so still nothing delivered.
      let settled = false;
      void first.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(2);
      expect(await first).toBe('\x1b');
      reader.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire the Escape timer when the rest of an arrow arrives in time', async () => {
    vi.useFakeTimers();
    try {
      const input = new PassThrough();
      (input as unknown as { isTTY: boolean }).isTTY = true;
      const reader = new KeyReader(input as unknown as NodeJS.ReadStream, 40);
      const first = reader.next();
      input.write('\x1b');
      await vi.advanceTimersByTimeAsync(10);
      input.write('[A');
      await vi.advanceTimersByTimeAsync(100);
      expect(await first).toBe('\x1b[A'); // one arrow, not Esc then '[A'
      reader.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire the Escape timer on a paste-end marker split at its ESC byte', async () => {
    // Regression: the timer armed on any trailing lone `\x1b`, including the
    // first byte of a split `\x1b[201~`. Over a slow link (large paste, ssh,
    // tmux) the remaining five bytes could take longer than the 40ms window,
    // so the timer delivered a phantom Escape and consumed the ESC the marker
    // needed. Paste mode then never closed, and every later byte folded to a
    // space: Enter could not submit and Ctrl+C could not interrupt, leaving no
    // way out of the session from the keyboard.
    vi.useFakeTimers();
    try {
      const input = new PassThrough();
      (input as unknown as { isTTY: boolean }).isTTY = true;
      const reader = new KeyReader(input as unknown as NodeJS.ReadStream, 40);
      const keys: string[] = [];
      let stop = false;
      void (async () => {
        while (!stop) {
          const k = await reader.next();
          if (k === null) break;
          keys.push(k);
        }
      })();

      input.write('\x1b[200~hello');
      await vi.advanceTimersByTimeAsync(1);
      input.write('\x1b'); // the marker's first byte, alone
      await vi.advanceTimersByTimeAsync(50); // longer than the Esc window
      input.write('[201~'); // the rest of it, late
      input.write('\r');
      input.write('\x03');
      await vi.advanceTimersByTimeAsync(50);
      stop = true;

      // The paste closed: no phantom Escape, no marker text, and Enter and
      // Ctrl+C are live again.
      expect(keys.join('')).toBe('hello\r\x03');
      reader.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a bracketed paste as literal text, newlines and all', () => {
    // Regression: with no paste mode, a pasted newline hit the submit branch,
    // so a two-line change request started an agent run on only its first line.
    const pending = { buf: '' };
    const keys: string[] = [];
    pushKeys(pending, `\x1b[200~rename R1 to R10\nand update the BOM\x1b[201~`, (k) => keys.push(k));
    expect(keys.join('')).toBe('rename R1 to R10 and update the BOM');
    expect(keys).not.toContain('\n');
    expect(keys).not.toContain('\r');
  });

  it('holds back a paste-end marker split across reads', () => {
    const pending = { buf: '' };
    const keys: string[] = [];
    pushKeys(pending, '\x1b[200~abc', (k) => keys.push(k));
    expect(keys.join('')).toBe('abc');
    // The marker arrives two bytes at a time; none of it may leak as text.
    pushKeys(pending, '\x1b[2', (k) => keys.push(k));
    expect(keys.join('')).toBe('abc');
    pushKeys(pending, '01~z', (k) => keys.push(k));
    expect(keys.join('')).toBe('abcz');
  });

  it('resumes normal key handling after the paste closes', () => {
    const pending = { buf: '' };
    const keys: string[] = [];
    pushKeys(pending, '\x1b[200~hi\x1b[201~\x1b[B\r', (k) => keys.push(k));
    expect(keys).toEqual(['h', 'i', '\x1b[B', '\r']);
  });

  it('ignores a stray paste-end marker with no paste open', () => {
    const pending = { buf: '' };
    const keys: string[] = [];
    pushKeys(pending, 'a\x1b[201~b', (k) => keys.push(k));
    expect(keys).toEqual(['a', 'b']);
  });

  it('a pasted multi-line request is submitted whole, not at its first newline', async () => {
    setColorEnabled(false);
    const output = new PassThrough();
    const chunk = `\x1b[200~rename R1 to R10\nand update the BOM\x1b[201~\r`;
    const pending = { buf: '' };
    const queue: string[] = [];
    pushKeys(pending, chunk, (k) => queue.push(k));
    let i = 0;
    const line = await promptWithSlashHints({
      prompt: '> ',
      commands: SLASH_COMMANDS,
      output: output as unknown as NodeJS.WriteStream,
      readKey: async () => (i < queue.length ? queue[i++]! : null),
    });
    expect(line).toBe('rename R1 to R10 and update the BOM');
  });

  it('SS3 arrow sequences work (\\x1bOA)', async () => {
    setColorEnabled(false);
    const output = new PassThrough();
    const line = await promptWithSlashHints({
      prompt: '> ',
      commands: SLASH_COMMANDS,
      output: output as unknown as NodeJS.WriteStream,
      readKey: keySequence(['/', '\x1bOB', '\x1bOB', '\r']),
    });
    // /demo → /examples → /status
    expect(line).toBe('/status');
  });
});

describe('session log file', () => {
  it('mirrors session lines to .copperhead/runs/repl-*.log with keys redacted', async () => {
    setColorEnabled(false);
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-repl-log-'));
    try {
      const { input, output } = fakeTty();
      const done = runRepl({
        repoRoot: repo,
        model: 'gpt-5',
        modelSource: 'flag',
        version: '0.7.0',
        kicadCliVersion: '9.0.0',
        renderer: plainRenderer(() => {}),
        input,
        output,
        runRequest: vi.fn(async (_req: string, log?: (l: string) => void) => {
          log?.('leaked sk-SECRET_KEY_123 in output');
          return { outcome: 'success' as const };
        }),
      });
      await new Promise((r) => setTimeout(r, 30));
      input.write('do the thing\n');
      await new Promise((r) => setTimeout(r, 30));
      input.write('/quit\n');
      await done;

      const runsDir = path.join(repo, '.copperhead', 'runs');
      const { readdirSync, readFileSync } = await import('node:fs');
      const logName = readdirSync(runsDir).find((f) => /^repl-.*\.log$/.test(f));
      expect(logName).toBeDefined();
      const text = readFileSync(path.join(runsDir, logName!), 'utf8');
      expect(text).toContain('copperhead v0.7.0'); // banner captured, SGR stripped
      expect(text).toContain('do the thing'); // echoed request
      expect(text).toContain('[REDACTED]'); // AC-4.1 redaction
      expect(text).not.toContain('sk-SECRET_KEY_123');
      expect(text).not.toContain('\x1b[');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('redacts a multi-line PEM private key, which only matches when redaction runs before the split (AC-4.1)', async () => {
    // Regression: log() used to split on newlines and redact each line, so a
    // key block reached the redactor one line at a time — the header alone
    // never matched the block pattern and the body was written verbatim.
    setColorEnabled(false);
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-repl-pem-'));
    const BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQFAKEKEYMATERIAL';
    try {
      const { input, output } = fakeTty();
      const done = runRepl({
        repoRoot: repo,
        model: 'gpt-5',
        modelSource: 'flag',
        version: '0.7.0',
        kicadCliVersion: '9.0.0',
        renderer: plainRenderer(() => {}),
        input,
        output,
        runRequest: vi.fn(async (_req: string, log?: (l: string) => void) => {
          // One message carrying real newlines, the way a service-account file
          // or an auth error quoting one would arrive.
          log?.(`auth failed for key:\n-----BEGIN PRIVATE KEY-----\n${BODY}\n${BODY}\n-----END PRIVATE KEY-----\ndone`);
          return { outcome: 'success' as const };
        }),
      });
      await new Promise((r) => setTimeout(r, 30));
      input.write('do the thing\n');
      await new Promise((r) => setTimeout(r, 30));
      input.write('/quit\n');
      await done;

      const runsDir = path.join(repo, '.copperhead', 'runs');
      const { readdirSync, readFileSync } = await import('node:fs');
      const logName = readdirSync(runsDir).find((f) => /^repl-.*\.log$/.test(f));
      const text = readFileSync(path.join(runsDir, logName!), 'utf8');
      expect(text).not.toContain(BODY); // no key material survives
      expect(text).not.toContain('BEGIN PRIVATE KEY');
      expect(text).toContain('[REDACTED]');
      expect(text).toContain('auth failed for key:'); // surrounding text kept
      expect(text).toContain('done'); // and the line after the block
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('redacts every AC-4.1 pattern, not just sk- keys', async () => {
    // Regression: the log used to carry its own inline /sk-.../ regex, so a
    // Bearer / npm_ / ghp_ token echoed by a tool result was persisted in
    // cleartext to a file the transcripts' shared redactor would have caught.
    setColorEnabled(false);
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-repl-log-'));
    const secrets = [
      'sk-SECRET_KEY_123',
      'Bearer abcdefghijklmnopqrstuvwxyz012345',
      `npm_${'a'.repeat(36)}`,
      `ghp_${'b'.repeat(36)}`,
      `github_pat_${'c'.repeat(22)}`,
    ];
    try {
      const { input, output } = fakeTty();
      const done = runRepl({
        repoRoot: repo,
        model: 'gpt-5',
        modelSource: 'flag',
        version: '0.7.0',
        kicadCliVersion: '9.0.0',
        renderer: plainRenderer(() => {}),
        input,
        output,
        runRequest: vi.fn(async (_req: string, log?: (l: string) => void) => {
          for (const s of secrets) log?.(`tool output: ${s} trailing`);
          return { outcome: 'success' as const };
        }),
      });
      await new Promise((r) => setTimeout(r, 30));
      input.write('publish it\n');
      await new Promise((r) => setTimeout(r, 30));
      input.write('/quit\n');
      await done;

      const runsDir = path.join(repo, '.copperhead', 'runs');
      const { readdirSync, readFileSync } = await import('node:fs');
      const logName = readdirSync(runsDir).find((f) => /^repl-.*\.log$/.test(f));
      const text = readFileSync(path.join(runsDir, logName!), 'utf8');
      for (const s of secrets) expect(text, s).not.toContain(s);
      expect(text).toContain('[REDACTED]');
      expect(text).toContain('trailing'); // surrounding context survives
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('demo scaffold', () => {
  it('creates a git repo with config ready for create', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-demo-'));
    try {
      await scaffoldDemoRepo(dir);
      expect(existsSync(path.join(dir, '.git'))).toBe(true);
      expect(existsSync(path.join(dir, '.copperhead/config.json'))).toBe(true);
      expect(existsSync(defaultBriefPath())).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runRepl', () => {
  it('refuses a non-TTY shell without a seed', async () => {
    setColorEnabled(false);
    const lines: string[] = [];
    const input = new PassThrough();
    const output = new PassThrough();
    const res = await runRepl({
      repoRoot: '/tmp/repo',
      model: 'gpt-5',
      modelSource: 'flag',
      version: '0.7.0',
      kicadCliVersion: '9.0.0',
      renderer: plainRenderer(() => {}),
      log: (l) => lines.push(l),
      input,
      output,
    });
    expect(res.ok).toBe(false);
    expect(lines.join('\n')).toContain('requires a TTY');
  });

  it('runs a seed on non-TTY as a one-shot', async () => {
    setColorEnabled(false);
    const lines: string[] = [];
    const runRequest = vi.fn(async () => ({ outcome: 'success' as const }));
    const res = await runRepl({
      repoRoot: '/tmp/repo',
      model: 'gpt-5',
      modelSource: 'flag',
      version: '0.7.0',
      kicadCliVersion: '9.0.0',
      seed: 'add ESD diodes',
      renderer: plainRenderer(() => {}),
      log: (l) => lines.push(l),
      input: new PassThrough(),
      output: new PassThrough(),
      runRequest,
    });
    expect(res).toEqual({ ok: true, turns: 1 });
    expect(runRequest).toHaveBeenCalledWith('add ESD diodes', expect.any(Function), expect.anything());
  });

  it('handles /help /demo /examples /model /check /quit on a TTY', async () => {
    setColorEnabled(false);
    const { input, output, lines, opts } = baseOpts();
    const done = runRepl(opts);

    // Drive the prompt after the banner is written.
    await new Promise((r) => setTimeout(r, 20));
    input.write('/help\n');
    await new Promise((r) => setTimeout(r, 20));
    input.write('/demo\n');
    await new Promise((r) => setTimeout(r, 20));
    input.write('/examples\n');
    await new Promise((r) => setTimeout(r, 20));
    input.write('/model\n');
    await new Promise((r) => setTimeout(r, 20));
    input.write('\x1b'); // cancel the model picker: keeps the current model
    await new Promise((r) => setTimeout(r, 20));
    input.write('/check\n');
    await new Promise((r) => setTimeout(r, 20));
    input.write('/quit\n');

    const res = await done;
    expect(res.ok).toBe(true);
    expect(res.turns).toBe(0);
    expect(lines.join('\n')).toContain('███  ███');
    expect(lines.join('\n')).toContain('/quit');
    expect(lines.join('\n')).toContain('What copperhead does');
    expect(lines.join('\n')).toContain('Example prompts');
    expect(lines.join('\n')).toContain('gpt-5');
    expect(lines.join('\n')).toContain('via flag');
    expect(lines).toContain('check ok');
    expect(lines.join('\n')).toContain('session ended');
    expect(opts.runRequest).not.toHaveBeenCalled();
  });

  it('switches the session model via the /model picker', async () => {
    setColorEnabled(false);
    const { input, lines, opts } = baseOpts();
    const done = runRepl(opts);

    await new Promise((r) => setTimeout(r, 20));
    input.write('/model\n');
    await new Promise((r) => setTimeout(r, 30));
    input.write('\x1b[B\r'); // hover codex, select
    await new Promise((r) => setTimeout(r, 30));
    input.write('/quit\n');

    const res = await done;
    expect(res.ok).toBe(true);
    expect(lines.join('\n')).toContain('model switched to codex');
    expect(opts.model).toBe('codex');
    expect(opts.modelSource).toBe('picker');
  });

  it('owns the alternate screen and restores it on quit', async () => {
    setColorEnabled(false);
    const { input, output, opts } = baseOpts();
    let raw = '';
    output.on('data', (c) => {
      raw += String(c);
    });
    const done = runRepl(opts);

    await new Promise((r) => setTimeout(r, 20));
    input.write('/quit\n');
    await done;

    const enter = raw.indexOf('\x1b[?1049h');
    const leave = raw.indexOf('\x1b[?1049l');
    expect(enter).toBeGreaterThanOrEqual(0);
    expect(leave).toBeGreaterThan(enter);
    expect(raw).toContain('\x1b[r'); // scroll fence reset before leaving
    expect(raw).toContain('❯ '); // prompt chevron with nbsp
  });

  it('typing /demo via live hints then /quit works end-to-end', async () => {
    setColorEnabled(false);
    const { input, lines, opts } = baseOpts();
    const done = runRepl(opts);

    await new Promise((r) => setTimeout(r, 30));
    input.write('/demo\n');
    await new Promise((r) => setTimeout(r, 40));
    input.write('/quit\n');

    const res = await done;
    expect(res.ok).toBe(true);
    expect(lines.join('\n')).toContain('What copperhead does');
    expect(lines.join('\n')).toContain('session ended');
  });


  it('runs a natural-language request then continues until /quit', async () => {
    setColorEnabled(false);
    const { input, output, lines, opts } = baseOpts();
    const done = runRepl(opts);

    await new Promise((r) => setTimeout(r, 20));
    input.write('rename net KEY_DAH to KEY_DASH\n');
    await new Promise((r) => setTimeout(r, 20));
    input.write('/quit\n');

    const res = await done;
    expect(res).toEqual({ ok: true, turns: 1 });
    expect(opts.runRequest).toHaveBeenCalledWith('rename net KEY_DAH to KEY_DASH', expect.any(Function), expect.anything());
    expect(lines.join('\n')).toContain('session ended');
    void output; // keep stream alive for typing
  });
});
