// The upstream connection (DESIGN.md "Upstream framing and headers", "Keep-alive", "TLS"; ).
//
//  - node:http / node:https with keep-alive agents (LIFO reuse); idle pooled sockets close after
//    upstream.keepAliveIdleMs (uvicorn closes at 5 s, so 4 s avoids racing the server's close);
//  - every request carries content-length = Buffer.byteLength(body), never chunked;
//  - request headers: hop-by-hop headers and every header named in `Connection` are dropped, as are
//    host, content-length and expect; accept-encoding is forced to identity (the tap and the error
//    classifier need plain text); upstream.headers are added; everything else (authorization,
//    x-sim-step, X-Session-Id, ...) is forwarded. Response headers lose their hop-by-hop headers;
//  - one transparent retry when a *reused* keep-alive socket fails with ECONNRESET/EPIPE before any
//    response byte (the server closed it while idle; a socket that already received bytes for this
//    request is never retried). It repeats the same attempt on a fresh connection and teaches nothing;
//  - a 101 answer or a close before the response headers fails the attempt (Node emits no 'error');
//  - timeouts: upstream.timeoutMs until the response headers, upstream.idleTimeoutMs between chunks;
//    an AbortSignal (client disconnect) destroys the request and its response;
//  - TLS: ca = [...tls.rootCertificates, upstream.caFile] when a CA file is configured;
//    upstream.insecureTls disables verification. HTTP(S)_PROXY is not honoured.
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ClientRequest, OutgoingHttpHeaders } from 'node:http';
import type { Socket } from 'node:net';
import type { Config } from '../config/schema.js';

export const HOP_BY_HOP: ReadonlySet<string> = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const REQUEST_DROP: ReadonlySet<string> = new Set([...HOP_BY_HOP, 'host', 'content-length', 'expect', 'accept-encoding']);

/** Header names listed in Connection header values (lower-cased). */
function connectionNamed(raw: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() !== 'connection') continue;
    for (const t of raw[i + 1]!.split(',')) {
      const n = t.trim().toLowerCase();
      if (n) out.add(n);
    }
  }
  return out;
}

/**
 * The headers of an upstream request from the client's raw headers (flat [name, value, ...] as in
 * IncomingMessage.rawHeaders). Names are lower-cased; repeated headers stay repeated.
 */
export function forwardRequestHeaders(clientRaw: readonly string[], extra: Readonly<Record<string, string>> = {}): Record<string, string | string[]> {
  const named = connectionNamed(clientRaw);
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i + 1 < clientRaw.length; i += 2) {
    const name = clientRaw[i]!.toLowerCase();
    if (REQUEST_DROP.has(name) || named.has(name)) continue;
    const v = clientRaw[i + 1]!;
    const prev = out[name];
    out[name] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  for (const [k, v] of Object.entries(extra)) out[k.toLowerCase()] = v;
  out['accept-encoding'] = 'identity';
  return out;
}

/** Response headers for the client (flat raw form, case and order kept) without hop-by-hop headers. */
export function forwardResponseHeaders(raw: readonly string[], opts: { dropContentLength?: boolean } = {}): string[] {
  const named = connectionNamed(raw);
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i]!.toLowerCase();
    if (HOP_BY_HOP.has(name) || named.has(name)) continue;
    if (opts.dropContentLength && name === 'content-length') continue;
    out.push(raw[i]!, raw[i + 1]!);
  }
  return out;
}

export type UpstreamErrorCode = 'connect' | 'timeout' | 'idle' | 'reset' | 'tls' | 'aborted' | 'other';

export class UpstreamError extends Error {
  readonly code: UpstreamErrorCode;
  constructor(code: UpstreamErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.name = 'UpstreamError';
  }
}

const TLS_ERROR = /CERT|SELF_SIGNED|UNABLE_TO_|TLS|SSL|ALTNAME/i;

function classifyNetError(e: unknown): UpstreamError {
  if (e instanceof UpstreamError) return e;
  const code = (e as NodeJS.ErrnoException)?.code ?? '';
  const msg = e instanceof Error ? e.message : String(e);
  if (TLS_ERROR.test(code)) return new UpstreamError('tls', `${code}: ${msg}`, e);
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return new UpstreamError('connect', `${code}: ${msg}`, e);
  if (code === 'ECONNRESET' || code === 'EPIPE') return new UpstreamError('reset', `${code}: ${msg}`, e);
  return new UpstreamError('other', code ? `${code}: ${msg}` : msg, e);
}

