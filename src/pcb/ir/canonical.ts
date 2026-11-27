/**
 * Canonical serialization and content hashing (RFC 11 §6.1, implementation
 * spec §3.3): keys sorted, arrays in declared order, integers only, no
 * whitespace, UTF-8, SHA-256. Equal designs hash equal on any machine.
 */
import { createHash } from 'node:crypto';
import type { PcbDesign } from './types.js';

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new Error(`canonical form holds integers only; got ${value}`);
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Content hash of a design, excluding the import timestamp and the hash itself. */
export function hashDesign(design: PcbDesign): string {
  const { source, ...rest } = design;
  const { importedAt: _importedAt, contentHash: _contentHash, ...src } = source;
  return sha256(canonicalJson({ ...rest, source: src }));
}
