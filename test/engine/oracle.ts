// Independent oracles for the engine property tests. Nothing here imports src/engine: pairing, head
// and counts are re-derived so that the engine cannot pass by checking itself (DESIGN §1, ).
import type { ChatMessage, ChatRequest } from '../../src/types.js';
import type { Config } from '../../src/config/schema.js';
import { canonicalJSON, sha256Hex } from '../../src/tokenize/canonical.js';
import { createCounter } from '../../src/tokenize/counter.js';
import type { TemplateName } from '../../src/tokenize/template.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { devTokenizer } from './stubs.js';

const HEADER = 'The following is a summary of your previous actions (long observations omitted):';

/** gobstopper v0.7.2 pairing_intact for Chat (crates/gobstopper-adapters/src/request/replay.rs:612-654). */
export function pairingIntact(msgs: readonly ChatMessage[]): boolean {
  let pending = new Set<unknown>();
  for (const m of msgs) {
    if (m.role === 'assistant') {
      if (pending.size) return false;
      pending = new Set((Array.isArray(m.tool_calls) ? m.tool_calls : []).map((c) => c?.id));
    } else if (m.role === 'tool') {
      if (!pending.has(m.tool_call_id)) return false;
      pending.delete(m.tool_call_id);
    } else if (pending.size) return false;
  }
  return true;
}

/**
 * Defects found per message (a different walk than the engine's): a tool message is fine when the
 * assistant right before its run of tool messages has an unconsumed call with its id; an assistant's
 * call is unanswered when its run of results ends (not at the end of the list) without it.
 */
export function oracleDefects(msgs: readonly ChatMessage[]): Map<string, number> {
  const out = new Map<string, number>();
  const add = (k: string): void => void out.set(k, (out.get(k) ?? 0) + 1);
  const id = (x: unknown): string => (typeof x === 'string' ? x : String(x));
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role !== 'assistant') continue;
    const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((c) => id(c?.id));
    let j = i + 1;
    const answered: string[] = [];
    while (j < msgs.length && msgs[j]!.role === 'tool') answered.push(id(msgs[j++]!.tool_call_id));
    const left = [...calls];
    for (const a of answered) {
      const k = left.indexOf(a);
      if (k >= 0) left.splice(k, 1);
      else add('orphan:' + a);
    }
    if (j < msgs.length) for (const c of left) add('unanswered:' + c);
  }
  // tool runs not preceded by an assistant
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]!.role !== 'tool') continue;
    let j = i;
    while (j > 0 && msgs[j - 1]!.role === 'tool') j--;
    if (j === 0 || msgs[j - 1]!.role !== 'assistant') add('orphan:' + id(msgs[i]!.tool_call_id));
  }
  return out;
}

export function subset(a: Map<string, number>, b: Map<string, number>): boolean {
  for (const [k, v] of a) if ((b.get(k) ?? 0) < v) return false;
  return true;
}

const text = (m: ChatMessage): string =>
  typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.filter((p) => (p as { type?: string }).type === 'text').map((p) => String((p as { text?: string }).text)).join('\n') : '';
const first = (m: ChatMessage): string =>
  typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? String((m.content.find((p) => (p as { type?: string }).type === 'text') as { text?: string } | undefined)?.text ?? '') : '';

/** DESIGN §5.1 head end, re-derived. */
export function oracleHeadEnd(msgs: readonly ChatMessage[], client: Config['client']): number {
  let h = msgs.findIndex((m) => m.role === 'assistant');
  if (h < 0) h = msgs.length;
  while (h > 0 && msgs[h - 1]!.role === 'user' && text(msgs[h - 1]!).startsWith(HEADER)) h--;
  const s = msgs[h];
  if (h >= 1 && s && s.role === 'assistant' && !(Array.isArray(s.tool_calls) && s.tool_calls.length) &&
      client.summaryMarkers.some((k) => k && text(s).includes(k)) && msgs[h - 1]!.role === 'user' &&
      client.compactionMarkers.includes(first(msgs[h - 1]!).trim())) h++;
  return h;
}

export const digest = (m: unknown): string => sha256Hex(canonicalJSON(m));
export const bytesOf = (msgs: readonly ChatMessage[]): number => Buffer.byteLength(JSON.stringify(msgs), 'utf8');

/**
 * An independent prompt counter, cold when created (one per chain): the bench mock's render + tokenizer
 * for sim/exact (a separate implementation), otherwise a separate counter instance whose caches are
 * filled only by oracle calls, never by the engine.
 */
export function oracleCounter(template: TemplateName, mode: 'exact' | 'estimate'): (req: ChatRequest) => number {
  const tok = devTokenizer();
  if (mode === 'exact' && template === 'sim' && tok) {
    const pc = new PromptCounter(tok);
    return (req) => pc.countBody({ messages: req.messages, tools: req.tools });
  }
  const c = createCounter({ mode: mode === 'exact' && tok ? 'exact' : 'estimate', template, tokenizer: tok, tokenizerId: tok?.sha256 ?? null });
  return (req) => c.countRequest({ messages: req.messages, tools: req.tools, chat_template_kwargs: req['chat_template_kwargs'] });
}
