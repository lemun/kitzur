// In-process port of reference-harness sim/mock_server.py: an OpenAI-compatible Chat Completions mock
// with a hard context limit. Behaviour is byte-for-byte the Python mock's (reference implementation,
// reference implementation):
//
//  - any POST path; the scripted reply is chosen by the `x-sim-step` header (missing = step -1);
//  - `seq` counts every request (rejected ones too); prompt tokens are counted BEFORE any check with the
//    mock's own counter (bench/lib/render.ts) over scenario.render();
//  - pairing check first (400 invalid_request_error), then the length check `prompt + max_tokens > limit`
//    (strict) with one of the registered error styles; errors are JSON even for stream requests;
//  - 200: stream => one HTTP chunk per SSE event (full tool call in one delta, `index` last), a finish
//    chunk, a usage chunk only when stream_options.include_usage is truthy, `data: [DONE]`; non-stream =>
//    one JSON body. All JSON is Python json.dumps default (ASCII-escaped, spaced separators).
//  - one JSONL record per request in <outDir>/mock.jsonl with Python's fields in Python's order, then the
//    harness extras: session (x-sim-session header or "default"), lcp_tokens / lcp_ok_tokens (token LCP
//    of the rendered prompt with the previous request / previous accepted request of the same session),
//    body_bytes, body_file (when bodies are saved, as reqs/{seq:04d}_step{step}.json like Python).
//
// Deliberate differences from the Python process (none changes any recorded number):
//  - Node's HTTP layer adds `Date`/`Connection`/`Keep-Alive` headers and no `Server: BaseHTTP/...`;
//    reason phrases follow Python's table (e.g. 422 "Unprocessable Content");
//  - an unknown error style fails at construction, not at the first rejection;
//  - requests Python would crash on (unparseable JSON, bad x-sim-step, a None id mixed with str ids in
//    the pairing sort) get their socket destroyed without a response, which is what a Python client sees.
//
// Extension hooks (defaults reproduce mock_server.py): `errorStyle` names an entry of ERROR_STYLES
// (registerErrorStyle adds more), `window` replaces the limit check, `usage` forces the usage chunk on
// or off, `streamError` injects an in-stream error event after HTTP 200, `reply` replaces the scripted turn.
//
// ---- bench/README.md extensions (§2 MockOptions, §3, §7) ----
//
// Routing (always active): `x-sim-kind: summarizer | title` gets a deterministic placeholder with no tool call
// (bench/mock/completion.ts; `x-sim-summary: baseline | template` overrides the placeholder style per request; a
// scenario's own F10 client summary, `clientCompact.summaryText`, is returned at its `atStep`, and generated
// placeholders then never plant its client-summary markers);
// `x-sim-scenario` selects a registered ScenarioSpec (`scenarios` option / registerScenario) and `x-sim-session` its
// session, whose assistantAt(step) is the reply. Without x-sim-scenario the reply is the Python reference's.
//
// SPEC mode (`spec: Partial<MockOptions>`, even `{}`): render 'sim' | 'qwen3' (bench/mock/qwen3-render.ts; a
// template/validation error is a vLLM-style 400), limitMode strict_total | prompt_only | tgi | silent_truncate
// against the real limit W − limitSkewTokens, hiddenOverheadTokens (count, limit check and usage), the §7 error
// styles (bench/mock/styles.ts; MockOptions.errorStyle is an ErrorStyleId), inStreamErrors, usage, the completion
// model with generation capped at min(max_tokens, window room) → finish_reason "length", maxBodyBytes → nginx 413,
// headerDelayMs before a rejection's status line (late400 defaults to 20 s).
//
// Records: in SPEC mode and for scenario-routed requests, `facts` is keyed by the scenario's FactSpec markers
// (the 7 reference markers only for the reference scenario), and the record adds `kind`, `scenario`,
// `pairing_strict` (bench/lib/pairing-strict.ts defect set), `finish_reason`, and when relevant `reasoning_tokens`,
// `hidden_overhead`, `server_prompt_tokens` / `truncated_messages` (silent_truncate), `reject_reason`
// (tokens | bytes), `error_status` (the status inside an in-stream error), `template_error`. Python mode records
// are unchanged (plus `kind` when the request carries x-sim-kind).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { ChatMessage, ToolCall } from '../../src/types.js';
import type { MockOptions, ScenarioSpec } from '../scenarios/types.js';
import { pyDumps, pyFloat } from '../lib/pyjson.js';
import { contentText, type PromptCounter, type RenderBody, type Segments } from '../lib/render.js';
import { checkPairing } from '../lib/pairing.js';
import { strictPairingDefects } from '../lib/pairing-strict.js';
import { assistantMessage, FACT_KEYS, pad4, pyInt, SUMMARY_HEADER, type ScenarioOptions } from '../scenarios/reference.js';
import {
  ALWAYS_IN_STREAM, DEFAULT_HEADER_DELAY_MS, ERROR_STYLES, PAYLOAD_TOO_LARGE, PYTHON_STYLES, resolveErrorStyle, STYLE_LIMIT_MODE,
  type ErrorResponse, type ErrorStyle, type LimitMode,
} from './styles.js';
import { renderQwen3 } from './qwen3-render.js';
import {
  capTurn, expandTurn, plantPositions, simCompletion, summaryPlaceholder, TITLE_PLACEHOLDER, type GeneratedTurn, type ScriptedTurn,
} from './completion.js';

