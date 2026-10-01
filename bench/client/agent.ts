// Port of reference-harness sim/agent_client.py: a simulated agent that resends its whole history each
// step, like OpenCode/Kilo.
//
//  - body {"model","messages","tools","max_tokens","stream"[,"stream_options":{"include_usage":true}]},
//    sent as Python json.dumps(body) bytes (ensure_ascii=True, spaced separators) — byte-identical;
//  - headers content-type / authorization: Bearer sim-key / x-sim-step (+ x-sim-session when set);
//  - a new connection per request, and the next request only after the server CLOSED it (bench/client/http.ts);
//  - stop at the first non-200 (the session ends), recording error_body[:600];
//  - SSE parse line-wise over the whole body (proxies re-chunk): every tool_calls delta entry is appended
//    as its OWN call with `index` removed (fragments are not merged by index, exactly like Python);
//    content "" becomes null; tool_calls stays [] when there are none;
//  - after each step: the assistant message, one tool message per call with tool_output(step), and the
//    USER_INJECT message after step 9;
//  - client.jsonl: {step, orig_messages, orig_est_tokens, orig_qwen_tokens, status, secs[, error_body]}
//    (Python's keys and order), then harness extras (usage, req_bytes, resp_bytes, ms_complete, server_closed).
//
// ---- bench/README.md extensions ----
//  - `strict: true` (benchmark contract ): a 200 response is also a client-visible error when it carries an in-stream
//    error event (`data:`/`error:` with a top-level `error`), ends with no [DONE] and no finish_reason, or stops at
//    finish_reason "length" with no tool call. The record gets `client_error_kind` and the session ends. The
//    Python-parity cross-check keeps strict off (the Python agent accepts such a turn as an empty one).
//  - `spec: ScenarioSpec`: the scenario drives the run instead of reference.ts — every session of it (history =
//    [system(), goal()], tools(), toolResults(step, calls), userAfter(step)), interleaved round-robin, seeded, or
//    with up to `concurrent` requests in flight; headers x-sim-scenario / x-sim-session / x-sim-step /
//    x-sim-kind: main and X-Session-Id; SSE parsed by bench/client/sse.ts (tool-call deltas merged by index);
//    reasoning sent back as `reasoning_content` like OpenCode (`reasoningEcho`, default on). The legacy path
//    (no spec) is untouched and stays byte-identical to agent_client.py.

import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { ChatMessage, ToolCall } from '../../src/types.js';
import type { ScenarioSpec, SessionSpec } from '../scenarios/types.js';
import { pyDumps, pyFloat, pySliceHead } from '../lib/pyjson.js';
import { PyRandom } from '../lib/pyrandom.js';
import { estTokens, type PromptCounter, type RenderBody } from '../lib/render.js';
import { pySplitlines, pyStrip, pyRound } from '../lib/stats.js';
import { initialHistory, toolOutput, tools as scenarioTools, USER_INJECT, type ScenarioOptions } from '../scenarios/reference.js';
import { renderQwen3 } from '../mock/qwen3-render.js';
import { header, httpRequest } from './http.js';
import { assistantFrom, clientErrorKind, parseResponse, type ClientErrorKind } from './sse.js';

type Json = Record<string, unknown>;
const isDict = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

