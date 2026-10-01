// Tool results as the fold sees them (DESIGN.md step 1.1, §5.5, §7): classification through the
// injected ToolRules (cached by digest), the call a result answers, superseded snapshots and their stubs.
import type { ChatMessage, ToolCall } from '../types.js';
import type { ResultKind, ToolRules } from './contracts.js';
import type { Lru } from './lru.js';
import { sha256Hex } from './canonical.js';
import { contentText, isToolResult, roleOf, toolCallsOf, withContent } from './message.js';
import type { Unit } from './units.js';

export interface ResultsEnv {
  msgs: readonly ChatMessage[];
  digests: readonly string[];
  rules: ToolRules;
  classify: Lru<string, ResultKind>;
  /** context-free size (strictly-smaller rule) */
  size: (m: ChatMessage) => number;
  /** stubs by result digest (a pure function of the result, the rules and the counter: engine-lifetime) */
  stubs?: Lru<string, ChatMessage | null>;
}

/** The tool call that result i answers: the nearest preceding assistant call with its id (the search
 *  stops at a user/system/developer message). */
export function callFor(msgs: readonly ChatMessage[], i: number): ToolCall | null {
  const id = msgs[i]?.tool_call_id;
  if (id === undefined) return null;
  for (let j = i - 1; j >= 0; j--) {
    const m = msgs[j]!;
    const r = roleOf(m);
    if (r === 'assistant') {
      const c = toolCallsOf(m).find((x) => x.id === id);
      if (c) return c;
    } else if (r !== 'tool' && r !== 'function') return null;
  }
  return null;
}

/**
 * callFor for every message with a string tool_call_id, in one forward pass: per run of assistant/tool/function
 * messages, a map from call id to the call of the nearest assistant that has it (the first such call of that
 * assistant). callFor scans backwards and copies the assistant's calls for every result, so one assistant with
 * thousands of parallel calls made classifying its results quadratic (10,000 results: 9 s).
 */
function callIndex(msgs: readonly ChatMessage[]): Array<ToolCall | null | undefined> {
  const out = new Array<ToolCall | null | undefined>(msgs.length);
  let byId = new Map<string, ToolCall>();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    const id = m?.tool_call_id;
    if (typeof id === 'string') out[i] = byId.get(id) ?? null;
    const r = roleOf(m);
    if (r === 'assistant') {
      const first = new Map<string, ToolCall>();
      for (const c of toolCallsOf(m)) if (typeof c.id === 'string' && !first.has(c.id)) first.set(c.id, c);
      for (const [k, c] of first) byId.set(k, c);
    } else if (r !== 'tool' && r !== 'function') byId = new Map();
  }
  return out;
}

const callIndexes = new WeakMap<ResultsEnv, { msgs: readonly ChatMessage[]; n: number; calls: Array<ToolCall | null | undefined> }>();

/** callFor(env.msgs, i), from the env's call index (built once per env and message list). */
function callOf(env: ResultsEnv, i: number): ToolCall | null {
  let ix = callIndexes.get(env);
  if (!ix || ix.msgs !== env.msgs || ix.n !== env.msgs.length) {
    ix = { msgs: env.msgs, n: env.msgs.length, calls: callIndex(env.msgs) };
    callIndexes.set(env, ix);
  }
  const c = ix.calls[i];
  return c === undefined ? callFor(env.msgs, i) : c; // non-string ids: the direct search
}

/** ToolRules.classify of result i, cached by (result digest, call). */
export function kindOf(env: ResultsEnv, i: number): ResultKind {
  const m = env.msgs[i]!;
  const call = callOf(env, i);
  const callKey = call ? sha256Hex(`${call.function?.name ?? ''}\u0000${call.function?.arguments ?? ''}`).slice(0, 16) : '-';
  const key = env.digests[i]! + '|' + callKey;
  let k = env.classify.get(key);
  if (k === undefined) {
    k = env.rules.classify(contentText(m), call);
    env.classify.set(key, k);
  }
  return k;
}

export const isSnapshotResult = (env: ResultsEnv, i: number): boolean =>
  isToolResult(env.msgs[i]!) && kindOf(env, i) === 'snapshot';

/**
 * Snapshot results in [units[0].start, lim) that are superseded: a newer snapshot result exists in a
 * LATER assistant unit before b (§5.4 1.1). Parallel calls in one unit do not supersede each other.
 * Pass lim = the mandatory start, so results inside the mandatory units are never returned.
 */
export function supersededSnapshots(env: ResultsEnv, units: readonly Unit[], lim: number): number[] {
  const snaps: Array<{ i: number; u: number }> = [];
  let last = -1;
  units.forEach((u, ui) => {
    let has = false;
    for (let i = u.start; i < u.end; i++) {
      if (isSnapshotResult(env, i)) {
        snaps.push({ i, u: ui });
        has = true;
      }
    }
    if (has && u.kind === 'assistant') last = ui;
  });
  return snaps.filter((x) => x.u < last && x.i < lim).map((x) => x.i);
}

/** The stub of snapshot result i (§7), or null when it has no info or would not be smaller. */
export function stubFor(env: ResultsEnv, i: number): ChatMessage | null {
  const key = env.digests[i];
  if (env.stubs && key !== undefined) {
    const hit = env.stubs.get(key);
    if (hit !== undefined) return hit;
  }
  const orig = env.msgs[i]!;
  const info = env.rules.snapshotInfo(contentText(orig));
  let out: ChatMessage | null = null;
  if (info) {
    const m = withContent(orig, env.rules.stubText(info));
    out = env.size(m) < env.size(orig) ? m : null;
  }
  // the same stub object every time: its digest and size are then cached by identity too
  if (env.stubs && key !== undefined) env.stubs.set(key, out);
  return out;
}