export { ERROR_STYLES, registerErrorStyle, resolveErrorStyle } from './styles.js';
export type { ErrorResponse, ErrorStyle, LengthErrorContext } from './styles.js';

type Json = Record<string, unknown>;
const isDict = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Python truthiness of a JSON value. */
export const pyTruthy = (v: unknown): boolean =>
  !(v === null || v === undefined || v === false || v === 0 || v === '' || (Array.isArray(v) && !v.length) || (isDict(v) && !Object.keys(v).length));

/** Python int(x) for the JSON values max_tokens may hold. */
function pyIntOf(v: unknown): number {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return pyInt(v);
  throw new TypeError(`int() argument must be a string or a number, not ${typeof v}`);
}

/** CPython http.HTTPStatus phrases (3.14) for the statuses the mock can send. */
const PY_REASON: Record<number, string> = {
  200: 'OK', 400: 'Bad Request', 404: 'Not Found', 408: 'Request Timeout', 413: 'Content Too Large',
  422: 'Unprocessable Content', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout',
};

// ---------------------------------------------------------------- records

export type RequestKind = 'main' | 'summarizer' | 'title';

export interface MockRecord {
  seq: number;
  step: number;
  /** time.time() at record creation (seconds, float) */
  ts: number;
  prompt_tokens: number;
  max_tokens: number;
  n_messages: number;
  has_summary: boolean;
  facts: Record<string, boolean>;
  /** len(raw): request body BYTES */
  body_chars: number;
  pairing_error: string | null;
  status?: number;
  rejected_for_length?: true;
  completion_tokens?: number;
  // ---- harness extras (not in the Python mock)
  session?: string;
  lcp_tokens?: number;
  lcp_ok_tokens?: number;
  body_bytes?: number;
  body_file?: string;
  stream_error?: true;
  // ---- SPEC extras (SPEC mode / scenario-routed requests; `kind` also whenever x-sim-kind is sent)
  kind?: RequestKind;
  scenario?: string | null;
  pairing_strict?: string[];
  finish_reason?: string;
  reasoning_tokens?: number;
  hidden_overhead?: number;
  server_prompt_tokens?: number;
  truncated_messages?: number;
  reject_reason?: 'tokens' | 'bytes';
  error_status?: number;
  template_error?: string;
}

/** Serialize a record exactly like `json.dumps(rec)` (ts as a Python float). */
export function mockRecordLine(rec: MockRecord): string {
  return pyDumps({ ...rec, ts: pyFloat(rec.ts) });
}

// ---------------------------------------------------------------- options

export interface StreamErrorContext {
  seq: number;
  step: number;
  prompt: number;
  body: RenderBody;
}
/** An SSE event to send after HTTP 200 instead of the scripted reply. */
export interface StreamErrorInjection {
  event: unknown;
  /** also send `data: [DONE]` after the error event (default false) */
  done?: boolean;
}

export interface WindowCheck {
  limit: number;
  /** true = reject. Default: prompt + max_tokens > limit (vLLM style, strict). */
  overLimit?: (prompt: number, maxTokens: number, limit: number, body: RenderBody) => boolean;
}

