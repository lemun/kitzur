// Proxy overhead on 300 KB bodies (DESIGN.md gate G7; bench/README.mdclass (a) shape). As in the
// spec, the proxy runs as a child process, the upstream (another child) answers at once without
// tokenizing, and the load generator posts a pre-serialized body: the reference scenario's history
// grown to ~300 KB. The engine is a pass-through fake, so this measures the proxy itself (parse, the
// ladder's bookkeeping, relay). Two measurements over ≥ 500 requests:
//   - inside the proxy: reqPath (body received -> upstream request written) + respPath (first upstream
//     body byte -> first client byte), from the stats records: the G7 quantity;
//   - outside: paired client-observed latency, direct vs through the proxy, alternating order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMessage } from '../../src/types.js';
import type { ProxyStatsRecord } from '../../src/proxy/stats.js';
import { initialHistory, assistantMessage, toolOutput } from '../../bench/scenarios/reference.js';
import { chunk, DONE, sleep } from './harness.js';

const N = 520;
const HERE = dirname(fileURLToPath(import.meta.url));

function history300k(): { body: Buffer; messages: number } {
  const msgs: ChatMessage[] = initialHistory();
  for (let step = 0; ; step++) {
    const a = assistantMessage(step, { capBytes: 51200 });
    msgs.push(a);
    for (const c of a.tool_calls) msgs.push({ role: 'tool', tool_call_id: c.id, content: toolOutput(step, { capBytes: 51200 }) });
    const body = Buffer.from(JSON.stringify({ model: 'qwen', messages: msgs, max_tokens: 32000, stream: true, stream_options: { include_usage: true } }));
    if (body.length >= 300_000) return { body, messages: msgs.length };
  }
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
};

function timedPost(agent: http.Agent, port: number, body: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', agent, headers: { 'content-type': 'application/json', 'content-length': String(body.length) } });
    req.on('error', reject);
    req.on('response', (res) => {
      res.on('data', () => undefined);
      res.on('end', () => resolve(performance.now() - t0));
    });
    req.end(body);
  });
}

/** Spawns a child and resolves with the port it prints ("listening on http://127.0.0.1:<port>"). */
function spawnListening(args: string[]): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.on('exit', (code) => reject(new Error(`child exited ${code}`)));
  });
}

// the upstream: consumes the body, answers a short SSE stream at once, never tokenizes
const UPSTREAM_JS = `
const http = require('node:http');
const stream = ${JSON.stringify(chunk('ok') + chunk('', 'stop') + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 70_000, completion_tokens: 2 } })}\n\n` + DONE)};
const s = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(stream); });
});
s.keepAliveTimeout = 30000;
s.listen(0, '127.0.0.1', () => console.log('listening on http://127.0.0.1:' + s.address().port));
process.on('SIGTERM', () => process.exit(0));
`;

test(`proxy overhead on 300 KB bodies, pass-through engine (p50/p99 over ${N} requests)`, async (t) => {
  const { body, messages } = history300k();
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-latency-'));
  const up = await spawnListening(['-e', UPSTREAM_JS]);
  const px = await spawnListening([join(HERE, 'proxy-child.js'), `http://127.0.0.1:${up.port}`, dir]);
  const agentDirect = new http.Agent({ keepAlive: true });
  const agentProxy = new http.Agent({ keepAlive: true });
  try {
    for (let i = 0; i < 30; i++) {
      await timedPost(agentDirect, up.port, body);
      await timedPost(agentProxy, px.port, body);
    }
    const direct: number[] = [];
    const proxied: number[] = [];
    for (let i = 0; i < N; i++) {
      if (i % 2) {
        direct.push(await timedPost(agentDirect, up.port, body));
        proxied.push(await timedPost(agentProxy, px.port, body));
      } else {
        proxied.push(await timedPost(agentProxy, px.port, body));
        direct.push(await timedPost(agentDirect, up.port, body));
      }
    }
    agentProxy.destroy();
    px.child.kill('SIGTERM');
    await new Promise((r) => px.child.once('exit', r));
    const path = join(dir, 'stats.jsonl');
    for (let i = 0; i < 50 && !existsSync(path); i++) await sleep(20);
    const recs = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ProxyStatsRecord).slice(30);
    assert.equal(recs.length, N);
    const internal = recs.map((r) => (r.req_path_ms ?? NaN) + (r.resp_path_ms ?? NaN));
    assert.ok(internal.every(Number.isFinite), 'every record has reqPath and respPath');
    const delta = proxied.map((p, i) => p - direct[i]!);
    const q = (xs: number[]) => ({ p50: +pct(xs, 0.5).toFixed(2), p99: +pct(xs, 0.99).toFixed(2), max: +pct(xs, 1).toFixed(2) });
    const report = {
      body_bytes: body.length, messages, n: N,
      g7_reqPath_plus_respPath_ms: q(internal),
      reqPath_ms: q(recs.map((r) => r.req_path_ms!)),
      respPath_ms: q(recs.map((r) => r.resp_path_ms!)),
      proxy_cpu_us: q(recs.map((r) => r.cpu_us ?? NaN)),
      external_added_ms: q(delta),
      direct_ms: q(direct),
      proxied_ms: q(proxied),
    };
    t.diagnostic(JSON.stringify(report));
    if (process.env['KITZUR_TEST_VERBOSE']) console.log(JSON.stringify(report, null, 1));
    // G7: p99 of reqPath + respPath < 100 ms on class (a)
    assert.ok(report.g7_reqPath_plus_respPath_ms.p99 < 100, `G7 p99 ${report.g7_reqPath_plus_respPath_ms.p99} ms`);
    assert.ok(report.external_added_ms.p50 < 50, `external added p50 ${report.external_added_ms.p50} ms`);
  } finally {
    agentDirect.destroy();
    agentProxy.destroy();
    px.child.kill('SIGKILL');
    up.child.kill('SIGKILL');
  }
});
