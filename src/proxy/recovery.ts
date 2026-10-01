// The per-request attempt ladder (DESIGN.md, §8, §9; ).
//
// runChat() turns one client chat request into at most errors.maxRetries + 1 upstream attempts:
//   attempt 1   the engine's output; on an engine exception or a failed guard the client's original
//               bytes, but only if serverFits(original, T_req) (or counting itself failed), else the
//               §5.7 400 without an upstream call (I7). An unsafe-integer body is never rewritten ().
//   attempt k+1 after a classified upstream error, per kind:
//     overflow_*            learn (validated window / prompt limit / correction, or the idempotent,
//                           capped tighten), persist, re-plan; if not strictly smaller, re-plan once
//                           more with the request-local extraTighten = budget − raw(rejected) + 256
//     max_tokens_too_large  same prompt, M = W − margin − tighten − ceil(raw·correction) if ≥ the
//                           clamp floor; else as overflow_unknown
//     payload_too_large     E.maxBodyBytes := min(E, floor(0.9 · rejected bytes)); the 413 goes back
//                           unchanged when the mandatory units' images alone exceed it; else re-plan
//     gateway_error / overflow_suspect   one request-local tightened retry, only near `hard`; the
//                           tighten is persisted after two distinct chains within 24 h both succeeded
//     unmatched 400/422/500 on a rewritten request ()   resend the original once if it fits, else
//                           a translated 400 context_length_exceeded
//     excluded              unchanged
//   an injected include_usage rejected (the stream_options exclusion, or any 4xx other than 429 whose
//   body names stream_options / include_usage) is retried once without the injection (not an attempt, )
// Every attempt k+1 is strictly smaller than attempt k (: raw < raw_k, or = and M < M_k; bytes ≤
// bytes_k, < for a 413) and never larger than the client's request; no attempt ≥ 2 is the original,
// except the  resend. When recovery ends, overflow kinds are translated for the client ().
//
// The I/O (engine, counter, upstream, state) is injected through LadderIO, so the ladder is tested
// without HTTP; src/proxy/server.ts supplies the streaming implementation.
import type { Config } from '../config/schema.js';
import type { ChatMessage, ChatRequest, EngineAction, EngineResult, ErrorKind, LearnedEntry, ProcessOptions, Usage } from '../types.js';
import type { ParsedRequest, ResponseTap } from '../dialect/dialect.js';
import {
  clientWantsUsage, contextLengthExceededBody, formatK, imageParts, isStreaming, requestBytes, requestMaxTokens,
  serializeChatRequest, withIncludeUsage, withMaxTokens,
} from '../dialect/openai-chat.js';
import { digestOf } from '../tokenize/canonical.js';
import { corrected, floorFrac, serverFits, serverLimits } from './budget.js';
import { ceil1pct, type CounterKind } from './calibration.js';
import {
  OVERFLOW_KINDS, STREAM_OPTIONS_EXCLUSION, TRANSLATED_KINDS, overshootOf, validateNumbers, type Classification, type ErrorClassifier,
} from './errors.js';

// ---------------------------------------------------------------- attempt sizes ()

/** a = (raw(a), bytes(a), M(a)): uncorrected tokens, §3 bytes, forwarded max_tokens. */
export interface AttemptSize {
  raw: number;
  bytes: number;
  maxTokens: number;
}

/** Attempt k+1 must be strictly smaller than attempt k (). */
export function strictlySmaller(next: AttemptSize, prev: AttemptSize, kind?: ErrorKind): boolean {
  const tokens = next.raw < prev.raw || (next.raw === prev.raw && next.maxTokens < prev.maxTokens);
  const bytes = kind === 'payload_too_large' ? next.bytes < prev.bytes : next.bytes <= prev.bytes;
  return tokens && bytes;
}

/** No attempt is larger than the client's request, in raw tokens or bytes (I7). */
export const withinOriginal = (a: AttemptSize, original: AttemptSize): boolean => a.raw <= original.raw && a.bytes <= original.bytes;

// ---------------------------------------------------------------- learning (§8, )

export interface LearnResult {
  entry: LearnedEntry;
  changed: boolean;
  /** the kind after validation: a refused window turns an overflow into overflow_unknown () */
  kind: ErrorKind;
  notes: string[];
}

const TIGHTEN_LOG_MAX = 32;
const ceil256 = (x: number): number => Math.ceil(x / 256) * 256;
const cloneEntry = (e: LearnedEntry): LearnedEntry => ({ ...e, tightenLog: [...e.tightenLog], ratios: [...e.ratios], pendingTighten: [...e.pendingTighten] });

