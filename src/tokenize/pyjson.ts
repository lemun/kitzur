// Python-compatible JSON (CPython Lib/json): `json.dumps` byte-for-byte and a lossless `json.loads`.
//
// Why: chat templates serialize tools and tool-call arguments with Python's json.dumps (HF
// transformers' `tojson` override is `json.dumps(x, ensure_ascii=False)`; the benchmark mock's
// render() uses json.dumps too). Its output differs from JSON.stringify in separators (', ' and
// ': '), in escaping (ensure_ascii, lone surrogates) and in float formatting (1.0, 1e-05, 1e+16),
// and every differing byte changes the token count.
//
// Value model (PyValue):
//   string, boolean, null        -> str, bool, None (undefined is treated as None in arrays and
//                                   skipped as an object value, like JSON.stringify)
//   number                       -> int when Number.isInteger (JS cannot tell 1.0 from 1), else float
//   bigint                       -> int (exact, any size)
//   PyFloat                      -> float, always printed as a float (1.0, -0.0, 1e+16)
//   array                        -> list
//   Map<string, PyValue> / object-> dict in insertion order. Plain objects hoist integer-like keys
//                                   ("2", "10") to the front, so parsePyJson returns Maps.

import { compareCodePoints } from './canonical.js';

export class PyFloat {
  constructor(readonly value: number) {}
}

export type PyValue =
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | PyFloat
  | PyValue[]
  | Map<string, PyValue>
  | { [k: string]: PyValue };

export class PyJsonDecodeError extends Error {
  constructor(message: string, readonly pos: number) {
    super(`${message}: char ${pos}`);
    this.name = 'PyJsonDecodeError';
  }
}

// ---------------------------------------------------------------- floats

/**
 * Python `repr(float)` (float_repr_style 'short'): the shortest digits that round-trip (the same
 * digits as JS Number::toString), fixed notation when -4 < decpt <= 16, else d.ddde±XX.
 * NaN/Infinity as json.dumps writes them (allow_nan=True).
 */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const js = String(Math.abs(x)); // shortest round-trip, "closest" tie rule (ECMA-262 Number::toString)
  let digits: string;
  let decpt: number; // value = 0.DIGITS x 10^decpt
  const e = js.indexOf('e');
  if (e >= 0) {
    const mant = js.slice(0, e);
    digits = mant.replace('.', '');
    decpt = Number(js.slice(e + 1)) + 1;
  } else {
    const dot = js.indexOf('.');
    const intPart = dot < 0 ? js : js.slice(0, dot);
    const frac = dot < 0 ? '' : js.slice(dot + 1);
    if (intPart === '0') {
      const lead = frac.length - frac.replace(/^0+/, '').length;
      digits = frac.slice(lead);
      decpt = -lead;
    } else {
      digits = intPart + frac;
      decpt = intPart.length;
    }
  }
  digits = digits.replace(/0+$/, '') || '0';
  let s: string;
  if (decpt <= -4 || decpt > 16) {
    const exp = decpt - 1;
    s = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + 'e' + (exp < 0 ? '-' : '+') +
      String(Math.abs(exp)).padStart(2, '0');
  } else if (decpt <= 0) {
    s = '0.' + '0'.repeat(-decpt) + digits;
  } else if (decpt >= digits.length) {
    s = digits + '0'.repeat(decpt - digits.length) + '.0';
  } else {
    s = digits.slice(0, decpt) + '.' + digits.slice(decpt);
  }
  return x < 0 ? '-' + s : s;
}

function pyNumber(n: number): string {
  if (Number.isInteger(n)) return String(n); // int (and -0 -> "0", as Python int)
  return pyFloatRepr(n);
}

// ---------------------------------------------------------------- strings

const SHORT: Record<number, string> = { 0x22: '\\"', 0x5c: '\\\\', 0x0a: '\\n', 0x0d: '\\r', 0x09: '\\t', 0x08: '\\b', 0x0c: '\\f' };
const hex4 = (c: number): string => '\\u' + c.toString(16).padStart(4, '0');
// Characters that need escaping (encoder.py ESCAPE / ESCAPE_ASCII)
const NEEDS_ESC = /["\\\u0000-\u001f]/;
const NEEDS_ESC_ASCII = /[^\x20\x21\x23-\x5b\x5d-\x7e]/;

/**
 * json.dumps of one str. ensure_ascii=True escapes every UTF-16 unit outside 0x20..0x7E (DEL
 * included, astral as surrogate pairs, lowercase hex); False escapes only '"', '\\' and < 0x20,
 * and passes lone surrogates, U+2028/2029 through raw (JSON.stringify would escape them).
 */
export function pyStr(s: string, ensureAscii = true): string {
  if (!(ensureAscii ? NEEDS_ESC_ASCII : NEEDS_ESC).test(s)) return '"' + s + '"';
  let out = '"';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc: string;
    if (c === 0x22 || c === 0x5c || c < 0x20) esc = SHORT[c] ?? hex4(c);
    else if (ensureAscii && c > 0x7e) esc = hex4(c);
    else continue;
    out += s.slice(start, i) + esc;
    start = i + 1;
  }
  return out + s.slice(start) + '"';
}

// ---------------------------------------------------------------- dumps

