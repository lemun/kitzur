// Port of the tokenizer-side helpers of reference-harness sim/scenario.py: content_text, render,
// est_tokens, count_tokens, count_text. Verified against reference implementation
//
// Counting is the MOCK's own counter and deliberately independent of src/tokenize/counter.ts: it renders
// the approximate Qwen template exactly like scenario.render(), splits the text on the tokenizer's
// added tokens (leftmost-longest, as HF does before normalization), and counts each text segment with
// the repo tokenizer through a per-segment cache. Because HF processes the pieces between added tokens
// independently, `Σ count(segment) + #added tokens` equals `len(tok.encode(render(body)).ids)` exactly
// (MEASURED: test/bench/render.test.ts on full 46-step histories).

import type { Tokenizer } from '../../src/tokenize/tokenizer.js';
import { pyDumps, pyLen } from './pyjson.js';

type Json = Record<string, unknown>;
const isDict = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Python str() for the scalar values the render may meet (role, content of odd types). */
function pyStrOf(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  // Dicts/lists would be Python repr; OpenAI content is str | list | null, so this is never hit.
  return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** scenario.content_text: non-dict list parts are SKIPPED; dict parts without "text" contribute "". */
export function contentText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(isDict)
      .map((p) => (p['text'] === undefined ? '' : pyStrOf(p['text'])))
      .join('\n');
  }
  return pyStrOf(content);
}

const orEmpty = (x: unknown): unknown[] => (Array.isArray(x) && x.length ? x : []);

function toolsBlock(tools: unknown[]): string {
  return '\n\n# Tools\n\n<tools>\n' + tools.map((t) => pyDumps(t, { ensureAscii: false })).join('\n') + '\n</tools>';
}

/** One message's piece (everything from its <|im_start|> to its trailing "\n"). */
function renderMessage(m: unknown): string {
  const msg = isDict(m) ? m : {};
  const role = msg['role'];
  const text = contentText(msg['content']);
  if (role === 'assistant') {
    let calls = '';
    for (const c of orEmpty(msg['tool_calls'])) {
      const f = isDict(c) && isDict(c['function']) ? c['function'] : {};
      calls +=
        '\n<tool_call>\n' +
        pyDumps(new Map([['name', f['name']], ['arguments', f['arguments']]]), { ensureAscii: false }) +
        '\n</tool_call>';
    }
    return `<|im_start|>assistant\n${text}${calls}<|im_end|>\n`;
  }
  if (role === 'tool') return `<|im_start|>user\n<tool_response>\n${text}\n</tool_response><|im_end|>\n`;
  return `<|im_start|>${pyStrOf(role)}\n${text}<|im_end|>\n`;
}

export interface RenderBody {
  messages?: unknown;
  tools?: unknown;
  [k: string]: unknown;
}

/**
 * scenario.render(): only `tools` and `messages` matter; reasoning_content, name and every other field
 * are ignored (the mock never counts reasoning). A system block is always emitted; the tools block is
 * appended to the first message's text when that message is a system message.
 */
export function renderPieces(body: RenderBody): string[] {
  const tools = orEmpty(body.tools);
  let msgs = orEmpty(body.messages);
  let sysText = '';
  const first = msgs[0];
  if (isDict(first) && first['role'] === 'system') {
    sysText = contentText(first['content']);
    msgs = msgs.slice(1);
  }
  if (tools.length) sysText += toolsBlock(tools);
  const out = [`<|im_start|>system\n${sysText}<|im_end|>\n`];
  for (const m of msgs) out.push(renderMessage(m));
  out.push('<|im_start|>assistant\n');
  return out;
}

export function render(body: RenderBody): string {
  return renderPieces(body).join('');
}

/** scenario.est_tokens: code points of the spaced ensure_ascii=False dump // 4. */
export function estTokens(value: unknown): number {
  return Math.floor(pyLen(pyDumps(value, { ensureAscii: false })) / 4);
}

/** gobstopper's own estimate: floor((len(json.dumps(body, ensure_ascii=False)) + 2) / 4) [reference implementation]. */
export function gobEstimate(value: unknown): number {
  return Math.floor((pyLen(pyDumps(value, { ensureAscii: false })) + 2) / 4);
}

