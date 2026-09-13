import { researchConfig, hostAllowed } from './config.js';
import type { RunContext } from '../agent/context.js';

export interface EgressResult {
  response: Response;
  bytes: number;
  url: string;
}

export class EgressError extends Error {
  status?: number;

  constructor(message: string) {
    super(message);
    this.name = 'EgressError';
  }
}

function methodOf(init?: RequestInit): string {
  return (init?.method ?? 'GET').toUpperCase();
}

function checkUrl(url: string, allowHosts: string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EgressError(`invalid research URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new EgressError(`research URL must use http(s): ${url}`);
  }
  if (!hostAllowed(parsed.hostname, allowHosts)) throw new EgressError(`research host is not allowlisted: ${parsed.hostname}`);
  return parsed;
}

async function logRequest(
  ctx: RunContext,
  data: { method: string; url: string; status?: number; bytes?: number; durationMs: number; error?: string },
): Promise<void> {
  ctx.networkRequests = (ctx.networkRequests ?? 0) + 1;
  await ctx.transcript.event('network-request', data);
}

/** Single network choke point. Redirects are followed manually so each hop is re-validated and logged. */
export async function request(ctx: RunContext, url: string, init: RequestInit = {}, options: { maxBytes?: number } = {}): Promise<EgressResult> {
  const cfg = researchConfig(ctx.config);
  const maxBytes = options.maxBytes ?? Math.floor(cfg.maxPdfMB * 1024 * 1024);
  const method = methodOf(init);
  let current: string;
  try {
    current = checkUrl(url, cfg.allowHosts).toString();
  } catch (err) {
    await logRequest(ctx, { method, url, durationMs: 0, error: (err as Error).message });
    throw err;
  }
  for (let hop = 0; hop <= 5; hop++) {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(current, { ...init, signal: controller.signal, redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        const next = new URL(location, current).toString();
        clearTimeout(timeout);
        await logRequest(ctx, { method, url: current, status: response.status, bytes: 0, durationMs: Date.now() - started });
        try {
          current = checkUrl(next, cfg.allowHosts).toString();
        } catch (err) {
          await logRequest(ctx, { method, url: next, durationMs: 0, error: (err as Error).message });
          throw err;
        }
        continue;
      }
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > maxBytes) {
        await logRequest(ctx, { method, url: current, status: response.status, bytes: body.byteLength, durationMs: Date.now() - started, error: `response exceeds ${maxBytes} bytes` });
        throw new EgressError(`research response exceeds configured size cap (${cfg.maxPdfMB} MB)`);
      }
      await logRequest(ctx, { method, url: current, status: response.status, bytes: body.byteLength, durationMs: Date.now() - started });
      clearTimeout(timeout);
      if (response.status === 429) {
        const rateLimited = new EgressError('research provider rate limited the request');
        rateLimited.status = 429;
        throw rateLimited;
      }
      return { response: new Response(body, { status: response.status, headers: response.headers }), bytes: body.byteLength, url: current };
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof EgressError) throw err;
      const message = (err as Error).message;
      await logRequest(ctx, { method, url: current, durationMs: Date.now() - started, error: message });
      throw new EgressError(`research request failed: ${message}`);
    }
  }
  throw new EgressError('research request exceeded redirect limit');
}

export async function requestJson(ctx: RunContext, url: string, init: RequestInit = {}): Promise<unknown> {
  const result = await request(ctx, url, init);
  const text = await result.response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EgressError(`research endpoint returned invalid JSON from ${result.url}`);
  }
}

export async function requestBytes(ctx: RunContext, url: string, init: RequestInit = {}, maxBytes?: number): Promise<{ bytes: Uint8Array; url: string }> {
  const result = await request(ctx, url, init, maxBytes === undefined ? {} : { maxBytes });
  return { bytes: new Uint8Array(await result.response.arrayBuffer()), url: result.url };
}