export interface UpstreamRequest {
  method: string;
  /** the client's path and query, appended to the origin unchanged */
  path: string;
  headers: Record<string, string | string[]>;
  body: Buffer;
  signal?: AbortSignal;
  /** called once the request body has been handed to the socket (reqPath timing) */
  onWritten?: () => void;
}

export interface UpstreamResponse {
  status: number;
  statusMessage: string;
  rawHeaders: string[];
  headers: http.IncomingHttpHeaders;
  /** the body stream; it errors with UpstreamError('idle') after idleTimeoutMs of silence */
  body: IncomingMessage;
  /** ms from send to the response headers */
  headerMs: number;
  /** the request went out on a reused keep-alive socket */
  reused: boolean;
  /** the transparent retry happened */
  retried: boolean;
}

export interface UpstreamStats {
  requests: number;
  reusedSockets: number;
  transportRetries: number;
  errors: number;
}

export interface ProbeResult {
  ok: boolean;
  status?: number;
  /** a TLS verification failure: startup must exit non-zero */
  tlsError?: string;
  error?: string;
}

export class Upstream {
  readonly origin: URL;
  private readonly basePath: string;
  private readonly agent: http.Agent;
  private readonly lib: typeof http | typeof https;
  private readonly tlsOpts: { rejectUnauthorized?: boolean; ca?: string[] };
  readonly stats: UpstreamStats = { requests: 0, reusedSockets: 0, transportRetries: 0, errors: 0 };

  constructor(private readonly cfg: Config['upstream']) {
    if (!cfg.origin) throw new Error('upstream.origin is not set');
    this.origin = new URL(cfg.origin);
    this.basePath = this.origin.pathname.replace(/\/+$/, '');
    const isHttps = this.origin.protocol === 'https:';
    if (!isHttps && this.origin.protocol !== 'http:') throw new Error(`upstream.origin: unsupported scheme ${this.origin.protocol}`);
    this.lib = isHttps ? https : http;
    this.tlsOpts = isHttps
      ? {
          rejectUnauthorized: !cfg.insecureTls,
          ...(cfg.caFile ? { ca: [...tls.rootCertificates, readFileSync(cfg.caFile, 'utf8')] } : {}),
        }
      : {};
    const agentOpts = { keepAlive: true, timeout: cfg.keepAliveIdleMs, scheduling: 'lifo' as const, ...this.tlsOpts };
    this.agent = isHttps ? new https.Agent(agentOpts) : new http.Agent(agentOpts);
  }

  /** Sends one request; resolves at the response headers, rejects with UpstreamError before them. */
  request(r: UpstreamRequest): Promise<UpstreamResponse> {
    this.stats.requests++;
    const t0 = performance.now();
    return this.send(r, false).then(
      (res) => ({ ...res, headerMs: performance.now() - t0 }),
      (e: unknown) => {
        this.stats.errors++;
        throw e;
      },
    );
  }