export interface AgentOptions {
  /** base URL (http://host:port[/prefix]); requests go to <prefix>/v1/chat/completions */
  base: string;
  counter: PromptCounter;
  /** client.jsonl and origs/ go here; null = in memory only */
  outDir?: string | null;
  steps?: number;
  maxTokens?: number;
  /** --no-stream => false */
  stream?: boolean;
  /** --no-usage => false */
  usage?: boolean;
  /** --save-origs: origs/step{N}.json (ensure_ascii=False), needed by analyze.py's fact/dropped columns */
  saveOrigs?: boolean;
  scenario?: ScenarioOptions;
  model?: string;
  /** adds an x-sim-session header (the mock keys its LCP bookkeeping on it) */
  session?: string | null;
  /** see http.ts (default true) */
  connectionClose?: boolean;
  closeWaitMs?: number;
  /** see http.ts (default true; false only to demonstrate the gobstopper calibration race) */
  waitForServerClose?: boolean;
  /** progress lines (Python prints the error line and "done") */
  log?: (line: string) => void;
  onStep?: (rec: ClientRecord) => void;
  // ---- bench/README.md
  /** benchmark contract client-visible errors (default false = the Python agent) */
  strict?: boolean;
  /** drive this ScenarioSpec (all of its sessions) instead of the reference scenario */
  spec?: ScenarioSpec;
  /** send reasoning back as reasoning_content (spec path; default true) */
  reasoningEcho?: boolean;
  /** overrides spec.interleave (default round-robin) */
  interleave?: ScenarioSpec['interleave'];
  /** template for orig_qwen_tokens on the spec path (default: the spec's mock.render, else 'sim'; match the mock's render) */
  origRender?: 'sim' | 'qwen3';
  /**
   * spec path: called before each client step's request is built (F13: restart the system under test). A returned
   * string is the new base URL for this and every later request.
   */
  beforeStep?: (ctx: { session: string; step: number }) => Promise<string | void> | string | void;
}

export interface ClientRecord {
  step: number;
  orig_messages: number;
  orig_est_tokens: number;
  orig_qwen_tokens: number;
  status?: number;
  secs?: number;
  error_body?: string;
  // ---- harness extras
  usage?: unknown;
  req_bytes?: number;
  resp_bytes?: number;
  ms_complete?: number;
  server_closed?: boolean;
  // ---- SPEC extras
  session?: string;
  finish_reason?: string | null;
  client_error_kind?: ClientErrorKind;
}

export interface AgentResult {
  records: ClientRecord[];
  history: ChatMessage[];
  /** client-visible failure (first non-200; with strict also in-stream errors, no-finish streams, length cut-offs) */
  error: { step: number; status: number; body: string; kind?: ClientErrorKind; session?: string } | null;
  ms: number;
  /** spec path: every session's final history and every session-ending error */
  histories?: Record<string, ChatMessage[]>;
  errors?: Array<{ step: number; status: number; body: string; kind: ClientErrorKind; session: string }>;
}

export function clientRecordLine(r: ClientRecord): string {
  return pyDumps({ ...r, secs: r.secs === undefined ? undefined : pyFloat(r.secs) });
}

/** agent_client.parse(): the assistant message from an SSE or JSON response body. */
export function parseAssistant(ctype: string, raw: Buffer): { msg: ChatMessage; usage: unknown } {
  let usage: unknown = undefined;
  if (ctype.includes('event-stream')) {
    const msg: { role: string; content: string | null; tool_calls: ToolCall[] } = { role: 'assistant', content: '', tool_calls: [] };
    for (const line of pySplitlines(raw.toString('utf8'))) {
      if (!line.startsWith('data:') || pyStrip(line) === 'data: [DONE]') continue;
      const ev = JSON.parse(line.slice(5)) as Json;
      if (ev['usage'] !== undefined && ev['usage'] !== null) usage = ev['usage'];
      const choices = ev['choices'] === undefined ? [] : (ev['choices'] as unknown[]);
      for (const ch of choices) {
        const d = isDict(ch) && ch['delta'] !== undefined ? (ch['delta'] as Json) : {};
        msg.content += (d['content'] as string | null | undefined) || '';
        const tcs = d['tool_calls'];
        for (const tc of Array.isArray(tcs) ? tcs : []) {
          const copy = { ...(tc as Json) };
          delete copy['index'];
          msg.tool_calls.push(copy as unknown as ToolCall);
        }
      }
    }
    msg.content = msg.content || null;
    return { msg, usage };
  }
  const j = JSON.parse(raw.toString('utf8')) as Json;
  usage = j['usage'];
  return { msg: ((j['choices'] as unknown[])[0] as Json)['message'] as ChatMessage, usage };
}

