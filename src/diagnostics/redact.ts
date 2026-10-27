// Redaction of captured chat-completions request bodies for sharing bug reports (docs/DIAGNOSTICS.md).
// Every free-text string (message content, tool results, system prompts, tool-call argument values, descriptions)
// becomes a placeholder of the same length with newlines in the same places, so token counts and truncation stay
// comparable; each character's UTF-8 width and JSON escaping cost are kept too, so the encoded body has the same size.
// Kept: object keys, numbers, booleans, roles, ids and their pairing, tool and function names, types, the model.
// The placeholder depends only on the length, newline positions and character widths of the original, never its text,
// except that a non-ASCII stand-in is one the original does not contain.

/** Keys whose string values (or arrays of strings) are structure, not content. */
const PROTECTED = new Set(['model', 'role', 'id', 'tool_call_id', 'type', 'required', 'tool_choice', 'format']);

/** Header names that carry credentials: a file holding one of them is a headers capture, not a body. */
const CREDENTIAL_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i;

let filler = '';

/** A fixed stream of pronounceable pseudo-words, so placeholders tokenize roughly like prose. */
function fillerOf(len: number): string {
  if (filler.length >= len) return filler.slice(0, len);
  const C = 'bdgkpvz';
  const V = 'aiu';
  let s = 1;
  const rnd = (n: number): number => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 16) % n;
  let out = '';
  while (out.length < Math.max(len, 4096)) {
    for (let k = 2 + rnd(3); k > 0; k--) out += C[rnd(C.length)]! + V[rnd(V.length)]!;
    out += ' ';
  }
  filler = out;
  return filler.slice(0, len);
}

/** Same-width stand-ins for non-ASCII characters, 16 per UTF-8 width: 2-byte, 3-byte BMP, astral pairs, lone surrogates. */
const POOLS = [
  Array.from({ length: 16 }, (_, k) => String.fromCharCode(0xe0 + k)),
  Array.from({ length: 16 }, (_, k) => String.fromCharCode(0x4e00 + k)),
  Array.from({ length: 16 }, (_, k) => String.fromCodePoint(0x1d41a + k)),
  Array.from({ length: 16 }, (_, k) => String.fromCharCode(0xdbf0 + k)),
] as const;

type Pick = (pool: readonly string[], orig: string) => string;

/** For each pool, the first character that occurs nowhere in `s` (so no filler can rebuild a run of `s`); when `s`
 *  uses the whole pool, the first one that differs from the original character at that position. */
function picker(s: string): Pick {
  const memo = new Map<readonly string[], string | undefined>();
  return (pool, orig) => {
    if (!memo.has(pool)) memo.set(pool, pool.find((p) => !s.includes(p)));
    return memo.get(pool) ?? pool.find((p) => p !== orig)!;
  };
}

/** The filler for the character at s[i]: same UTF-16 length (a surrogate pair stays two units), same UTF-8 bytes and
 *  the same JSON-escaped length. Newlines and carriage returns stay; `ascii` stands in for a plain ASCII character. */
function fillAt(s: string, i: number, ascii: string, pick: Pick): string {
  const c = s.charCodeAt(i);
  if (c === 10 || c === 13) return s[i]!;
  if (c === 8 || c === 9 || c === 12 || c === 0x22 || c === 0x5c) return '\t';
  if (c < 0x20) return '\u0001';
  if (c < 0x80) return ascii;
  if (c < 0x800) return pick(POOLS[0], s[i]!);
  if (c < 0xd800 || c >= 0xe000) return pick(POOLS[1], s[i]!);
  const pair = c < 0xdc00 && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
  return pair ? pick(POOLS[2], s.slice(i, i + 2)) : pick(POOLS[3], s[i]!);
}

/** A placeholder with the length, UTF-8 size and JSON-encoded size of `s`, and its newlines where they were. */
export function placeholder(s: string): string {
  const f = fillerOf(s.length);
  const pick = picker(s);
  let out = '';
  for (let i = 0; i < s.length; ) {
    const r = fillAt(s, i, f[i]!, pick);
    out += r;
    i += r.length;
  }
  return out;
}

/** The inside of a JSON string literal masked so both its encoded and its decoded length stay the same:
 *  \n, \r and \t stay, \uXXXX becomes a \u escape of a filler letter, \" and \\ become \\ and other
 *  two-character escapes \t (so the arguments string re-encodes to the same size inside the body). */
function maskEncoded(inner: string): string {
  const f = fillerOf(inner.length);
  const pick = picker(inner);
  let out = '';
  for (let i = 0, n = 0; i < inner.length; ) {
    if (inner[i] !== '\\') {
      const r = fillAt(inner, i, f[n]!, pick);
      out += r;
      i += r.length;
      n += r.length;
    } else if (inner[i + 1] === 'u') {
      out += '\\u00' + f[n++]!.charCodeAt(0).toString(16);
      i += 6;
    } else {
      out += '\\' + ('nrt'.includes(inner[i + 1]!) ? inner[i + 1] : '"\\'.includes(inner[i + 1]!) ? '\\' : 't');
      i += 2;
      n++;
    }
  }
  return out;
}

/** Tool-call arguments: JSON keys and non-string values kept, string values masked in place (same total length). */
export function redactArguments(s: string): string {
  try {
    JSON.parse(s);
  } catch {
    return placeholder(s);
  }
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '"') {
      out += s[i++];
      continue;
    }
    let j = i + 1;
    while (s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
    let k = j + 1;
    while (/\s/.test(s[k] ?? '')) k++;
    const inner = s.slice(i + 1, j);
    out += '"' + (s[k] === ':' ? inner : maskEncoded(inner)) + '"';
    i = j + 1;
  }
  return out;
}

/** Paths (array indices as #) of the objects whose `name` is a tool or function name, kept as is. */
const TOOL_NAME_AT = new Set(['tools.#.function', 'functions.#', 'tool_choice.function', 'function_call',
  'messages.#.tool_calls.#.function', 'messages.#.function_call']);

/** True for the `name` of a tool definition, tool choice or tool call, or of a tool or function result message. */
function isToolName(o: Record<string, unknown>, k: string, path: string): boolean {
  if (k !== 'name' || typeof o[k] !== 'string') return false;
  return TOOL_NAME_AT.has(path) || (path === 'messages.#' && (o['role'] === 'tool' || o['role'] === 'function'));
}

function redactValue(v: unknown, key: string | null, path: string): unknown {
  if (typeof v === 'string') {
    if (key !== null && PROTECTED.has(key)) return v;
    return key === 'arguments' ? redactArguments(v) : placeholder(v);
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, key === 'required' ? key : null, path + '.#'));
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    const at = (k: string): string => (path ? path + '.' + k : k);
    for (const [k, x] of Object.entries(v)) o[k] = isToolName(v as Record<string, unknown>, k, path) ? x : redactValue(x, k, at(k));
    return o;
  }
  return v;
}

/** The redacted copy of a request body; the input is not modified. */
export function redactRequest<T>(body: T): T {
  return redactValue(body, null, '') as T;
}

/** True when a parsed file looks like captured HTTP headers (which may hold credentials) rather than a body. */
export function looksLikeHeaders(x: unknown): boolean {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  const h = o['headers'] !== null && typeof o['headers'] === 'object' ? (o['headers'] as Record<string, unknown>) : o;
  return Object.keys(h).some((k) => CREDENTIAL_HEADERS.test(k));
}
