// Test harness for the proxy: fake upstream servers (node:http), a proxy fixture on port 0 with a
// temp state dir and stats file, a raw HTTP client, and a deterministic character counter.
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import net from 'node:net';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type Config } from '../../src/config/schema.js';
import type { ChatRequest, Measure, TokenCounter } from '../../src/types.js';
import { createProxyServer, type Faults, type ProxyServer } from '../../src/proxy/server.js';
import { StateStore } from '../../src/proxy/state.js';
import { StatsWriter, type ProxyStatsRecord } from '../../src/proxy/stats.js';
import type { RemoteTokenizer } from '../../src/tokenize/remote.js';
import type { TemplateProfile } from '../../src/tokenize/template.js';
import type { FakeEngine } from './fake-engine.js';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- config

type DeepPartial<T> = { [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && b && typeof b === 'object' && !Array.isArray(b) ? merge(b, v as DeepPartial<typeof b>) : v;
  }
  return out as T;
}

export function testConfig(over?: DeepPartial<Config>): Config {
  return merge(structuredClone(DEFAULT_CONFIG), merge<DeepPartial<Config>>({ listen: { port: 0 } }, over));
}

// ---------------------------------------------------------------- counter

/** tokens = ceil(chars(JSON messages) / 4) + ceil(chars(JSON tools) / 4); throws on a message with content "COUNT-FAIL". */
export function charCounter(mode: 'exact' | 'estimate' = 'estimate'): TokenCounter & { profile?: TemplateProfile; calls: number } {
  const memo = new WeakMap<object, number>();
  const c = {
    mode,
    id: `chars4;${mode}`,
    calls: 0,
    countText: (t: string) => Math.ceil(t.length / 4),
    measure(req: ChatRequest): Measure {
      c.calls++;
      const per = req.messages.map((m) => {
        if (m.content === 'COUNT-FAIL') throw new Error('counting failed');
        let n = memo.get(m);
        if (n === undefined) memo.set(m, (n = Math.ceil(JSON.stringify(m).length / 4)));
        return n;
      });
      const overhead = req.tools ? Math.ceil(JSON.stringify(req.tools).length / 4) : 0;
      return { perMessage: per, overhead, total: per.reduce((a, b) => a + b, 0) + overhead };
    },
    countRequest(req: ChatRequest): number {
      return c.measure(req).total;
    },
  };
  return c;
}

/** The same count computed from a parsed body (what fake upstreams "tokenize"). */
export function bodyTokens(json: { messages?: unknown[]; tools?: unknown[] }): number {
  const per = (json.messages ?? []).reduce<number>((a, m) => a + Math.ceil(JSON.stringify(m).length / 4), 0);
  return per + (json.tools ? Math.ceil(JSON.stringify(json.tools).length / 4) : 0);
}

// ---------------------------------------------------------------- fake upstream

export interface UpstreamHit {
  n: number;
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  body: Buffer;
  json: any;
  at: number;
  closedAt?: number;
  socket: Socket;
}

export type Responder = (hit: UpstreamHit, res: ServerResponse, req: IncomingMessage) => void | Promise<void>;

export interface FakeUpstream {
  origin: string;
  port: number;
  hits: UpstreamHit[];
  sockets: Set<Socket>;
  /** sockets ever accepted */
  connections: number;
  responder: Responder;
  close(): Promise<void>;
}

export function fakeUpstream(responder: Responder): Promise<FakeUpstream> {
  const hits: UpstreamHit[] = [];
  const sockets = new Set<Socket>();
  const fu: FakeUpstream = { origin: '', port: 0, hits, sockets, connections: 0, responder, close: async () => undefined };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let json: unknown;
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        json = undefined;
      }
      const hit: UpstreamHit = { n: hits.length + 1, method: req.method ?? '', url: req.url ?? '', headers: req.headers, rawHeaders: req.rawHeaders, body, json, at: performance.now(), socket: req.socket };
      hits.push(hit);
      res.on('close', () => (hit.closedAt = performance.now()));
      Promise.resolve(fu.responder(hit, res, req)).catch(() => res.destroy());
    });
  });
  server.keepAliveTimeout = 30_000;
  server.on('connection', (s: Socket) => {
    fu.connections++;
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      fu.port = (server.address() as AddressInfo).port;
      fu.origin = `http://127.0.0.1:${fu.port}`;
      fu.close = () =>
        new Promise<void>((r) => {
          for (const s of sockets) s.destroy();
          server.close(() => r());
        });
      resolve(fu);
    }),
  );
}

export function jsonRes(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const b = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(b.length), ...headers });
  res.end(b);
}