// ---------------------------------------------------------------- counting

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A rendered prompt split on added tokens: [text, special, text, special, ..., text]. Even indices are
 * text segments (possibly empty), odd indices are added tokens (one token each).
 */
export type Segments = string[];

export interface PromptCounterOptions {
  /** Upper bound on the cached segment characters before the cache is cleared (default 64M). */
  maxCacheChars?: number;
}

export class PromptCounter {
  private readonly split: RegExp;
  private readonly cache = new Map<string, number>();
  private cachedChars = 0;
  private readonly maxCacheChars: number;
  /** diagnostics */
  hits = 0;
  misses = 0;

  constructor(
    readonly tok: Tokenizer,
    opts: PromptCounterOptions = {},
  ) {
    this.maxCacheChars = opts.maxCacheChars ?? 64 * 1024 * 1024;
    // Longest first => JS leftmost-first alternation == HF's leftmost-longest added-token matching.
    const added = [...tok.addedTokens.keys()].sort((x, y) => y.length - x.length || (x < y ? -1 : 1));
    this.split = new RegExp('(' + added.map(escapeRe).join('|') + ')', 'u');
  }

  segments(text: string): Segments {
    return text.split(this.split);
  }

  /** Tokens of one text segment (no added tokens inside), cached. */
  countSegment(s: string): number {
    if (s.length === 0) return 0;
    const c = this.cache.get(s);
    if (c !== undefined) {
      this.hits++;
      return c;
    }
    this.misses++;
    const n = this.tok.count(s);
    if (this.cachedChars + s.length > this.maxCacheChars) {
      this.cache.clear();
      this.cachedChars = 0;
    }
    this.cache.set(s, n);
    this.cachedChars += s.length;
    return n;
  }

  countSegments(segs: Segments): number {
    let n = 0;
    for (let i = 0; i < segs.length; i++) n += i & 1 ? 1 : this.countSegment(segs[i]!);
    return n;
  }

  /** scenario.count_text: len(tok.encode(text, add_special_tokens=False).ids). */
  countText(text: string): number {
    return this.countSegments(this.segments(text));
  }

  /** scenario.count_tokens(body). */
  countBody(body: RenderBody): number {
    return this.countSegments(this.segments(render(body)));
  }

  /** Render + split once, for callers that need both the count and an LCP later. */
  measureBody(body: RenderBody): { segments: Segments; tokens: number } {
    const segments = this.segments(render(body));
    return { segments, tokens: this.countSegments(segments) };
  }

  private ids(segs: Segments, i: number): ArrayLike<number> {
    const s = segs[i]!;
    if (i & 1) return [this.tok.addedTokens.get(s)!];
    return s.length ? this.tok.encode(s) : [];
  }

  /**
   * Token-level longest common prefix of two rendered prompts. Equal segments are skipped by string
   * comparison (equal text => equal tokens); the first differing pair is expanded to token ids, and the
   * comparison continues across segment boundaries when one side runs out first (exact even when two
   * different strings tokenize alike, e.g. NFC-equivalent text).
   */
  lcp(a: Segments, b: Segments): number {
    let total = 0;
    let i = 0;
    let j = 0;
    let ta: ArrayLike<number> | null = null;
    let tb: ArrayLike<number> | null = null;
    let pa = 0;
    let pb = 0;
    for (;;) {
      if (ta === null && tb === null) {
        if (i >= a.length || j >= b.length) return total;
        if ((i & 1) === (j & 1) && a[i] === b[j]) {
          total += i & 1 ? 1 : this.countSegment(a[i]!);
          i++;
          j++;
          continue;
        }
      }
      if (ta === null) {
        if (i >= a.length) return total;
        ta = this.ids(a, i);
        pa = 0;
      }
      if (tb === null) {
        if (j >= b.length) return total;
        tb = this.ids(b, j);
        pb = 0;
      }
      while (pa < ta.length && pb < tb.length) {
        if (ta[pa] !== tb[pb]) return total;
        pa++;
        pb++;
        total++;
      }
      if (pa >= ta.length) {
        ta = null;
        i++;
      }
      if (pb >= tb.length) {
        tb = null;
        j++;
      }
    }
  }

  clearCache(): void {
    this.cache.clear();
    this.cachedChars = 0;
  }
}
