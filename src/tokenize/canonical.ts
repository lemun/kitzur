// Canonical JSON and digests used as counter cache keys (DESIGN.md).
// canonicalJSON: keys sorted by code point, compact separators, strings/numbers as JSON.stringify
// writes them, undefined-valued keys skipped. Kept self-contained so the counter does not depend
// on the engine; the counter only needs the digest to be a function of the message.
import { createHash } from 'node:crypto';

/** Code-point order (JS `<` compares UTF-16 units, which misorders astral vs U+E000..U+FFFF). */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    // surrogates (astral) sort after every BMP unit >= U+E000
    if (x >= 0xd800) x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
    if (y >= 0xd800) y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
    return x - y;
  }
  return a.length - b.length;
}

export function canonicalJSON(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'number':
      return JSON.stringify(v); // non-finite -> null, as JSON.stringify
    case 'boolean':
      return v ? 'true' : 'false';
    case 'bigint':
      return v.toString();
    case 'object':
      break;
    default:
      return 'null';
  }
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : canonicalJSON(x))).join(',') + ']';
  const src = v instanceof Map ? Object.fromEntries(v as Map<string, unknown>) : (v as Record<string, unknown>);
  const keys = Object.keys(src).filter((k) => src[k] !== undefined).sort(compareCodePoints);
  let out = '{';
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    if (i) out += ',';
    out += JSON.stringify(k) + ':' + canonicalJSON(src[k]);
  }
  return out + '}';
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** d = sha256(canonicalJSON(value)), hex. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJSON(value));
}
