// Latency, CPU and memory of the proxy (bench/README.mdgate G7).
//
//   node dist/bench/latency.js [--n 500] [--preset 100k] [--template qwen3|sim] [--classes a,b,c,d,e,f,r]
//                              [--sizes 0.3,1,2,4] [--out bench/results/latency.json]
//
// Serial phase, machine otherwise idle. The proxy is a real `kitzur serve` child process (bench/systems/kitzur.ts:
// isolated state dir, HOME, stats JSONL) with the exact tokenizer; the upstream is another child that answers a
// short SSE stream at once and never tokenizes (and sends no usage, so calibration never moves P mid-run). Bodies
// are pre-serialized before a class starts. Every number below is measured INSIDE the proxy, from the stats JSONL
// (hrtime): reqPath = body received → upstream request written (engine included), respPath = first upstream byte
// → first client byte, engine_ms, cpu_us (process.cpuUsage delta per request); plus, outside, the paired
// direct-vs-proxy time-to-first-byte delta for class (a).
//
// Classes (n each unless noted):
//   (a) steady:     a ~300 KB reference history whose plan is cached, plus one NEW 20–50 KB unit (unique text):
//                   the fold resumes from the memo and steps once (reuse/admit); gate G7 = p99(reqPath+respPath)
//   (b) compaction: a cached history near the trigger plus one new 20–50 KB unit: the live step compacts
//   (c) oversize:   a cached history plus a new unit whose tool result is 180,000 characters (admission truncation)
//   (d) cold:       the first request of a never-seen ~300 KB history (unique text in every message): the full fold
//                   replay with cold counter caches, as after a restart without a persisted store
//   (r) restart:    real restarts (n = 20): a fresh `kitzur serve` and the reference session's last request
//   (e) sweep:      class (a) on cached histories of 0.3, 1, 2 and 4 MB
//   (f) shadow:     class (a) with shadow = true
// Memory (RSS, heapUsed, external from /status) after warm-up and after 1,000 requests.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { ChatMessage, ChatRequest } from '../src/types.js';
import { loadConfig } from '../src/config/load.js';
import { createEngine } from '../src/engine/engine.js';
import { createSummarizer } from '../src/engine/summary.js';
import { createToolRules } from '../src/engine/rules/index.js';
import { counterFromConfig } from '../src/tokenize/counter.js';
import { loadTokenizerCached } from '../src/tokenize/load.js';
import { assistantMessage, initialHistory, toolOutput, tools as scenarioTools, USER_INJECT } from './scenarios/reference.js';
import { Kitzur } from './systems/kitzur.js';
import { RAW_RESULTS_DIR, RESULTS_DIR, benchTokenizerPath } from './lib/paths.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}

const N = Number(arg('n', '500'));
const PRESET = arg('preset', '100k');
const TEMPLATE = arg('template', 'qwen3');
const CLASSES = new Set(arg('classes', 'a,b,c,d,r,e,f').split(','));
const SIZES = arg('sizes', '0.3,1,2,4').split(',').map(Number);
const OUT = arg('out', join(RESULTS_DIR, 'latency.json'));
const CAP = { capBytes: 51_200 };
const RUN_DIR = join(RAW_RESULTS_DIR, 'latency');

// ---------------------------------------------------------------- statistics

const pct = (xs: number[], p: number): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
};
const r1 = (x: number): number => Math.round(x * 10) / 10;
const dist = (xs: number[]): { n: number; p50: number; p90: number; p99: number; max: number; mean: number } => ({
  n: xs.length, p50: r1(pct(xs, 0.5)), p90: r1(pct(xs, 0.9)), p99: r1(pct(xs, 0.99)), max: r1(Math.max(...xs)),
  mean: r1(xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)),
});

// ---------------------------------------------------------------- upstream (never tokenizes)

const SSE = [
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
].join('');
const UPSTREAM_JS = `
const http = require('node:http');
const sse = ${JSON.stringify(SSE)};
const s = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(sse);
  });
});
s.keepAliveTimeout = 60000;
s.listen(0, '127.0.0.1', () => console.log('listening on http://127.0.0.1:' + s.address().port));
process.on('SIGTERM', () => process.exit(0));
`;

function spawnUpstream(): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', UPSTREAM_JS], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) resolve({ child, url: m[1]! });
    });
    child.once('exit', (c) => reject(new Error(`upstream exited ${c}`)));
  });
}

// ---------------------------------------------------------------- client

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const directAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });

