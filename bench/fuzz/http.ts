// HTTP subset of the fuzz suite (bench/README.md: "300 chains through the real proxy against the mock (I7,
// streaming, dialect)").
//
//   node dist/bench/fuzz/http.js [--chains 300] [--base 900000] [--out bench/results/fuzz.json]
//
// Every chain (gen.ts with { http: true }: intact pairing, no template errors, no injected learned state) runs
// through a real `kitzur serve` child (its config = the chain's config as a file, exact tokenizer, calibration
// off so that P stays the chain's) in front of the bench mock (bench/mock/server.ts in SPEC mode: the chain's
// template, the server type's limit mode at the window W, the mock's own render + tokenizer). A third of the
// chains run with KITZUR_TEST_FAULTS=engine-throw:0.05 (I7), some bodies carry an integer outside
// Number.isSafeInteger (dialect), and requests stream or not as the chain says. Per request:
//   - the client status is 400 iff the in-process engine (same config, same fault spec) says impossible or
//     guard_reject, and then the mock saw no request;
//   - otherwise the mock saw exactly one request whose messages and max_tokens fields equal the in-process engine's
//     output (canonical JSON), and the mock never rejected it for length (I2 against the server's real limit);
//   - a body with an unsafe integer is never rewritten: the mock sees the original messages, or the client gets the
//     400 when the original does not fit;
//   - a streamed response is well-formed SSE ending in [DONE]; a JSON response parses.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMessage, ChatRequest, EngineResult } from '../../src/types.js';
import { canonicalJSON } from '../../src/tokenize/canonical.js';
import { MockServer } from '../mock/server.js';
import { PromptCounter } from '../lib/render.js';
import { httpRequest } from '../client/http.js';
import { parseResponse } from '../client/sse.js';
import { RAW_RESULTS_DIR, RESULTS_DIR, benchTokenizerPath } from '../lib/paths.js';
import { genChain, type FuzzChain } from './gen.js';
import { counterFor, engineFor, type Violation } from './invariants.js';
import { computeBudget, requestedMaxTokens, serverFits } from '../../src/engine/budget.js';
import { defaultLearnedEntry } from '../../src/engine/learned.js';
import { corrected, createOracle } from './oracle.js';
import { fuzzTokenizer } from './run.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '..', '..', 'src', 'cli.js');

function arg(name: string, def: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}

const LIMIT_MODE: Record<string, 'strict_total' | 'prompt_only' | 'tgi' | 'silent_truncate'> = {
  vllm: 'strict_total', sglang: 'strict_total', litellm: 'strict_total', unknown: 'strict_total',
  llamacpp: 'prompt_only', lmstudio: 'prompt_only', tgi: 'tgi', ollama: 'silent_truncate',
};

function startProxy(cfgPath: string, upstream: string, dir: string, faults: string | null): Promise<{ child: ChildProcess; port: number }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('KITZUR_') && !k.startsWith('XDG_')) env[k] = v;
  env['HOME'] = join(dir, 'home');
  if (faults) env['KITZUR_TEST_FAULTS'] = faults;
  const tok = benchTokenizerPath();
  const argv = [CLI, 'serve', '--config', cfgPath, '--upstream', upstream, '--port', '0', '--state-dir', join(dir, 'state'),
    '--stats', join(dir, 'stats.jsonl'), ...(tok ? ['--tokenizer', tok] : []), '--log-level', 'error'];
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => rej(new Error('proxy did not start: ' + err)), 60_000);
    child.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        res({ child, port: Number(m[1]) });
      }
    });
    child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
    child.once('exit', (c) => {
      clearTimeout(timer);
      rej(new Error(`proxy exited ${c}: ${err.slice(0, 500)}`));
    });
  });
}

const stop = (c: ChildProcess): Promise<void> =>
  new Promise((r) => {
    if (c.exitCode !== null) return r();
    const t = setTimeout(() => c.kill('SIGKILL'), 5000);
    c.once('exit', () => {
      clearTimeout(t);
      r();
    });
    c.kill('SIGTERM');
  });

export interface HttpOutcome {
  seed: number;
  requests: number;
  violations: Violation[];
  faults: boolean;
  streamed: number;
  unsafeInts: number;
  faulted: number;
  rejected400: number;
}