  private send(r: UpstreamRequest, retry: boolean): Promise<Omit<UpstreamResponse, 'headerMs'>> {
    return new Promise((resolve, reject) => {
      if (r.signal?.aborted) {
        reject(new UpstreamError('aborted', 'aborted'));
        return;
      }
      const headers: OutgoingHttpHeaders = { ...r.headers, 'content-length': r.body.length };
      const req: ClientRequest = this.lib.request({
        protocol: this.origin.protocol,
        hostname: this.origin.hostname.replace(/^\[|\]$/g, ''),
        port: this.origin.port || undefined,
        method: r.method,
        path: this.basePath + r.path,
        headers,
        // the transparent retry uses a fresh connection: another pooled socket may be just as stale
        agent: retry ? false : this.agent,
        ...this.tlsOpts,
      });
      let settled = false;
      let response: IncomingMessage | null = null;
      const headerTimer = setTimeout(() => req.destroy(new UpstreamError('timeout', `no response headers within ${this.cfg.timeoutMs} ms`)), this.cfg.timeoutMs);
      const onAbort = (): void => {
        const e = new UpstreamError('aborted', 'aborted by the client');
        req.destroy(e);
        response?.destroy(e);
      };
      r.signal?.addEventListener('abort', onAbort, { once: true });
      // "before any response byte" (the transparent retry below): a server that already started its
      // answer on the reused socket processed the request, and resending it would run it twice
      let responseBytes = false;
      let sockSeen: Socket | null = null;
      const onFirstBytes = (): void => {
        responseBytes = true;
      };
      req.once('socket', (sock) => {
        sockSeen = sock;
        sock.on('data', onFirstBytes);
      });
      const cleanup = (): void => {
        clearTimeout(headerTimer);
        r.signal?.removeEventListener('abort', onAbort);
        sockSeen?.off('data', onFirstBytes);
      };
      req.on('error', (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        const code = (e as NodeJS.ErrnoException).code;
        if (!retry && req.reusedSocket && !responseBytes && (code === 'ECONNRESET' || code === 'EPIPE') && !r.signal?.aborted) {
          this.stats.transportRetries++;
          this.send(r, true).then((res) => resolve({ ...res, retried: true }), reject);
          return;
        }
        reject(r.signal?.aborted ? new UpstreamError('aborted', 'aborted by the client') : classifyNetError(e));
      });
      // A 101 answer (no 'upgrade' listener: Node destroys the socket) and any other close before the
      // response headers emit no 'error': without these the attempt would wait forever, past timeoutMs.
      const failEarly = (e: UpstreamError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(r.signal?.aborted ? new UpstreamError('aborted', 'aborted by the client') : e);
      };
      req.on('upgrade', (_res: IncomingMessage, sock: { destroy(): void }) => {
        sock.destroy();
        failEarly(new UpstreamError('other', 'the upstream answered 101 Switching Protocols'));
      });
      req.on('close', () => failEarly(new UpstreamError('reset', 'connection closed before the response headers')));
      req.on('response', (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        clearTimeout(headerTimer);
        sockSeen?.off('data', onFirstBytes);
        response = res;
        if (req.reusedSocket) this.stats.reusedSockets++;
        // idle timeout between chunks: watched on the socket, so the body stays paused until the
        // caller attaches its own listeners (a 'data' listener here would start the flow and lose data)
        const idle = setTimeout(() => res.destroy(new UpstreamError('idle', `no data for ${this.cfg.idleTimeoutMs} ms`)), this.cfg.idleTimeoutMs);
        const sock = req.socket;
        const onSocketData = (): void => void idle.refresh();
        sock?.on('data', onSocketData);
        res.once('close', () => {
          clearTimeout(idle);
          sock?.off('data', onSocketData);
          r.signal?.removeEventListener('abort', onAbort);
        });
        resolve({
          status: res.statusCode ?? 502,
          statusMessage: res.statusMessage ?? '',
          rawHeaders: res.rawHeaders,
          headers: res.headers,
          body: res,
          reused: req.reusedSocket,
          retried: false,
        });
      });
      req.end(r.body, () => r.onWritten?.());
    });
  }

  /** Startup probe: GET <origin>/v1/models. A TLS verification failure is reported as tlsError. */
  async probe(path = '/v1/models', headers: Record<string, string> = {}): Promise<ProbeResult> {
    try {
      const res = await this.request({ method: 'GET', path, headers: forwardRequestHeaders([], { ...this.cfg.headers, ...headers }), body: Buffer.alloc(0) });
      res.body.resume();
      return { ok: res.status >= 200 && res.status < 500, status: res.status };
    } catch (e) {
      const u = classifyNetError(e);
      return u.code === 'tls' ? { ok: false, tlsError: u.message } : { ok: false, error: u.message };
    }
  }

  close(): void {
    this.agent.destroy();
  }
}

/** Reads a whole body (bounded); resolves with what arrived when the stream fails or is cut at `max`. */
export function readBody(stream: NodeJS.ReadableStream, max = 16 * 1024 * 1024): Promise<{ body: Buffer; complete: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (complete: boolean): void => {
      if (done) return;
      done = true;
      resolve({ body: Buffer.concat(chunks), complete });
    };
    stream.on('data', (d: Buffer) => {
      if (size < max) {
        chunks.push(d);
        size += d.length;
      }
    });
    stream.on('end', () => finish(true));
    stream.on('error', () => finish(false));
    stream.on('close', () => finish(false));
  });
}
