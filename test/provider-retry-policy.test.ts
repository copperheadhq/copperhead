import { describe, expect, it } from 'vitest';
import {
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAIConnectionTimeoutError,
  APIUserAbortError as OpenAIUserAbortError,
} from 'openai';
import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicConnectionTimeoutError,
  APIUserAbortError as AnthropicUserAbortError,
} from '@anthropic-ai/sdk';
import { TurnTimeoutError } from '../src/agent/recovery.js';
import { isRateLimit, isRetryableProviderError, withRetry } from '../src/util/retry.js';

describe('explicit provider retry policy', () => {
  it.each([408, 409, 429, 500, 502, 503, 504, 529, 599])('retries transient HTTP %i', (status) => {
    expect(isRetryableProviderError(Object.assign(new Error('temporary'), { status }))).toBe(true);
    expect(isRetryableProviderError({ statusCode: status })).toBe(true);
    // A transient server failure must not trigger rate-limit provider failover.
    expect(isRateLimit({ status })).toBe(status === 429);
  });

  it.each([
    new OpenAIConnectionError({}), new OpenAIConnectionTimeoutError({}),
    new AnthropicConnectionError({}), new AnthropicConnectionTimeoutError({}),
  ])('retries installed SDK connection error %#', (error) => {
    expect(isRetryableProviderError(error)).toBe(true);
  });

  it.each([
    null, undefined, 'connection error', new Error('connection error'), new SyntaxError('invalid JSON'),
    new DOMException('aborted', 'AbortError'), new OpenAIUserAbortError({}), new AnthropicUserAbortError({}),
    new TurnTimeoutError(100, 'idle'), new TurnTimeoutError(100, 'max'),
    { status: 400 }, { status: 401 }, { status: 403 }, { status: 404 }, { status: 422 }, { status: 600 },
    Object.assign(new SyntaxError('bad response'), { status: 500 }),
  ])('does not retry cancellation, watchdog, parse or permanent errors %#', (error) => {
    expect(isRetryableProviderError(error)).toBe(false);
  });

  it('recovers after a transient SDK connection error and a 503', async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) throw new OpenAIConnectionError({});
      if (calls === 2) throw Object.assign(new Error('unavailable'), { status: 503 });
      return 'recovered';
    }, {
      isRetryable: isRetryableProviderError,
      baseMs: 10,
      sleep: async (ms) => { delays.push(ms); },
    });
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  it('stops after three retries and preserves the final failure for normal handling', async () => {
    let calls = 0;
    const error = Object.assign(new Error('unavailable'), { status: 503 });
    await expect(withRetry(async () => {
      calls++;
      throw error;
    }, { isRetryable: isRetryableProviderError, sleep: async () => {} })).rejects.toBe(error);
    expect(calls).toBe(4);
  });

  it('keeps the generic tool retry default limited to rate limits', async () => {
    let calls = 0;
    const error = Object.assign(new Error('local tool failed'), { status: 503 });
    await expect(withRetry(async () => {
      calls++;
      throw error;
    }, { sleep: async () => {} })).rejects.toBe(error);
    expect(calls).toBe(1);
  });
});
