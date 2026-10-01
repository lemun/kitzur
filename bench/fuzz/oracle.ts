// The fuzz oracle (bench/README.md; DESIGN.md "How the invariants are tested"): everything the invariants
// compare against is re-derived here WITHOUT the engine.
//
//   count    exact + sim:    the bench mock's render (bench/lib/render.ts) + its own PromptCounter over the
//                            tokenizer (a separate implementation from src/tokenize/counter.ts);
//            exact + qwen3:  the bench mock's vLLM/Jinja port (bench/mock/qwen3-render.ts) + PromptCounter, with
//                            the vision placeholders re-priced at tokenizer.imageTokens (the engine never
//                            tokenizes images, DESIGN §4);
//            otherwise:      a fresh counter instance (src/tokenize/counter.ts) built for this oracle only, so its
//                            caches are cold and filled by oracle calls alone.
//   pairing  a defect walk of its own (orphans and unanswered calls), plus gobstopper's pairing_intact;
//   head     DESIGN §5.1 hEnd re-derived;
//   bytes    bytes(JSON.stringify(messages)) (+ fixedBytes on both sides, so comparisons use the raw part).
import type { ChatMessage, ChatRequest } from '../../src/types.js';
import type { Config } from '../../src/config/schema.js';
import { canonicalJSON, sha256Hex } from '../../src/tokenize/canonical.js';
import { createCounter } from '../../src/tokenize/counter.js';
import type { Tokenizer } from '../../src/tokenize/tokenizer.js';
import type { TemplateName } from '../../src/tokenize/template.js';
import { PromptCounter } from '../lib/render.js';
import { renderQwen3 } from '../mock/qwen3-render.js';

const HEADER = 'The following is a summary of your previous actions (long observations omitted):';
const VISION = '<|vision_start|>';
const MOCK_IMAGE_TOKENS = 3; // <|vision_start|><|image_pad|><|vision_end|>: three added tokens

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
 * Pairing defects as a multiset: a tool message is fine when the assistant right before its run of tool
 * messages has an unconsumed call with its id; an assistant's call is unanswered when its run of results ends
 * (not at the end of the list) without it.
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
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]!.role !== 'tool') continue;
    let j = i;
    while (j > 0 && msgs[j - 1]!.role === 'tool') j--;
    if (j === 0 || msgs[j - 1]!.role !== 'assistant') add('orphan:' + id(msgs[i]!.tool_call_id));
  }
  return out;
}

export function defectSubset(a: Map<string, number>, b: Map<string, number>): boolean {
  for (const [k, v] of a) if ((b.get(k) ?? 0) < v) return false;
  return true;
}

const text = (m: ChatMessage): string =>
  typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.filter((p) => (p as { type?: string }).type === 'text').map((p) => String((p as { text?: string }).text)).join('\n') : '';
const firstText = (m: ChatMessage): string =>
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
      client.compactionMarkers.includes(firstText(msgs[h - 1]!).trim())) h++;
  return h;
}

export const digest = (m: unknown): string => sha256Hex(canonicalJSON(m));
export const bytesOf = (msgs: readonly ChatMessage[]): number => Buffer.byteLength(JSON.stringify(msgs), 'utf8');

/** Effective chat_template_kwargs: the request's booleans over the config defaults (what the server applies). */
function kwargsOf(cfg: Config, req: ChatRequest): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const t = cfg.tokenizer.template;
  if (t.enableThinking !== null) out['enable_thinking'] = t.enableThinking;
  if (t.preserveThinking !== null) out['preserve_thinking'] = t.preserveThinking;
  const kw = req['chat_template_kwargs'];
  if (kw && typeof kw === 'object' && !Array.isArray(kw)) {
    for (const k of ['enable_thinking', 'preserve_thinking']) {
      const v = (kw as Record<string, unknown>)[k];
      if (typeof v === 'boolean') out[k] = v;
    }
  }
  return out;
}

export class OracleCountError extends Error {}

export interface Oracle {
  /** raw prompt tokens of a request (messages, tools, kwargs); throws OracleCountError when it cannot be rendered */
  raw(req: ChatRequest): number;
  /** which implementation counts */
  readonly kind: 'mock-sim' | 'mock-qwen3' | 'fresh-counter';
}

/** A cold oracle for one chain. */
export function createOracle(cfg: Config, template: TemplateName, mode: 'exact' | 'estimate', tok: Tokenizer | null): Oracle {
  if (mode === 'exact' && tok && template === 'sim') {
    const pc = new PromptCounter(tok);
    return { kind: 'mock-sim', raw: (req) => pc.countBody({ messages: req.messages, tools: req.tools }) };
  }
  if (mode === 'exact' && tok && template === 'qwen3') {
    const pc = new PromptCounter(tok);
    const img = cfg.tokenizer.imageTokens;
    return {
      kind: 'mock-qwen3',
      raw: (req) => {
        const kw = kwargsOf(cfg, req);
        const body: Record<string, unknown> = { messages: req.messages };
        if (req.tools !== undefined) body['tools'] = req.tools;
        if (Object.keys(kw).length) body['chat_template_kwargs'] = kw;
        let t: string;
        try {
          t = renderQwen3(JSON.stringify(body));
        } catch (e) {
          throw new OracleCountError(e instanceof Error ? e.message : String(e));
        }
        let images = 0;
        for (let i = t.indexOf(VISION); i >= 0; i = t.indexOf(VISION, i + 1)) images++;
        return pc.countText(t) + images * (img - MOCK_IMAGE_TOKENS);
      },
    };
  }
  const c = createCounter({
    mode: mode === 'exact' && tok ? 'exact' : 'estimate', template,
    templateOptions: { enableThinking: cfg.tokenizer.template.enableThinking, perMessageOverhead: cfg.tokenizer.fallback.perMessageOverhead },
    tokenizer: mode === 'exact' ? tok : null, imageTokens: cfg.tokenizer.imageTokens, fallback: cfg.tokenizer.fallback, cacheEntries: 50_000,
  });
  return {
    kind: 'fresh-counter',
    raw: (req) => {
      const kw = kwargsOf(cfg, req);
      try {
        return c.countRequest({ messages: req.messages, ...(req.tools !== undefined ? { tools: req.tools } : {}), ...(Object.keys(kw).length ? { chat_template_kwargs: kw } : {}) });
      } catch (e) {
        throw new OracleCountError(e instanceof Error ? e.message : String(e));
      }
    },
  };
}

/** ceil(raw · correction) with the correction in percent (DESIGN §4). */
export const corrected = (raw: number, corrPct: number): number => (corrPct === 100 ? raw : Math.floor((raw * corrPct + 99) / 100));
export const corrPctOf = (correction: number | undefined): number => Math.max(100, Math.ceil((correction ?? 1) * 100 - 1e-9));