/**
 * The overflow_unknown rule (§8), idempotent and capped:
 *   budget₀ = W − T_plan − margin; maxTighten = floor(maxTightenFraction · budget₀)
 *   E.tighten := min(maxTighten, max(E.tighten, ceil256(budget₀ − floor(0.95 · raw(rejected)))))
 * Each change appends {rule, at, rejectedRaw} to E.tightenLog.
 */
export function applyTighten(e: LearnedEntry, rejectedRaw: number, cfg: Config, rule: string, now: Date): { entry: LearnedEntry; changed: boolean } {
  const lim = serverLimits(cfg, e);
  const maxTighten = floorFrac(lim.budget0, cfg.errors.maxTightenFraction);
  const t = Math.max(0, Math.min(maxTighten, Math.max(e.tighten, ceil256(lim.budget0 - Math.floor(0.95 * rejectedRaw)))));
  if (t === e.tighten) return { entry: e, changed: false };
  const next = cloneEntry(e);
  next.tighten = t;
  next.tightenLog = [...e.tightenLog, { rule, at: now.toISOString(), rejectedRaw }].slice(-TIGHTEN_LOG_MAX);
  next.updatedAt = now.toISOString();
  return { entry: next, changed: true };
}

/**
 * What an overflow (or max_tokens_too_large) body teaches. Validated exact numbers set
 * E.window := min(E.window ?? budget.window, window) and raise the correction to ceil_1%(P / ours);
 * a lower-bound P only raises the correction; a server prompt limit sets E.maxPrompt; with no usable
 * limit number the overflow_unknown tighten applies. All corrections are capped per counter mode and
 * apply at once (no hysteresis).
 */
export function learnFromOverflow(e: LearnedEntry, c: Classification, rejectedRaw: number, cfg: Config, mode: CounterKind, now: Date): LearnResult {
  const v = validateNumbers(c, { configuredWindow: cfg.budget.window, rejectedRaw });
  let next = cloneEntry(e);
  let changed = false;
  const notes: string[] = [];
  let kind = c.kind;
  if (v.window !== null) {
    const w = Math.min(e.window ?? cfg.budget.window, v.window);
    if (w !== e.window) {
      next.window = w;
      changed = true;
      notes.push(`window ${w}`);
    }
  }
  if (v.maxPrompt !== null) {
    const p = Math.min(e.maxPrompt ?? Infinity, v.maxPrompt);
    if (p !== e.maxPrompt) {
      next.maxPrompt = p;
      changed = true;
      notes.push(`maxPrompt ${p}`);
    }
  }
  const p = v.promptExact ?? v.promptLowerBound;
  if (p !== null && rejectedRaw > 0) {
    const cand = Math.min(cfg.calibration.maxCorrection[mode], ceil1pct(p / rejectedRaw));
    if (cand > next.correction + 1e-9) {
      next.correction = cand;
      changed = true;
      notes.push(`correction ${cand}`);
    }
  }
  if (v.refused) {
    notes.push(`refused: ${v.refused}`);
    if (kind === 'overflow_prompt' || kind === 'overflow_total') kind = 'overflow_unknown';
  }
  const limitKnown = v.window !== null || v.maxPrompt !== null;
  if (!limitKnown && kind !== 'max_tokens_too_large') {
    const t = applyTighten(next, rejectedRaw, cfg, c.ruleId ?? kind, now);
    if (t.changed) {
      next = t.entry;
      changed = true;
      notes.push(`tighten ${next.tighten}`);
    }
  }
  if (changed) next.updatedAt = now.toISOString();
  return { entry: changed ? next : e, changed, kind, notes };
}

