// Python `json.loads` for the bench mock's qwen3 render (bench/mock/qwen3-render.ts), which must see a request
// exactly as vLLM does after `json.loads`:
//
//  - objects become `Map`s in document order. JSON.parse would hoist integer-like keys ("2", "10") to the front,
//    and the template renders tool definitions and tool-call arguments in key order (`tojson`, `|items`);
//  - a duplicate key keeps its FIRST position with the LAST value (Python dict assignment);
//  - integers stay integers: safe ones as `number`, others as `bigint` (Python int is unbounded); "-0" is int 0;
//  - numbers with a fraction or exponent become `PyFloat` (so `tojson` prints "1.0", "1e-05", "1e+16");
//  - `NaN`, `Infinity`, `-Infinity` are accepted (Python's default `allow_nan`);
//  - strings keep lone surrogates from `\udXXX` escapes; raw control characters are rejected (strict=True);
//  - whitespace is ' \t\n\r' only.
//
// `pyDumps` (bench/lib/pyjson.ts) serializes the result back byte-exactly like Python.

import { PyFloat } from './pyjson.js';

export type PyValue = null | boolean | number | bigint | string | PyFloat | PyValue[] | PyObject;
export type PyObject = Map<string, PyValue>;

export class PyJsonError extends Error {
  constructor(msg: string, readonly pos: number) {
    super(`${msg}: char ${pos}`);
    this.name = 'PyJsonError';
  }
}

const WS = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const NUM = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?/y;
const ESC: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

export function parsePyJson(text: string): PyValue {
  let i = 0;
  const n = text.length;
  const skip = (): void => {
    while (i < n && WS(text.charCodeAt(i))) i++;
  };
  const fail = (msg: string): never => {
    throw new PyJsonError(msg, i);
  };
  const str = (): string => {
    i++; // opening quote
    let out = '';
    let start = i;
    for (;;) {
      if (i >= n) fail('Unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i);
        i++;
        return out;
      }
      if (c < 0x20) fail('Invalid control character');
      if (c === 0x5c) {
        out += text.slice(start, i);
        const e = text[i + 1];
        if (e === undefined) fail('Unterminated string');
        if (e === 'u') {
          const h = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('Invalid \\uXXXX escape');
          out += String.fromCharCode(parseInt(h, 16)); // a surrogate pair is two escapes: concatenation pairs them
          i += 6;
        } else {
          const r = ESC[e!];
          if (r === undefined) fail('Invalid \\escape');
          out += r;
          i += 2;
        }
        start = i;
        continue;
      }
      i++;
    }
  };
  const value = (): PyValue => {
    skip();
    if (i >= n) fail('Expecting value');
    const c = text[i]!;
    if (c === '"') return str();
    if (c === '{') {
      i++;
      const obj: PyObject = new Map();
      skip();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        skip();
        if (text[i] !== '"') fail('Expecting property name enclosed in double quotes');
        const k = str();
        skip();
        if (text[i] !== ':') fail("Expecting ':' delimiter");
        i++;
        obj.set(k, value());
        skip();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return obj;
        }
        fail("Expecting ',' delimiter");
      }
    }
    if (c === '[') {
      i++;
      const arr: PyValue[] = [];
      skip();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value());
        skip();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return arr;
        }
        fail("Expecting ',' delimiter");
      }
    }
    for (const [lit, v] of [['null', null], ['true', true], ['false', false], ['NaN', new PyFloat(NaN)], ['Infinity', new PyFloat(Infinity)], ['-Infinity', new PyFloat(-Infinity)]] as const) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return v;
      }
    }
    NUM.lastIndex = i;
    const m = NUM.exec(text);
    if (!m) fail('Expecting value');
    i += m![0].length;
    if (m![1] !== undefined || m![2] !== undefined) return new PyFloat(Number(m![0]));
    const big = BigInt(m![0]);
    return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
  };
  const v = value();
  skip();
  if (i < n) fail('Extra data');
  return v;
}

export const isPyObject = (v: unknown): v is PyObject => v instanceof Map;

/** Python truthiness of a parsed JSON value. */
export function pyTruthyValue(v: PyValue | undefined): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '' || v === 0n) return false;
  if (v instanceof PyFloat) return v.value !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  return true;
}
