// Response parsing for the spec-driven clients (bench/client/agent.ts with a ScenarioSpec, bench/client/opencode.ts).
// Unlike agent_client.py's parse() (kept byte-exact in agent.ts for the cross-check), this one sees everything a
// strict client must see (bench/README.md):
//  - every SSE line `data: …` / `error: …` (llama.cpp ≤b6400 used the non-standard `error:` field); an event whose
//    JSON has a top-level `error` is an in-stream error;
//  - `data: [DONE]`, every `finish_reason`, the usage chunk, `reasoning_content` / `reasoning` deltas;
//  - tool-call deltas merged by `index` (OpenAI streaming semantics: id/type/name once, arguments concatenated) and
//    ordered by it, like the AI SDK; an entry without `index` is a call of its own;
// A JSON (non-stream) body is read as one message; a body with a top-level `error` is an error.

import type { ChatMessage, ToolCall } from '../../src/types.js';

type Json = Record<string, unknown>;
const isDict = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

export interface ParsedResponse {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  /** `data: [DONE]` seen (always true for a JSON body that parsed) */
  done: boolean;
  usage: Record<string, unknown> | null;
  /** events / bodies with a top-level `error` */
  errors: Json[];
  /** lines that were neither JSON nor [DONE] */
  badLines: number;
  stream: boolean;
}

/**
 * benchmark contract client_error_kind, with the names bench/metrics/pairing.ts reports: `http_<status>` (non-200),
 * `stream_error` (an in-stream error event), `truncated_stream` (no [DONE] and no finish_reason), `length_no_tool`
 * (finish_reason "length" with no tool call); `bad_response` = a 200 body that is not JSON.
 */
export type ClientErrorKind = `http_${number}` | 'stream_error' | 'truncated_stream' | 'length_no_tool' | 'bad_response';

/** benchmark contract : the client-visible error of a response, or null. */
export function clientErrorKind(status: number, p: ParsedResponse | null): ClientErrorKind | null {
  if (status !== 200) return `http_${status}`;
  if (!p) return 'bad_response';
  if (p.errors.length) return 'stream_error';
  if (p.badLines && !p.stream) return 'bad_response';
  if (p.stream && !p.done && p.finishReason === null) return 'truncated_stream';
  if (p.finishReason === 'length' && !p.toolCalls.length) return 'length_no_tool';
  return null;
}

/**
 * Merge streamed tool-call deltas. Like the AI SDK (openai-compatible `toolCalls[index]`), a call's position is its
 * `index` (a delta without one opens a call at the current count), not the order in which the indices first arrived.
 */
function mergeCalls(calls: ToolCall[], byIndex: Map<number, ToolCall>, entries: unknown[], delta: boolean): void {
  for (const e of entries) {
    if (!isDict(e)) continue;
    const fn = isDict(e['function']) ? e['function'] : {};
    // a non-stream message lists whole calls: never merge them, whatever `index` they may carry
    const next = byIndex.size ? Math.max(...byIndex.keys()) + 1 : 0;
    const idx = delta && typeof e['index'] === 'number' ? e['index'] : next;
    const prev = byIndex.get(idx);
    if (prev) {
      if (typeof e['id'] === 'string' && e['id']) prev.id = e['id'];
      if (typeof fn['name'] === 'string' && fn['name'] && !prev.function.name) prev.function.name = fn['name'];
      if (typeof fn['arguments'] === 'string') prev.function.arguments += fn['arguments'];
      continue;
    }
    const call: ToolCall = {
      id: typeof e['id'] === 'string' ? e['id'] : '',
      type: typeof e['type'] === 'string' ? e['type'] : 'function',
      function: { name: typeof fn['name'] === 'string' ? fn['name'] : '', arguments: typeof fn['arguments'] === 'string' ? fn['arguments'] : '' },
    };
    calls.push(call);
    byIndex.set(idx, call);
  }
}

/** The merged calls in `index` order. */
const inIndexOrder = (byIndex: Map<number, ToolCall>): ToolCall[] => [...byIndex].sort((a, b) => a[0] - b[0]).map(([, c]) => c);

export function parseResponse(ctype: string, raw: Buffer | string): ParsedResponse {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const p: ParsedResponse = { content: '', reasoning: '', toolCalls: [], finishReason: null, done: false, usage: null, errors: [], badLines: 0, stream: false };
  const byIndex = new Map<number, ToolCall>();
  const absorbChoice = (ch: unknown, delta: boolean): void => {
    if (!isDict(ch)) return;
    const d = delta ? ch['delta'] : ch['message'];
    if (isDict(d)) {
      if (typeof d['content'] === 'string') p.content += d['content'];
      const r = typeof d['reasoning_content'] === 'string' ? d['reasoning_content'] : typeof d['reasoning'] === 'string' ? d['reasoning'] : '';
      p.reasoning += r;
      if (Array.isArray(d['tool_calls'])) mergeCalls(p.toolCalls, byIndex, d['tool_calls'], delta);
    }
    if (typeof ch['finish_reason'] === 'string') p.finishReason = ch['finish_reason'];
  };
  if (!ctype.includes('event-stream')) {
    try {
      const j = JSON.parse(text) as unknown;
      if (!isDict(j)) throw new Error('not an object');
      if (j['error'] !== undefined && j['error'] !== null) p.errors.push(j);
      const choices = Array.isArray(j['choices']) ? j['choices'] : [];
      for (const ch of choices) absorbChoice(ch, false);
      if (isDict(j['usage'])) p.usage = j['usage'];
      p.done = true;
    } catch {
      p.badLines++;
    }
    return p;
  }
  p.stream = true;
  for (const line of text.split(/\r\n|\r|\n/)) {
    let payload: string;
    if (line.startsWith('data:')) payload = line.slice(5);
    else if (line.startsWith('error:')) payload = line.slice(6);
    else continue; // blank lines, comments (": keep-alive"), event:/id: fields
    if (payload.startsWith(' ')) payload = payload.slice(1);
    if (payload.trim() === '[DONE]') {
      p.done = true;
      continue;
    }
    let ev: unknown;
    try {
      ev = JSON.parse(payload);
    } catch {
      p.badLines++;
      continue;
    }
    if (!isDict(ev)) continue;
    if (line.startsWith('error:') || (ev['error'] !== undefined && ev['error'] !== null)) {
      p.errors.push(line.startsWith('error:') && ev['error'] === undefined ? { error: ev } : ev);
      continue;
    }
    if (isDict(ev['usage'])) p.usage = ev['usage'];
    for (const ch of Array.isArray(ev['choices']) ? ev['choices'] : []) absorbChoice(ch, true);
  }
  p.toolCalls = inIndexOrder(byIndex);
  return p;
}

/** The assistant message a spec-driven client appends (reasoning echoed like OpenCode when asked). */
export function assistantFrom(p: ParsedResponse, echoReasoning: boolean): ChatMessage {
  const m: ChatMessage = { role: 'assistant', content: p.content || null };
  if (echoReasoning && p.reasoning) m.reasoning_content = p.reasoning;
  m.tool_calls = p.toolCalls;
  return m;
}