/** A 413 teaches a byte limit, never a token tighten (). */
export function learnFrom413(e: LearnedEntry, rejectedBytes: number, now: Date): { entry: LearnedEntry; changed: boolean } {
  const lim = Math.min(e.maxBodyBytes ?? Infinity, Math.floor(0.9 * rejectedBytes));
  if (lim === e.maxBodyBytes) return { entry: e, changed: false };
  return { entry: { ...cloneEntry(e), maxBodyBytes: lim, updatedAt: now.toISOString() }, changed: true };
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * A request-local tightened retry of an ambiguous error (gateway_error, overflow_suspect) succeeded.
 * The tighten is persisted only once two distinct chains did so within 24 h, with the overflow_unknown
 * rule and the smaller rejected raw count (); until then the success waits in E.pendingTighten.
 */
export function notePendingSuccess(e: LearnedEntry, chainKey: string, rejectedRaw: number, rule: string, cfg: Config, now: Date): { entry: LearnedEntry; changed: boolean; persisted: boolean } {
  const cutoff = now.getTime() - DAY_MS;
  const pending = e.pendingTighten.filter((p) => Date.parse(p.at) >= cutoff && p.chainKey !== chainKey);
  pending.push({ chainKey, at: now.toISOString(), rejectedRaw });
  let next: LearnedEntry = { ...cloneEntry(e), pendingTighten: pending, updatedAt: now.toISOString() };
  if (new Set(pending.map((p) => p.chainKey)).size >= 2) {
    const minRaw = Math.min(...pending.map((p) => p.rejectedRaw));
    next = applyTighten({ ...next, pendingTighten: [] }, minRaw, cfg, rule, now).entry;
    next.pendingTighten = [];
    return { entry: next, changed: true, persisted: true };
  }
  return { entry: next, changed: true, persisted: false };
}

/** M for a max_tokens_too_large retry: W − margin − tighten − ceil(raw · correction). */
export function maxTokensRetryValue(cfg: Config, e: LearnedEntry, extraTighten: number, rejectedRaw: number): number {
  const lim = serverLimits(cfg, e, extraTighten);
  return lim.window - lim.margin - lim.tighten - corrected(rejectedRaw, e.correction);
}

/**
 * Bytes of the image parts of a request's mandatory units: the newest assistant message and every
 * message after it (§5.1). If they alone exceed the learned byte limit, no re-plan can fit ().
 */
export function mandatoryImageBytes(req: ChatRequest): number {
  const msgs = req.messages;
  let start = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role === 'assistant') {
      start = i;
      break;
    }
  }
  let n = 0;
  if (start < 0) return 0;
  for (let i = start; i < msgs.length; i++) for (const p of imageParts(msgs[i] as ChatMessage)) n += Buffer.byteLength(JSON.stringify(p), 'utf8');
  return n;
}

// ---------------------------------------------------------------- the ladder

/** One upstream attempt. */
export interface OutgoingAttempt {
  /** attempt number (1-based); the include_usage and transport retries repeat it */
  n: number;
  /** the request that is sent */
  req: ChatRequest;
  /** its bytes (the client's own bytes when unchanged) */
  body: Buffer;
  /** the request and bytes before any include_usage injection ( retries without it) */
  baseReq: ChatRequest;
  baseBody: Buffer;
  /** the client's request (messages and max_tokens as sent; include_usage injection aside) */
  original: boolean;
  injectedUsage: boolean;
  /** the engine result it came from; null when the original is forwarded without one */
  result: EngineResult | null;
  /** request-local extra tighten it was planned with */
  extraTighten: number;
  /** computed on demand */
  size?: AttemptSize;
}

/** An upstream error not yet written to the client. */
export interface ErrorOutcome {
  type: 'error';
  /** effective status (in-stream: the status the event carries) */
  status: number;
  httpStatus: number;
  statusMessage: string;
  /** upstream response headers (flat rawHeaders form) */
  headers: string[];
  /** the HTTP error body, or the in-stream event payload */
  body: Buffer;
  inStream: boolean;
  /** the client's response headers were already sent (hold timed out, or a retry after one) */
  committed: boolean;
  /** in-stream: the bytes that relay the error unchanged (held comments, the event, the stream tail) */
  streamBytes?: Buffer;
  upstreamMs: number;
}

export type AttemptOutcome =
  | { type: 'ok'; status: number; tap: ResponseTap; complete: boolean; upstreamMs: number }
  | ErrorOutcome
  | { type: 'unavailable'; committed: boolean; error: string; upstreamMs: number }
  | { type: 'aborted'; upstreamMs: number };

/** What the server writes when the ladder ends. */
export type Final =
  | { type: 'relayed' }
  | { type: 'aborted' }
  | { type: 'relay'; error: ErrorOutcome }
  | { type: 'generated'; status: number; body: Buffer; overflow: boolean; message: string }
  | { type: 'unavailable'; committed: boolean };

export interface AttemptLog {
  attempt: OutgoingAttempt;
  status: number | null;
  kind: ErrorKind | 'ok';
  inStream: boolean;
  upstreamMs: number;
  overshoot?: number;
  ruleId?: string;
}