export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  if (o.spec) return runSpecAgent(o, o.spec);
  const steps = o.steps ?? 46;
  const maxTokens = o.maxTokens ?? 32_000;
  const stream = o.stream ?? true;
  const withUsage = o.usage ?? true;
  const sc = o.scenario ?? {};
  const out = o.outDir ?? null;
  const logPath = out ? join(out, 'client.jsonl') : null;
  if (out) {
    mkdirSync(join(out, 'origs'), { recursive: true }); // Python makes origs/ unconditionally
    writeFileSync(logPath!, ''); // opened with "w"
  }
  const u = new URL(o.base);
  const url = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}/v1/chat/completions`;
  const history = initialHistory();
  const tools = scenarioTools();
  const records: ClientRecord[] = [];
  let error: AgentResult['error'] = null;
  const t0 = performance.now();
  const write = (rec: ClientRecord): void => {
    records.push(rec);
    if (logPath) appendFileSync(logPath, clientRecordLine(rec) + '\n');
    o.onStep?.(rec);
  };
  for (let step = 0; step < steps; step++) {
    const body: Json = { model: o.model ?? 'local-model', messages: history, tools, max_tokens: maxTokens, stream };
    if (stream && withUsage) body['stream_options'] = { include_usage: true };
    const rec: ClientRecord = {
      step,
      orig_messages: history.length,
      orig_est_tokens: estTokens(body),
      orig_qwen_tokens: o.counter.countBody(body),
    };
    if (o.saveOrigs && out) writeFileSync(join(out, 'origs', `step${step}.json`), pyDumps(body, { ensureAscii: false }));
    const t = performance.now();
    const data = Buffer.from(pyDumps(body), 'latin1'); // ensure_ascii=True: pure ASCII
    const headers: Array<[string, string]> = [
      ['content-type', 'application/json'],
      ['authorization', 'Bearer sim-key'],
      ['x-sim-step', String(step)],
    ];
    if (o.session) headers.push(['x-sim-session', o.session]);
    const res = await httpRequest({
      method: 'POST', url, headers, body: data,
      connectionClose: o.connectionClose ?? true, closeWaitMs: o.closeWaitMs ?? 10_000,
      ...(o.waitForServerClose === false ? { waitForServerClose: false } : {}),
    });
    rec.status = res.status;
    rec.secs = pyRound((performance.now() - t) / 1000, 2);
    rec.req_bytes = data.length;
    rec.resp_bytes = res.body.length;
    rec.ms_complete = Math.round(res.msComplete * 10) / 10;
    rec.server_closed = res.serverClosed;
    if (res.status !== 200) {
      const text = res.body.toString('utf8'); // errors="replace"
      rec.error_body = pySliceHead(text, 600);
      // Python key order: ..., status, secs, error_body (extras after)
      const ordered: ClientRecord = {
        step: rec.step, orig_messages: rec.orig_messages, orig_est_tokens: rec.orig_est_tokens, orig_qwen_tokens: rec.orig_qwen_tokens,
        status: rec.status, secs: rec.secs, error_body: rec.error_body,
        req_bytes: rec.req_bytes, resp_bytes: rec.resp_bytes, ms_complete: rec.ms_complete, server_closed: rec.server_closed,
      };
      write(ordered);
      o.log?.(`step ${step}: HTTP ${res.status}: ${pySliceHead(rec.error_body, 200)}`);
      error = { step, status: res.status, body: text };
      break;
    }
    if (o.strict) {
      const kind = clientErrorKind(200, parseResponse(header(res, 'content-type') ?? '', res.body));
      if (kind) {
        rec.client_error_kind = kind;
        write(rec);
        o.log?.(`step ${step}: client-visible error ${kind}`);
        error = { step, status: 200, body: res.body.toString('utf8'), kind };
        break;
      }
    }
    const { msg, usage } = parseAssistant(header(res, 'content-type') ?? '', res.body);
    if (usage !== undefined) rec.usage = usage;
    history.push(msg);
    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    for (const call of calls) history.push({ role: 'tool', tool_call_id: call.id, content: toolOutput(step, sc) });
    const inj = USER_INJECT.get(step);
    if (inj !== undefined) history.push({ role: 'user', content: inj });
    write(rec);
  }
  o.log?.('done');
  return { records, history, error, ms: performance.now() - t0 };
}

// ---------------------------------------------------------------- spec-driven path (bench/README.md)

interface SessionRun {
  spec: SessionSpec;
  history: ChatMessage[];
  tools: unknown[];
  step: number;
  steps: number;
  done: boolean;
}

/** orig_qwen_tokens under the given render (qwen3: the mock's vLLM-faithful render; -1 if it does not render). */
function origCount(counter: PromptCounter, body: RenderBody, render: 'sim' | 'qwen3'): number {
  if (render === 'sim') return counter.countBody(body);
  try {
    return counter.countText(renderQwen3(JSON.stringify(body)));
  } catch {
    return -1;
  }
}

async function runSpecAgent(o: AgentOptions, spec: ScenarioSpec): Promise<AgentResult> {
  const maxTokens = o.maxTokens ?? 32_000;
  const stream = o.stream ?? true;
  const withUsage = o.usage ?? true;
  const strict = o.strict ?? false;
  const echo = o.reasoningEcho ?? true;
  const render = o.origRender ?? spec.mock?.render ?? 'sim';
  const out = o.outDir ?? null;
  const logPath = out ? join(out, 'client.jsonl') : null;
  if (out) {
    mkdirSync(join(out, 'origs'), { recursive: true });
    writeFileSync(logPath!, '');
  }
  const urlOf = (base: string): string => {
    const u = new URL(base);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}/v1/chat/completions`;
  };
  let url = urlOf(o.base);
  const runs: SessionRun[] = spec.sessions.map((s) => ({
    spec: s, history: [{ role: 'system', content: s.system() }, s.goal()], tools: s.tools(), step: 0, steps: o.steps ?? s.steps, done: false,
  }));
  const single = runs.length === 1;
  const records: ClientRecord[] = [];
  const errors: NonNullable<AgentResult['errors']> = [];
  const t0 = performance.now();
  const write = (rec: ClientRecord): void => {
    records.push(rec);
    if (logPath) appendFileSync(logPath, clientRecordLine(rec) + '\n');
    o.onStep?.(rec);
  };
  const fail = (S: SessionRun, rec: ClientRecord, status: number, body: string, kind: ClientErrorKind): void => {
    S.done = true;
    errors.push({ step: rec.step, status, body, kind, session: S.spec.id });
    o.log?.(`[${S.spec.id}] step ${rec.step}: ${status !== 200 ? `HTTP ${status}: ${pySliceHead(body, 200)}` : `client-visible error ${kind}`}`);
  };
  const runStep = async (S: SessionRun): Promise<void> => {
    const step = S.step;
    if (o.beforeStep) {
      const nb = await o.beforeStep({ session: S.spec.id, step });
      if (typeof nb === 'string') url = urlOf(nb);
    }
    const body: Record<string, unknown> = { model: o.model ?? 'local-model', messages: S.history, tools: S.tools, max_tokens: maxTokens, stream };
    if (stream && withUsage) body['stream_options'] = { include_usage: true };
    const rec: ClientRecord = {
      step, orig_messages: S.history.length, orig_est_tokens: estTokens(body), orig_qwen_tokens: origCount(o.counter, body as RenderBody, render),
    };
    if (o.saveOrigs && out) writeFileSync(join(out, 'origs', single ? `step${step}.json` : `${S.spec.id}_step${step}.json`), pyDumps(body, { ensureAscii: false }));
    const data = Buffer.from(pyDumps(body), 'latin1');
    const headers: Array<[string, string]> = [
      ['content-type', 'application/json'],
      ['authorization', 'Bearer sim-key'],
      ['x-sim-step', String(step)],
      ['x-sim-session', S.spec.id],
      ['x-sim-scenario', spec.id],
      ['x-sim-kind', 'main'],
      ['X-Session-Id', S.spec.id],
    ];
    const t = performance.now();
    const res = await httpRequest({
      method: 'POST', url, headers, body: data,
      connectionClose: o.connectionClose ?? true, closeWaitMs: o.closeWaitMs ?? 10_000,
      ...(o.waitForServerClose === false ? { waitForServerClose: false } : {}),
    });
    rec.status = res.status;
    rec.secs = pyRound((performance.now() - t) / 1000, 2);
    const text = res.body.toString('utf8');
    if (res.status !== 200) rec.error_body = pySliceHead(text, 600);
    rec.req_bytes = data.length;
    rec.resp_bytes = res.body.length;
    rec.ms_complete = Math.round(res.msComplete * 10) / 10;
    rec.server_closed = res.serverClosed;
    rec.session = S.spec.id;
    if (res.status !== 200) {
      rec.client_error_kind = `http_${res.status}`;
      write(rec);
      fail(S, rec, res.status, text, rec.client_error_kind);
      return;
    }
    const parsed = parseResponse(header(res, 'content-type') ?? '', res.body);
    if (parsed.usage) rec.usage = parsed.usage;
    rec.finish_reason = parsed.finishReason;
    const kind = strict ? clientErrorKind(200, parsed) : null;
    if (kind) {
      rec.client_error_kind = kind;
      write(rec);
      fail(S, rec, 200, text, kind);
      return;
    }
    const msg = assistantFrom(parsed, echo);
    S.history.push(msg);
    S.history.push(...S.spec.toolResults(step, msg.tool_calls ?? []));
    S.history.push(...S.spec.userAfter(step));
    write(rec);
    S.step++;
    if (S.step >= S.steps) S.done = true;
  };
  const il = o.interleave ?? spec.interleave ?? 'round-robin';
  const concurrent = typeof il === 'object' ? Math.max(1, il.concurrent ?? 1) : 1;
  if (concurrent > 1) {
    // each session runs its own sequential loop; at most `concurrent` requests are in flight
    let free = concurrent;
    const waiting: Array<() => void> = [];
    const acquire = (): Promise<void> => (free > 0 ? (free--, Promise.resolve()) : new Promise((r) => waiting.push(r)));
    const release = (): void => {
      const next = waiting.shift();
      if (next) next();
      else free++;
    };
    await Promise.all(runs.map(async (S) => {
      while (!S.done) {
        await acquire();
        try {
          await runStep(S);
        } finally {
          release();
        }
      }
    }));
  } else {
    const rng = typeof il === 'object' ? new PyRandom(il.seed) : null;
    let next = 0;
    for (;;) {
      const active = runs.filter((r) => !r.done);
      if (!active.length) break;
      let S: SessionRun;
      if (rng) S = active[rng.randbelow(active.length)]!;
      else {
        let i = next;
        while (runs[i % runs.length]!.done) i++;
        S = runs[i % runs.length]!;
        next = (i % runs.length) + 1;
      }
      await runStep(S);
    }
  }
  o.log?.('done');
  const histories: Record<string, ChatMessage[]> = {};
  for (const r of runs) histories[r.spec.id] = r.history;
  const first = errors[0];
  return {
    records, history: runs[0]!.history, histories, errors,
    error: first ? { step: first.step, status: first.status, body: first.body, kind: first.kind, session: first.session } : null,
    ms: performance.now() - t0,
  };
}