export interface MockServerOptions {
  counter: PromptCounter;
  /** directory for mock.jsonl (appended, like Python) and reqs/; null = in-memory records only */
  outDir?: string | null;
  /** --limit (default 100000) = the window W; ignored when `window` is given */
  limit?: number;
  /** --error-style registry key (default 'vllm'); `spec.errorStyle` (an ErrorStyleId) wins */
  errorStyle?: string;
  /** the SIM_* knobs; SIM_CHATTY matters here because assistant_message() runs in the mock */
  scenario?: ScenarioOptions;
  /** save every request body to reqs/{seq:04d}_step{step}.json (default: true when outDir is set) */
  saveBodies?: boolean;
  host?: string;
  // ---- extension hooks
  window?: WindowCheck;
  /** 'client' (default): usage chunk iff stream_options.include_usage; 'never' / 'always' override */
  usage?: 'client' | 'never' | 'always';
  streamError?: (ctx: StreamErrorContext) => StreamErrorInjection | null;
  /** the assistant turn for a step (default: scenario assistant_message(step)) */
  reply?: (step: number, body: RenderBody) => { role: string; content: string | null; tool_calls: unknown[] };
  onRecord?: (rec: MockRecord) => void;
  // ---- bench/README.md
  /** benchmark contract MockOptions; its presence (even `{}`) switches on SPEC mode */
  spec?: Partial<MockOptions>;
  /** ScenarioSpecs served by x-sim-scenario */
  scenarios?: Iterable<ScenarioSpec>;
  /** summarizer placeholder size (default 1500 tokens, baseline.py's summary_tokens) */
  summaryTokens?: number;
  /** summarizer placeholder style (default 'template'); the x-sim-summary header overrides it per request */
  summaryStyle?: 'template' | 'baseline';
  /** delta / message field that carries reasoning (default 'reasoning_content', llama.cpp / vLLM ≤0.15) */
  reasoningField?: 'reasoning_content' | 'reasoning';
  /**
   * The summary to return for a summarizer request (null = the generated placeholder). Default: a scenario that
   * carries `clientCompact: {atStep, summaryText}` (bench/scenarios ScenarioDef, F10) gets its summaryText for the
   * summarizer request of step atStep.
   */
  summaryFor?: (ctx: { scenario: ScenarioSpec | null; session: string; step: number }) => string | null;
}

/** F10: the client's own summary a scenario may carry (bench/scenarios/common.ts ScenarioDef.clientCompact). */
function scenarioSummary(scen: ScenarioSpec | null, step: number): string | null {
  const cc = (scen as { clientCompact?: { atStep?: unknown; summaryText?: unknown } } | null)?.clientCompact;
  return cc && cc.atStep === step && typeof cc.summaryText === 'string' ? cc.summaryText : null;
}

/**
 * Whether the scenario carries its own client summary (clientCompact.summaryText). Its client-summary markers then live
 * in THAT text only: a generated placeholder (any other summarizer request, e.g. an overflow compaction of the OpenCode
 * client before the scripted one) must not plant them, or they would appear before the client compaction that
 * introduces them. They are listed like any other marker when the request shows them (after the scripted summary).
 */
function ownsClientSummary(scen: ScenarioSpec | null): boolean {
  const cc = (scen as { clientCompact?: { summaryText?: unknown } } | null)?.clientCompact;
  return !!cc && typeof cc.summaryText === 'string';
}

interface SessionState {
  prev: Segments | null;
  prevOk: Segments | null;
}

class CrashLikePython extends Error {}

type OverLimit = (prompt: number, maxTokens: number, limit: number, body: RenderBody) => boolean;

/** The limit check of each MockOptions.limitMode (benchmark contract ). */
export function limitCheck(mode: LimitMode, python: boolean): OverLimit {
  switch (mode) {
    case 'prompt_only':
      return (p, _m, l) => p >= l;
    case 'tgi':
      return (p, m, l) => p + (m > 0 ? Math.min(m, 1024) : 0) > l || p > l - 1;
    case 'silent_truncate':
      return () => false;
    case 'strict_total':
    default:
      // vLLM: with no max_tokens the prompt must leave room for one token; the Python mock checks p + m > l only
      return python ? (p, m, l) => p + m > l : (p, m, l) => p + Math.max(m, 1) > l;
  }
}