export interface ChatResult {
  final: Final;
  /** action of the result whose request reached the upstream last (else the first result's) */
  action: EngineAction;
  first: EngineResult | null;
  last: EngineResult | null;
  attempts: AttemptLog[];
  /** the attempt whose response went to the client */
  sent: OutgoingAttempt | null;
  tap: ResponseTap | null;
  complete: boolean;
  guard?: string;
  reason?: string;
  rewriteRejected?: { ruleId: string; status: number };
  /** any engine result of this request compacted */
  compacted: boolean;
  /** the  resend of the original happened */
  originalResent: boolean;
  engineMs: number;
}

export interface LadderIO {
  /** sends one attempt; on success the response has been relayed to the client */
  send(a: OutgoingAttempt): Promise<AttemptOutcome>;
  /** the client went away */
  aborted(): boolean;
  /** raw count of a request (throws when counting fails, e.g. a template error) */
  count(req: ChatRequest): number;
  /** the current learned entry of this request's key */
  learned(): LearnedEntry;
  /** persists (atomically, before returning) and applies a learned entry */
  saveLearned(e: LearnedEntry): void;
  /** engine.process (may throw) */
  process(req: ChatRequest, opts: ProcessOptions): EngineResult;
  now(): Date;
  onRewriteRejected?(ruleId: string, status: number): void;
}

export interface LadderInput {
  cfg: Config;
  parsed: ParsedRequest;
  classifier: ErrorClassifier;
  counterMode: CounterKind;
  shadow: boolean;
}

/** The kitzur message of a translated overflow (numbers per §5.7; never a client retry run). */
export function overflowMessage(countTokens: number | null, window: number): string {
  const need = countTokens !== null && Number.isFinite(countTokens) ? `about ${formatK(countTokens)} prompt tokens` : 'a prompt';
  return `kitzur: the model server rejected ${need} as too long for its context window (about ${formatK(window)} tokens), even after compaction. Compact the conversation or start a new session.`;
}

/** The §5.7 (c) message for a request the proxy refuses itself. */
export function refuseMessage(countTokens: number, fit: number, window: number, reply: number): string {
  const need = Number.isFinite(countTokens) ? `needs about ${formatK(countTokens)} tokens, but ` : 'does not fit: ';
  return `kitzur: this request ${need}at most ${formatK(Math.max(0, fit))} fit in this model's window (${formatK(window)}) after reserving ${formatK(reply)} for the reply. Compact the conversation or start a new session.`;
}

/** An error body that names the injected field (). */
const USAGE_FIELD = /stream_options|include_usage/;

const NO_FORWARD: ReadonlySet<EngineAction> = new Set<EngineAction>(['impossible', 'guard_reject', 'guard_fallback', 'shadow']);

