// CPython `json.dumps` compatible serializer (Lib/json/encoder.py), verified against
// reference implementation (test/bench/pyjson.test.ts).
//
//  - separators: (', ', ': ') when indent is None, (',', ': ') when indent is set;
//  - ensure_ascii=True (Python default): every UTF-16 unit outside 0x20..0x7E is escaped, DEL included;
//    short forms for " \ \n \r \t \b \f, otherwise \uXXXX in lowercase hex; astral chars become
//    surrogate-pair escapes;
//  - ensure_ascii=False: only ", \ and units < 0x20 are escaped; DEL, U+2028/2029 and LONE SURROGATES
//    pass through raw (JSON.stringify would escape lone surrogates, so it is only used when the
//    string has no surrogates at all);
//  - key order = insertion order. Plain JS objects hoist integer-like keys ("2", "10") to the front,
//    so pass a Map when that matters. sort_keys sorts by code point, like Python's sorted().
//  - numbers: integers print as ints; wrap a value in PyFloat to print Python float repr ("1.0",
//    "1e-05", "1e+16"), which JS cannot express for integral values.

/** A number that Python would hold as a float (prints `1.0`, not `1`). */
export class PyFloat {
  constructor(readonly value: number) {}
}
export const pyFloat = (x: number): PyFloat => new PyFloat(x);

export interface DumpsOptions {
  /** default true (Python default) */
  ensureAscii?: boolean;
  indent?: number | string | null;
  /** [item_separator, key_separator] */
  separators?: readonly [string, string] | null;
  sortKeys?: boolean;
}

const SHORT: Record<number, string> = {
  0x22: '\\"',
  0x5c: '\\\\',
  0x0a: '\\n',
  0x0d: '\\r',
  0x09: '\\t',
  0x08: '\\b',
  0x0c: '\\f',
};
const hex4 = (c: number): string => '\\u' + c.toString(16).padStart(4, '0');
const HAS_SURROGATE = /[\ud800-\udfff]/;
const NON_ASCII_OR_DEL = /[\u007f-￿]/g;

/** Python json string encoding (encoder.py py_encode_basestring[_ascii]). */
export function pyStr(s: string, ensureAscii = true): string {
  if (ensureAscii) {
    // JSON.stringify already matches Python for ASCII controls/quotes and escapes lone surrogates as
    // lowercase \udxxx, exactly like Python; every remaining unit > 0x7E (paired surrogates included)
    // becomes its own \uXXXX, which is Python's surrogate-pair escape.
    return JSON.stringify(s).replace(NON_ASCII_OR_DEL, (c) => hex4(c.charCodeAt(0)));
  }
  if (!HAS_SURROGATE.test(s)) return JSON.stringify(s);
  // Slow path (surrogates present): Python emits lone surrogates raw.
  let out = '"';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 0x22 && c !== 0x5c && c >= 0x20) continue;
    out += s.slice(start, i) + (SHORT[c] ?? hex4(c));
    start = i + 1;
  }
  return out + s.slice(start) + '"';
}

/**
 * Python float.__repr__: the shortest round-trip digits (same digits as JS), but scientific notation
 * when exp < -4 or exp >= 16 ("1e-05", "1e+16"), and always a ".0" on integral values.
 */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (Object.is(x, -0)) return '-0.0';
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return x.toFixed(1);
  const s = x.toExponential(); // shortest digits, e.g. "1.2345e-5"
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-])(\d+)$/.exec(s);
  if (!m) throw new Error(`unexpected toExponential output ${s}`);
  const sign = m[1]!;
  const digits = m[2]! + (m[3] ?? '');
  const exp = (m[4] === '-' ? -1 : 1) * Number(m[5]);
  if (exp < -4 || exp >= 16) {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    return `${sign}${mant}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
  const intPart = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
  const frac = digits.slice(exp + 1);
  return `${sign}${intPart}.${frac || '0'}`;
}

function pyInt(n: number): string {
  return Math.abs(n) < 1e21 ? String(n) : BigInt(n).toString();
}

/** json.dumps float formatting (allow_nan=True): NaN, Infinity, -Infinity, else repr. */
function pyJsonFloat(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  return pyFloatRepr(x);
}

function pyNum(n: number): string {
  if (Number.isInteger(n) && !Object.is(n, -0)) return pyInt(n);
  return pyJsonFloat(n);
}

function keyStr(k: unknown): string {
  if (typeof k === 'string') return k;
  if (typeof k === 'number') return pyNum(k);
  if (k instanceof PyFloat) return pyJsonFloat(k.value);
  if (k === true) return 'true';
  if (k === false) return 'false';
  if (k === null) return 'null';
  throw new TypeError(`keys must be str, int, float, bool or None, not ${typeof k}`);
}

/** Code-point order (Python str comparison); JS default sort compares UTF-16 units. */
export function cmpCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    // codePointAt yields the unit itself for a lone surrogate, which is also its Python code point.
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}

type Entries = Array<[unknown, unknown]>;

export function pyDumps(value: unknown, opts: DumpsOptions = {}): string {
  const ensureAscii = opts.ensureAscii ?? true;
  const indent = opts.indent ?? null;
  const [itemSep, keySep] = opts.separators ?? (indent === null ? [', ', ': '] : [',', ': ']);
  const ind = indent === null ? null : typeof indent === 'number' ? ' '.repeat(indent) : indent;
  const sortKeys = opts.sortKeys ?? false;
  const enc = (v: unknown, level: number): string => {
    if (v === null || v === undefined) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'string') return pyStr(v, ensureAscii);
    if (typeof v === 'number') return pyNum(v);
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof PyFloat) return pyJsonFloat(v.value);
    let items: string[];
    let open: string;
    let close: string;
    if (Array.isArray(v)) {
      items = v.map((x) => enc(x, level + 1));
      open = '[';
      close = ']';
    } else if (typeof v === 'object') {
      let entries: Entries =
        v instanceof Map ? [...(v as Map<unknown, unknown>).entries()] : Object.entries(v as Record<string, unknown>);
      entries = entries.filter(([, x]) => x !== undefined); // like JSON.stringify: undefined members do not exist
      const keyed = entries.map(([k, x]) => [keyStr(k), x] as [string, unknown]);
      if (sortKeys) keyed.sort((a, b) => cmpCodePoints(a[0], b[0]));
      items = keyed.map(([k, x]) => pyStr(k, ensureAscii) + keySep + enc(x, level + 1));
      open = '{';
      close = '}';
    } else {
      throw new TypeError(`Object of type ${typeof v} is not JSON serializable`);
    }
    if (!items.length) return open + close;
    if (ind === null) return open + items.join(itemSep) + close;
    const nl = '\n' + ind.repeat(level + 1);
    return open + nl + items.join(itemSep + nl) + '\n' + ind.repeat(level) + close;
  };
  return enc(value, 0);
}

/** Python len(str): code points. JS .length counts UTF-16 units (astral = 2). */
export function pyLen(s: string): number {
  if (!HAS_SURROGATE.test(s)) return s.length;
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n--;
        i++;
      }
    }
  }
  return n;
}

/** Python s[:n] (code points). */
export function pySliceHead(s: string, n: number): string {
  if (!HAS_SURROGATE.test(s)) return s.slice(0, n);
  let i = 0;
  let cps = 0;
  while (i < s.length && cps < n) {
    const c = s.charCodeAt(i);
    const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
    i += c >= 0xd800 && c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff ? 2 : 1;
    cps++;
  }
  return s.slice(0, i);
}