/** POSTs a pre-serialized body; resolves with time to first byte and total time (ms). */
function post(base: string, body: Buffer, session: string, a = agent): Promise<{ ttfb: number; total: number; status: number }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let ttfb = -1;
    const req = http.request({
      host: u.hostname, port: Number(u.port), method: 'POST', path: '/v1/chat/completions', agent: a,
      headers: { 'content-type': 'application/json', 'content-length': String(body.length), 'x-session-id': session },
    });
    req.on('error', reject);
    req.on('response', (res) => {
      res.on('data', () => {
        if (ttfb < 0) ttfb = performance.now() - t0;
      });
      res.on('end', () => resolve({ ttfb: ttfb < 0 ? performance.now() - t0 : ttfb, total: performance.now() - t0, status: res.statusCode ?? 0 }));
    });
    req.end(body);
  });
}

async function status(base: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    http.get(base + '/status', (res) => {
      const ch: Buffer[] = [];
      res.on('data', (d: Buffer) => ch.push(d));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(ch).toString('utf8')) as Record<string, unknown>));
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------- histories

/** The reference session grown step by step (assistant turn + its results), from `from` to `to` steps. */
function grow(msgs: ChatMessage[], from: number, to: number): ChatMessage[] {
  for (let step = from; step < to; step++) {
    const a = assistantMessage(step, CAP) as ChatMessage;
    msgs.push(a);
    for (const c of a.tool_calls ?? []) msgs.push({ role: 'tool', tool_call_id: c.id, content: toolOutput(step, CAP) });
    const inj = USER_INJECT.get(step);
    if (inj !== undefined) msgs.push({ role: 'user', content: inj });
  }
  return msgs;
}

const TOOLS = scenarioTools();
const bodyOf = (messages: ChatMessage[]): Buffer =>
  Buffer.from(JSON.stringify({ model: 'qwen', messages, tools: TOOLS, max_tokens: 32_000, stream: true }));

/** A NEW unit: assistant tool call + a unique tool result of `chars` characters (reference-like text). */
function newUnit(tag: string, chars: number, step: number): ChatMessage[] {
  const id = `call_lat_${tag}`;
  const a: ChatMessage = { role: 'assistant', content: `Checking ${tag}.`, tool_calls: [{ id, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `npx playwright test --grep ${tag}` }) } }] };
  let text = `run ${tag}\n`;
  for (let k = step; text.length < chars; k++) text += toolOutput(k % 200, CAP) + `\n-- ${tag} ${k}\n`;
  return [a, { role: 'tool', tool_call_id: id, content: text.slice(0, chars) }];
}

/** Every string in the history salted with `salt`, so no counter cache or plan matches (cold class). */
function salted(msgs: ChatMessage[], salt: string): ChatMessage[] {
  return msgs.map((m) => {
    const c = typeof m.content === 'string' ? `[${salt}] ${m.content}` : m.content;
    const out: ChatMessage = { ...m, content: c };
    if (m.tool_calls) out.tool_calls = m.tool_calls.map((t) => ({ ...t, id: `${t.id}_${salt}` }));
    if (m.tool_call_id) out.tool_call_id = `${m.tool_call_id}_${salt}`;
    return out;
  });
}

// ---------------------------------------------------------------- the proxy under test

interface Run {
  sys: Kitzur;
  base: string;
  dir: string;
  seen: number;
}