/** Writes SSE pieces (raw strings) with an optional delay between them. */
export async function sseRes(res: ServerResponse, pieces: string[], opts: { delayMs?: number; status?: number; headers?: Record<string, string>; end?: boolean } = {}): Promise<void> {
  res.writeHead(opts.status ?? 200, { 'content-type': 'text/event-stream', ...opts.headers });
  res.flushHeaders();
  for (const p of pieces) {
    if (opts.delayMs) await sleep(opts.delayMs);
    if (res.destroyed) return;
    res.write(p);
  }
  if (opts.end !== false) res.end();
}

export const chunk = (content: string, finish: string | null = null, extra: Record<string, unknown> = {}): string =>
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: finish }], ...extra })}\n\n`;
export const usageChunk = (prompt: number, completion = 5): string =>
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } })}\n\n`;
export const DONE = 'data: [DONE]\n\n';

export function okCompletion(prompt = 10, finish = 'stop'): Record<string, unknown> {
  return { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: finish }], usage: { prompt_tokens: prompt, completion_tokens: 2, total_tokens: prompt + 2 } };
}

// ---------------------------------------------------------------- proxy fixture

export interface ProxyFixture {
  proxy: ProxyServer;
  port: number;
  url: string;
  cfg: Config;
  engine: FakeEngine;
  state: StateStore;
  stats: StatsWriter;
  stateDir: string;
  statsPath: string;
  counter: TokenCounter;
  records(): ProxyStatsRecord[];
  close(): Promise<void>;
}

export interface FixtureOptions {
  config?: DeepPartial<Config>;
  counter?: TokenCounter & { profile?: TemplateProfile };
  remote?: RemoteTokenizer | null;
  faults?: Faults | null;
  stateDir?: string;
}

export async function startProxy(up: FakeUpstream | string, engine: FakeEngine, o: FixtureOptions = {}): Promise<ProxyFixture> {
  const stateDir = o.stateDir ?? mkdtempSync(join(tmpdir(), 'kitzur-proxy-test-'));
  const statsPath = join(stateDir, 'stats.jsonl');
  const origin = typeof up === 'string' ? up : up.origin;
  const cfg = testConfig(merge<DeepPartial<Config>>({ upstream: { origin }, stateDir, stats: { path: statsPath } }, o.config));
  const counter = o.counter ?? charCounter();
  const state = new StateStore({ dir: stateDir, configuredWindow: cfg.budget.window, counterId: counter.id, debounceMs: 20 });
  const stats = new StatsWriter(statsPath);
  const proxy = createProxyServer(cfg, { engine, counter, state, stats, remote: o.remote ?? null, faults: o.faults ?? null });
  const { port } = await proxy.listen();
  return {
    proxy, port, url: `http://127.0.0.1:${port}`, cfg, engine, state, stats, stateDir, statsPath, counter,
    records: () => (existsSync(statsPath) ? readFileSync(statsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ProxyStatsRecord) : []),
    close: () => proxy.close(2000),
  };
}

/** Waits until `n` stats records are on disk (they are written after the response). */
export async function waitRecords(f: ProxyFixture, n: number, timeoutMs = 3000): Promise<ProxyStatsRecord[]> {
  const t0 = Date.now();
  for (;;) {
    const r = f.records();
    if (r.length >= n || Date.now() - t0 > timeoutMs) return r;
    await sleep(10);
  }
}

// ---------------------------------------------------------------- client

export interface ClientResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
  body: Buffer;
  /** ms from send to the response headers */
  headerMs: number;
  text(): string;
  json(): any;
}

export function request(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: Buffer | string | object; agent?: http.Agent | false } = {}): Promise<ClientResponse> {
  const body = o.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(o.body) ? o.body : Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body), 'utf8');
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request({
      host: '127.0.0.1', port, method: o.method ?? 'POST', path: o.path ?? '/v1/chat/completions', agent: o.agent ?? false,
      headers: { 'content-type': 'application/json', 'content-length': String(body.length), ...o.headers },
    });
    req.on('error', reject);
    req.on('response', (res) => {
      const headerMs = performance.now() - t0;
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => {
        const b = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, body: b, headerMs, text: () => b.toString('utf8'), json: () => JSON.parse(b.toString('utf8')) });
      });
      res.on('error', reject);
    });
    req.end(body);
  });
}

/** A raw HTTP/1.0 request without a Host header. */
export function rawRequest(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let out = '';
    s.on('data', (d) => (out += d.toString('utf8')));
    s.on('end', () => resolve(out));
    s.on('error', reject);
  });
}

export const chatBody = (content = 'hello', extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'm1', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content }], max_tokens: 1000, ...extra,
});