/** hiddenOverheadTokens → the tokens added to a count. */
export function overheadOf(h: MockOptions['hiddenOverheadTokens'] | undefined, count: number): number {
  if (h === undefined) return 0;
  if (typeof h === 'number') return Math.max(0, Math.round(h));
  const pct = Number(h.slice(0, -1));
  if (!Number.isFinite(pct)) throw new Error(`bad hiddenOverheadTokens ${h}`);
  return Math.max(0, Math.ceil((count * pct) / 100));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class MockServer {
  readonly records: MockRecord[] = [];
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private seq = 0;
  private readonly sessions = new Map<string, SessionState>();
  private readonly style: ErrorStyle;
  private readonly styleKey: string;
  private readonly window: WindowCheck;
  private readonly logPath: string | null;
  private readonly reqsDir: string | null;
  private readonly scenarios = new Map<string, ScenarioSpec>();
  private readonly specMode: boolean;
  private readonly limitMode: LimitMode;
  private readonly overLimit: OverLimit;
  /** requests that crashed the Python handler (no response sent) */
  crashes = 0;
  port = 0;

  constructor(private readonly o: MockServerOptions) {
    const spec = o.spec;
    this.specMode = spec !== undefined;
    const styleName = spec?.errorStyle !== undefined ? resolveErrorStyle(spec.errorStyle) : (o.errorStyle ?? 'vllm');
    const style = ERROR_STYLES.get(styleName);
    if (!style) throw new Error(`unknown error style ${styleName} (have: ${[...ERROR_STYLES.keys()].join(', ')})`);
    this.style = style;
    this.styleKey = styleName;
    const w = o.window?.limit ?? o.limit ?? 100_000;
    this.window = o.window ?? { limit: w - (spec?.limitSkewTokens ?? 0) };
    this.limitMode = spec?.limitMode ?? STYLE_LIMIT_MODE.get(styleName) ?? 'strict_total';
    this.overLimit = o.window?.overLimit ?? limitCheck(this.specMode ? this.limitMode : 'strict_total', !this.specMode || PYTHON_STYLES.has(styleName));
    for (const s of o.scenarios ?? []) this.registerScenario(s);
    const out = o.outDir ?? null;
    this.logPath = out ? join(out, 'mock.jsonl') : null;
    this.reqsDir = out && (o.saveBodies ?? true) ? join(out, 'reqs') : null;
    if (out) mkdirSync(join(out, 'reqs'), { recursive: true }); // Python makes reqs/ unconditionally
  }

  registerScenario(s: ScenarioSpec): void {
    this.scenarios.set(s.id, s);
  }

  get styleName(): string {
    return this.styleKey;
  }

  /** The mock's real limit (W − limitSkewTokens). */
  get limit(): number {
    return this.window.limit;
  }

  /** The line mock_server.py prints at startup (run.py captures it in mock.out). */
  startupLine(): string {
    return `mock listening on ${this.port} limit=${this.window.limit} style=${this.styleName}`;
  }

  get url(): string {
    return `http://${this.o.host ?? '127.0.0.1'}:${this.port}`;
  }

  start(port = 0): Promise<number> {
    const server = createServer((req, res) => this.onRequest(req, res));
    server.keepAliveTimeout = 5_000;
    server.requestTimeout = 0; // the gobstopper relay can be slow on huge bodies; never cut a request
    server.on('connection', (s: Socket) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.o.host ?? '127.0.0.1', () => {
        this.port = (server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') {
      // BaseHTTPRequestHandler without do_GET answers 501 (run.py's wait_http treats any HTTP error as "up").
      const msg = Buffer.from(`Unsupported method ('${req.method}')`);
      res.writeHead(501, 'Not Implemented', [['content-type', 'text/html;charset=utf-8'], ['content-length', String(msg.length)]]);
      res.end(msg);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        this.handle(req, res, Buffer.concat(chunks));
      } catch (e) {
        this.crashes++;
        if (!(e instanceof CrashLikePython) && !(e instanceof SyntaxError) && !(e instanceof TypeError)) console.error('mock:', e);
        res.socket?.destroy();
      }
    });
  }

  /** Render + count with the configured template. A qwen3 template/validation error yields `error`. */
  private measure(body: RenderBody, raw: Buffer | null): { segments: Segments; tokens: number; error?: string } {
    if ((this.o.spec?.render ?? 'sim') !== 'qwen3') return this.o.counter.measureBody(body);
    try {
      const text = renderQwen3(raw ? raw.toString('utf8') : JSON.stringify(body));
      const segments = this.o.counter.segments(text);
      return { segments, tokens: this.o.counter.countSegments(segments) };
    } catch (e) {
      if (e instanceof Error && (e.name === 'TemplateError' || e.name === 'VLLMValidationError' || e.name === 'PyJsonError')) return { segments: [], tokens: 0, error: e.message };
      throw e;
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse, raw: Buffer): void {
    const body = JSON.parse(raw.toString('utf8')) as unknown;
    if (!isDict(body)) throw new CrashLikePython('body is not an object');
    const msgs = body['messages'] === undefined ? [] : body['messages'];
    const hdr = (n: string): string | undefined => {
      const v = req.headers[n];
      return typeof v === 'string' && v ? v : undefined;
    };
    const step = pyInt(hdr('x-sim-step') ?? '-1');
    const session = hdr('x-sim-session') ?? 'default';
    const scenarioId = hdr('x-sim-scenario');
    const kindHdr = hdr('x-sim-kind');
    const kind: RequestKind = kindHdr === 'summarizer' || kindHdr === 'title' ? kindHdr : 'main';
    const full = this.specMode || scenarioId !== undefined;
    const seq = ++this.seq;
    const spec = this.o.spec ?? {};
    const measured = this.measure(body as RenderBody, raw);
    const { segments } = measured;
    const hidden = this.specMode ? overheadOf(spec.hiddenOverheadTokens, measured.tokens) : 0;
    const prompt = measured.tokens + hidden;
    const maxTokens = pyIntOf(
      pyTruthy(body['max_tokens']) ? body['max_tokens'] : pyTruthy(body['max_completion_tokens']) ? body['max_completion_tokens'] : 0,
    );
    if (!Array.isArray(msgs)) throw new CrashLikePython('messages is not a list'); // len(msgs) would raise
    // scenario routing (x-sim-scenario / x-sim-session)
    let scen: ScenarioSpec | null = null;
    let routeError: string | null = null;
    if (scenarioId !== undefined) {
      scen = this.scenarios.get(scenarioId) ?? null;
      if (!scen) routeError = `mock: unknown scenario '${scenarioId}' (registered: ${[...this.scenarios.keys()].join(', ') || 'none'})`;
    }
    const sessSpec = scen ? (scen.sessions.find((s) => s.id === session) ?? (scen.sessions.length === 1 ? scen.sessions[0]! : null)) : null;
    if (scen && !sessSpec) routeError = `mock: scenario '${scen.id}' has no session '${session}'`;
    const markers = scen ? scen.facts.map((f) => f.marker) : FACT_KEYS;
    const blob = pyDumps(msgs, { ensureAscii: false });
    const facts: Record<string, boolean> = {};
    for (const k of markers) facts[k] = blob.includes(k);
    const rec: MockRecord = {
      seq, step, ts: (performance.timeOrigin + performance.now()) / 1000, prompt_tokens: prompt, max_tokens: maxTokens,
      n_messages: msgs.length,
      has_summary: msgs.some((m) => isDict(m) && contentText(m['content']).startsWith(SUMMARY_HEADER)),
      facts, body_chars: raw.length, pairing_error: null,
    };
    let bodyFile: string | undefined;
    if (this.reqsDir) {
      bodyFile = `${pad4(seq)}_step${step}.json`;
      writeFileSync(join(this.reqsDir, bodyFile), pyDumps(body, { ensureAscii: false }));
    }
    const pairing = checkPairing(msgs); // may throw TypeError like Python's sorted()
    rec.pairing_error = pairing;
    const spx: Partial<MockRecord> = {};
    if (full || kindHdr !== undefined) spx.kind = kind;
    if (full) {
      spx.scenario = scen ? scen.id : null;
      spx.pairing_strict = strictPairingDefects(msgs);
    }
    if (hidden) spx.hidden_overhead = hidden;
    // Python key order: ..., pairing_error, status, then rejected_for_length | completion_tokens.
    const finish = (status: number, more: Partial<MockRecord> = {}, extra: Partial<MockRecord> = {}): void => {
      rec.status = status;
      Object.assign(rec, more);
      this.extras(rec, kind === 'main' ? session : `${session}\u0000${kind}`, segments, raw.length, bodyFile);
      Object.assign(rec, spx, extra);
      this.log(rec);
    };
    const stream = pyTruthy(body['stream']);
    // 1. a gateway in front of the server rejects on bytes before anything else (benchmark contract http413)
    const maxBody = spec.maxBodyBytes ?? null;
    if (maxBody !== null && raw.length > maxBody) {
      finish(PAYLOAD_TOO_LARGE.status, { rejected_for_length: true }, { reject_reason: 'bytes' });
      this.sendError(res, PAYLOAD_TOO_LARGE, false, this.delayMs());
      return;
    }
    if (pairing) {
      finish(400);
      this.sendJson(res, 400, { error: { type: 'invalid_request_error', message: `Invalid messages: ${pairing}` } });
      return;
    }
    if (routeError !== null) {
      console.error(routeError);
      finish(400, {}, { template_error: routeError });
      this.sendJson(res, 400, { error: { type: 'invalid_request_error', message: routeError } });
      return;
    }
    if (measured.error !== undefined) {
      // vLLM answers a template or request-validation error with a 400 before any length check
      finish(400, {}, { template_error: measured.error });
      this.sendRaw(res, 400, JSON.stringify({ error: { message: measured.error, type: 'BadRequestError', param: null, code: 400 } }), 'application/json');
      return;
    }
    const limit = this.window.limit;
    if (this.overLimit(prompt, maxTokens, limit, body as RenderBody)) {
      const err = this.style({ prompt, maxTokens, limit, body: body as RenderBody, stream });
      const inStream = stream && err.inStream && (ALWAYS_IN_STREAM.has(this.styleKey) || (this.specMode && spec.inStreamErrors === true)) ? err.inStream : null;
      if (inStream) {
        finish(200, { rejected_for_length: true }, { stream_error: true, reject_reason: 'tokens', error_status: err.inStreamStatus ?? err.status });
        this.sendInStream(res, inStream, this.delayMs());
        return;
      }
      finish(err.status, { rejected_for_length: true }, full ? { reject_reason: 'tokens' } : {});
      this.sendError(res, err, true, this.delayMs());
      return;
    }
    // silent_truncate (Ollama): drop messages from the front until the prompt fits
    let served = prompt;
    let truncated = 0;
    if (this.specMode && this.limitMode === 'silent_truncate' && prompt > limit) {
      ({ tokens: served, dropped: truncated } = this.silentTruncate(body as RenderBody, msgs, limit));
      spx.server_prompt_tokens = served;
      spx.truncated_messages = truncated;
    }
    const turn = this.generate(kind, step, session, scen, sessSpec, body as RenderBody, msgs, served, maxTokens, limit, hdr('x-sim-summary'));
    const usage = { prompt_tokens: served, completion_tokens: turn.completion_tokens, total_tokens: served + turn.completion_tokens };
    const injected = stream && this.o.streamError ? this.o.streamError({ seq, step, prompt, body: body as RenderBody }) : null;
    const tail: Partial<MockRecord> = injected ? { stream_error: true } : {};
    if (full) {
      tail.finish_reason = turn.finish_reason;
      if (turn.reasoning_tokens) tail.reasoning_tokens = turn.reasoning_tokens;
    }
    finish(200, { completion_tokens: turn.completion_tokens }, tail);
    const base = { id: `chatcmpl-${seq}`, object: 'chat.completion.chunk', model: body['model'] ?? null };
    const field = this.o.reasoningField ?? 'reasoning_content';
    const mode = this.specMode ? (spec.usage ?? this.o.usage ?? 'client') : (this.o.usage ?? 'client');
    if (stream) {
      res.writeHead(200, PY_REASON[200], [['content-type', 'text/event-stream'], ['transfer-encoding', 'chunked']]);
      if (injected) {
        writeChunksInOrder(res, [`data: ${pyDumps(injected.event)}\n\n`, ...(injected.done ? ['data: [DONE]\n\n'] : [])]);
        return;
      }
      const opts = body['stream_options'];
      const includeUsage = mode === 'always' || (mode === 'client' && pyTruthy(isDict(opts) ? opts['include_usage'] : undefined));
      const delta = {
        role: 'assistant',
        content: turn.content || '',
        tool_calls: turn.tool_calls.map((c, i) => ({ ...(c as unknown as Json), index: i })), // dict(c, index=i): index last
      };
      const events: unknown[] = [];
      if (turn.reasoning) events.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', [field]: turn.reasoning }, finish_reason: null }] });
      events.push({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }, { ...base, choices: [{ index: 0, delta: {}, finish_reason: turn.finish_reason }] });
      if (includeUsage) events.push({ ...base, choices: [], usage });
      // Each res.write() must be its own HTTP chunk ("<hex len>\r\n<data>\r\n") like mock_server.py's _chunk();
      // Node coalesces writes issued in one tick into a single chunk, so each write waits for the previous flush.
      writeChunksInOrder(res, [...events.map((ev) => `data: ${pyDumps(ev)}\n\n`), 'data: [DONE]\n\n']);
    } else {
      const message: Json = { role: 'assistant', content: turn.content };
      if (turn.reasoning) message[field] = turn.reasoning;
      message['tool_calls'] = turn.tool_calls;
      const out: Json = { id: `chatcmpl-${seq}`, object: 'chat.completion', model: body['model'] ?? null, choices: [{ index: 0, message, finish_reason: turn.finish_reason }] };
      if (mode !== 'never') out['usage'] = usage;
      this.sendJson(res, 200, out);
    }
  }

  /** The turn to send: a placeholder (summarizer/title), the reply hook, the scenario's or the reference's script. */
  private generate(
    kind: RequestKind, step: number, session: string, scen: ScenarioSpec | null, sess: ScenarioSpec['sessions'][number] | null,
    body: RenderBody, msgs: unknown[], prompt: number, maxTokens: number, limit: number, summaryHdr: string | undefined,
  ): GeneratedTurn {
    const counter = this.o.counter;
    let t: ScriptedTurn;
    if (kind !== 'main') {
      let content: string;
      const fixed = kind === 'summarizer' ? (this.o.summaryFor ? this.o.summaryFor({ scenario: scen, session, step }) : scenarioSummary(scen, step)) : null;
      if (kind === 'title') content = TITLE_PLACEHOLDER;
      else if (fixed !== null) content = fixed;
      else {
        const blob = pyDumps(msgs, { ensureAscii: false });
        const facts = scen ? scen.facts : null;
        const plantMarkers = facts && !ownsClientSummary(scen) && !this.o.summaryFor ? facts.filter((f) => f.channel === 'client-summary').map((f) => f.marker) : [];
        const visible = (facts ? facts.map((f) => f.marker) : FACT_KEYS).filter((m) => blob.includes(m) && !plantMarkers.includes(m));
        const style = summaryHdr === 'baseline' || summaryHdr === 'template' ? summaryHdr : (this.o.summaryStyle ?? 'template');
        content = summaryPlaceholder({ style, tokens: this.o.summaryTokens ?? 1500, visible, plant: plantPositions(plantMarkers) }, counter);
      }
      t = { content, reasoning: null, tool_calls: [] };
    } else {
      const m = (this.o.reply
        ? this.o.reply(step, body)
        : sess
          ? sess.assistantAt(step)
          : assistantMessage(step, this.o.scenario ?? {})) as ChatMessage;
      const reasoning = typeof m['reasoning_content'] === 'string' ? (m['reasoning_content'] as string) : typeof m['reasoning'] === 'string' ? (m['reasoning'] as string) : null;
      const content = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? contentText(m.content) : null;
      t = { content, reasoning, tool_calls: Array.isArray(m.tool_calls) ? (m.tool_calls as ToolCall[]) : [] };
      const cm = this.o.spec?.completionModel;
      if (this.specMode && cm !== undefined && cm !== 'sim') t = expandTurn(t, cm, [scen?.id ?? 'reference', session, step], counter);
    }
    if (!this.specMode) {
      // Python mode: no cap; every scripted step "finishes" with tool_calls, like mock_server.py
      const completion = t.reasoning ? counter.countText(t.reasoning) + simCompletion(t, counter) : simCompletion(t, counter);
      return { ...t, finish_reason: kind === 'main' ? 'tool_calls' : 'stop', completion_tokens: completion, reasoning_tokens: t.reasoning ? counter.countText(t.reasoning) : 0 };
    }
    const room = limit - prompt;
    const cap = Math.max(0, maxTokens > 0 ? Math.min(maxTokens, room) : room);
    return capTurn(t, cap, counter);
  }

  /** Ollama /v1: drop the oldest non-system messages (keeping at least the last one) until the prompt fits. */
  private silentTruncate(body: RenderBody, msgs: unknown[], limit: number): { tokens: number; dropped: number } {
    const spec = this.o.spec ?? {};
    const sysIdx = msgs.map((m, i) => (isDict(m) && m['role'] === 'system' ? i : -1)).filter((i) => i >= 0);
    const others = msgs.map((_, i) => i).filter((i) => !sysIdx.includes(i));
    const countWith = (drop: number): number => {
      const keep = new Set([...sysIdx, ...others.slice(drop)]);
      const b: RenderBody = { ...body, messages: msgs.filter((_, i) => keep.has(i)) };
      let m = this.measure(b, null);
      // Ollama renders with its own Go template, which never raises; the Jinja port does (e.g. "No user query found"
      // once the only user message is dropped), so such a candidate is counted with the sim render
      if (m.error !== undefined) m = this.o.counter.measureBody(b);
      return m.tokens + overheadOf(spec.hiddenOverheadTokens, m.tokens);
    };
    let lo = 1;
    let hi = Math.max(0, others.length - 1);
    if (hi < lo || countWith(hi) > limit) return { tokens: countWith(hi), dropped: hi };
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (countWith(mid) <= limit) hi = mid;
      else lo = mid + 1;
    }
    return { tokens: countWith(lo), dropped: lo };
  }

  private delayMs(): number {
    return this.o.spec?.headerDelayMs ?? (this.specMode ? (DEFAULT_HEADER_DELAY_MS.get(this.styleKey) ?? 0) : 0);
  }

  private sendError(res: ServerResponse, err: ErrorResponse, pythonJson: boolean, delayMs: number): void {
    const send = (): void => {
      if (err.raw !== undefined) this.sendRaw(res, err.status, err.raw, err.contentType ?? 'application/json');
      else if (pythonJson) this.sendJson(res, err.status, err.body);
      else this.sendRaw(res, err.status, JSON.stringify(err.body), err.contentType ?? 'application/json');
    };
    if (delayMs > 0) void sleep(delayMs).then(send);
    else send();
  }

  private sendInStream(res: ServerResponse, text: string, delayMs: number): void {
    const send = (): void => {
      res.writeHead(200, PY_REASON[200], [['content-type', 'text/event-stream'], ['transfer-encoding', 'chunked']]);
      for (const ev of text.split(/(?<=\n\n)/)) if (ev) res.write(ev);
      res.end();
    };
    if (delayMs > 0) void sleep(delayMs).then(send);
    else send();
  }

  private extras(rec: MockRecord, key: string, segs: Segments, bytes: number, bodyFile: string | undefined): void {
    let st = this.sessions.get(key);
    if (!st) this.sessions.set(key, (st = { prev: null, prevOk: null }));
    rec.session = key.split('\u0000')[0]!;
    rec.lcp_tokens = st.prev ? this.o.counter.lcp(st.prev, segs) : 0;
    rec.lcp_ok_tokens = st.prevOk ? this.o.counter.lcp(st.prevOk, segs) : 0;
    rec.body_bytes = bytes;
    if (bodyFile) rec.body_file = 'reqs/' + bodyFile;
    st.prev = segs;
    if (rec.status === 200 && !rec.rejected_for_length) st.prevOk = segs;
  }

  private log(rec: MockRecord): void {
    this.records.push(rec);
    if (this.logPath) appendFileSync(this.logPath, mockRecordLine(rec) + '\n');
    this.o.onRecord?.(rec);
  }

  private sendJson(res: ServerResponse, status: number, obj: unknown): void {
    const data = Buffer.from(pyDumps(obj), 'utf8');
    res.writeHead(status, PY_REASON[status] ?? 'Unknown', [['content-type', 'application/json'], ['content-length', String(data.length)]]);
    res.end(data);
  }

  private sendRaw(res: ServerResponse, status: number, text: string, contentType: string): void {
    const data = Buffer.from(text, 'utf8');
    res.writeHead(status, PY_REASON[status] ?? 'Unknown', [['content-type', contentType], ['content-length', String(data.length)]]);
    res.end(data);
  }
}

// ---------------------------------------------------------------- CLI (mock_server.py's arguments)
//   node dist/bench/mock/server.js PORT OUTDIR [--limit 100000] [--error-style vllm|llamacpp|gateway502|tgi422]
//                                  [--spec '<MockOptions JSON>']
//   SIM_CAP_BYTES / SIM_CHATTY / SIM_HUGE_AT / SIM_HUGE_CHARS are read like scenario.py.
// Unlike Python, the "listening" line is printed AFTER the socket is bound (no readiness race).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--')));
  const flag = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  if (pos.length < 2) {
    console.error('usage: server.js PORT OUTDIR [--limit N] [--error-style STYLE] [--spec JSON]');
    process.exit(2);
  }
  const { PromptCounter } = await import('../lib/render.js');
  const { benchTokenizer } = await import('../lib/paths.js');
  const { scenarioOptionsFromEnv } = await import('../scenarios/reference.js');
  const specArg = flag('--spec');
  const mock = new MockServer({
    counter: new PromptCounter(benchTokenizer()),
    outDir: pos[1]!,
    limit: pyInt(flag('--limit') ?? '100000'),
    errorStyle: flag('--error-style') ?? 'vllm',
    scenario: scenarioOptionsFromEnv(process.env),
    ...(specArg ? { spec: JSON.parse(specArg) as Partial<MockOptions> } : {}),
  });
  await mock.start(pyInt(pos[0]!));
  console.log(mock.startupLine());
  const stop = (): void => void mock.stop().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/** Writes each part as a separate HTTP chunk (waiting for the previous write to flush), then ends the response. */
function writeChunksInOrder(res: { write(chunk: string, cb: (err?: Error | null) => void): boolean; end(): void; destroyed?: boolean }, parts: string[]): void {
  let i = 0;
  const next = (err?: Error | null): void => {
    if (err || res.destroyed) return;
    if (i >= parts.length) { res.end(); return; }
    res.write(parts[i++]!, next);
  };
  next();
}