export async function runChat(inp: LadderInput, io: LadderIO): Promise<ChatResult> {
  const { cfg, parsed } = inp;
  const orig = parsed.req;
  const tReq = requestMaxTokens(orig, cfg.budget.defaultMaxTokens);
  const out: ChatResult = {
    final: { type: 'relayed' }, action: 'passthrough', first: null, last: null, attempts: [], sent: null, tap: null,
    complete: false, compacted: false, originalResent: false, engineMs: 0,
  };

  // -------------------------------------------------------- sizes
  // bytes() walks tools recursively (canonicalJSON): a pathologically deep body overflows the stack.
  // That is a counting failure (NaN blocks every size-based retry), never an internal error (I7).
  const bytesOf = (r: ChatRequest): number => {
    try {
      return requestBytes(r);
    } catch {
      return NaN;
    }
  };
  const sizeOf = (a: OutgoingAttempt): AttemptSize => {
    if (!a.size) {
      let raw = NaN;
      try {
        raw = io.count(a.req);
      } catch {
        /* counting failed: NaN blocks every size-based retry */
      }
      a.size = { raw, bytes: bytesOf(a.req), maxTokens: requestMaxTokens(a.req, cfg.budget.defaultMaxTokens) };
    }
    return a.size;
  };
  let origSize: AttemptSize | null = null;
  const originalSize = (): AttemptSize => {
    if (!origSize) {
      let raw = NaN;
      try {
        raw = io.count(orig);
      } catch {
        /* counting failed */
      }
      origSize = { raw, bytes: bytesOf(orig), maxTokens: tReq };
    }
    return origSize;
  };
  /** serverFits(original, T_req); null when counting failed */
  const originalFits = (e: LearnedEntry): boolean | null => {
    const s = originalSize();
    if (!Number.isFinite(s.raw)) return null;
    return serverFits(corrected(s.raw, e.correction), tReq, serverLimits(cfg, e));
  };
  const refuse = (e: LearnedEntry): Final => {
    const lim = serverLimits(cfg, e);
    const count = corrected(originalSize().raw, e.correction);
    const fit = lim.window - lim.margin - lim.tighten - (lim.mode === 'strict_total' ? tReq : lim.mode === 'tgi' ? Math.min(tReq, 1024) : 0);
    const message = refuseMessage(count, fit, lim.window, tReq);
    return { type: 'generated', status: 400, body: contextLengthExceededBody(message), overflow: true, message };
  };

  // -------------------------------------------------------- attempts
  const injectUsage = (a: OutgoingAttempt): OutgoingAttempt => {
    // never into an unsafe-integer body: the injection re-serializes it and would change the number ()
    if (inp.shadow || parsed.unsafeInteger || !cfg.stream.injectIncludeUsage || !isStreaming(a.req) || clientWantsUsage(a.req) || io.learned().includeUsageRejected) return a;
    const req = withIncludeUsage(a.baseReq);
    return { ...a, req, body: serializeChatRequest(req), injectedUsage: true, size: undefined };
  };
  const makeAttempt = (n: number, req: ChatRequest, body: Buffer, original: boolean, result: EngineResult | null, extraTighten: number): OutgoingAttempt =>
    injectUsage({ n, req, body, baseReq: req, baseBody: body, original, injectedUsage: false, result, extraTighten });
  const originalAttempt = (n: number, result: EngineResult | null): OutgoingAttempt => makeAttempt(n, orig, parsed.raw, true, result, 0);
  const fromResult = (r: EngineResult, n: number, extraTighten: number): OutgoingAttempt | null => {
    if (!r.request || NO_FORWARD.has(r.action)) return null;
    let req = r.request;
    let changed = r.changed;
    if (r.maxTokens) {
      const mt = r.maxTokens;
      const fields = mt.fields.length ? mt.fields : (['max_tokens'] as const);
      if (fields.some((f) => req[f] !== mt.value)) {
        req = withMaxTokens(req, mt.value, mt.fields);
        changed = true;
      }
    }
    if (!changed) return makeAttempt(n, orig, parsed.raw, true, r, extraTighten);
    return makeAttempt(n, req, serializeChatRequest(req), false, r, extraTighten);
  };
  const process = (opts: ProcessOptions): EngineResult | null => {
    const t0 = performance.now();
    try {
      const r = io.process(orig, opts);
      if (r.action === 'compact') out.compacted = true;
      return r;
    } catch {
      return null;
    } finally {
      out.engineMs += performance.now() - t0;
    }
  };

  // -------------------------------------------------------- attempt 1
  let E = io.learned();
  let cur: OutgoingAttempt;
  if (inp.shadow) {
    // shadow mode is transparent: the original bytes go out whatever the engine (or ) would do
    if (parsed.unsafeInteger) out.reason = 'unsafe_integer';
    const t0 = performance.now();
    try {
      out.first = io.process(orig, { attempt: 1, learned: E });
    } catch (e) {
      out.reason = `engine: ${e instanceof Error ? e.name : 'error'}`;
    }
    out.engineMs += performance.now() - t0;
    out.action = 'shadow';
    cur = originalAttempt(1, out.first);
  } else if (parsed.unsafeInteger) {
    // : never rewritten; forwarded unchanged only if it fits the server limit
    out.reason = 'unsafe_integer';
    if (originalFits(E) === false) {
      out.action = 'guard_reject';
      out.guard = 'unsafe_integer';
      out.final = refuse(E);
      return out;
    }
    cur = originalAttempt(1, null);
  } else {
    let r: EngineResult | null = null;
    const t0 = performance.now();
    try {
      r = io.process(orig, { attempt: 1, learned: E });
    } catch (e) {
      out.guard = `engine:${e instanceof Error ? e.name : 'error'}`;
    }
    out.engineMs += performance.now() - t0;
    out.first = r;
    out.last = r;
    if (r?.action === 'compact') out.compacted = true;
    if (!r) {
      // I7: the original only if it fits the server limit, or if counting itself failed
      if (originalFits(E) === false) {
        out.action = 'guard_reject';
        out.final = refuse(E);
        return out;
      }
      out.action = 'guard_fallback';
      cur = originalAttempt(1, null);
    } else if (r.action === 'impossible' || r.action === 'guard_reject') {
      out.action = r.action;
      if (r.stats.guard) out.guard = r.stats.guard;
      if (r.reason) out.reason = r.reason;
      if (r.error) {
        const body = Buffer.from(JSON.stringify(r.error.body), 'utf8');
        const code = (r.error.body as { error?: { code?: unknown } } | null)?.error?.code;
        out.final = { type: 'generated', status: r.error.status, body, overflow: code === 'context_length_exceeded', message: '' };
      } else {
        out.final = refuse(E);
      }
      return out;
    } else if (r.action === 'guard_fallback') {
      out.action = 'guard_fallback';
      out.guard = r.stats.guard ?? r.reason ?? 'guard';
      // I7 belt and braces: the original goes out only if it fits the server limit (or counting failed)
      if (originalFits(E) === false) {
        out.action = 'guard_reject';
        out.final = refuse(E);
        return out;
      }
      cur = originalAttempt(1, r);
    } else {
      out.action = r.action;
      const a = fromResult(r, 1, 0);
      if (!a) {
        out.action = 'guard_fallback';
        out.guard = 'engine:no_request';
        if (originalFits(E) === false) {
          out.action = 'guard_reject';
          out.final = refuse(E);
          return out;
        }
        cur = originalAttempt(1, r);
      } else {
        cur = a;
      }
    }
  }

  // -------------------------------------------------------- the loop
  const maxAttempts = cfg.errors.maxRetries + 1;
  let k = 1;
  let usageRetried = false;
  let ambiguousTries = 0;
  let pending: { chainKey: string; rejectedRaw: number; rule: string } | null = null;

  const candidateOK = (a: OutgoingAttempt | null, rejected: AttemptSize, kind: ErrorKind): a is OutgoingAttempt => {
    if (!a || a.original) return false; // never the original on a retry ()
    const s = sizeOf(a);
    return Number.isFinite(s.raw) && strictlySmaller(s, rejected, kind) && withinOriginal(s, originalSize());
  };
  const finalFor = (c: Classification, err: ErrorOutcome, lastSent: OutgoingAttempt): Final => {
    if (cfg.errors.translateForClient && TRANSLATED_KINDS.has(c.kind)) {
      const e = io.learned();
      const s = sizeOf(lastSent);
      const message = overflowMessage(Number.isFinite(s.raw) ? corrected(s.raw, e.correction) : null, e.window ?? cfg.budget.window);
      return { type: 'generated', status: 400, body: contextLengthExceededBody(message), overflow: true, message };
    }
    return { type: 'relay', error: err };
  };

  /** re-plan after an overflow (the learned entry is already updated) */
  const replan = (rejected: AttemptSize, kind: ErrorKind): OutgoingAttempt | Final | null => {
    E = io.learned();
    let r = process({ attempt: k + 1, learned: E });
    if (r && r.action === 'impossible' && r.impossibleKind === 'fixed' && r.error) {
      return { type: 'generated', status: r.error.status, body: Buffer.from(JSON.stringify(r.error.body), 'utf8'), overflow: false, message: '' };
    }
    let a = r ? fromResult(r, k + 1, 0) : null;
    if (candidateOK(a, rejected, kind)) {
      out.last = r;
      return a;
    }
    const budgetU = r?.stats?.budget?.budget ?? serverLimits(cfg, E).budget;
    const xt = Math.max(0, budgetU - rejected.raw + 256);
    r = process({ attempt: k + 1, learned: E, extraTighten: xt });
    a = r ? fromResult(r, k + 1, xt) : null;
    if (candidateOK(a, rejected, kind)) {
      out.last = r;
      return a;
    }
    return null;
  };

  for (;;) {
    if (io.aborted()) {
      out.final = { type: 'aborted' };
      return out;
    }
    const res = await io.send(cur);
    const log: AttemptLog = { attempt: cur, status: null, kind: 'ok', inStream: false, upstreamMs: res.upstreamMs };
    out.attempts.push(log);

    if (res.type === 'ok') {
      log.status = res.status;
      out.sent = cur;
      out.tap = res.tap;
      out.complete = res.complete;
      out.final = { type: 'relayed' };
      if (pending) {
        const p = notePendingSuccess(io.learned(), pending.chainKey, pending.rejectedRaw, pending.rule, cfg, io.now());
        if (p.changed) io.saveLearned(p.entry);
      }
      return out;
    }
    if (res.type === 'aborted') {
      out.final = { type: 'aborted' };
      return out;
    }
    if (res.type === 'unavailable') {
      log.kind = 'unmatched';
      out.final = { type: 'unavailable', committed: res.committed };
      return out;
    }

    // ---------------------------------------------------- an upstream error
    const c = inp.classifier.classify({ status: res.status, body: res.body.toString('utf8'), inStream: res.inStream });
    log.status = res.status;
    log.kind = c.kind;
    log.inStream = res.inStream;
    if (c.ruleId) log.ruleId = c.ruleId;
    const ov = overshootOf(c);
    if (ov !== undefined) log.overshoot = ov;
    pending = null;

    if (inp.shadow) {
      out.final = { type: 'relay', error: res };
      return out;
    }
    // : an injected include_usage the server rejects. Besides the built-in exclusion, any 4xx (not 429)
    // naming stream_options / include_usage counts: the field is ours, and servers word the rejection
    // differently (pydantic `extra_forbidden` 422s, "Unrecognized request argument supplied: stream_options",
    // in-stream errors). Without this the client got an error its own request never caused.
    const usageRejected = cur.injectedUsage && !usageRetried &&
      (c.ruleId === STREAM_OPTIONS_EXCLUSION || (res.status >= 400 && res.status < 500 && res.status !== 429 && USAGE_FIELD.test(res.body.toString('utf8'))));
    if (usageRejected) {
      usageRetried = true;
      io.saveLearned({ ...io.learned(), includeUsageRejected: true, updatedAt: io.now().toISOString() });
      cur = { ...cur, req: cur.baseReq, body: cur.baseBody, injectedUsage: false, size: undefined };
      continue;
    }
    if (c.kind === 'excluded') {
      if (c.ruleId === STREAM_OPTIONS_EXCLUSION && cur.injectedUsage && !usageRetried) {
        // : retry once without the injection; not an attempt, and remembered for this key
        usageRetried = true;
        io.saveLearned({ ...io.learned(), includeUsageRejected: true, updatedAt: io.now().toISOString() });
        cur = { ...cur, req: cur.baseReq, body: cur.baseBody, injectedUsage: false, size: undefined };
        continue;
      }
      out.final = { type: 'relay', error: res };
      return out;
    }
    const rejected = sizeOf(cur);
    let next: OutgoingAttempt | Final | null = null;
    const now = io.now();

    // Every rejection teaches (§8), whether or not a retry follows: the last attempt's rejection
    // (and every one with maxRetries 0) still updates the learned entry for the next request.
    let learnedKind: ErrorKind = c.kind;
    const overflowish = c.kind === 'max_tokens_too_large' || OVERFLOW_KINDS.has(c.kind);
    if (overflowish && Number.isFinite(rejected.raw)) {
      const L = learnFromOverflow(io.learned(), c, rejected.raw, cfg, inp.counterMode, now);
      if (L.changed) io.saveLearned(L.entry);
      if (L.kind !== c.kind) log.kind = learnedKind = L.kind;
    } else if (c.kind === 'payload_too_large') {
      const L = learnFrom413(io.learned(), rejected.bytes, now);
      if (L.changed) io.saveLearned(L.entry);
    }
    // : an unsafe-integer body is never rewritten, so no smaller retry exists
    if (k >= maxAttempts || parsed.unsafeInteger) {
      out.final = finalFor(c, res, cur);
      return out;
    }

    if (overflowish) {
      if (!Number.isFinite(rejected.raw)) {
        out.final = finalFor(c, res, cur);
        return out;
      }
      if (c.kind === 'max_tokens_too_large') {
        const e = io.learned();
        const M = maxTokensRetryValue(cfg, e, cur.extraTighten, rejected.raw);
        if (M >= cfg.budget.maxTokensClamp.floorTokens && M < rejected.maxTokens) {
          const req = withMaxTokens(cur.baseReq, M);
          const a = makeAttempt(k + 1, req, serializeChatRequest(req), false, cur.result, cur.extraTighten);
          if (candidateOK(a, rejected, c.kind)) next = a;
        }
        if (!next) {
          // treated as overflow_unknown: the tighten rule, then a re-plan
          const t = applyTighten(io.learned(), rejected.raw, cfg, c.ruleId ?? c.kind, now);
          if (t.changed) io.saveLearned(t.entry);
          next = replan(rejected, 'overflow_unknown');
        }
      } else {
        next = replan(rejected, learnedKind);
      }
    } else if (c.kind === 'payload_too_large') {
      const limit = io.learned().maxBodyBytes ?? Infinity;
      if (mandatoryImageBytes(cur.req) > limit) {
        out.final = { type: 'relay', error: res }; // OpenCode strips the media on a 413 ()
        return out;
      }
      const r = process({ attempt: k + 1, learned: io.learned() });
      const a = r ? fromResult(r, k + 1, 0) : null;
      if (candidateOK(a, rejected, c.kind)) {
        out.last = r;
        next = a;
      }
    } else if (c.kind === 'gateway_error' || c.kind === 'overflow_suspect') {
      E = io.learned();
      const lim = serverLimits(cfg, E, cur.extraTighten);
      const hard = cur.result?.stats?.budget?.hard ?? lim.hard;
      // The first ambiguous retry needs the rejected request to have been near `hard`; later ones (up to
      // errors.maxRetries) follow a rejected tightened retry and shrink geometrically: 0.9^(n-1) of the last
      // rejected size, minus 256. Never larger, never the original; capped at maxTightenFraction of the budget
      // below the first rejection.
      const near = Number.isFinite(rejected.raw) && rejected.raw >= cfg.errors.nearBudgetFraction * hard;
      if (ambiguousTries < cfg.errors.maxRetries && Number.isFinite(rejected.raw) && (ambiguousTries > 0 || near)) {
        const budget = serverLimits(cfg, E).budget;
        const goal = Math.floor(rejected.raw * Math.pow(0.9, ambiguousTries)) - 256;
        ambiguousTries++;
        const xt = Math.min(Math.max(0, budget - goal), Math.ceil(budget * Math.max(cfg.errors.maxTightenFraction, 0.2) * 2));
        const r = process({ attempt: k + 1, learned: E, extraTighten: xt });
        const a = r ? fromResult(r, k + 1, xt) : null;
        if (candidateOK(a, rejected, c.kind)) {
          out.last = r;
          next = a;
          pending = { chainKey: digestOf(orig.messages), rejectedRaw: rejected.raw, rule: c.ruleId ?? c.kind };
        }
      }
    } else if (c.kind === 'unmatched' && [400, 422, 500].includes(res.status) && !cur.original) {
      // : an error the rewrite may have caused is not made permanent
      const ruleId = c.ruleId ?? 'unmatched';
      out.rewriteRejected = { ruleId, status: res.status };
      io.onRewriteRejected?.(ruleId, res.status);
      if (!out.originalResent && originalFits(io.learned()) === true) {
        out.originalResent = true;
        next = originalAttempt(k + 1, null);
      } else {
        const e = io.learned();
        const s = originalSize();
        const message = overflowMessage(Number.isFinite(s.raw) ? corrected(s.raw, e.correction) : null, e.window ?? cfg.budget.window);
        next = { type: 'generated', status: 400, body: contextLengthExceededBody(message), overflow: true, message };
      }
    }

    if (!next) {
      out.final = finalFor(c, res, cur);
      return out;
    }
    if (!('n' in next)) {
      out.final = next;
      return out;
    }
    if (next.result && !next.original) out.action = next.result.action;
    cur = next;
    k++;
  }
}