async function startProxy(upstream: string, name: string, extra: Record<string, string | number | boolean | null> = {}, stateDir?: string): Promise<Run> {
  const dir = join(RUN_DIR, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const sys = new Kitzur({
    name, preset: PRESET, tokenizer: benchTokenizerPath(), ...(stateDir ? { stateDir } : {}),
    set: { 'tokenizer.template.name': TEMPLATE, 'calibration.enabled': false, 'stream.holdFirstEvent': true, ...extra },
  });
  const base = await sys.start(upstream, dir);
  return { sys, base, dir, seen: 0 };
}

interface StatsRec {
  seq: number;
  action: string;
  client_session?: string;
  engine_ms: number;
  total_ms: number;
  req_path_ms?: number;
  resp_path_ms?: number;
  cpu_us?: number;
  tokens_in: number;
  tokens_out: number;
  compacted: boolean;
}

/** New stats records since the last call (waits until `n` new ones are written). */
async function newStats(run: Run, n: number): Promise<StatsRec[]> {
  for (let t = 0; t < 200; t++) {
    let lines: string[] = [];
    try {
      lines = readFileSync(join(run.dir, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean);
    } catch {
      /* not yet */
    }
    if (lines.length >= run.seen + n) {
      const recs = lines.slice(run.seen, run.seen + n).map((l) => JSON.parse(l) as StatsRec);
      run.seen += n;
      return recs;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`stats: expected ${n} new records in ${run.dir}`);
}

interface ClassResult {
  n: number;
  actions: Record<string, number>;
  overhead: ReturnType<typeof dist>;
  reqPath: ReturnType<typeof dist>;
  respPath: ReturnType<typeof dist>;
  engine: ReturnType<typeof dist>;
  total: ReturnType<typeof dist>;
  cpuMs: ReturnType<typeof dist>;
  bodyKB: ReturnType<typeof dist>;
  tokensIn: ReturnType<typeof dist>;
  ttfbDeltaMs?: ReturnType<typeof dist>;
  note?: string;
  /** 1-minute load average at the start and end of the class (other processes on the box inflate latencies) */
  load?: [number, number];
}

function summarize(recs: StatsRec[], sizes: number[], deltas?: number[], note?: string, load?: [number, number]): ClassResult {
  const actions: Record<string, number> = {};
  for (const r of recs) actions[r.action] = (actions[r.action] ?? 0) + 1;
  const req = recs.map((r) => r.req_path_ms ?? NaN).filter(Number.isFinite);
  const resp = recs.map((r) => r.resp_path_ms ?? 0);
  return {
    n: recs.length, actions,
    overhead: dist(recs.map((r) => (r.req_path_ms ?? 0) + (r.resp_path_ms ?? 0))),
    reqPath: dist(req), respPath: dist(resp), engine: dist(recs.map((r) => r.engine_ms)), total: dist(recs.map((r) => r.total_ms)),
    cpuMs: dist(recs.map((r) => (r.cpu_us ?? 0) / 1000)), bodyKB: dist(sizes.map((s) => s / 1024)), tokensIn: dist(recs.map((r) => r.tokens_in)),
    ...(deltas ? { ttfbDeltaMs: dist(deltas) } : {}), ...(note ? { note } : {}), ...(load ? { load } : {}),
  };
}

/** Sends bodies serially (built lazily in batches so that memory stays bounded), returns their stats. */
async function runClass(run: Run, label: string, count: number, make: (i: number) => Buffer, direct?: string): Promise<{ recs: StatsRec[]; sizes: number[]; deltas: number[]; load: [number, number] }> {
  const l0 = loadavg()[0]!;
  const sizes: number[] = [];
  const deltas: number[] = [];
  const BATCH = 50;
  for (let i0 = 0; i0 < count; i0 += BATCH) {
    const bodies = Array.from({ length: Math.min(BATCH, count - i0) }, (_, j) => make(i0 + j));
    for (let j = 0; j < bodies.length; j++) {
      const b = bodies[j]!;
      sizes.push(b.length);
      const i = i0 + j;
      if (direct && i % 2 === 1) {
        const d = await post(direct, b, label, directAgent);
        const p = await post(run.base, b, `${label}-${i}`);
        deltas.push(p.ttfb - d.ttfb);
      } else {
        const p = await post(run.base, b, `${label}-${i}`);
        if (p.status !== 200) throw new Error(`${label} ${i}: status ${p.status}`);
        if (direct) {
          const d = await post(direct, b, label, directAgent);
          deltas.push(p.ttfb - d.ttfb);
        }
      }
    }
  }
  return { recs: await newStats(run, count), sizes, deltas, load: [Math.round(l0 * 100) / 100, Math.round(loadavg()[0]! * 100) / 100] };
}

// ---------------------------------------------------------------- planning the histories (in-process engine)

interface Bases {
  steady: ChatMessage[];
  nearTrigger: ChatMessage[];
  trigger: number;
}

/** Picks the steady (a) and near-trigger (b) bases with the same engine the proxy runs (deterministic, I5). */
function planBases(): Bases {
  const cfg = loadConfig({ preset: PRESET, env: {}, sets: [`tokenizer.template.name=${TEMPLATE}`, 'calibration.enabled=false'] }).config;
  const tokPath = benchTokenizerPath();
  if (!tokPath) throw new Error('latency: the dev tokenizer is required (scripts/fetch-tokenizer.sh)');
  const tok = loadTokenizerCached(tokPath, null, { stateDir: join(RUN_DIR, '.tokcache') });
  const counter = counterFromConfig(cfg, { tokenizer: tok });
  const e = createEngine(cfg, { counter, summarizer: createSummarizer(cfg, counter), rules: createToolRules(cfg), faults: null });
  const msgs = initialHistory() as ChatMessage[];
  let steady: ChatMessage[] | null = null;
  let near: ChatMessage[] | null = null;
  let trigger = 0;
  for (let step = 0; step < 200 && (!steady || !near); step++) {
    grow(msgs, step, step + 1);
    const r = e.process({ model: 'qwen', messages: msgs, tools: TOOLS, max_tokens: 32_000 } as ChatRequest, { attempt: 1 });
    trigger = r.stats.budget.trigger;
    const bytes = Buffer.byteLength(JSON.stringify(msgs));
    const out = r.stats.tokensOut;
    // (a): ≈300 KB with room for a 50 KB unit (≤ 25k tokens even for snapshot text) below the trigger, so that no
    // steady sample compacts; (b): within 4k tokens of the trigger, so that every new 20–50 KB unit compacts
    if (!steady && bytes >= 270_000 && out + 25_000 < trigger) steady = msgs.slice();
    if (!near && bytes >= 200_000 && out > trigger - 4_000 && out <= trigger && r.action !== 'compact') near = msgs.slice();
  }
  if (!steady || !near) throw new Error('latency: could not find the base histories');
  return { steady, nearTrigger: near, trigger };
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  mkdirSync(RUN_DIR, { recursive: true });
  const t0 = performance.now();
  console.log(`latency: preset ${PRESET}, template ${TEMPLATE}, n ${N}, classes ${[...CLASSES].join(',')}`);
  const bases = planBases();
  console.log(`  bases: steady ${bases.steady.length} msgs / ${(bodyOf(bases.steady).length / 1024).toFixed(0)} KB, near-trigger ${bases.nearTrigger.length} msgs / ${(bodyOf(bases.nearTrigger).length / 1024).toFixed(0)} KB (trigger ${bases.trigger})`);
  const up = await spawnUpstream();
  const result: Record<string, unknown> = {
    preset: PRESET, template: TEMPLATE, n: N, node: process.version,
    setup: 'serial; proxy = kitzur serve child (exact tokenizer, calibration off); upstream child answers SSE at once, no tokenizing; pre-serialized bodies; timings from the proxy stats JSONL (hrtime)',
    classes: {} as Record<string, ClassResult>, memory: {} as Record<string, unknown>,
  };
  const classes = result['classes'] as Record<string, ClassResult>;
  const memory = result['memory'] as Record<string, unknown>;
  const mem = async (run: Run, at: string): Promise<void> => {
    const s = await status(run.base);
    memory[at] = s['memory'];
  };
  const rnd = (i: number, a: number, b: number): number => a + ((i * 2654435761) >>> 0) % (b - a + 1);

  try {
    const run = await startProxy(up.url, 'main');
    // warm-up: the steady and near-trigger histories as a live session sends them (one request per boundary)
    const warm: Buffer[] = [];
    for (let k = 3; k <= bases.steady.length; k++) if (k === bases.steady.length || (bases.steady[k]?.role === 'assistant' && bases.steady[k - 1]?.role !== 'assistant')) warm.push(bodyOf(bases.steady.slice(0, k)));
    for (const b of warm) await post(run.base, b, 'warm');
    await post(run.base, bodyOf(bases.nearTrigger), 'warm');
    await newStats(run, warm.length + 1);
    await mem(run, 'afterWarmup');
    let sent = warm.length + 1;

    if (CLASSES.has('a')) {
      const r = await runClass(run, 'a', N, (i) => bodyOf([...bases.steady, ...newUnit(`a${i}`, rnd(i, 20_000, 50_000), i)]), up.url);
      classes['a_steady'] = summarize(r.recs, r.sizes, r.deltas, undefined, r.load);
      sent += N;
      console.log(`  (a) steady: overhead p50 ${classes['a_steady'].overhead.p50} p99 ${classes['a_steady'].overhead.p99} max ${classes['a_steady'].overhead.max} ms ${JSON.stringify(classes['a_steady'].actions)}`);
    }
    if (CLASSES.has('b')) {
      const r = await runClass(run, 'b', N, (i) => bodyOf([...bases.nearTrigger, ...newUnit(`b${i}`, rnd(i, 20_000, 50_000), i + 7)]));
      classes['b_compaction'] = summarize(r.recs, r.sizes, undefined, undefined, r.load);
      sent += N;
      console.log(`  (b) compaction: engine p50 ${classes['b_compaction'].engine.p50} p99 ${classes['b_compaction'].engine.p99} max ${classes['b_compaction'].engine.max} ms ${JSON.stringify(classes['b_compaction'].actions)}`);
    }
    if (sent >= 1000) await mem(run, `after${sent}Requests`);
    if (CLASSES.has('c')) {
      const r = await runClass(run, 'c', N, (i) => bodyOf([...bases.steady, ...newUnit(`c${i}`, 180_000, i + 13)]));
      classes['c_oversize'] = summarize(r.recs, r.sizes, undefined, undefined, r.load);
      sent += N;
      console.log(`  (c) oversize: engine p50 ${classes['c_oversize'].engine.p50} p99 ${classes['c_oversize'].engine.p99} max ${classes['c_oversize'].engine.max} ms ${JSON.stringify(classes['c_oversize'].actions)}`);
    }
    if (CLASSES.has('d')) {
      const r = await runClass(run, 'd', N, (i) => bodyOf(salted(bases.steady, `cold${i}`)));
      classes['d_cold'] = summarize(r.recs, r.sizes, undefined, 'first request of a never-seen history (unique text in every message): full fold replay, cold counter caches', r.load);
      sent += N;
      console.log(`  (d) cold: engine p50 ${classes['d_cold'].engine.p50} p99 ${classes['d_cold'].engine.p99} max ${classes['d_cold'].engine.max} ms`);
    }
    await mem(run, `after${sent}Requests`);
    if (CLASSES.has('e')) {
      for (const mb of SIZES) {
        // a cached base of `mb` MB: the reference session grown (compactions included), sent once (fold replay)
        const msgs = initialHistory() as ChatMessage[];
        for (let step = 0; Buffer.byteLength(JSON.stringify(msgs)) < mb * 1024 * 1024 - 40_000; step++) grow(msgs, step, step + 1);
        await post(run.base, bodyOf(msgs), 'e-warm');
        await newStats(run, 1);
        const r = await runClass(run, `e${mb}`, N, (i) => bodyOf([...msgs, ...newUnit(`e${mb}-${i}`, rnd(i, 20_000, 50_000), i)]));
        const cr = summarize(r.recs, r.sizes, undefined, undefined, r.load);
        classes[`e_sweep_${mb}MB`] = cr;
        sent += N + 1;
        console.log(`  (e) ${mb} MB: overhead p50 ${cr.overhead.p50} p99 ${cr.overhead.p99} ms ${JSON.stringify(cr.actions)}`);
      }
      await mem(run, `after${sent}Requests`);
    }
    await run.sys.stop();

    if (CLASSES.has('f')) {
      const sh = await startProxy(up.url, 'shadow', { shadow: true });
      for (const b of warm) await post(sh.base, b, 'warm');
      await newStats(sh, warm.length);
      const r = await runClass(sh, 'f', N, (i) => bodyOf([...bases.steady, ...newUnit(`f${i}`, rnd(i, 20_000, 50_000), i)]), up.url);
      classes['f_shadow'] = summarize(r.recs, r.sizes, r.deltas, 'class (a) with shadow = true: the engine runs, the original is forwarded', r.load);
      console.log(`  (f) shadow: overhead p50 ${classes['f_shadow'].overhead.p50} p99 ${classes['f_shadow'].overhead.p99} ms`);
      await sh.sys.stop();
    }
    if (CLASSES.has('r')) {
      // real restarts: a fresh process (empty memo, cold caches) gets the reference session's last request
      const last = grow(initialHistory() as ChatMessage[], 0, 46);
      const body = bodyOf(last);
      const recs: StatsRec[] = [];
      const RN = Math.min(20, N);
      for (let i = 0; i < RN; i++) {
        const rr = await startProxy(up.url, `restart`);
        await post(rr.base, body, 'r');
        recs.push(...(await newStats(rr, 1)));
        await rr.sys.stop();
      }
      classes['r_restart'] = summarize(recs, recs.map(() => body.length), undefined, `${RN} real restarts; the reference session's 46-step request as the first request of a fresh process`);
      console.log(`  (r) restart: engine p50 ${classes['r_restart'].engine.p50} max ${classes['r_restart'].engine.max} ms`);
    }
  } finally {
    up.child.kill('SIGTERM');
  }
  const a = classes['a_steady'];
  result['gate7'] = a ? { metric: 'p99(reqPath + respPath) over class (a)', p99: a.overhead.p99, thresholdMs: 100, pass: a.overhead.p99 < 100 } : null;
  result['runtimeS'] = Math.round((performance.now() - t0) / 1000);
  writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');
  console.log(`latency → ${OUT}; gate 7 ${a ? (a.overhead.p99 < 100 ? 'PASS' : 'FAIL') + ` (p99 ${a.overhead.p99} ms)` : 'n/a'}`);
  agent.destroy();
  directAgent.destroy();
}

await main();
