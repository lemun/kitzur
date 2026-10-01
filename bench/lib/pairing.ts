// Port of mock_server.check_pairing (reference-harness sim/mock_server.py:36-52), verified against the
// pairing cases in reference implementation Error strings are byte-identical to Python's, including
// the Python list repr of the sorted pending ids (`['c1', 'c2']`) and `None` for a missing id.
//
// Semantics (as in Python): a tool message must answer an id of the most recent assistant's calls; any
// non-tool message while calls are pending is an error; an assistant message REPLACES the pending set
// (duplicate ids collapse); a tool result may answer the calls in any order.

type Json = Record<string, unknown>;
const isDict = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Python repr of a str / None (single quotes unless the text has ' and no ", like repr()). */
function pyRepr(x: unknown): string {
  if (x === null || x === undefined) return 'None';
  if (typeof x !== 'string') return String(x);
  const q = x.includes("'") && !x.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of x) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += '\\' + q;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return q + out + q;
}

/** Python sorted() over str ids (code point order). A None mixed with str raises TypeError in Python. */
function sortedIds(ids: Iterable<unknown>): unknown[] {
  const arr = [...ids];
  const hasNone = arr.some((x) => x === null || x === undefined);
  if (hasNone && arr.length > 1) throw new TypeError("'<' not supported between instances of 'NoneType' and 'str'");
  return arr.sort((a, b) => {
    const x = String(a);
    const y = String(b);
    return x < y ? -1 : x > y ? 1 : 0; // UTF-16 order == code point order for BMP ids (all harness ids)
  });
}

const listRepr = (ids: Iterable<unknown>): string => '[' + sortedIds(ids).map(pyRepr).join(', ') + ']';

/** Returns null when valid, else the mock's error text. */
export function checkPairing(msgs: readonly unknown[]): string | null {
  let pending = new Set<unknown>();
  for (let i = 0; i < msgs.length; i++) {
    const m = isDict(msgs[i]) ? (msgs[i] as Json) : {};
    const role = m['role'];
    if (role === 'tool') {
      const tid = m['tool_call_id'] === undefined ? null : m['tool_call_id'];
      if (!pending.has(tid)) return `message ${i}: tool result ${tid === null ? 'None' : String(tid)} has no preceding tool call`;
      pending.delete(tid);
    } else {
      if (pending.size) return `message ${i}: tool calls ${listRepr(pending)} were never answered`;
      if (role === 'assistant') {
        const calls = Array.isArray(m['tool_calls']) ? (m['tool_calls'] as unknown[]) : [];
        pending = new Set(calls.map((c) => (isDict(c) && c['id'] !== undefined ? c['id'] : null)));
      }
    }
  }
  if (pending.size) return `end: tool calls ${listRepr(pending)} were never answered`;
  return null;
}