export interface PyDumpsOptions {
  /** default true, as Python */
  ensureAscii?: boolean;
  /** null (default) = one line; number/string = pretty-print with that indent */
  indent?: number | string | null;
  /** default (', ', ': ') without indent, (',', ': ') with indent */
  separators?: [string, string] | null;
  sortKeys?: boolean;
}

function dictKey(k: unknown): string {
  if (typeof k === 'string') return k;
  if (typeof k === 'number') return pyNumber(k);
  if (k instanceof PyFloat) return pyFloatRepr(k.value);
  if (typeof k === 'bigint') return k.toString();
  if (k === true) return 'true';
  if (k === false) return 'false';
  if (k === null) return 'null';
  throw new TypeError(`keys must be str, int, float, bool or None, not ${typeof k}`);
}

/** Python `json.dumps(value, ensure_ascii=..., indent=..., separators=..., sort_keys=...)`. */
export function pyDumps(value: unknown, opts: PyDumpsOptions = {}): string {
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
    if (typeof v === 'number') return pyNumber(v);
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof PyFloat) return pyFloatRepr(v.value);
    if (typeof v !== 'object') throw new TypeError(`Object of type ${typeof v} is not JSON serializable`);
    let items: string[];
    let open: string;
    let close: string;
    if (Array.isArray(v)) {
      items = v.map((x) => enc(x, level + 1));
      open = '[';
      close = ']';
    } else {
      let entries: [string, unknown][] =
        v instanceof Map
          ? [...(v as Map<unknown, unknown>).entries()].map(([k, x]) => [dictKey(k), x])
          : Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
      // Python sorts str keys by code point; JS `<` compares UTF-16 units (astral keys before U+E000..U+FFFF)
      if (sortKeys) entries = entries.sort(([a], [b]) => compareCodePoints(a, b));
      items = entries.map(([k, x]) => pyStr(k, ensureAscii) + keySep + enc(x, level + 1));
      open = '{';
      close = '}';
    }
    if (items.length === 0) return open + close;
    if (ind === null) return open + items.join(itemSep) + close;
    const nl = '\n' + ind.repeat(level + 1);
    return open + nl + items.join(itemSep + nl) + '\n' + ind.repeat(level) + close;
  };
  return enc(value, 0);
}

// ---------------------------------------------------------------- loads

/**
 * Python `json.loads(text)` (strict=True), lossless: objects become Maps (wire key order, duplicate
 * keys keep the first position and the last value, like a Python dict), integers beyond 2^53 become
 * bigint, and floats with an integral value (1.0, 1e5, -0.0) become PyFloat so that pyDumps prints
 * them as Python would. Accepts NaN, Infinity and -Infinity like Python. Throws PyJsonDecodeError.
 */
export function parsePyJson(text: string): PyValue {
  let i = 0;
  const n = text.length;
  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const fail = (msg: string): never => {
    throw new PyJsonDecodeError(msg, i);
  };
  const NUM = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;

  const str = (): string => {
    // at the opening quote
    i++;
    let out = '';
    let start = i;
    for (;;) {
      if (i >= n) fail('Unterminated string starting at');
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i);
        i++;
        return out;
      }
      if (c < 0x20) fail('Invalid control character at');
      if (c !== 0x5c) {
        i++;
        continue;
      }
      out += text.slice(start, i);
      const e = text[i + 1];
      if (e === undefined) fail('Unterminated string starting at');
      i += 2;
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const h = text.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('Invalid \\uXXXX escape');
          out += String.fromCharCode(parseInt(h, 16)); // lone surrogates kept, pairs combine naturally
          i += 4;
          break;
        }
        default:
          i -= 1;
          fail('Invalid \\escape');
      }
      start = i;
    }
  };

  const value = (): PyValue => {
    ws();
    if (i >= n) fail('Expecting value');
    const c = text[i];
    if (c === '"') return str();
    if (c === '{') {
      i++;
      const m = new Map<string, PyValue>();
      ws();
      if (text[i] === '}') {
        i++;
        return m;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('Expecting property name enclosed in double quotes');
        const k = str();
        ws();
        if (text[i] !== ':') fail("Expecting ':' delimiter");
        i++;
        m.set(k, value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return m;
        }
        fail("Expecting ',' delimiter");
      }
    }
    if (c === '[') {
      i++;
      const a: PyValue[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return a;
      }
      for (;;) {
        a.push(value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return a;
        }
        fail("Expecting ',' delimiter");
      }
    }
    if (text.startsWith('null', i)) { i += 4; return null; }
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('NaN', i)) { i += 3; return new PyFloat(NaN); }
    if (text.startsWith('Infinity', i)) { i += 8; return new PyFloat(Infinity); }
    if (text.startsWith('-Infinity', i)) { i += 9; return new PyFloat(-Infinity); }
    NUM.lastIndex = i;
    const m = NUM.exec(text);
    if (m === null) fail('Expecting value');
    const lex = m![0];
    i += lex.length;
    if (m![1] === undefined && m![2] === undefined) {
      const v = Number(lex);
      return Number.isSafeInteger(v) ? (Object.is(v, -0) ? 0 : v) : BigInt(lex);
    }
    const f = Number(lex);
    return Number.isInteger(f) || !Number.isFinite(f) ? new PyFloat(f) : f;
  };

  const v = value();
  ws();
  if (i !== n) fail('Extra data');
  return v;
}

/** Python len(): code points (JS .length counts UTF-16 units). */
export function pyLen(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length - 1; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n--;
        i++;
      }
    }
  }
  return n;
}