/** One chain through proxy + mock. */
export async function runHttpChain(c: FuzzChain, faults: string | null, unsafeEvery: number): Promise<HttpOutcome> {
  const tok = fuzzTokenizer();
  if (!tok) throw new Error('the HTTP subset needs the dev tokenizer');
  const dir = join(RAW_RESULTS_DIR, 'fuzz', 'http', String(c.seed));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  const violations: Violation[] = [];
  const v = (inv: string, k: number, d: string): void => void violations.push({ inv, seed: c.seed, request: k, detail: d.slice(0, 500) });
  const cfg = { ...c.cfg, calibration: { ...c.cfg.calibration, enabled: false } };
  const cfgPath = join(dir, 'kitzur.json');
  writeFileSync(cfgPath, JSON.stringify(cfg));
  // what the mock saw, per request
  const seen: Array<{ messages: unknown; max_tokens: unknown; max_completion_tokens: unknown }> = [];
  const mock = new MockServer({
    counter: new PromptCounter(tok), outDir: null,
    limit: cfg.budget.window,
    spec: { render: c.template === 'qwen3' ? 'qwen3' : 'sim', limitMode: LIMIT_MODE[cfg.server.type] ?? 'strict_total', usage: 'client' },
    reply: (_step, body) => {
      seen.push({ messages: body['messages'], max_tokens: body['max_tokens'], max_completion_tokens: body['max_completion_tokens'] });
      return { role: 'assistant', content: 'ok', tool_calls: [] };
    },
  });
  await mock.start(0);
  // in-process expectation: the same engine, config and fault spec
  const counter = counterFor(c, tok);
  const E = engineFor(cfg, counter, { faults });
  const oracle = createOracle(cfg, c.template, c.mode, tok);
  let proxy: { child: ChildProcess; port: number } | null = null;
  const out: HttpOutcome = { seed: c.seed, requests: c.requests.length, violations, faults: faults !== null, streamed: 0, unsafeInts: 0, faulted: 0, rejected400: 0 };
  let statsSeen = 0;
  try {
    proxy = await startProxy(cfgPath, mock.url, dir, faults);
    for (let k = 0; k < c.requests.length; k++) {
      const req = c.requests[k]!;
      const unsafe = unsafeEvery > 0 && (c.seed + k) % unsafeEvery === 0;
      let text = JSON.stringify(req);
      if (unsafe) text = text.slice(0, -1) + ',"user_seed":12345678901234567890}';
      const before = seen.length;
      const recBefore = mock.records.length;
      const res = await httpRequest({
        method: 'POST', url: `http://127.0.0.1:${proxy.port}/v1/chat/completions`, body: Buffer.from(text),
        headers: [['content-type', 'application/json'], ['x-sim-step', String(k)], ['x-sim-session', `fz${c.seed}`]],
        connectionClose: false, waitForServerClose: false, timeoutMs: 120_000,
      });
      if (req.stream) out.streamed++;
      const calls = seen.slice(before);
      const recs = mock.records.slice(recBefore);
      for (const r of recs) if (r.rejected_for_length) v('http-I2', k, `the mock rejected a forwarded request for length: prompt ${r.prompt_tokens} + ${r.max_tokens} > ${mock.limit}`);
      if (unsafe) {
        statsSeen++;
        out.unsafeInts++;
        const raw = corrected(oracle.raw(req), 100);
        const fitsOrig = serverFitsRaw(cfg, raw, req);
        if (res.status === 200) {
          if (calls.length !== 1 || canonicalJSON(calls[0]!.messages) !== canonicalJSON(req.messages)) v('http-dialect', k, `an unsafe-integer body was rewritten or not forwarded once (${calls.length} upstream calls)`);
        } else if (res.status === 400) {
          if (calls.length) v('http-dialect', k, 'a 400 after an upstream call');
          if (fitsOrig) v('http-dialect', k, 'an unsafe-integer body that fits got a 400');
        } else v('http-dialect', k, `status ${res.status}`);
        // the live engine never saw this request: keep the in-process chain in step with the proxy's (the proxy
        // did not plan it either)
        continue;
      }
      const exp: EngineResult = E.process(req, { attempt: 1 });
      if (exp.reason === 'engine:fault') out.faulted++;
      // the proxy has a fault layer of its own around engine.process (src/proxy/server.ts, random): its stats
      // record says guard 'engine:InjectedFault'; then I7 decides, not the in-process engine
      const st = await statsRecord(join(dir, 'stats.jsonl'), statsSeen++);
      if (st && st['guard'] === 'engine:InjectedFault') {
        out.faulted++;
        const fitsOrig = serverFitsRaw(cfg, corrected(oracle.raw(req), 100), req);
        if (fitsOrig && !(res.status === 200 && calls.length === 1 && canonicalJSON(calls[0]!.messages) === canonicalJSON(req.messages))) v('http-I7', k, `proxy fault: the fitting original was not forwarded once (status ${res.status}, ${calls.length} calls)`);
        if (!fitsOrig && !(res.status === 400 && calls.length === 0)) v('http-I7', k, `proxy fault: an original that does not fit was forwarded (status ${res.status}, ${calls.length} calls)`);
        continue;
      }
      if (exp.request === null) {
        out.rejected400++;
        if (res.status !== 400) v('http-status', k, `expected a 400 (${exp.action} ${exp.reason}), got ${res.status}`);
        if (calls.length) v('http-I7', k, `${exp.action}: the upstream was called ${calls.length} times`);
        continue;
      }
      if (res.status !== 200) {
        v('http-status', k, `expected 200 (${exp.action} ${exp.reason}), got ${res.status}: ${res.body.toString('utf8').slice(0, 200)}`);
        continue;
      }
      if (calls.length !== 1) {
        v('http-attempts', k, `${calls.length} upstream calls for one request (${exp.action})`);
        continue;
      }
      const got = calls[0]!;
      const want = exp.request;
      if (canonicalJSON(got.messages) !== canonicalJSON(want.messages)) v('http-equiv', k, `forwarded messages != in-process engine output (${exp.action} ${exp.reason}); ${(got.messages as ChatMessage[]).length} vs ${want.messages.length} messages`);
      for (const f of ['max_tokens', 'max_completion_tokens'] as const) {
        if ((got[f] ?? null) !== (want[f] ?? null)) v('http-equiv', k, `${f}: forwarded ${String(got[f])} != engine ${String(want[f])} (${exp.action})`);
      }
      const p = parseResponse(res.headers.find(([h]) => h === 'content-type')?.[1] ?? '', res.body);
      if (req.stream && (!p.stream || !p.done)) v('http-stream', k, `stream not well formed (done ${p.done}, stream ${p.stream})`);
      if (!req.stream && (p.stream || p.errors.length)) v('http-stream', k, 'a JSON response expected');
      if (p.errors.length) v('http-stream', k, `error events: ${JSON.stringify(p.errors[0]).slice(0, 200)}`);
    }
  } catch (e) {
    v('http-crash', -1, e instanceof Error ? e.stack ?? e.message : String(e));
  } finally {
    if (proxy) await stop(proxy.child);
    await mock.stop();
  }
  if (!violations.length) rmSync(dir, { recursive: true, force: true });
  return out;
}

