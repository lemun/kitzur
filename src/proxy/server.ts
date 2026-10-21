// The HTTP proxy (DESIGN.md, §8-§10). Routes:
//   POST …/chat/completions (any prefix)  engine + recovery ladder (recovery.ts), streamed relay
//   GET /status, GET /kitzur/status      JSON status (status.ts)
//   anything else                         streamed pass-through to the same upstream
// Every route checks the Host header first (DNS rebinding). The upstream is fixed by config: request
// paths never choose a host. Nothing here logs content or header values.
//
// Chat requests: the body is parsed by the dialect (fail-open: an unparseable, compressed or
// non-object body is forwarded unchanged); the ladder decides what each attempt sends; send()
// streams one attempt: non-2xx bodies are read and handed back to the ladder, SSE goes through the
// first-event hold (from the upstream headers, ) and the relay (sse.ts), JSON is relayed as it
// arrives with a bounded tap copy. After the response: calibration (usage, or the tokenize endpoint
// when no usage came back), the stats record and the status counters.
//
// Shadow mode: the engine runs and is recorded, the original bytes are forwarded, errors are relayed
// unchanged; usage and the tokenize endpoint still calibrate.
import type { LoopWatchdog } from '../diagnostics/runtime.js';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { listenSecurityError } from '../config/listen.js';
import type { Config } from '../config/schema.js';
import { isAutoWindow, setDiscoveredWindows } from '../config/window.js';
import type { ChatRequest, Engine, EngineResult, LearnedEntry, ProcessOptions, TokenCounter } from '../types.js';
import type { RemoteTokenizer } from '../tokenize/remote.js';
import type { TemplateProfile } from '../tokenize/template.js';
import {
  errorBody, inStreamErrorEvents, inStreamErrorStatus, inStreamOverflowEvents, isChatCompletionsPath, isStreaming, parseChatRequest,
  tapJsonBody, upstreamUnavailableBody, extractErrorMessage,
} from '../dialect/openai-chat.js';
import { hostAllowed } from './hostcheck.js';
import { ErrorClassifier } from './errors.js';
import { runChat, attemptRecords, type AttemptOutcome, type ChatResult, type ErrorOutcome, type Final, type OutgoingAttempt } from './recovery.js';
import { SseRelay, type RelayStep } from './sse.js';
import { Upstream, forwardRequestHeaders, forwardResponseHeaders, readBody, type ProbeResult, type UpstreamResponse } from './upstream.js';
import { learnedKey, type StateStore } from './state.js';
import { buildStatsRecord, type StatsWriter } from './stats.js';
import { StatusTracker, type RecentRequest } from './status.js';
import { applyAcceptedRatio, EndpointCalibrator, judgeSample, type CounterKind } from './calibration.js';
import { budgetModeOf, serverLimits, budgetQuantities } from './budget.js';
import { packageInfo } from '../config/paths.js';
import type { ModelRuntimeMap } from './model-runtime.js';

/**
 * true when a request may be served despite browser context: no Origin header and no cross-site or
 * same-site Sec-Fetch-Site, or an Origin listed in listen.allowedOrigins (compared case-insensitively).
 */
export function originAllowed(origin: string | undefined, fetchSite: string | string[] | undefined, allowed: readonly string[]): boolean {
  const listed = origin !== undefined && allowed.some((a) => a.trim().toLowerCase() === origin.trim().toLowerCase());
  if (origin !== undefined && !listed) return false;
  const site = (Array.isArray(fetchSite) ? fetchSite.join(',') : fetchSite ?? '').toLowerCase();
  return listed || !/\b(?:cross-site|same-site)\b/.test(site);
}

/** true for application/json, with or without parameters (charset=utf-8). */
export function isJsonContentType(ct: string | undefined): boolean {
  return ct !== undefined && ct.split(';')[0]!.trim().toLowerCase() === 'application/json';
}

export interface ProxyDeps {
  watchdog?: LoopWatchdog;
  modelRuntimes?: ModelRuntimeMap;
  engine: Engine;
  /** the local counter (exact or estimate); a 'remote' counter is refused */
  counter: TokenCounter & { profile?: TemplateProfile };
  /** the gateway tokenize endpoint: a calibration source only () */
  remote?: RemoteTokenizer | null;
  state: StateStore;
  stats: StatsWriter;
  now?: () => Date;
  /** defaults to a client built from config.upstream */
  upstream?: Upstream;
  /** error-level diagnostics (never content) */
  log?: (level: 'error' | 'warn' | 'info' | 'debug', msg: string) => void;
}

export interface ProxyServer {
  server: http.Server;
  status: StatusTracker;
  upstream: Upstream;
  /** binds listen.host:listen.port (port 0 = any) */
  listen(): Promise<{ port: number; host: string }>;
  /** stops accepting, drains in-flight requests for up to drainMs, then flushes state and stats */
  close(drainMs?: number): Promise<void>;
  /** requests in flight */
  active(): number;
  /** the /status payload */
  snapshot(): Record<string, unknown>;
  /** startup probe (GET <origin>/v1/models); the result is shown in /status. A tlsError must fail startup. */
  probe(): Promise<ProbeResult>;
}

const MAX_JSON_TAP = 4 * 1024 * 1024;
const JSON_CT = 'application/json';

function sendJson(res: ServerResponse, status: number, body: Buffer | string, extra: Record<string, string> = {}): void {
  const b = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { 'content-type': JSON_CT, 'content-length': String(b.length), ...extra });
  res.end(b);
}

