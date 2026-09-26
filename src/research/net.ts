import { researchConfig, hostAllowed } from './config.js';
import type { RunContext } from '../agent/context.js';

export interface EgressResult {
  response: Response;
  bytes: number;
  url: string;
}

export class EgressError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'EgressError';
    if (status !== undefined) this.status = status;
  }
}

export class EgressSizeError extends EgressError {
  constructor(
    message: string,
    readonly maxBytes: number,
    readonly receivedBytes?: number,
  ) {
    super(message);
    this.name = 'EgressSizeError';
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
  if (parsed.protocol !== 'https:') {
    throw new EgressError(`research URL must use https: ${url}`);
  }
  if (!hostAllowed(parsed.hostname, allowHosts)) throw new EgressError(`research host is not allowlisted: ${parsed.hostname}`);
  return parsed;
}

function redirectedInit(init: RequestInit, status: number, from: URL, to: URL): RequestInit {
  const headers = new Headers(init.headers);
  const crossOrigin = from.origin !== to.origin;
  if (crossOrigin) {
    headers.delete('authorization');
    headers.delete('cookie');
    headers.delete('proxy-authorization');
  }

  const method = methodOf(init);
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    headers.delete('content-length');
    headers.delete('content-type');
    const { body: _body, ...rest } = init;
    return { ...rest, method: 'GET', headers };
  }
  if (crossOrigin && init.body != null) {
    throw new EgressError(`refusing to forward a request body across origins (${from.origin} -> ${to.origin})`);
  }
  return { ...init, headers };
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new EgressSizeError(`research response exceeds configured size cap (${maxBytes} bytes)`, maxBytes, declared);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new EgressSizeError(`research response exceeds configured size cap (${maxBytes} bytes)`, maxBytes, total);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
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
  let requestInit = init;
  let method = methodOf(requestInit);
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
      const response = await fetch(current, { ...requestInit, signal: controller.signal, redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        const next = new URL(location, current).toString();
        await response.body?.cancel().catch(() => undefined);
        clearTimeout(timeout);
        await logRequest(ctx, { method, url: current, status: response.status, bytes: 0, durationMs: Date.now() - started });
        try {
          const checked = checkUrl(next, cfg.allowHosts);
          requestInit = redirectedInit(requestInit, response.status, new URL(current), checked);
          current = checked.toString();
          method = methodOf(requestInit);
        } catch (err) {
          await logRequest(ctx, { method, url: next, durationMs: 0, error: (err as Error).message });
          throw err;
        }
        continue;
      }
      let body: Uint8Array;
      try {
        body = await readCapped(response, maxBytes);
      } catch (err) {
        if (err instanceof EgressSizeError) {
          await logRequest(ctx, {
            method,
            url: current,
            status: response.status,
            bytes: err.receivedBytes,
            durationMs: Date.now() - started,
            error: err.message,
          });
        }
        throw err;
      }
      await logRequest(ctx, { method, url: current, status: response.status, bytes: body.byteLength, durationMs: Date.now() - started });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new EgressError(
          response.status === 429
            ? 'research provider rate limited the request'
            : `research provider returned HTTP ${response.status}`,
          response.status,
        );
      }
      const responseBody = response.status === 204 || response.status === 205 ? null : body;
      return { response: new Response(responseBody, { status: response.status, headers: response.headers }), bytes: body.byteLength, url: current };
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