/** AttemptRecord for stats (sizes computed now, after the response: off the latency path). */
export function attemptRecords(r: ChatResult, count: (req: ChatRequest) => number, cfg: Config): Array<{
  status: number | null; kind: ErrorKind | 'ok'; inStream: boolean; raw: number; bytes: number; maxTokens: number; overshoot?: number; upstreamMs: number;
}> {
  return r.attempts.map((l) => {
    const a = l.attempt;
    if (!a.size) {
      let raw = NaN;
      try {
        raw = count(a.req);
      } catch {
        /* counting failed */
      }
      a.size = { raw, bytes: NaN, maxTokens: requestMaxTokens(a.req, cfg.budget.defaultMaxTokens) }; // bytes() not needed here
    }
    // bytes: what was actually sent (the §3 bytes() of the size order is used only inside the ladder)
    const rec: { status: number | null; kind: ErrorKind | 'ok'; inStream: boolean; raw: number; bytes: number; maxTokens: number; overshoot?: number; upstreamMs: number } = {
      status: l.status, kind: l.kind, inStream: l.inStream, raw: Number.isFinite(a.size.raw) ? a.size.raw : -1, bytes: a.body.length,
      maxTokens: a.size.maxTokens, upstreamMs: Math.round(l.upstreamMs * 10) / 10,
    };
    if (l.overshoot !== undefined) rec.overshoot = l.overshoot;
    return rec;
  });
}

/** Usage of the attempt that reached the client, if any. */
export const usageOf = (r: ChatResult): Usage | null => r.tap?.usage ?? null;
