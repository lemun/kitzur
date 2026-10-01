// Strict positional pairing (bench/README.md): the Qwen template renders no tool_call_id, so a server pairs a
// tool result with a call only by position. For every assistant message with n tool calls, the maximal run of
// `tool` messages right after it must answer those calls one by one, in order.
//
// The result is a DEFECT SET keyed by tool_call_id and position inside the call block, so that the set of a
// request forwarded by a proxy can be compared with the set of the client request it came from (the output's
// defects must be a subset of the input's) even when the proxy dropped or rewrote messages around them:
//   unanswered:<callId>#<k>   call k has no result at position k (the run is shorter, or the request ends)
//   mismatch:<callId>#<k>     the result at position k answers another id
//   orphan:<toolCallId>#<k>   a result beyond the calls of its block (k = position in the run), or a run of tool
//                             messages with no assistant call block right before it
//   dup-call:<callId>#<k>     a call id repeated inside one assistant message
// A missing id prints as `None`. An empty array means valid.

type Json = Record<string, unknown>;
const isDict = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);
const idOf = (x: unknown): string => (typeof x === 'string' ? x : x === undefined || x === null ? 'None' : String(x));

export function strictPairingDefects(msgs: readonly unknown[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < msgs.length) {
    const m = isDict(msgs[i]) ? (msgs[i] as Json) : {};
    if (m['role'] === 'tool') {
      // a tool run with no call block before it
      let k = 0;
      while (i < msgs.length && isDict(msgs[i]) && (msgs[i] as Json)['role'] === 'tool') out.push(`orphan:${idOf((msgs[i++] as Json)['tool_call_id'])}#${k++}`);
      continue;
    }
    i++;
    const calls = m['role'] === 'assistant' && Array.isArray(m['tool_calls']) ? (m['tool_calls'] as unknown[]) : [];
    if (!calls.length) continue;
    const ids = calls.map((c) => idOf(isDict(c) ? c['id'] : undefined));
    const seen = new Set<string>();
    ids.forEach((id, k) => {
      if (seen.has(id)) out.push(`dup-call:${id}#${k}`);
      seen.add(id);
    });
    const run: string[] = [];
    while (i < msgs.length && isDict(msgs[i]) && (msgs[i] as Json)['role'] === 'tool') run.push(idOf((msgs[i++] as Json)['tool_call_id']));
    for (let k = 0; k < Math.max(ids.length, run.length); k++) {
      if (k >= run.length) out.push(`unanswered:${ids[k]}#${k}`);
      else if (k >= ids.length) out.push(`orphan:${run[k]}#${k}`);
      else if (run[k] !== ids[k]) out.push(`mismatch:${ids[k]}#${k}`);
    }
  }
  return out;
}

/** True when every defect of `out` is also a defect of `input` (benchmark contract fuzz I1). */
export function defectsSubset(out: readonly string[], input: readonly string[]): boolean {
  const s = new Set(input);
  return out.every((d) => s.has(d));
}
