// Redaction of captured chat-completions request bodies for sharing bug reports (docs/DIAGNOSTICS.md).
// Every free-text string (message content, tool results, system prompts, tool-call argument values, descriptions)
// becomes a placeholder of the same length with newlines in the same places, so token counts and truncation stay
// comparable. Kept: object keys, numbers, booleans, roles, ids and their pairing, names, types, the model.
// The placeholder depends only on the length and newline positions of the original, never on its text.

/** Keys whose string values (or arrays of strings) are structure, not content. */
const PROTECTED = new Set(['model', 'role', 'name', 'id', 'tool_call_id', 'type', 'required', 'tool_choice', 'format']);

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

/** A placeholder with the length of `s` and its newlines (and carriage returns) where they were. */
export function placeholder(s: string): string {
  const f = fillerOf(s.length);
  let out = '';
  for (let i = 0; i < s.length; i++) out += s[i] === '\n' || s[i] === '\r' ? s[i] : f[i];
  return out;
}

/** The inside of a JSON string literal masked so both its encoded and its decoded length stay the same:
 *  \n, \r and \t stay, \uXXXX becomes a \u escape of a filler letter, other two-character escapes become \t. */
function maskEncoded(inner: string): string {
  const f = fillerOf(inner.length);
  let out = '';
  for (let i = 0, n = 0; i < inner.length; n++) {
    if (inner[i] !== '\\') {
      out += f[n];
      i++;
    } else if (inner[i + 1] === 'u') {
      out += '\\u00' + f[n]!.charCodeAt(0).toString(16);
      i += 6;
    } else {
      out += '\\' + ('nrt'.includes(inner[i + 1]!) ? inner[i + 1] : 't');
      i += 2;
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

function redactValue(v: unknown, key: string | null): unknown {
  if (typeof v === 'string') {
    if (key !== null && PROTECTED.has(key)) return v;
    return key === 'arguments' ? redactArguments(v) : placeholder(v);
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, key === 'required' ? key : null));
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = redactValue(x, k);
    return o;
  }
  return v;
}

/** The redacted copy of a request body; the input is not modified. */
export function redactRequest<T>(body: T): T {
  return redactValue(body, null) as T;
}

/** True when a parsed file looks like captured HTTP headers (which may hold credentials) rather than a body. */
export function looksLikeHeaders(x: unknown): boolean {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  const h = o['headers'] !== null && typeof o['headers'] === 'object' ? (o['headers'] as Record<string, unknown>) : o;
  return Object.keys(h).some((k) => CREDENTIAL_HEADERS.test(k));
}
