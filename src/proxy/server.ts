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
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Config } from '../config/schema.js';
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
import { StatusTracker } from './status.js';
import { applyAcceptedRatio, EndpointCalibrator, judgeSample, type CounterKind } from './calibration.js';
import { budgetModeOf, serverLimits } from './budget.js';

export const KITZUR_VERSION = '0.1.0';

/** Test-only fault injection (KITZUR_TEST_FAULTS=engine-throw:0.01): the engine throws on attempt 1. */
export interface Faults {
  engineThrow: number;
  random?: () => number;
}

export class InjectedFault extends Error {
  constructor() {
    super('injected engine fault');
    this.name = 'InjectedFault';
  }
}

/**
 * Parses KITZUR_TEST_FAULTS (`engine-throw:<probability>[:<seed>]`); null when unset or malformed.
 * With a seed the faults are reproducible (mulberry32), else Math.random decides.
 */
export function parseFaults(v: string | undefined): Faults | null {
  if (!v) return null;
  const m = /^engine-throw:(0(?:\.\d+)?|1(?:\.0+)?)(?::(\d+))?$/.exec(v.trim());
  if (!m) return null;
  const f: Faults = { engineThrow: Number(m[1]) };
  if (m[2] !== undefined) {
    let s = Number(m[2]) >>> 0;
    f.random = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  return f;
}

export interface ProxyDeps {
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
  faults?: Faults | null;
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

const MAX_REQUEST_BYTES = 256 * 1024 * 1024;
const MAX_JSON_TAP = 4 * 1024 * 1024;
const JSON_CT = 'application/json';

function sendJson(res: ServerResponse, status: number, body: Buffer | string, extra: Record<string, string> = {}): void {
  const b = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, { 'content-type': JSON_CT, 'content-length': String(b.length), ...extra });
  res.end(b);
}

export function createProxyServer(config: Config, deps: ProxyDeps): ProxyServer {
  const cfg = config;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  if (deps.counter.mode === 'remote') throw new Error('the proxy needs a local counter (exact or estimate); remote is a calibration source only');
  const counterMode: CounterKind = deps.counter.mode === 'exact' ? 'exact' : 'estimate';
  const upstream = deps.upstream ?? new Upstream(cfg.upstream);
  const origin = upstream.origin.origin + upstream.origin.pathname.replace(/\/+$/, '');
  const classifier = new ErrorClassifier(cfg.errors);
  const status = new StatusTracker(cfg, KITZUR_VERSION, () => now().getTime());
  const endpoint = deps.remote && deps.counter.profile ? new EndpointCalibrator(deps.remote, deps.counter.profile) : null;
  const faults = deps.faults === undefined ? parseFaults(process.env['KITZUR_TEST_FAULTS']) : deps.faults;
  const mode = budgetModeOf(cfg);
  for (const [k, e] of Object.entries(deps.state.entries())) deps.engine.setLearned(k, e);
  if (deps.state.discarded.length) status.warn('learned_discarded', `${deps.state.discarded.length} learned entries discarded (window or counter changed)`);
  if (deps.state.lastError) status.warn('state', deps.state.lastError);

  let inflight = 0;
  let closing = false;
  const sockets = new Set<Socket>();
  const idleWaiters: Array<() => void> = [];
  const settle = (): void => {
    if (inflight === 0) for (const w of idleWaiters.splice(0)) w();
  };

  const server = http.createServer({ noDelay: true }, (req, res) => {
    // in flight until the response is done *and* its stats/calibration ran (the drain waits for both)
    inflight++;
    handle(req, res)
      .catch((e: unknown) => {
        log('error', `request failed: ${e instanceof Error ? e.message : String(e)}`);
        if (!res.headersSent) sendJson(res, 500, errorBody('kitzur: internal error', 'api_error', 'kitzur_internal_error'));
        else res.destroy();
      })
      .finally(() => {
        inflight--;
        settle();
      });
  });
  server.on('connection', (s: Socket) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });

  const snapshot = (): Record<string, unknown> =>
    status.snapshot({
      counter: { mode: deps.counter.mode, id: deps.counter.id },
      learned: deps.state.entries(),
      stateError: deps.state.lastError,
      statsPath: deps.stats.path,
      statsError: deps.stats.lastError,
      upstream: { origin, ...upstream.stats, endpoint: deps.remote ? deps.remote.stats() : null },
    });

  // ------------------------------------------------------------------ routing
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    status.requests++;
    if (!hostAllowed(req.headers.host, cfg.listen.allowedHosts)) {
      status.hostRejected++;
      sendJson(res, 403, errorBody('kitzur: this host name is not served (listen.allowedHosts)', 'permission_error', 'host_not_allowed'));
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
    const body = await readRequest(req);
    if (body === null) {
      if (!res.headersSent && !req.destroyed) sendJson(res, 413, errorBody('kitzur: request body too large', 'invalid_request_error', 'request_too_large'));
      return;
    }
    const tBody = performance.now();
    if (isChatCompletionsPath(req.method ?? '', pathname)) await handleChat(req, res, body, pathname, tBody);
    else await passthrough(req, res, body);
  }

  function readRequest(req: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let over = false;
      req.on('data', (d: Buffer) => {
        size += d.length;
        if (size > MAX_REQUEST_BYTES) over = true;
        else chunks.push(d);
      });
      req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
      req.on('error', () => resolve(null));
      req.on('aborted', () => resolve(null));
    });
  }

  // ------------------------------------------------------------------ pass-through
  async function passthrough(req: IncomingMessage, res: ServerResponse, body: Buffer): Promise<void> {
    status.passthroughRequests++;
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) ac.abort();
    });
    let up: UpstreamResponse;
    try {
      up = await upstream.request({ method: req.method ?? 'GET', path: req.url ?? '/', headers: forwardRequestHeaders(req.rawHeaders, cfg.upstream.headers), body, signal: ac.signal });
    } catch {
      if (!res.headersSent && !ac.signal.aborted) {
        status.upstreamUnavailable++;
        sendJson(res, 502, upstreamUnavailableBody());
      }
      return;
    }
    res.writeHead(up.status, up.statusMessage, forwardResponseHeaders(up.rawHeaders));
    await new Promise<void>((resolve) => {
      up.body.on('data', (d: Buffer) => {
        if (!res.write(d)) {
          up.body.pause();
          res.once('drain', () => up.body.resume());
        }
      });
      up.body.on('end', () => {
        res.end();
        resolve();
      });
      up.body.on('error', () => {
        res.destroy();
        resolve();
      });
      up.body.on('close', () => {
        if (!res.writableEnded) res.destroy();
        resolve();
      });
    });
  }

  // ------------------------------------------------------------------ chat
  async function handleChat(req: IncomingMessage, res: ServerResponse, raw: Buffer, pathname: string, tBody: number): Promise<void> {
    status.chatRequests++;
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
      res.writeHead(st, msg, hdrs);
      res.flushHeaders();
    };

    // fail-open: compressed or unparseable bodies are forwarded unchanged
    const enc = req.headers['content-encoding'];
    const parsed = enc && enc !== 'identity' ? ({ ok: false, reason: 'content_encoding' } as const) : parseChatRequest(raw);
    if (!parsed.ok) {
      status.failedOpen(parsed.reason);
      status.action('passthrough');
      await passthrough(req, res, raw);
      deps.stats.write(buildStatsRecord({
        seq, ts, path: pathname, first: null, last: null, action: 'passthrough', attempts: [], clientStatus: res.statusCode, tokensIn: null,
        correction: 1, engineMs: 0, totalMs: performance.now() - tBody, compacted: false, shadow: cfg.shadow, usage: null, usageMismatch: false,
        rewriteRejected: false, reason: `parse:${parsed.reason}`, forwarded: 'original', ...(clientSession ? { clientSession } : {}),
      }));
      return;
    }
    const creq = parsed.value.req;
    const key = learnedKey(origin, creq.model);

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
      upstreamCalls++;
      dropRest(); // a retry: the previous attempt's error is not relayed
      if (a.n > 1) status.retries++;
      if (!firstClientByte) firstUpByte = 0; // respPath is measured on the attempt that reaches the client
      let up: UpstreamResponse;
      try {
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
          res.end();
          const tap = tapSize < MAX_JSON_TAP ? tapJsonBody(Buffer.concat(tapChunks).toString('utf8')) : { usage: null, finishReason: null };
          resolve({ type: 'ok', status: up.status, tap, complete: true, upstreamMs: performance.now() - t0 });
        });
        up.body.on('close', () => {
          if (done) return;
          if (clientGone) resolve({ type: 'aborted', upstreamMs: performance.now() - t0 });
          else resolve({ type: 'unavailable', committed: true, error: 'upstream body failed', upstreamMs: performance.now() - t0 });
        });
        up.body.on('error', () => undefined);
      });

    const relaySse = (a: OutgoingAttempt, up: UpstreamResponse, t0: number): Promise<AttemptOutcome> =>
      new Promise((resolve) => {
        const hold = cfg.stream.holdFirstEvent && !committed;
        const relay = new SseRelay({ hold, strip: a.injectedUsage, committed, detectErrors: cfg.errors.inStream });
        const hdrs = forwardResponseHeaders(up.rawHeaders, { dropContentLength: true });
        let finished = false;
        let erroredAt: RelayStep['error'] | null = null;
        let holdTimer: NodeJS.Timeout | null = null;
        const apply = (step: RelayStep): void => {
          if (step.commit) commit(up.status, up.statusMessage, hdrs);
          write(step.writes, up.body);
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
          }, cfg.stream.firstEventTimeoutMs);
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
            cut = setTimeout(park, Math.min(cfg.upstream.idleTimeoutMs, 2000));
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
          else finish({ type: 'unavailable', committed, error: 'upstream stream failed', upstreamMs: performance.now() - t0 });
        });
        up.body.on('error', () => undefined);
      });

    // ---------------------------------------------------------------- the ladder
    const io = {
      send,
      aborted: () => clientGone,
      count: (r: ChatRequest) => deps.counter.countRequest(r),
      learned: () => deps.state.entry(key),
      saveLearned: (e: LearnedEntry) => {
        deps.state.set(key, e); // atomic and synchronous for planning changes
        deps.engine.setLearned(key, e);
      },
      process: (r: ChatRequest, o: ProcessOptions): EngineResult => {
        if (faults && o.attempt === 1 && (faults.random ?? Math.random)() < faults.engineThrow) throw new InjectedFault();
        return deps.engine.process(r, o);
      },
      now,
      onRewriteRejected: (ruleId: string, st: number) => status.rewriteRejected(ruleId, st),
    };
    let result: ChatResult;
    try {
      result = await runChat({ cfg, parsed: parsed.value, classifier, counterMode, shadow: cfg.shadow }, io);
    } catch (e) {
      // an internal failure before any upstream call (e.g. a stack overflow on a pathologically deep
      // body): never worse than no proxy, so the client's bytes go out unchanged (I7, as for a failed
      // count). Once an attempt was sent, resending the original would break : a 500 instead.
      dropRest();
      if (upstreamCalls > 0 || committed || clientGone) throw e;
      log('error', `ladder failed before any upstream call, forwarding the original: ${e instanceof Error ? e.message : String(e)}`);
      status.failedOpen('internal');
      status.action('passthrough');
      await passthrough(req, res, raw);
      deps.stats.write(buildStatsRecord({
        seq, ts, path: pathname, first: null, last: null, action: 'passthrough', attempts: [], clientStatus: res.statusCode, tokensIn: null,
        correction: 1, engineMs: 0, totalMs: performance.now() - tBody, compacted: false, shadow: cfg.shadow, usage: null, usageMismatch: false,
        rewriteRejected: false, reason: 'internal', forwarded: 'original', ...(clientSession ? { clientSession } : {}),
      }));
      return;
    }
    writeFinal(res, result.final, () => committed, (c) => (committed = c), rest);
    if (firstUpByte && firstClientByte) respPathMs = Math.max(0, firstClientByte - firstUpByte);

    // ---------------------------------------------------------------- after the response
    const done = (): void => {
      try {
        afterChat(result, {
          seq, ts, pathname, tBody, cpu0, key, creq, clientSession, reqPathMs, respPathMs, clientStatus: clientGone && !res.headersSent ? 499 : res.statusCode,
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

  function writeFinal(res: ServerResponse, f: Final, isCommitted: () => boolean, setCommitted: (c: boolean) => void, rest: Rest | null = null): void {
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
        else sendJson(res, 502, upstreamUnavailableBody());
        return;
      case 'generated':
        if (!committed) {
          sendJson(res, f.status, f.body);
          setCommitted(true);
        } else if (f.overflow) res.end(inStreamOverflowEvents(f.message || 'kitzur: context length exceeded'));
        else res.end(inStreamErrorEvents(f.status, extractErrorMessage(safeJson(f.body)) ?? 'kitzur: request failed'));
        return;
      case 'relay': {
        const e = f.error;
        if (!committed) {
          if (e.inStream) {
            res.writeHead(e.httpStatus, e.statusMessage, forwardResponseHeaders(e.headers, { dropContentLength: true }));
            endWith(res, e.streamBytes ?? e.body, cont);
          } else {
            const hdrs = forwardResponseHeaders(e.headers, { dropContentLength: true });
            hdrs.push('content-length', String(e.body.length));
            res.writeHead(e.httpStatus, e.statusMessage, hdrs);
            res.end(e.body);
          }
          setCommitted(true);
        } else if (e.inStream) {
          endWith(res, e.streamBytes ?? e.body, cont);
        } else {
          const text = e.body.toString('utf8');
          res.end(inStreamErrorEvents(e.status, extractErrorMessage(safeJson(text)) ?? text.slice(0, 2000)));
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
  }

  function afterChat(r: ChatResult, c: AfterCtx): void {
    const count = (q: ChatRequest): number => deps.counter.countRequest(q);
    const attempts = attemptRecords(r, count, cfg);
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
    const budgetOf = (a: OutgoingAttempt): number => a.result?.stats?.budget?.budget ?? serverLimits(cfg, e0, a.extraTighten).budget;
    const learnSample = (counted: number, reported: number, source: 'usage' | 'endpoint', a: OutgoingAttempt): void => {
      const v = judgeSample({
        cfg, mode: counterMode, budget: budgetOf(a), counted, reported, source, complete: r.complete, finishReason: r.tap?.finishReason ?? null,
        sameAttempt: true, silentTruncate: mode === 'silent_truncate',
      });
      if (v.warning) status.warn('silent_truncate', v.warning);
      if (v.verdict === 'mismatch') {
        usageMismatch = true;
        status.usageMismatch++;
        status.warn('usage_mismatch', `usage_mismatch: ${v.reason ?? ''}`);
      }
      if (v.verdict !== 'accepted') return;
      const cur = deps.state.entry(c.key);
      const applied = applyAcceptedRatio(cur, v.ratio, cfg, counterMode, now());
      deps.state.set(c.key, applied.entry);
      if (applied.correctionChanged) deps.engine.setLearned(c.key, applied.entry);
    };
    if (sent && r.final.type === 'relayed') {
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
      tokensIn, correction: e0.correction, engineMs: r.engineMs, totalMs, compacted: r.compacted, shadow: cfg.shadow,
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
      deps.state.flush();
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
function endWith(res: ServerResponse, bytes: Buffer, rest: Rest | null): void {
  if (!rest) {
    res.end(bytes);
    return;
  }
  const up = rest.body;
  res.write(bytes);
  for (const b of rest.parked.splice(0)) res.write(b);
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
