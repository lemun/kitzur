// Run directory → compact per-request records (bench/metrics/records.ts), from the mock's view (bench/README.md).
//
// Reads the reference layout written by bench/harness.ts (and run.py): mock.jsonl + reqs/<body_file> for the upstream
// side, client.jsonl + origs/step{N}.json for the client side. Every upstream body is re-rendered with the mock's
// render and tokenizer to get per-message tokens and exact token LCPs:
//   lcp        with the previous accepted MAIN request of the same session (summarizer/title excluded)
//   lcpGlobal  the max over all earlier accepted main requests of any session
// Segment prefixes are compared by per-segment hashes, then token by token inside the first differing segment pair
// (PromptCounter.lcp), which is exact because the render is split at added tokens (bench/lib/render.ts).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { digestOf } from '../../src/tokenize/canonical.js';
import { strictPairingDefects } from '../lib/pairing-strict.js';
import { render, renderPieces, type PromptCounter, type RenderBody, type Segments } from '../lib/render.js';
import type { FactSpec } from '../scenarios/types.js';
import type { ClientRec, ReqKind, RunRecords, UpstreamRec } from './records.js';

type Json = Record<string, unknown>;

export function readJsonl(path: string): Json[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length)
    .map((l) => JSON.parse(l) as Json);
}

/**
 * Per-message facts: ids of the facts whose marker occurs in each message's dump. The markers are printable ASCII
 * without quotes or backslashes (lint.ts), so JSON.stringify and Python's ensure_ascii=False dump agree on whether a
 * marker occurs (they differ only in separators and escapes of characters no marker contains).
 */
export function messageFacts(messages: readonly unknown[], facts: readonly FactSpec[]): string[][] {
  return messages.map((m) => {
    const t = JSON.stringify(m);
    return facts.filter((f) => t.includes(f.marker)).map((f) => f.id);
  });
}

/**
 * Digest and facts of a message, memoized by its JSON text: client histories resend every message at every step, so
 * without this a run costs O(Σ|C_k|) canonicalisations instead of O(unique messages).
 */
export class MessageInfoCache {
  private readonly m = new Map<string, { digest: string; facts: string[] }>();
  constructor(private readonly facts: readonly FactSpec[]) {}
  get(msg: unknown): { digest: string; facts: string[] } {
    const key = JSON.stringify(msg) ?? 'null';
    let v = this.m.get(key);
    if (!v) {
      v = { digest: digestOf(msg), facts: this.facts.filter((f) => key.includes(f.marker)).map((f) => f.id) };
      this.m.set(key, v);
    }
    return v;
  }
  digests(msgs: readonly unknown[]): string[] {
    return msgs.map((x) => this.get(x).digest);
  }
  factsOf(msgs: readonly unknown[]): string[][] {
    return msgs.map((x) => this.get(x).facts);
  }
}

/** A rendered prompt with per-segment hashes and cumulative token counts, for fast exact LCPs. */
export interface SegIndex {
  segs: Segments;
  hash: string[];
  /** cum[i] = tokens of segs[0..i) */
  cum: number[];
}

export function segIndex(counter: PromptCounter, segs: Segments): SegIndex {
  const hash: string[] = [];
  const cum: number[] = [0];
  for (let i = 0; i < segs.length; i++) {
    hash.push(createHash('sha1').update(segs[i]!).digest('base64'));
    cum.push(cum[i]! + (i & 1 ? 1 : counter.countSegment(segs[i]!)));
  }
  return { segs, hash, cum };
}

/** Token ids of a text segment, memoized (LCPs re-encode the same first-differing segments many times). */
export class IdCache {
  private readonly m = new Map<string, ArrayLike<number>>();
  private chars = 0;
  constructor(private readonly counter: PromptCounter, private readonly maxChars = 64 * 1024 * 1024) {}
  ids(segs: Segments, i: number): ArrayLike<number> {
    const s = segs[i]!;
    if (i & 1) return [this.counter.tok.addedTokens.get(s)!];
    if (!s.length) return [];
    let v = this.m.get(s);
    if (!v) {
      if (this.chars + s.length > this.maxChars) {
        this.m.clear();
        this.chars = 0;
      }
      v = this.counter.tok.encode(s);
      this.m.set(s, v);
      this.chars += s.length;
    }
    return v;
  }
}

