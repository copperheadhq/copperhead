import { describe, it, expect, afterEach } from 'vitest';
import {
  flatten,
  okResult,
  failResult,
  outcomeResult,
  seal,
  textResult,
  unavailable,
  isRetryableToolKind,
} from '../src/agent/envelope.js';
import { toolLine } from '../src/agent/theme.js';

describe('ToolResult envelope', () => {
  it('flattens success as summary plus detail', () => {
    const r = okResult('ERC clean\n0 violations', 'diagnostic');
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('ERC clean');
    expect(flatten(r)).toBe('ERC clean\n0 violations');
  });

  it('flattens typed errors to the original message', () => {
    const r = failResult('validation', 'error: search requires a non-empty regex');
    expect(r.error?.kind).toBe('validation');
    expect(flatten(r)).toContain('search requires');
  });

  it('unavailable preserves lock phrasing', () => {
    const r = unavailable('edit_file', false);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('unavailable');
    expect(flatten(r)).toContain('not available');
    expect(flatten(r)).toContain('unlock');
  });

  it('only exception kinds are retryable', () => {
    expect(isRetryableToolKind('exception')).toBe(true);
    expect(isRetryableToolKind('validation')).toBe(false);
    expect(isRetryableToolKind('refusal')).toBe(false);
    expect(isRetryableToolKind('unavailable')).toBe(false);
  });

  it('textResult maps error: prefixes to validation (not retried)', () => {
    const r = textResult('error: search requires a non-empty regex in "pattern"', 'query');
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('validation');
  });

  it('uses a handler-owned diagnostic outcome for the glyph and keeps failure detail', () => {
    const r = outcomeResult(
      'ERC: 3 violation(s)\n  error unconnected_pin: pin 2 of U1',
      false,
      'diagnostic',
    );
    expect(r.ok).toBe(false);
    expect(flatten(r)).toContain('unconnected_pin');
    expect(toolLine('run_erc', r.summary, r.ok)).toContain('▸');
  });

  it('keeps partial detail on an unsuccessful envelope without a typed invocation error', () => {
    const r = seal({
      ok: false,
      summary: 'design report incomplete',
      detail: 'run_erc:\nERC: clean',
      viewHint: 'diagnostic',
    });
    expect(flatten(r)).toBe('design report incomplete\nrun_erc:\nERC: clean');
  });

  it('textResult maps refusal prefixes to refusal', () => {
    const r = textResult('cannot finish yet:\n- run ERC', 'diagnostic');
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('refusal');
  });

  it('redacts key-shaped tokens at construction', () => {
    const r = okResult('token sk-abcdefghijklmnopqrstuvwxyz123456 in body', 'query', {
      raw: 'sk-abcdefghijklmnopqrstuvwxyz123456',
    });
    expect(r.summary).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(JSON.stringify(r.data)).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
  });

  it('redacts *_KEY env values at construction so the renderer never sees them', () => {
    const prev = process.env.NEXAR_FAKE_KEY;
    process.env.NEXAR_FAKE_KEY = 'nexar-secret-value-abcdefgh';
    try {
      const r = seal({
        ok: true,
        summary: 'got nexar-secret-value-abcdefgh',
        data: { token: 'nexar-secret-value-abcdefgh' },
        viewHint: 'query',
      });
      expect(r.summary).not.toContain('nexar-secret-value-abcdefgh');
      expect(JSON.stringify(r.data)).not.toContain('nexar-secret-value-abcdefgh');
      const line = toolLine('web_search', r.summary, r.ok);
      expect(line).not.toContain('nexar-secret-value-abcdefgh');
    } finally {
      if (prev === undefined) delete process.env.NEXAR_FAKE_KEY;
      else process.env.NEXAR_FAKE_KEY = prev;
    }
  });
});
