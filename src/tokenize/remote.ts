// Gateway tokenize endpoints (DESIGN.md fallback 1; reference implementation). Used per rendered
// segment text, so the same segment cache applies as in exact mode:
//   vllm      POST /tokenize     {model?, prompt, add_special_tokens:false}   -> {count}
//   sglang    POST /v1/tokenize  {model?, prompt, add_special_tokens:false}   -> {count}
//   llamacpp  POST /tokenize     {content, add_special:false, parse_special:true} -> {tokens:[...]}
//   tgi       POST /tokenize     {inputs}                                     -> [{id,text,...}, ...]
// Every call resolves (never rejects): null means "unknown, use the estimate". After a failure the
// endpoint is skipped for `failureBackoffMs` so a dead gateway costs one timeout, not one per request.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { Config } from '../config/schema.js';

export type TokenizeStyle = 'vllm' | 'sglang' | 'llamacpp' | 'tgi';

export const DEFAULT_TOKENIZE_PATHS: Record<TokenizeStyle, string> = {
  vllm: '/tokenize',
  sglang: '/v1/tokenize',
  llamacpp: '/tokenize',
  tgi: '/tokenize',
};

export interface RemoteTokenizerOptions {
  /** scheme://host[:port] of the gateway (config upstream.origin) */
  origin: string;
  style: TokenizeStyle;
  /** endpoint path; null = the style's default */
  path?: string | null;
  timeoutMs?: number;
  /** extra headers (e.g. Authorization); never logged */
  headers?: Record<string, string>;
  /** default model name sent to vllm/sglang */
  model?: string | null;
  insecureTls?: boolean;
  ca?: string | Buffer | null;
  /** parallel requests (default 4) */
  concurrency?: number;
  /** skip the endpoint for this long after a failure (default 30 s) */
  failureBackoffMs?: number;
  /** max response bytes (default 32 MiB) */
  maxResponseBytes?: number;
}

export interface RemoteStats {
  requests: number;
  ok: number;
  failed: number;
  skipped: number;
  lastError: string | null;
}

export interface RemoteTokenizer {
  readonly style: TokenizeStyle;
  readonly url: string;
  /** token count of `text` (added tokens parsed as special), or null on any failure */
  count(text: string, model?: string | null): Promise<number | null>;
  stats(): RemoteStats;
  /** true while the endpoint is in failure backoff */
  down(): boolean;
  close(): void;
}

export function tokenizeRequestBody(style: TokenizeStyle, text: string, model?: string | null): Record<string, unknown> {
  switch (style) {
    case 'vllm':
    case 'sglang':
      return model ? { model, prompt: text, add_special_tokens: false } : { prompt: text, add_special_tokens: false };
    case 'llamacpp':
      return { content: text, add_special: false, parse_special: true };
    case 'tgi':
      return { inputs: text };
  }
}

/** Token count from a tokenize response body, or null when the shape is not recognised. */
export function parseTokenizeResponse(style: TokenizeStyle, body: unknown): number | null {
  const okInt = (x: unknown): number | null => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : null);
  if (style === 'tgi') return Array.isArray(body) ? body.length : null;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  if (style === 'vllm' || style === 'sglang') {
    const n = okInt(o['count']);
    if (n !== null) return n;
  }
  return Array.isArray(o['tokens']) ? o['tokens'].length : null;
}

export function createRemoteTokenizer(opts: RemoteTokenizerOptions): RemoteTokenizer {
  const path = opts.path ?? DEFAULT_TOKENIZE_PATHS[opts.style];
  // origin + path appended verbatim (like the proxy appends the client's path to upstream.origin)
  const url = new URL(opts.origin.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path));
  const isHttps = url.protocol === 'https:';
  const agent = isHttps
    ? new https.Agent({ keepAlive: true, maxSockets: opts.concurrency ?? 4, rejectUnauthorized: !opts.insecureTls, ...(opts.ca ? { ca: opts.ca } : {}) })
    : new http.Agent({ keepAlive: true, maxSockets: opts.concurrency ?? 4 });
  const timeoutMs = opts.timeoutMs ?? 5000;
  const backoffMs = opts.failureBackoffMs ?? 30_000;
  const maxBytes = opts.maxResponseBytes ?? 32 * 1024 * 1024;
  const limit = Math.max(1, opts.concurrency ?? 4);
  const st: RemoteStats = { requests: 0, ok: 0, failed: 0, skipped: 0, lastError: null };
  let downUntil = 0;
  let active = 0;
  const queue: Array<() => void> = [];

  const acquire = (): Promise<void> =>
    active < limit ? (active++, Promise.resolve()) : new Promise<void>((res) => queue.push(() => (active++, res())));
  const release = (): void => {
    active--;
    const next = queue.shift();
    if (next) next();
  };

  const post = (body: string): Promise<{ status: number; text: string }> =>
    new Promise((resolve, reject) => {
      const lib = isHttps ? https : http;
      const req = lib.request(url, {
        method: 'POST',
        agent,
        headers: {
          ...opts.headers,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          accept: 'application/json',
          'accept-encoding': 'identity',
        },
      });
      const timer = setTimeout(() => req.destroy(new Error(`tokenize timeout after ${timeoutMs} ms`)), timeoutMs);
      timer.unref?.();
      req.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (d: Buffer) => {
          size += d.length;
          if (size > maxBytes) req.destroy(new Error('tokenize response too large'));
          else chunks.push(d);
        });
        res.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req.end(body);
    });

  return {
    style: opts.style,
    url: url.toString(),
    down: () => Date.now() < downUntil,
    stats: () => ({ ...st }),
    close: () => agent.destroy(),
    async count(text, model) {
      if (Date.now() < downUntil) {
        st.skipped++;
        return null;
      }
      await acquire();
      try {
        if (Date.now() < downUntil) {
          st.skipped++;
          return null;
        }
        st.requests++;
        const { status, text: out } = await post(JSON.stringify(tokenizeRequestBody(opts.style, text, model ?? opts.model ?? null)));
        if (status < 200 || status >= 300) throw new Error(`tokenize HTTP ${status}`);
        const n = parseTokenizeResponse(opts.style, JSON.parse(out) as unknown);
        if (n === null) throw new Error('tokenize response not understood');
        st.ok++;
        return n;
      } catch (e) {
        st.failed++;
        st.lastError = e instanceof Error ? e.message : String(e);
        downUntil = Date.now() + backoffMs;
        return null;
      } finally {
        release();
      }
    },
  };
}

/** The tokenize client the config describes, or null (no endpoint style or no upstream origin). */
export function remoteFromConfig(cfg: Config): RemoteTokenizer | null {
  const ep = cfg.tokenizer.endpoint;
  if (!ep.style || !cfg.upstream.origin) return null;
  return createRemoteTokenizer({
    origin: cfg.upstream.origin,
    style: ep.style,
    path: ep.path,
    timeoutMs: ep.timeoutMs,
    headers: cfg.upstream.headers,
    insecureTls: cfg.upstream.insecureTls,
    ca: cfg.upstream.caFile ? readFileSync(cfg.upstream.caFile) : null,
  });
}
