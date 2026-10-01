// Counting helpers of one request (DESIGN.md "Counts used for planning", §3 byte limit).
//
//   raw(x)   = counter.measure(candidate).total, every candidate counted as a standalone request, so
//              render contexts come from the candidate alone (); per-message pieces are cached by
//              the counter under (engine digest, render context)
//   count(x) = ceil(raw(x) · correction), correction quantized to 1% (integer arithmetic, no FP drift)
//   bytes(x) = bytes(JSON.stringify(x.messages)) + fixedBytes, from per-message byte sizes cached by digest
import type { ChatMessage, ChatRequest, Measure, TokenCounter } from '../types.js';
import type { DigestCache } from './canonical.js';
import type { Lru } from './lru.js';
import { messageSize, type OpsEnv } from './oversize.js';

/** Engine-lifetime caches keyed by message digest or text (pure: the value is a function of the key). */
export interface MessageCaches {
  size: Lru<string, number>;
  bytes: Lru<string, number>;
  text: TextTokenCache;
}

/**
 * Token counts of plain texts, keyed by the text itself and bounded by total characters. The engine
 * counts the same large texts several times per step (sizes, rooms, truncation checks); the estimate
 * counter does not cache countText, and the exact one re-hashes long texts on every call.
 */
export class TextTokenCache {
  private readonly m = new Map<string, number>();
  private chars = 0;
  constructor(private readonly maxChars: number, private readonly maxEntries: number) {}

  get(s: string): number | undefined {
    const v = this.m.get(s);
    if (v !== undefined) {
      this.m.delete(s);
      this.m.set(s, v);
    }
    return v;
  }

  set(s: string, n: number): void {
    if (this.m.has(s)) return;
    this.m.set(s, n);
    this.chars += s.length;
    while (this.m.size > 1 && (this.chars > this.maxChars || this.m.size > this.maxEntries)) {
      const k = this.m.keys().next().value as string;
      this.m.delete(k);
      this.chars -= k.length;
    }
  }
}

/** Texts shorter than this are counted directly (cheaper than a map lookup of the key). */
const TEXT_CACHE_MIN = 64;

export interface CountingDeps {
  counter: TokenCounter;
  /** tools of the request (every candidate carries them) */
  tools: unknown[] | undefined;
  /** effective chat_template_kwargs (request over config defaults), null = none */
  kwargs: Record<string, unknown> | null;
  /** correction in percent (100 = uncalibrated) */
  corrPct: number;
  fixedBytes: number;
  imageTokens: number;
  headShare: number;
  digests: DigestCache;
  caches: MessageCaches;
}

export class Counting implements OpsEnv {
  readonly headShare: number;
  readonly imageTokens: number;
  /** candidates measured (diagnostics) */
  measures = 0;
  private readonly d: CountingDeps;

  constructor(d: CountingDeps) {
    this.d = d;
    this.headShare = d.headShare;
    this.imageTokens = d.imageTokens;
  }

  readonly text = (s: string): number => {
    if (s.length < TEXT_CACHE_MIN) return s.length === 0 ? 0 : this.d.counter.countText(s);
    const c = this.d.caches.text;
    let n = c.get(s);
    if (n === undefined) {
      n = this.d.counter.countText(s);
      c.set(s, n);
    }
    return n;
  };

  digest(m: ChatMessage): string {
    return this.d.digests.of(m);
  }

  /** The candidate as a standalone request (only what the template reads: messages, tools, kwargs). */
  request(msgs: ChatMessage[]): ChatRequest {
    const r: ChatRequest = { messages: msgs };
    if (this.d.tools !== undefined) r.tools = this.d.tools;
    if (this.d.kwargs) r['chat_template_kwargs'] = this.d.kwargs;
    return r;
  }

  /** Raw measure of a candidate. */
  measure(msgs: ChatMessage[], digests: string[]): Measure {
    this.measures++;
    return this.d.counter.measure(this.request(msgs), digests);
  }

  /** ceil(raw · correction). */
  count(raw: number): number {
    const p = this.d.corrPct;
    return p === 100 ? raw : Math.floor((raw * p + 99) / 100);
  }

  /** The raw amount whose corrected count is at most `c` (for converting corrected overshoots). */
  rawOf(c: number): number {
    const p = this.d.corrPct;
    return p === 100 ? c : Math.ceil((c * 100) / p);
  }

  /** Context-free message size (tokens), cached by digest. */
  size(m: ChatMessage, d?: string): number {
    const key = d ?? this.digest(m);
    let v = this.d.caches.size.get(key);
    if (v === undefined) {
      v = messageSize(m, this);
      this.d.caches.size.set(key, v);
    }
    return v;
  }

  /** bytes(JSON.stringify(m)) of one message, cached by digest. */
  msgBytes(m: ChatMessage, d?: string): number {
    const key = d ?? this.digest(m);
    let v = this.d.caches.bytes.get(key);
    if (v === undefined) {
      v = Buffer.byteLength(JSON.stringify(m) ?? 'null', 'utf8');
      this.d.caches.bytes.set(key, v);
    }
    return v;
  }

  /**
   * A rewrite's acceptance test (§5.4 , §5.6): strictly smaller in tokens AND not larger in bytes. The guard
   * compares bytes(out) with bytes(in) too (I3), and a head+tail cut that drops fewer characters than its marker adds
   * is smaller in tokens but larger in bytes (fuzz seed 7205: −261 characters, +280 marker).
   */
  smaller(a: ChatMessage, b: ChatMessage): boolean {
    return this.size(a) < this.size(b) && this.msgBytes(a) <= this.msgBytes(b);
  }

  /** bytes(JSON.stringify(msgs)) + fixedBytes (§3). */
  bytes(msgs: readonly ChatMessage[], digests: readonly string[]): number {
    let n = 2 + Math.max(0, msgs.length - 1) + this.d.fixedBytes;
    for (let i = 0; i < msgs.length; i++) {
      const key = digests[i]!;
      let v = this.d.caches.bytes.get(key);
      if (v === undefined) {
        v = Buffer.byteLength(JSON.stringify(msgs[i]) ?? 'null', 'utf8');
        this.d.caches.bytes.set(key, v);
      }
      n += v;
    }
    return n;
  }
}
