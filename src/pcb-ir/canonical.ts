import { createHash } from 'node:crypto';

/**
 * Canonical serialization and content hashes (RFC 3 Section 17.1, as RFC 11
 * Section 6.13 applies it to the layout records).
 *
 * The kernel (fang) hashes the same records in Python; a content hash names a
 * record across both, so the bytes here must equal the kernel's exactly. The
 * RFC's example records cite one another by hash and serve as the conformance
 * fixtures (test/fixtures/rfc11/).
 */

/**
 * Arrays under these keys keep their order; every other array is unordered and
 * is sorted. Order is declared by key, the set being the union of the keys each
 * standard states (RFC 3 Section 17.1).
 */
export const ORDERED_KEYS: ReadonlySet<string> = new Set([
  // RFC 3
  'provenance',
  'rationale',
  'alternatives_rejected',
  'args',
  'power_sequence',
  // RFC 11 Section 6.13
  'outline',
  'layers',
  'preserved',
  // RFC 12 Section 2.2
  'branches',
  'calls',
]);

export class NotCanonicalizable extends Error {}

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

function encodeString(text: string): string {
  let out = '"';
  for (const ch of text.normalize('NFC')) {
    const escaped = ESCAPES[ch];
    const code = ch.codePointAt(0)!;
    if (escaped) out += escaped;
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/** A string's Unicode code points after NFC: the order RFC 3 sorts by. */
function codePoints(text: string): number[] {
  return Array.from(text.normalize('NFC'), (c) => c.codePointAt(0)!);
}

function compareCodePoints(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/**
 * A bare number: the shortest decimal that round-trips to the same value,
 * written positionally, with no exponent, no trailing zeros after the point,
 * no point when the value is whole, and zero as 0. JavaScript already writes
 * the shortest digits; only its notation for very small and very large values
 * has to change.
 */
export function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new NotCanonicalizable(`${value} has no canonical serialization`);
  if (value === 0) return '0';
  const text = String(value);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!m) return text;
  const [, sign, whole, frac = '', exp] = m;
  const digits = whole! + frac;
  const point = whole!.length + Number(exp);
  let out: string;
  if (point <= 0) out = '0.' + '0'.repeat(-point) + digits;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = digits.slice(0, point) + '.' + digits.slice(point);
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  return sign + out;
}

/**
 * The sort key of an item in an unordered collection: an entity by its
 * identifier, any other item by its canonical serialization, which also breaks
 * a tie between entities sharing an identifier.
 */
function itemKey(item: unknown): [number[], number[]] {
  const serialized = codePoints(canonical(item));
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const id = (item as Record<string, unknown>).id;
    if (typeof id === 'string') return [codePoints(id), serialized];
  }
  return [serialized, []];
}

function encode(value: unknown, ordered: boolean): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') return encodeString(value);
  if (typeof value === 'number') return encodeNumber(value);
  if (Array.isArray(value)) {
    if (value.some((v) => v === undefined)) throw new NotCanonicalizable('an array holds undefined');
    let items: unknown[] = value;
    if (!ordered) {
      const keyed = value.map((item) => ({ item, key: itemKey(item) }));
      keyed.sort((a, b) => compareCodePoints(a.key[0], b.key[0]) || compareCodePoints(a.key[1], b.key[1]));
      items = keyed.map((k) => k.item);
    }
    return '[' + items.map((v) => encode(v, false)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .map((k) => ({ k, cp: codePoints(k) }))
      .sort((a, b) => compareCodePoints(a.cp, b.cp))
      .map(({ k }) => k);
    return '{' + keys.map((k) => `${encodeString(k)}:${encode(record[k], ORDERED_KEYS.has(k))}`).join(',') + '}';
  }
  throw new NotCanonicalizable(`${typeof value} has no canonical serialization`);
}

/** The canonical JSON text of a value, without the trailing newline. */
export function canonical(value: unknown): string {
  return encode(value, false);
}

/** The canonical bytes: UTF-8, one trailing newline. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonical(value) + '\n', 'utf8');
}

/** A record's content hash: sha256 over its canonical bytes. */
export function contentHash(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalBytes(value)).digest('hex');
}