// ---------------------------------------------------------------- CLI (agent_client.py's arguments)
//   node dist/bench/client/agent.js BASE_URL OUTDIR [--steps 46] [--max-tokens 32000] [--no-stream] [--no-usage] [--save-origs] [--strict]
//   SIM_CAP_BYTES / SIM_CHATTY / SIM_HUGE_AT / SIM_HUGE_CHARS are read like scenario.py.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const pos: string[] = [];
  const o: Partial<AgentOptions> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--steps') o.steps = Number(args[++i]);
    else if (a === '--max-tokens') o.maxTokens = Number(args[++i]);
    else if (a === '--no-stream') o.stream = false;
    else if (a === '--no-usage') o.usage = false;
    else if (a === '--save-origs') o.saveOrigs = true;
    else if (a === '--session') o.session = args[++i] ?? null;
    else if (a === '--strict') o.strict = true;
    else pos.push(a);
  }
  if (pos.length < 2) {
    console.error('usage: agent.js BASE_URL OUTDIR [--steps N] [--max-tokens N] [--no-stream] [--no-usage] [--save-origs] [--session S] [--strict]');
    process.exit(2);
  }
  const { PromptCounter } = await import('../lib/render.js');
  const { benchTokenizer } = await import('../lib/paths.js');
  const { scenarioOptionsFromEnv } = await import('../scenarios/reference.js');
  await runAgent({ ...o, base: pos[0]!, outDir: pos[1]!, counter: new PromptCounter(benchTokenizer()), scenario: scenarioOptionsFromEnv(process.env), log: (l) => console.log(l) });
}