/** The k-th stats record of the proxy (written after the response; polled briefly). */
async function statsRecord(path: string, k: number): Promise<Record<string, unknown> | null> {
  for (let t = 0; t < 100; t++) {
    try {
      const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
      if (lines.length > k) return JSON.parse(lines[k]!) as Record<string, unknown>;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return null;
}

/** serverFits(original, T_req) with the budget arithmetic of DESIGN §3 (the count is the oracle's). */
function serverFitsRaw(cfg: FuzzChain['cfg'], c: number, req: ChatRequest): boolean {
  const tReq = requestedMaxTokens(req, cfg);
  const bud = computeBudget(cfg, defaultLearnedEntry(cfg, ''), 0, tReq);
  return serverFits(bud, c, tReq);
}

async function main(): Promise<void> {
  const count = Number(arg('chains', '300'));
  const base = Number(arg('base', '900000'));
  const outPath = arg('out', join(RESULTS_DIR, 'fuzz.json'));
  const t0 = performance.now();
  const outs: HttpOutcome[] = [];
  for (let i = 0; i < count; i++) {
    const seed = base + i;
    const c = genChain(seed, { exact: true, http: true, template: i % 3 === 2 ? 'qwen3' : 'sim' });
    const faults = i % 3 === 1 ? 'engine-throw:0.05' : null;
    const o = await runHttpChain(c, faults, 7);
    outs.push(o);
    if (o.violations.length) console.log(`HTTP VIOLATION seed ${seed}: ${o.violations.slice(0, 3).map((x) => `${x.inv}@${x.request} ${x.detail}`).join(' | ')}`);
    if ((i + 1) % 25 === 0) console.log(`  http ${i + 1}/${count} chains, ${outs.filter((x) => x.violations.length).length} with violations, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  }
  const byInv: Record<string, number> = {};
  for (const o of outs) for (const x of o.violations) byInv[x.inv] = (byInv[x.inv] ?? 0) + 1;
  const http = {
    chains: outs.length, requests: outs.reduce((a, o) => a + o.requests, 0), base,
    withFaults: outs.filter((o) => o.faults).length, faulted: outs.reduce((a, o) => a + o.faulted, 0),
    streamed: outs.reduce((a, o) => a + o.streamed, 0), unsafeInts: outs.reduce((a, o) => a + o.unsafeInts, 0),
    rejected400: outs.reduce((a, o) => a + o.rejected400, 0),
    violations: { total: Object.values(byInv).reduce((a, b) => a + b, 0), byInvariant: byInv, first: outs.flatMap((o) => o.violations).slice(0, 20) },
    runtimeS: Math.round((performance.now() - t0) / 1000),
  };
  let doc: Record<string, unknown> = {};
  if (existsSync(outPath)) {
    try {
      doc = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>;
    } catch {
      doc = {};
    }
  }
  doc['http'] = http;
  writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n');
  console.log(`http subset: ${http.chains} chains, ${http.requests} requests, ${http.violations.total} violations, ${http.runtimeS} s → ${outPath}`);
  process.exitCode = http.violations.total ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