export function createProxyServer(config: Config, deps: ProxyDeps): ProxyServer {
  const cfg = config;
  const securityError = listenSecurityError(cfg);
  if (securityError) throw new Error(securityError);
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  if (deps.counter.mode === 'remote') throw new Error('the proxy needs a local counter (exact or estimate); remote is a calibration source only');
  const counterMode: CounterKind = deps.counter.mode === 'exact' ? 'exact' : 'estimate';
  const upstream = deps.upstream ?? new Upstream(cfg.upstream);
  const origin = upstream.origin.origin + upstream.origin.pathname.replace(/\/+$/, '');
  const classifier = new ErrorClassifier(cfg.errors);
  const status = new StatusTracker(cfg, packageInfo().version,() => now().getTime());
  const endpoint = deps.remote && deps.counter.profile ? new EndpointCalibrator(deps.remote, deps.counter.profile) : null;
  for (const [k, e] of Object.entries(deps.state.entries())) {
    const model = k.startsWith(`${origin}|`) ? k.slice(origin.length + 1) : undefined;
    if (deps.modelRuntimes) deps.modelRuntimes.setLearned(model, k, e);
    else deps.engine.setLearned(k, e);
  }
  if (deps.state.discarded.length) status.warn('learned_discarded', `${deps.state.discarded.length} learned entries discarded (window or counter changed)`);
  if (deps.state.lastError) status.warn('state', deps.state.lastError);

  let discoveredWindows: Record<string, number> = {};
  // models already warned about with window_auto_fallback: warn once per model, not per request
  const fallbackWarned = new Set<string>();
  let inflight = 0;
  let concurrencyRejected = 0;
  let closing = false;
  const sockets = new Set<Socket>();
  const idleWaiters: Array<() => void> = [];
  const settle = (): void => {
    if (inflight === 0) for (const w of idleWaiters.splice(0)) w();
  };

  const server = http.createServer({ noDelay: true }, (req, res) => {
    if (inflight >= cfg.listen.maxConcurrentRequests) {
      status.requests++;
      concurrencyRejected++;
      rejectUpload(req, res, 503, 'too many concurrent requests', 'server_busy', { 'retry-after': '1' });
      return;
    }
    // in flight until the response is done *and* its stats/calibration ran (the drain waits for both)
    inflight++;
    const requestId = String(status.requests + 1);
    deps.watchdog?.phase(requestId, 'handling');
    handle(req, res, requestId)
      .catch((e: unknown) => {
        log('error', `request failed: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) sendJson(res, 500, errorBody('kitzur: internal error', 'api_error', 'kitzur_internal_error'));
        else res.destroy();
      })
      .finally(() => {
        deps.watchdog?.phase(requestId, 'complete');
        inflight--;
        settle();
      });
  });
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });

  const snapshot = (): Record<string, unknown> => ({
    ...status.snapshot({
      counter: { mode: deps.counter.mode, id: deps.counter.id },
      learned: deps.state.entries(),
      stateError: deps.state.lastError,
      statsPath: deps.stats.path,
      statsError: deps.stats.lastError,
      upstream: { origin, ...upstream.stats, endpoint: deps.remote ? deps.remote.stats() : null },
    }),
    concurrency_rejected: concurrencyRejected,
    ...deps.watchdog?.snapshot(),
  });

  // ------------------------------------------------------------------ routing
  async function handle(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    status.requests++;
    if (!hostAllowed(req.headers.host, cfg.listen.allowedHosts)) {
      status.hostRejected++;
      sendJson(res, 403, errorBody('kitzur: this host name is not served (listen.allowedHosts)', 'permission_error', 'host_not_allowed'));
      return;
    }
    if (!originAllowed(req.headers.origin, req.headers['sec-fetch-site'], cfg.listen.allowedOrigins)) {
      // a web page in a browser: CLI agents send no Origin. A CORS "simple" POST needs no preflight, so the
      // check runs before any upstream call (which would carry Authorization and upstream.headers)
      sendJson(res, 403, errorBody('kitzur: browser cross-origin requests are not served (listen.allowedOrigins)', 'permission_error', 'origin_not_allowed'));
      return;
    }
    if (req.method === 'OPTIONS') {
      // CORS preflight: answered here, never forwarded with the injected upstream headers
      sendJson(res, 403, errorBody('kitzur: OPTIONS is not served', 'permission_error', 'method_not_allowed'));
      return;
    }
    if (cfg.listen.token !== null) {
      const expected = Buffer.from('Bearer ' + cfg.listen.token);
      const supplied = Buffer.from(req.headers.authorization ?? '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        rejectUpload(req, res, 401, 'a valid client Bearer token is required', 'invalid_client_token', { 'www-authenticate': 'Bearer' });
        return;
      }
      // The proxy token authenticates the client only; never forward it to the upstream.
      for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
        if (req.rawHeaders[i]!.toLowerCase() === 'authorization') req.rawHeaders.splice(i, 2);
      }
    }
    const length = req.headers['content-length'];
    if (length !== undefined && BigInt(length) > BigInt(cfg.listen.maxRequestBytes)) {
      rejectUpload(req, res, 413, 'request body too large', 'request_too_large');
      return;
    }
    const url = req.url ?? '/';
    if (!url.startsWith('/')) {
      // absolute-form (`GET http://other.host/… HTTP/1.1`) would hand a client-chosen authority to the
      // upstream: request paths never choose a host (§10), so only origin-form targets are served
      sendJson(res, 400, errorBody('kitzur: only origin-form request targets are served', 'invalid_request_error', 'invalid_request_target'));
      return;
    }
    const q = url.indexOf('?');
    const pathname = q < 0 ? url : url.slice(0, q);
    if (req.method === 'GET' && (pathname === '/status' || pathname === '/kitzur/status')) {
      sendJson(res, 200, JSON.stringify(snapshot(), null, 1));
      return;
    }
    if (isChatCompletionsPath(req.method ?? '', pathname) && !isJsonContentType(req.headers['content-type'])) {
      sendJson(res, 415, errorBody('kitzur: chat requests must have Content-Type application/json', 'invalid_request_error', 'unsupported_media_type'));
      return;
    }
    deps.watchdog?.phase(requestId, 'reading_body');
    const body = await readRequest(req, res);
    if (body === null) return;
    const tBody = performance.now();
    if (isChatCompletionsPath(req.method ?? '', pathname)) await handleChat(req, res, body, pathname, tBody, requestId);
    else await passthrough(req, res, body);
  }

  function rejectUpload(req: IncomingMessage, res: ServerResponse, code: number, message: string, kind: string, headers: Record<string, string> = {}): void {
    // Stop consuming immediately. Flush the error, then destroy the request/socket rather than
    // draining an unbounded upload. Connection: close prevents reuse with unread body bytes.
    req.pause();
    res.once('finish', () => req.destroy());
    sendJson(res, code, errorBody('kitzur: ' + message, code >= 500 ? 'api_error' : 'invalid_request_error', kind), { connection: 'close', ...headers });
  }

  function readRequest(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const done = (body: Buffer | null): void => {
        if (settled) return;
        settled = true;
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('aborted', onAborted);
        chunks.length = 0;
        resolve(body);
      };
      const onData = (d: Buffer): void => {
        size += d.length;
        if (size > cfg.listen.maxRequestBytes) {
          rejectUpload(req, res, 413, 'request body too large', 'request_too_large');
          done(null);
        } else chunks.push(d);
      };
      const onEnd = (): void => done(Buffer.concat(chunks, size));
      const onAborted = (): void => {
        // The peer has gone away; there is no response channel left.
        res.destroy();
        done(null);
      };
      req.on('data', onData);
      req.once('end', onEnd);
      req.once('aborted', onAborted);
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        if (req.destroyed || res.destroyed) res.destroy();
        else rejectUpload(req, res, err.code === 'ECONNRESET' ? 400 : 500, 'request body read failed', 'request_read_error');
        done(null);
      });
    });
  }

  // ------------------------------------------------------------------ pass-through
  // Per-response observations never retain or log response content.
  function observeResponse(res: ServerResponse) {
    type Outcome = 'ok' | 'aborted' | 'incomplete' | 'upstream_error' | 'refused';
    const o = {
      relay: null as SseRelay | null,
      bytes: 0,
      firstByte: 0,
      ended: false,
      outcome: 'ok' as Outcome,
      midstream: false,
      finish: null as string | null,
    };
    const fields = (): string => `finish=${o.relay?.finishReason ?? o.finish ?? 'none'} done=${o.relay?.done ?? false} events=${o.relay?.events ?? 0} bytes=${o.bytes}`;
    const inspect = (): void => {
      const err = o.relay?.midStreamError;
      if (!err || o.midstream) return;
      o.midstream = true;
      status.midstreamErrors++;
      o.outcome = 'upstream_error';
      const json = err.json;
      let message = '';
      if (typeof json === 'object' && json !== null) {
        const inner = 'error' in json ? json.error : json;
        if (typeof inner === 'object' && inner !== null && 'message' in inner && typeof inner.message === 'string') message = inner.message.trim().slice(0, 200);
      }
      log('warn', `upstream sent an error event after ${o.relay!.midStreamErrorAfter} events: ${JSON.stringify(message)}`);
    };
    res.once('close', () => {
      inspect();
      if (!res.writableEnded && !o.ended) {
        o.outcome = 'aborted';
        log('warn', `client closed before upstream ended ${fields()} ms_since_first_byte=${o.firstByte ? Math.round(performance.now() - o.firstByte) : 0}`);
      }
    });
    const end = (): void => {
      o.ended = true;
      inspect();
      if (o.relay && !o.relay.complete) {
        if (o.outcome === 'ok') o.outcome = 'incomplete';
        log('warn', `upstream stream ended without [DONE]/finish_reason ${fields()}`);
      }
    };
    return { o, fields, inspect, end };
  }

  async function passthrough(req: IncomingMessage, res: ServerResponse, body: Buffer, observation = observeResponse(res)): Promise<void> {
    status.passthroughRequests++;
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded && !observation.o.ended) {
        status.aborted++;
        ac.abort();
      }
    });
    let up: UpstreamResponse;
    try {
      up = await upstream.request({ method: req.method ?? 'GET', path: req.url ?? '/', headers: forwardRequestHeaders(req.rawHeaders, cfg.upstream.headers), body, signal: ac.signal });
    } catch {
      if (!res.headersSent && !ac.signal.aborted) {
        status.upstreamUnavailable++;
        observation.o.outcome = 'upstream_error';
        sendJson(res, 502, upstreamUnavailableBody());
      }
      return;
    }
    if (String(up.headers['content-type'] ?? '').includes('text/event-stream')) observation.o.relay = new SseRelay({ hold: false, strip: false, committed: true, detectErrors: false });
    if (up.status >= 400) observation.o.outcome = 'upstream_error';
    res.writeHead(up.status, up.statusMessage, forwardResponseHeaders(up.rawHeaders));
    await new Promise<void>((resolve) => {
      up.body.on('data', (d: Buffer) => {
        observation.o.bytes += d.length;
        observation.o.firstByte ||= performance.now();
        observation.o.relay?.onChunk(d);
        observation.inspect();
        if (!res.write(d)) {
          up.body.pause();
          res.once('drain', () => up.body.resume());
        }
      });
      up.body.on('end', () => {
        observation.o.relay?.onEnd();
        observation.end();
        if (observation.o.outcome === 'incomplete') status.upstreamIncomplete++;
        res.end();
        resolve();
      });
      up.body.on('error', () => {
        observation.o.ended = true;
        observation.o.outcome = 'upstream_error';
        res.destroy();
        resolve();
      });
      up.body.on('close', () => {
        if (!res.writableEnded && !ac.signal.aborted) {
          observation.o.ended = true;
          observation.o.outcome = 'upstream_error';
          res.destroy();
        }
        resolve();
      });
    });
  }

  // ------------------------------------------------------------------ chat
  async function handleChat(req: IncomingMessage, res: ServerResponse, raw: Buffer, pathname: string, tBody: number, requestId: string): Promise<void> {
    status.chatRequests++;
    const observation = observeResponse(res);
    const visible: RecentRequest = { action: 'passthrough', tokens: { in: null, out: null, trigger: null }, model: null, ms: 0 };
    let quantities: { budget: number; trigger: number; target: number } = budgetQuantities(cfg, null);
    const show = (n: number | null): string => n === null ? 'unknown' : String(n);
    const setVisibleHeaders = (): void => {
      if (res.headersSent) return;
      res.setHeader('x-kitzur-action', visible.action);
      res.setHeader('x-kitzur-tokens', `${show(visible.tokens.in)}/${show(visible.tokens.out)}/${show(visible.tokens.trigger)}`);
    };
    const actionOf = (a: string): RecentRequest['action'] => {
      if (a === 'impossible' || a === 'guard_reject') return 'refuse';
      if (a === 'admit') return 'compact';
      if (a === 'restore') return 'clamp';
      return a === 'reuse' || a === 'compact' || a === 'clamp' || a === 'truncate' ? a : 'passthrough';
    };
    res.once('close', () => {
      visible.ms = Math.round((performance.now() - tBody) * 10) / 10;
      status.recordRequest(visible);
      log('info', `chat action=${visible.action} tokens=${show(visible.tokens.in)}->${show(visible.tokens.out)} budget=${quantities.budget} trigger=${show(visible.tokens.trigger)} target=${quantities.target} model=${JSON.stringify(visible.model)} ms=${visible.ms} status=${res.headersSent ? res.statusCode : 499} outcome=${observation.o.outcome} ${observation.fields()}`);
    });
    setVisibleHeaders();
    const seq = deps.stats.nextSeq();
    const ts = now();
    const cpu0 = process.cpuUsage();
    const headers = forwardRequestHeaders(req.rawHeaders, cfg.upstream.headers);
    const sessHdr = req.headers['x-session-id'] ?? req.headers['x-sim-session'];
    const clientSession = typeof sessHdr === 'string' && sessHdr.length <= 128 ? sessHdr : undefined;

    const ac = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        ac.abort();
      }
    });

    let committed = false;
    let reqPathMs: number | undefined;
    let respPathMs: number | undefined;
    const commit = (st: number, msg: string, hdrs: string[]): void => {
      if (committed) return;
      committed = true;
      setVisibleHeaders();
      // Local diagnostics take precedence over similarly named upstream headers.
      const clean: string[] = [];
      for (let i = 0; i < hdrs.length; i += 2) if (!hdrs[i]!.toLowerCase().startsWith('x-kitzur-')) clean.push(hdrs[i]!, hdrs[i + 1]!);
      res.writeHead(st, msg, clean);
      res.flushHeaders();
    };

    // fail-open: compressed or unparseable bodies are forwarded unchanged
    const enc = req.headers['content-encoding'];
    const parsed = enc && enc !== 'identity' ? ({ ok: false, reason: 'content_encoding' } as const) : parseChatRequest(raw);
    if (!parsed.ok) {
      status.failedOpen(parsed.reason);
      status.action('passthrough');
      await passthrough(req, res, raw, observation);
      deps.stats.write(buildStatsRecord({
        seq, ts, path: pathname, first: null, last: null, action: 'passthrough', attempts: [], clientStatus: res.statusCode, tokensIn: null,
        correction: 1, engineMs: 0, totalMs: performance.now() - tBody, compacted: false, shadow: cfg.shadow, usage: null, usageMismatch: false,
        rewriteRejected: false, reason: `parse:${parsed.reason}`, forwarded: 'original', ...(clientSession ? { clientSession } : {}),
      }));
      return;
    }
    const creq = parsed.value.req;
    const runtime = deps.modelRuntimes?.forModel(creq.model);
    const requestCfg = runtime?.cfg ?? cfg;
    const requestEngine = runtime?.engine ?? deps.engine;
    const requestCounter = runtime?.counter ?? deps.counter;
    const requestCounterMode: CounterKind = requestCounter.mode === 'exact' ? 'exact' : 'estimate';
    if (deps.modelRuntimes?.shouldWarnUnknown(creq.model)) {
      const message = `No model profile configured for ${JSON.stringify(creq.model)}; using the root runtime.`;
      status.warn('model_runtime_fallback', message);
      log('warn', message);
    }
    const key = learnedKey(origin, creq.model);
    visible.model = creq.model ?? null;
    const learnedForModel = (): LearnedEntry => {
      const entry = deps.state.entry(key);
      const model = creq.model ?? '';
      const window = Object.hasOwn(discoveredWindows, model) ? discoveredWindows[model] : undefined;
      if (isAutoWindow(requestCfg) && window !== undefined) entry.window = entry.window === null ? window : Math.min(entry.window, window);
      return entry;
    };
    if (isAutoWindow(requestCfg) && !Object.hasOwn(discoveredWindows, creq.model ?? '') && !fallbackWarned.has(creq.model ?? '')) {
      fallbackWarned.add(creq.model ?? '');
      const message = `No context window discovered for model ${JSON.stringify(creq.model ?? '')}; using fallback ${requestCfg.budget.window}.`;
      status.warn('window_auto_fallback', message);
      log('warn', message);
    }
    quantities = budgetQuantities(requestCfg, learnedForModel());
    visible.tokens.trigger = quantities.trigger;
    const clientWarning = status.clientRequest(creq, clientSession, quantities.trigger);
    if (clientWarning) log('warn', clientWarning);
    setVisibleHeaders();

    // ---------------------------------------------------------------- one upstream attempt
    let firstUpByte = 0;
    let firstClientByte = 0;
    let upstreamCalls = 0;
    // the parked rest of a stream whose first event was an error (relaySse): relayed or destroyed by writeFinal
    let rest: Rest | null = null;
    const dropRest = (): void => {
      rest?.body.destroy();
      rest = null;
    };
    const send = async (a: OutgoingAttempt): Promise<AttemptOutcome> => {
      const t0 = performance.now();
      if (!committed) {
        const st = a.result?.stats;
        if (st) quantities = st.budget;
        visible.action = requestCfg.shadow || !a.result ? 'passthrough' : actionOf(a.result.action);
        visible.tokens.out = a.original ? visible.tokens.in : st?.tokensOut ?? visible.tokens.in;
        visible.tokens.trigger = quantities.trigger;
        setVisibleHeaders();
      }
      status.forwardedPrompt(creq.model, clientSession, a.original ? visible.tokens.in : a.result?.stats.tokensOut ?? visible.tokens.in);
      upstreamCalls++;
      dropRest(); // a retry: the previous attempt's error is not relayed
      if (a.n > 1) status.retries++;
      if (!firstClientByte) firstUpByte = 0; // respPath is measured on the attempt that reaches the client
      let up: UpstreamResponse;
      try {
        deps.watchdog?.phase(requestId, 'upstream');
        up = await upstream.request({
          method: 'POST', path: req.url ?? pathname, headers, body: a.body, signal: ac.signal,
          onWritten: () => {
            if (reqPathMs === undefined) reqPathMs = performance.now() - tBody;
          },
        });
      } catch (e) {
        if (clientGone) return { type: 'aborted', upstreamMs: performance.now() - t0 };
        status.upstreamUnavailable++;
        log('warn', `upstream unavailable: ${e instanceof Error ? e.message : String(e)}`);
        return { type: 'unavailable', committed, error: e instanceof Error ? e.message : String(e), upstreamMs: performance.now() - t0 };
      }
      if (up.status < 200 || up.status >= 300) {
        const { body } = await readBody(up.body);
        if (clientGone) return { type: 'aborted', upstreamMs: performance.now() - t0 };
        return {
          type: 'error', status: up.status, httpStatus: up.status, statusMessage: up.statusMessage, headers: up.rawHeaders, body,
          inStream: false, committed, upstreamMs: performance.now() - t0,
        };
      }
      const ctype = String(up.headers['content-type'] ?? '').toLowerCase();
      const sse = ctype.includes('text/event-stream') || (ctype === '' && isStreaming(a.req));
      return sse ? relaySse(a, up, t0) : relayJson(up, t0);
    };

    const write = (bufs: Buffer[], src: IncomingMessage): void => {
      if (!bufs.length) return;
      observation.o.bytes += bufs.reduce((n, b) => n + b.length, 0);
      observation.o.firstByte ||= performance.now();
      if (!firstClientByte) firstClientByte = performance.now();
      // One write, never res.cork(): a corked ServerResponse whose buffered writes pass its 64 KiB
      // highWaterMark returns false from write() but never emits 'drain' (Node 26), so the relay paused
      // the upstream forever. A burst of small events (the upstream got ahead while the event loop ran the
      // engine) or a large held-comment flush hit that and stalled the stream until idleTimeoutMs.
      const ok = res.write(bufs.length === 1 ? bufs[0]! : Buffer.concat(bufs));
      if (!ok) {
        src.pause();
        res.once('drain', () => src.resume());
      }
    };

    const relayJson = (up: UpstreamResponse, t0: number): Promise<AttemptOutcome> =>
      new Promise((resolve) => {
        commit(up.status, up.statusMessage, forwardResponseHeaders(up.rawHeaders));
        const tapChunks: Buffer[] = [];
        let tapSize = 0;
        up.body.on('data', (d: Buffer) => {
          if (!firstUpByte) firstUpByte = performance.now();
          if (tapSize < MAX_JSON_TAP) {
            tapChunks.push(d);
            tapSize += d.length;
          }
          write([d], up.body);
        });
        let done = false;
        up.body.on('end', () => {
          done = true;
          observation.end();
          const tap = tapSize < MAX_JSON_TAP ? tapJsonBody(Buffer.concat(tapChunks).toString('utf8')) : { usage: null, finishReason: null };
          observation.o.finish = tap.finishReason;
          res.end();
          resolve({ type: 'ok', status: up.status, tap, complete: true, upstreamMs: performance.now() - t0 });
        });
        up.body.on('close', () => {
          if (done) return;
          if (clientGone) resolve({ type: 'aborted', upstreamMs: performance.now() - t0 });
          else {
            observation.o.ended = true;
            observation.o.outcome = 'upstream_error';
            resolve({ type: 'unavailable', committed: true, error: 'upstream body failed', upstreamMs: performance.now() - t0 });
          }
        });
        up.body.on('error', () => undefined);
      });

    const relaySse = (a: OutgoingAttempt, up: UpstreamResponse, t0: number): Promise<AttemptOutcome> =>
      new Promise((resolve) => {
        const hold = requestCfg.stream.holdFirstEvent && !committed;
        const relay = new SseRelay({ hold, strip: a.injectedUsage, committed, detectErrors: requestCfg.errors.inStream });
        observation.o.relay = relay;
        const hdrs = forwardResponseHeaders(up.rawHeaders, { dropContentLength: true });
        let finished = false;
        let erroredAt: RelayStep['error'] | null = null;
        let holdTimer: NodeJS.Timeout | null = null;
        const apply = (step: RelayStep): void => {
          if (step.commit) commit(up.status, up.statusMessage, hdrs);
          write(step.writes, up.body);
          observation.inspect();
        };
        const finish = (o: AttemptOutcome): void => {
          if (finished) return;
          finished = true;
          if (holdTimer) clearTimeout(holdTimer);
          resolve(o);
        };
        const errorOutcome = (): ErrorOutcome => {
          const err = erroredAt!;
          const held = relay.heldBytes(); // empty once flushed (commit or hold timeout)
          return {
            type: 'error', status: inStreamErrorStatus(err.json, up.status), httpStatus: up.status, statusMessage: up.statusMessage,
            headers: up.rawHeaders, body: Buffer.from(err.payload, 'utf8'), inStream: true, committed,
            streamBytes: Buffer.concat([held, err.event.raw, relay.tail()]), upstreamMs: performance.now() - t0,
          };
        };
        if (hold) {
          // : the hold starts at the upstream headers and ends at the first event, the end of body or the timer
          holdTimer = setTimeout(() => {
            holdTimer = null;
            apply(relay.onHoldTimeout());
          }, requestCfg.stream.firstEventTimeoutMs);
          holdTimer.unref();
        } else {
          commit(up.status, up.statusMessage, hdrs); // no-op when a previous attempt committed
        }
        let cut: NodeJS.Timeout | null = null;
        // the tail bound (2 s or TAIL_MAX bytes) was hit with the stream still open: stop reading and hand
        // the rest to writeFinal, which relays it after the error if the error goes back unchanged, and
        // destroys it otherwise (a retry). Cutting it here instead silently truncated an unchanged relay.
        const park = (): void => {
          if (cut) clearTimeout(cut);
          cut = null;
          up.body.off('data', onData);
          const p: Rest = { body: up.body, parked: [], ended: false, closed: false, outcome: null };
          up.body.on('data', (d: Buffer) => p.parked.push(d)); // a stray resume() never loses bytes
          up.body.once('end', () => (p.ended = true));
          up.body.once('close', () => (p.closed = true));
          up.body.pause();
          const o = errorOutcome();
          p.outcome = o;
          rest = p;
          finish(o);
        };
        const onData = (d: Buffer): void => {
          if (!firstUpByte) firstUpByte = performance.now();
          const step = relay.onChunk(d);
          if (erroredAt) {
            if (relay.tailFull) park();
            return;
          }
          if (step.error) {
            erroredAt = step.error;
            if (holdTimer) {
              clearTimeout(holdTimer);
              holdTimer = null;
            }
            apply({ ...step, error: undefined }); // held comments stay held; nothing of the error is written
            // collect the stream's tail (e.g. `data: [DONE]`) briefly, to relay the error unchanged if needed
            if (relay.tailFull) return park();
            cut = setTimeout(park, Math.min(requestCfg.upstream.idleTimeoutMs, 2000));
            cut.unref();
            up.body.once('close', () => {
              if (cut) clearTimeout(cut);
            });
            return;
          }
          apply(step);
        };
        up.body.on('data', onData);
        up.body.on('end', () => {
          if (erroredAt) {
            finish(errorOutcome());
            return;
          }
          const last = relay.onEnd();
          if (last.error) {
            // an unterminated error event at the end of the body is still a first-event error
            erroredAt = last.error;
            finish(errorOutcome());
            return;
          }
          apply(last);
          observation.end();
          res.end();
          finish({ type: 'ok', status: up.status, tap: { usage: relay.usage, finishReason: relay.finishReason }, complete: relay.complete, upstreamMs: performance.now() - t0 });
        });
        up.body.on('close', () => {
          if (erroredAt) {
            finish(errorOutcome());
            return;
          }
          if (finished) return;
          if (clientGone) finish({ type: 'aborted', upstreamMs: performance.now() - t0 });
          else {
            observation.o.ended = true;
            observation.o.outcome = 'upstream_error';
            if (!relay.complete) log('warn', `upstream stream closed without [DONE]/finish_reason ${observation.fields()}`);
            finish({ type: 'unavailable', committed, error: 'upstream stream failed', upstreamMs: performance.now() - t0 });
          }
        });
        up.body.on('error', () => undefined);
      });

    // ---------------------------------------------------------------- the ladder
    let firstStats = true;
    const io = {
      send,
      aborted: () => clientGone,
      count: (r: ChatRequest) => {
        const n = requestCounter.countRequest(r);
        if (r === creq && firstStats) visible.tokens.in = n;
        return n;
      },
      learned: learnedForModel,
      saveLearned: (e: LearnedEntry) => {
        deps.watchdog?.phase(requestId, 'learning');
        // Discovery is runtime metadata, not an overflow learned from this request. Keep it
        // out of persisted entries so a restart can discover a larger active context.
        const model = creq.model ?? '';
        const served = Object.hasOwn(discoveredWindows, model) ? discoveredWindows[model] : undefined;
        const stored = isAutoWindow(requestCfg) && e.window === served
          ? { ...e, window: deps.state.entry(key).window }
          : e;
        deps.state.set(key, stored); // immediate memory update; async coalesced checkpoint
        if (deps.modelRuntimes) deps.modelRuntimes.setLearned(creq.model, key, stored);
        else requestEngine.setLearned(key, stored);
      },
      process: (r: ChatRequest, o: ProcessOptions): EngineResult => {
        deps.watchdog?.phase(requestId, 'planning');
        const result = requestEngine.process(r, o);
        if (firstStats) {
          firstStats = false;
          visible.tokens.in = result.stats.tokensIn;
        }
        return result;
      },
      now,
      onRewriteRejected: (ruleId: string, st: number) => status.rewriteRejected(ruleId, st),
    };
    let result: ChatResult;
    try {
      result = await runChat({ cfg: requestCfg, parsed: parsed.value, classifier, counterMode: requestCounterMode, shadow: requestCfg.shadow }, io);
    } catch (e) {
      // an internal failure before any upstream call (e.g. a stack overflow on a pathologically deep
      // body): never worse than no proxy, so the client's bytes go out unchanged (I7, as for a failed
      // count). Once an attempt was sent, resending the original would break : a 500 instead.
      dropRest();
      if (upstreamCalls > 0 || committed || clientGone) throw e;
      log('error', `ladder failed before any upstream call, forwarding the original: ${e instanceof Error ? e.message : String(e)}`);
      visible.action = 'passthrough';
      if (visible.tokens.in === null) {
        try { visible.tokens.in = requestCounter.countRequest(creq); } catch { /* count unavailable */ }
      }
      visible.tokens.out = visible.tokens.in;
      setVisibleHeaders();
      status.failedOpen('internal');
      status.action('passthrough');
      await passthrough(req, res, raw, observation);
      deps.stats.write(buildStatsRecord({
        seq, ts, path: pathname, first: null, last: null, action: 'passthrough', attempts: [], clientStatus: res.statusCode, tokensIn: null,
        correction: 1, engineMs: 0, totalMs: performance.now() - tBody, compacted: false, shadow: requestCfg.shadow, usage: null, usageMismatch: false,
        rewriteRejected: false, reason: 'internal', forwarded: 'original', ...(clientSession ? { clientSession } : {}),
      }));
      return;
    }
    if (!committed) {
      visible.action = result.final.type === 'generated' ? 'refuse' : actionOf(result.action);
      if (result.originalResent || requestCfg.shadow) visible.action = 'passthrough';
      const st = (result.last ?? result.first)?.stats;
      if (st) quantities = st.budget;
      visible.tokens.trigger = quantities.trigger;
      if (result.attempts.length === 0) visible.tokens.out = 0;
      setVisibleHeaders();
    }
    if (result.final.type === 'generated') {
      observation.o.outcome = 'refused';
    }
    else if (result.final.type === 'relay' || result.final.type === 'unavailable') observation.o.outcome = 'upstream_error';
    if (result.final.type === 'relay' && result.final.error.inStream) {
      observation.o.relay = new SseRelay({ hold: false, strip: false, committed: true, detectErrors: false });
    }
    writeFinal(res, result.final, () => committed, (c) => (committed = c), rest, (bytes) => {
      observation.o.bytes += bytes.length;
      observation.o.firstByte ||= performance.now();
      observation.o.relay?.onChunk(bytes);
    });
    if (firstUpByte && firstClientByte) respPathMs = Math.max(0, firstClientByte - firstUpByte);

    // ---------------------------------------------------------------- after the response
    const done = (): void => {
      try {
        afterChat(result, {
          seq, ts, pathname, tBody, cpu0, key, creq, clientSession, reqPathMs, respPathMs, clientStatus: clientGone && !res.headersSent ? 499 : res.statusCode,
          requestCfg, requestCounter, requestEngine,
        });
      } catch (e) {
        log('error', `post-processing failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    await new Promise<void>((resolve) => {
      const run = (): void =>
        void setImmediate(() => {
          done();
          resolve();
        });
      if (res.writableFinished || res.destroyed) run();
      else res.once('close', run);
    });
  }

  function writeFinal(res: ServerResponse, f: Final, isCommitted: () => boolean, setCommitted: (c: boolean) => void, rest: Rest | null = null, onBytes: (bytes: Buffer) => void = () => undefined): void {
    const end = (bytes: Buffer): void => { onBytes(bytes); res.end(bytes); };
    // the parked stream continues only after its own error, relayed unchanged
    const cont = rest && f.type === 'relay' && f.error === rest.outcome && f.error.inStream ? rest : null;
    if (rest && !cont) rest.body.destroy();
    if (res.writableEnded || res.destroyed) {
      cont?.body.destroy();
      return;
    }
    const committed = isCommitted();
    switch (f.type) {
      case 'relayed':
        return;
      case 'aborted':
        res.destroy();
        return;
      case 'unavailable':
        if (committed) res.destroy(); // §9: after headers, no terminating chunk
        else { const bytes = upstreamUnavailableBody(); onBytes(bytes); sendJson(res, 502, bytes); }
        return;
      case 'generated':
        if (!committed) {
          onBytes(f.body);
          sendJson(res, f.status, f.body);
          setCommitted(true);
        } else if (f.overflow) end(inStreamOverflowEvents(f.message || 'kitzur: context length exceeded'));
        else end(inStreamErrorEvents(f.status, extractErrorMessage(safeJson(f.body)) ?? 'kitzur: request failed'));
        return;
      case 'relay': {
        const e = f.error;
        if (!committed) {
          if (e.inStream) {
            res.writeHead(e.httpStatus, e.statusMessage, forwardResponseHeaders(e.headers, { dropContentLength: true }));
            endWith(res, e.streamBytes ?? e.body, cont, onBytes);
          } else {
            const hdrs = forwardResponseHeaders(e.headers, { dropContentLength: true });
            hdrs.push('content-length', String(e.body.length));
            res.writeHead(e.httpStatus, e.statusMessage, hdrs);
            end(e.body);
          }
          setCommitted(true);
        } else if (e.inStream) {
          endWith(res, e.streamBytes ?? e.body, cont, onBytes);
        } else {
          const text = e.body.toString('utf8');
          end(inStreamErrorEvents(e.status, extractErrorMessage(safeJson(text)) ?? text.slice(0, 2000)));
        }
        return;
      }
    }
  }

  interface AfterCtx {
    seq: number;
    ts: Date;
    pathname: string;
    tBody: number;
    cpu0: NodeJS.CpuUsage;
    key: string;
    creq: ChatRequest;
    clientSession: string | undefined;
    reqPathMs: number | undefined;
    respPathMs: number | undefined;
    clientStatus: number;
    requestCfg: Config;
    requestCounter: TokenCounter & { profile?: TemplateProfile };
    requestEngine: Engine;
  }

  function afterChat(r: ChatResult, c: AfterCtx): void {
    const afterCounter = c.requestCounter;
    const afterEngine = c.requestEngine;
    const afterCfg = c.requestCfg;
    const afterMode: CounterKind = afterCounter.mode === 'exact' ? 'exact' : 'estimate';
    const count = (q: ChatRequest): number => afterCounter.countRequest(q);
    const attempts = attemptRecords(r, count, afterCfg);
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]!;
      if (a.kind === 'ok') continue;
      status.errorKind(a.kind);
      status.rejection({ key: c.key, kind: a.kind, rule: r.attempts[i]!.ruleId ?? null, status: a.status, inStream: a.inStream, raw: a.raw, overshoot: a.overshoot ?? null });
    }
    for (let i = 1; i < r.attempts.length; i++) if (r.attempts[i]!.attempt.n === r.attempts[i - 1]!.attempt.n) status.usageRetries++;
    status.action(r.action);
    if (r.guard) status.guard(r.guard);
    if (r.first?.replan) status.replan(r.first.replan);
    if (r.first?.sessionKey) status.session(r.first.sessionKey);
    if (r.originalResent) status.originalResent++;
    if (r.final.type === 'aborted') status.aborted++;
    const incomplete = r.final.type === 'relayed' && r.sent !== null && isStreaming(r.sent.req) && !r.complete;
    if (incomplete) status.upstreamIncomplete++;

    // calibration (): usage of the attempt that reached the client, else the tokenize endpoint
    let usageMismatch = false;
    const e0 = deps.state.entry(c.key);
    const sent = r.sent;
    const usage = r.tap?.usage ?? null;
    status.completionUsage(usage?.completion_tokens, budgetQuantities(afterCfg, e0).allowance);
    const budgetOf = (a: OutgoingAttempt): number => a.result?.stats?.budget?.budget ?? serverLimits(afterCfg, e0, a.extraTighten).budget;
    const learnSample = (counted: number, reported: number, source: 'usage' | 'endpoint', a: OutgoingAttempt): void => {
      const v = judgeSample({
        cfg: afterCfg, mode: afterMode, budget: budgetOf(a), counted, reported, source, complete: r.complete, finishReason: r.tap?.finishReason ?? null,
        sameAttempt: true, silentTruncate: budgetModeOf(afterCfg) === 'silent_truncate',
      });
      if (v.warning) status.warn('silent_truncate', v.warning);
      if (v.verdict === 'mismatch') {
        usageMismatch = true;
        status.usageMismatch++;
        status.warn('usage_mismatch', `usage_mismatch: ${v.reason ?? ''}`);
      }
      if (v.verdict !== 'accepted') return;
      const cur = deps.state.entry(c.key);
      const applied = applyAcceptedRatio(cur, v.ratio, afterCfg, afterMode, now());
      deps.state.set(c.key, applied.entry);
      if (applied.correctionChanged) {
        if (deps.modelRuntimes) deps.modelRuntimes.setLearned(c.creq.model, c.key, applied.entry);
        else afterEngine.setLearned(c.key, applied.entry);
      }
    };
    if (sent && r.final.type === 'relayed') {
      status.forwardedPrompt(c.creq.model, c.clientSession, usage?.prompt_tokens ?? null);
      const reported = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null;
      const counted = sent.size?.raw ?? NaN; // counted once, by attemptRecords above
      if (reported !== null) {
        if (Number.isFinite(counted)) learnSample(counted, reported, 'usage', sent);
      } else if (endpoint) {
        if (Number.isFinite(counted)) {
          void endpoint.count(sent.req).then((n) => {
            if (n !== null) learnSample(counted, n, 'endpoint', sent);
          });
        }
      }
    }

    let tokensIn: number | null = null;
    if (!r.first) {
      try {
        tokensIn = count(c.creq);
      } catch {
        tokensIn = null;
      }
    }
    const cpu = process.cpuUsage(c.cpu0);
    const totalMs = performance.now() - c.tBody;
    const upstreamMs = attempts.reduce((s, a) => s + a.upstreamMs, 0);
    status.latency(totalMs, (c.reqPathMs ?? 0) + (c.respPathMs ?? 0), r.engineMs);
    deps.stats.write(buildStatsRecord({
      seq: c.seq, ts: c.ts, path: c.pathname, first: r.first, last: r.last, action: r.action, attempts, clientStatus: c.clientStatus,
      tokensIn, correction: e0.correction, engineMs: r.engineMs, totalMs, compacted: r.compacted, shadow: afterCfg.shadow,
      forwarded: r.attempts.length === 0 ? 'none' : r.attempts[r.attempts.length - 1]!.attempt.original ? 'original' : 'engine',
      usage: usage ? { ...(typeof usage.prompt_tokens === 'number' ? { prompt_tokens: usage.prompt_tokens } : {}), ...(typeof usage.completion_tokens === 'number' ? { completion_tokens: usage.completion_tokens } : {}) } : null,
      usageMismatch, rewriteRejected: r.rewriteRejected !== undefined,
      ...(r.guard ? { guard: r.guard } : {}), ...(r.reason ? { reason: r.reason } : {}),
      ...(c.clientSession ? { clientSession: c.clientSession } : {}),
      incomplete, originalResent: r.originalResent, usageInjected: r.sent?.injectedUsage ?? false,
      ...(c.reqPathMs !== undefined ? { reqPathMs: c.reqPathMs } : {}),
      ...(c.respPathMs !== undefined ? { respPathMs: c.respPathMs } : {}),
      cpuUs: cpu.user + cpu.system,
      upstreamMs,
    }));
  }

  // ------------------------------------------------------------------ lifecycle
  return {
    server,
    status,
    upstream,
    active: () => inflight,
    snapshot,
    async probe() {
      const p = await upstream.probe();
      discoveredWindows = p.discovered_window ?? {};
      if (deps.modelRuntimes) deps.modelRuntimes.setDiscoveredWindows(discoveredWindows);
      else setDiscoveredWindows(cfg, discoveredWindows);
      status.setDiscoveredWindows(discoveredWindows);
      for (const [model, window] of Object.entries(discoveredWindows)) {
        const modelCfg = deps.modelRuntimes?.forModel(model).cfg ?? cfg;
        if (window !== modelCfg.budget.window) {
          const message = `Model ${JSON.stringify(model)} reports context window ${window}; budget.window is ${modelCfg.budget.window}${isAutoWindow(modelCfg) ? ' (auto fallback); using the discovered window' : '; set budget.window=auto to use the discovered window'}.`;
          status.warn(`window_mismatch:${model}`, message);
          log('warn', message);
        }
      }
      if (isAutoWindow(cfg) && !Object.keys(discoveredWindows).length) {
        const message = `No upstream context window discovered; budget.window=auto uses fallback ${cfg.budget.window}.`;
        status.warn('window_auto_fallback', message);
        log('warn', message);
      }
      status.setProbe({ ...p, at: now().toISOString() });
      if (!p.ok) status.warn('upstream_probe', p.tlsError ? `TLS verification failed: ${p.tlsError}` : `upstream probe failed: ${p.error ?? p.status}`);
      return p;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(cfg.listen.port, cfg.listen.host, () => {
          server.off('error', reject);
          const a = server.address() as AddressInfo;
          resolve({ port: a.port, host: cfg.listen.host });
        });
      });
    },
    async close(drainMs = 10_000) {
      if (closing) return;
      closing = true;
      server.close();
      server.closeIdleConnections();
      if (inflight > 0) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, drainMs);
          t.unref();
          idleWaiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      for (const s of sockets) s.destroy();
      await deps.state.close();
      await deps.stats.close();
      upstream.close();
      deps.remote?.close();
    },
  };
}

/** The parked rest of an upstream stream (see relaySse park()). */
interface Rest {
  body: IncomingMessage;
  /** bytes that arrived after the park (a stray resume) */
  parked: Buffer[];
  ended: boolean;
  closed: boolean;
  /** the error outcome this rest belongs to */
  outcome: ErrorOutcome | null;
}

/** Writes `bytes`, then the parked rest of the stream as it arrives (or ends the response at once without one). */
function endWith(res: ServerResponse, bytes: Buffer, rest: Rest | null, onBytes: (bytes: Buffer) => void = () => undefined): void {
  onBytes(bytes);
  if (!rest) {
    res.end(bytes);
    return;
  }
  const up = rest.body;
  res.write(bytes);
  for (const b of rest.parked.splice(0)) { onBytes(b); res.write(b); }
  if (rest.ended) {
    res.end();
    return;
  }
  if (rest.closed) {
    res.destroy(); // the upstream failed after the error: no terminating chunk (§9)
    return;
  }
  up.removeAllListeners('data');
  up.on('data', (d: Buffer) => {
    onBytes(d);
    if (!res.write(d)) {
      up.pause();
      res.once('drain', () => up.resume());
    }
  });
  up.once('end', () => res.end());
  up.once('close', () => {
    if (!res.writableEnded) res.destroy();
  });
  res.once('close', () => {
    if (!res.writableEnded) up.destroy();
  });
  up.resume();
}

function safeJson(x: Buffer | string): unknown {
  try {
    return JSON.parse(typeof x === 'string' ? x : x.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * SIGTERM/SIGINT: stop accepting, drain in-flight streams for up to drainMs, flush state and stats,
 * then call onExit (default process.exit(0)). Returns a function that removes the handlers.
 */
export function installSignalHandlers(p: ProxyServer, opts: { drainMs?: number; onExit?: (code: number) => void } = {}): () => void {
  const onExit = opts.onExit ?? ((code: number) => process.exit(code));
  let stopping = false;
  const handler = (): void => {
    if (stopping) return;
    stopping = true;
    p.close(opts.drainMs ?? 10_000).then(
      () => onExit(0),
      () => onExit(1),
    );
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  return () => {
    process.off('SIGTERM', handler);
    process.off('SIGINT', handler);
  };
}