/**
 * Exact token LCP of two rendered prompts: equal leading segments by hash (tokens from the cumulative counts), then
 * the id-level LCP from the first differing segment on, continuing across segment boundaries like PromptCounter.lcp.
 */
export function lcpIndexed(counter: PromptCounter, a: SegIndex, b: SegIndex, idc: IdCache = new IdCache(counter)): number {
  const n = Math.min(a.hash.length, b.hash.length);
  let i = 0;
  while (i < n && a.hash[i] === b.hash[i]) i++;
  if (i === n) return a.cum[i]!;
  let total = a.cum[i]!;
  let j = i;
  let ta: ArrayLike<number> | null = null;
  let tb: ArrayLike<number> | null = null;
  let pa = 0;
  let pb = 0;
  for (;;) {
    if (ta === null) {
      if (i >= a.segs.length) return total;
      ta = idc.ids(a.segs, i);
      pa = 0;
    }
    if (tb === null) {
      if (j >= b.segs.length) return total;
      tb = idc.ids(b.segs, j);
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

export interface MessageMeasure {
  perMessage: number[];
  overhead: number;
  total: number;
  segments: Segments;
}

/** The sim render (scenario.render) measured per message: piece i ↔ message i (the tools block merged into a first
 * system message; otherwise a tools-only system block is overhead). Additive: pieces are split at added tokens. */
export function measureSim(counter: PromptCounter, body: RenderBody): MessageMeasure {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const pieces = renderPieces(body);
  const hasSys = typeof msgs[0] === 'object' && msgs[0] !== null && (msgs[0] as Json)['role'] === 'system';
  const off = hasSys ? 0 : 1;
  const perMessage = msgs.map((_, i) => counter.countText(pieces[i + off]!));
  const segments = counter.segments(render(body));
  const total = counter.countSegments(segments);
  return { perMessage, overhead: total - perMessage.reduce((x, y) => x + y, 0), total, segments };
}

export interface CollectOptions {
  counter: PromptCounter;
  facts: readonly FactSpec[];
  /** client step count per session (the scenario's) */
  steps: Record<string, number>;
  /** per-message measure of a body in the mock's render (default: the sim render) */
  measure?: (body: RenderBody) => MessageMeasure;
  /** compute lcpGlobal (default true) */
  global?: boolean;
  /** the session name of client records written without one (reference agent: the mock records "default") */
  defaultSession?: string;
}

function kindOf(x: unknown): ReqKind {
  return x === 'summarizer' || x === 'title' ? x : 'main';
}

/** Upstream records from mock.jsonl + reqs/. */
export function collectUpstream(runDir: string, o: CollectOptions, cache = new MessageInfoCache(o.facts)): UpstreamRec[] {
  const measure = o.measure ?? ((b: RenderBody) => measureSim(o.counter, b));
  const recs = readJsonl(join(runDir, 'mock.jsonl'));
  const out: UpstreamRec[] = [];
  const prevOk = new Map<string, SegIndex>();
  const allOk: SegIndex[] = [];
  const idc = new IdCache(o.counter);
  for (const r of recs) {
    const file = r['body_file'] as string | undefined;
    if (!file) throw new Error(`${runDir}: mock record ${String(r['seq'])} has no body_file (run with bodies saved)`);
    const body = JSON.parse(readFileSync(join(runDir, file), 'utf8')) as RenderBody;
    const msgs = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
    const m = measure(body);
    const session = typeof r['session'] === 'string' ? (r['session'] as string) : (o.defaultSession ?? 'default');
    const kind = kindOf(r['kind']);
    const status = (r['status'] as number | undefined) ?? 0;
    const prompt = r['prompt_tokens'] as number;
    const streamError = r['stream_error'] === true;
    const ok = status === 200 && !streamError;
    let lcp = 0;
    let lcpGlobal: number | null = null;
    let idx: SegIndex | null = null;
    if (kind === 'main') {
      idx = segIndex(o.counter, m.segments);
      const prev = prevOk.get(session);
      if (ok && prev) lcp = lcpIndexed(o.counter, prev, idx, idc);
      if (ok && o.global !== false) {
        lcpGlobal = 0;
        for (const e of allOk) lcpGlobal = Math.max(lcpGlobal, lcpIndexed(o.counter, e, idx, idc));
      }
    }
    out.push({
      seq: r['seq'] as number,
      session,
      step: r['step'] as number,
      kind,
      status,
      rejected: r['rejected_for_length'] === true,
      prompt,
      ...(typeof r['hidden_overhead'] === 'number' && r['hidden_overhead'] ? { hidden: r['hidden_overhead'] as number } : {}),
      completion: (r['completion_tokens'] as number | undefined) ?? null,
      maxTokens: (r['max_tokens'] as number | undefined) ?? 0,
      bytes: ((r['body_bytes'] ?? r['body_chars']) as number | undefined) ?? 0,
      lcp,
      lcpGlobal: kind === 'main' && ok ? lcpGlobal : kind === 'main' ? 0 : null,
      digests: cache.digests(msgs),
      msgTokens: m.perMessage,
      overhead: prompt - m.perMessage.reduce((a, b) => a + b, 0),
      facts: cache.factsOf(msgs),
      pairingError: (r['pairing_error'] as string | null | undefined) ?? null,
      pairingStrict: strictPairingDefects(msgs),
      finishReason: (r['finish_reason'] as string | undefined) ?? null,
      ...(streamError ? { streamError: true } : {}),
    });
    if (ok && idx) {
      prevOk.set(session, idx);
      allOk.push(idx);
    }
  }
  return out;
}

/** Client records from client.jsonl + origs/ (the reference agent's layout: one session, origs/step{N}.json). */
export function collectClient(runDir: string, o: CollectOptions, cache = new MessageInfoCache(o.facts)): ClientRec[] {
  const recs = readJsonl(join(runDir, 'client.jsonl'));
  const out: ClientRec[] = [];
  const attempts = new Map<string, number>();
  for (const r of recs) {
    const step = r['step'] as number;
    const session = typeof r['session'] === 'string' ? (r['session'] as string) : (o.defaultSession ?? 'default');
    const kind = kindOf(r['kind']);
    const multi = Object.keys(o.steps).length > 1;
    const origName = typeof r['orig_file'] === 'string'
      ? (r['orig_file'] as string)
      : multi ? `origs/${session}_step${step}.json` : `origs/step${step}.json`;
    const p = join(runDir, origName);
    let msgs: unknown[] = [];
    let maxTokens: number | null = null;
    if (existsSync(p)) {
      const body = JSON.parse(readFileSync(p, 'utf8')) as Json;
      msgs = Array.isArray(body['messages']) ? (body['messages'] as unknown[]) : [];
      maxTokens = typeof body['max_tokens'] === 'number' ? (body['max_tokens'] as number) : null;
    }
    const key = `${session}\u0000${step}\u0000${kind}`;
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    const status = typeof r['status'] === 'number' ? (r['status'] as number) : null;
    const usage = r['usage'] as Json | undefined;
    const explicit = r['client_error_kind'];
    out.push({
      session, step, kind, attempt,
      digests: cache.digests(msgs),
      facts: cache.factsOf(msgs),
      prompt: typeof r['orig_qwen_tokens'] === 'number' ? (r['orig_qwen_tokens'] as number) : null,
      bytes: typeof r['req_bytes'] === 'number' ? (r['req_bytes'] as number) : null,
      status,
      clientErrorKind: explicit !== undefined ? ((explicit as string | null) ?? null) : status === 200 ? null : status === null ? 'transport' : `http_${status}`,
      usage: usage && typeof usage['prompt_tokens'] === 'number'
        ? { prompt: usage['prompt_tokens'] as number, completion: (usage['completion_tokens'] as number | undefined) ?? 0 }
        : null,
      maxTokens,
      pairingStrict: strictPairingDefects(msgs),
      errorBody: typeof r['error_body'] === 'string' ? (r['error_body'] as string) : null,
    });
  }
  return out;
}

export function collectRunDir(runDir: string, o: CollectOptions): RunRecords {
  const cache = new MessageInfoCache(o.facts);
  return { up: collectUpstream(runDir, o, cache), client: collectClient(runDir, o, cache), steps: { ...o.steps } };
}

/** Whether a run directory still holds its bodies. */
export function hasBodies(runDir: string): boolean {
  return existsSync(join(runDir, 'reqs')) && readdirSync(join(runDir, 'reqs')).length > 0;
}
