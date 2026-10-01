// OpenCode's (and optionally Kilo Code's) client-side context mechanics over HTTP (bench/README.md), so the
// OpenCode client can run direct against the mock or through a proxy, see translated errors and retries, and produce
// family 10's client-compacted histories. Everything is READ from OpenCode 1.18.33 @03e6717 / Kilo 7.8.1 @7d977bc
// (reference implementation; strings in bench/client/opencode-strings.ts):
//
//  - trigger: after a step, `prompt_tokens + completion_tokens` of its usage ≥ usable = context − min(output,32000)
//    (no usage → never proactive); a provider overflow error (OpenCode's 27 patterns minus exclusions on the AI-SDK
//    message, HTTP 413, error.code "context_length_exceeded"; in-stream: parseStreamError, only
//    code "context_length_exceeded") compacts and re-sends the step, at most 3 attempts per step (the 3rd rejection
//    still compacts, then the step fails, like baseline.py);
//  - compaction: select() keeps the newest user turns within preserve_recent = min(15000, max(2000, usable/4))
//    estimated tokens (splitting the newest turn at message granularity; keep 0 or none → everything summarized, no
//    tail), the head is serialized (tool results cut at 2000 chars) into the exact summarizer prompt (compaction.txt
//    system, buildPrompt with SUMMARY_TEMPLATE / prior-summary / SUMMARY_UPDATE_INSTRUCTIONS), sent with
//    `x-sim-kind: summarizer`, no tools, max_tokens = min(output, 32000); the next request is [system,
//    "What did we do so far?", summary, tail…, Continue] with the long Continue text after an overflow, the short
//    one otherwise;
//  - wire conventions: tools sorted by name (localeCompare) as {type, function:{name, description, parameters}},
//    tool_choice "auto", max_tokens always sent, stream + include_usage, compact JSON, tool-call arguments
//    re-serialized with JSON.stringify(JSON.parse(args)), content "" on tool-only assistants, reasoning_content sent
//    back, headers x-session-affinity / X-Session-Id / User-Agent; a title request after the first step
//    (`x-sim-kind: title`);
//  - retries (retry.ts): non-overflow errors with status 408/409/429/≥500, or unknown in-stream errors whose JSON
//    matches /429|500|502|503|504|524/, are retried up to 5 times after 2000·2^(n−1)·(1+0.25·rand) ms on a VIRTUAL
//    clock (nothing sleeps);
//  - Kilo (`variant: 'kilo'`, the cheap documented differences): content null on tool-only assistants, an
//    <environment_details> text part on every user message (marker and Continue included), tail limited to the 2
//    newest user turns, KiloLLM.capOutputTokens max_tokens, the post-compaction and payload-limit (> 1.25 MB) prunes
//    that rewrite old tool results to "[Old tool result content cleared]", Kilo's extra overflow exclusion and
//    headers. Not modelled: chunked summaries, replay, persona prompts, the preflight threshold (off by default).
//
// `mode: 'baseline-compat'` reproduces reference-harness baseline.py against the TS mock: scenario tool order, the
// mock's raw tool-call arguments, baseline's est (spaced json.dumps code points // 4) and serialize(), the short
// Continue text, no title request, and `x-sim-summary: baseline` so the mock's summary is baseline.py's filler plus the
// visible markers. SIM_CAP_BYTES=51200 at 100k/32k: 1,994,168 main + 462,169 rejected (MEASURED by
// test/bench/client-opencode.test.ts); `baselineSummIn` re-computes baseline's summarizer estimate, so
// main + rejected + baselineSummIn = baseline.py's total_prompt_tokens (2,492,784).
// Not modelled in either mode: OpenCode's replay of the last user message after an overflow (an INFERRED shape in
// reference implementation; baseline.py and the ≈2.5M reference number do not model it either) and the opt-in prune.
//
//   node dist/bench/client/opencode.js [BASE_URL] [--baseline-compat] [--kilo] [--context 100000] [--output 32000]
//        [--steps N] [--cap-bytes N] [--long-continue] [--no-title] [--out DIR]
//   Without BASE_URL an in-process TS mock (Python mode, limit = context) is started and the totals are printed.

import { createHash } from 'node:crypto';
import { STATUS_CODES } from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatMessage, ToolCall } from '../../src/types.js';
import type { ScenarioSpec, SessionSpec } from '../scenarios/types.js';
import { pyDumps, pyLen, pySliceHead } from '../lib/pyjson.js';
import { PyRandom } from '../lib/pyrandom.js';
import { contentText, type PromptCounter } from '../lib/render.js';
import { referenceScenario } from '../lib/ref-spec.js';
import { renderQwen3 } from '../mock/qwen3-render.js';
import type { ScenarioOptions } from '../scenarios/reference.js';
import { header, httpRequest } from './http.js';
import { parseResponse, type ClientErrorKind, type ParsedResponse } from './sse.js';
import {
  buildSummarizerPrompt, COMPACTION_MARKER, COMPACTION_SYSTEM, CONTINUE_OVERFLOW, CONTINUE_PROACTIVE, OVERFLOW_EXCLUSIONS_KILO,
  OVERFLOW_EXCLUSIONS_OPENCODE, OVERFLOW_PATTERNS, RETRYABLE_UNKNOWN, TITLE_SYSTEM, TITLE_USER_PREFIX,
} from './opencode-strings.js';

type Json = Record<string, unknown>;
const isDict = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

export const OUTPUT_TOKEN_MAX = 32_000;
export const CLEARED = '[Old tool result content cleared]';
const OPENCODE_VERSION = '1.18.33';
const KILO_VERSION = '7.8.1';

// ---------------------------------------------------------------- pure mechanics (overflow.ts, compaction.ts)

/** overflow.ts usable() for a config with no limit.input. */
export function usableTokens(context: number, output: number): number {
  if (context === 0) return 0;
  const maxOut = Math.min(output, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX;
  return Math.max(0, context - maxOut);
}

/** compaction.ts preserve_recent default: min(15000, max(2000, floor(usable·0.25))). */
export const preserveRecent = (usable: number): number => Math.min(15_000, Math.max(2_000, Math.floor(usable * 0.25)));

export interface ErrorClass {
  overflow: boolean;
  retryable: boolean;
  /** the message OpenCode derives (provider/error.ts message()) */
  message: string;
}

/** AI SDK createJsonErrorResponseHandler + OpenCode ProviderError: is an HTTP error an overflow, is it retried? */
export function classifyHttpError(status: number, statusText: string, body: string, variant: 'opencode' | 'kilo' = 'opencode'): ErrorClass {
  // 1. the AI SDK message: error.message when the body matches the openai-compatible error schema, else statusText
  let sdk = statusText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  if (body.trim() !== '' && isDict(parsed)) {
    const e = parsed['error'];
    if (isDict(e) && typeof e['message'] === 'string' && (e['type'] == null || typeof e['type'] === 'string') &&
      (e['code'] == null || typeof e['code'] === 'string' || typeof e['code'] === 'number')) sdk = e['message'];
  }
  // 2. OpenCode's message()
  let m: string;
  const std = STATUS_CODES[status];
  if (sdk === '') m = body ? body.trim() : std ?? 'Unknown error';
  else if (!body || (status && sdk !== std)) m = sdk.trim();
  else {
    let found: string | null = null;
    if (isDict(parsed)) {
      const errMsg = parsed['message'] || parsed['error'] || (isDict(parsed['error']) ? parsed['error']['message'] : undefined);
      if (errMsg && typeof errMsg === 'string') found = `${sdk}: ${errMsg}`.trim();
    }
    m = found ?? (/^\s*<!doctype|^\s*<html/i.test(body) ? sdk.trim() : `${sdk}: ${body}`.trim());
  }
  // 3. overflow
  const excl = variant === 'kilo' ? OVERFLOW_EXCLUSIONS_KILO : OVERFLOW_EXCLUSIONS_OPENCODE;
  const isCtx = !excl.some((p) => p.test(m)) && (OVERFLOW_PATTERNS.some((p) => p.test(m)) || /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(m));
  const code = isDict(parsed) && isDict(parsed['error']) ? parsed['error']['code'] : undefined;
  const overflow = isCtx || status === 413 || code === 'context_length_exceeded';
  const retryable = !overflow && (status === 408 || status === 409 || status === 429 || status >= 500);
  return { overflow, retryable, message: m };
}

/** message-v2.ts parseStreamError on an in-stream `{error: …}` event, then retry.ts for NamedError.Unknown. */
export function classifyStreamError(ev: Json): ErrorClass {
  const error = ev['error'];
  const obj = { type: 'error', error };
  let overflow = isDict(error) && error['code'] === 'context_length_exceeded';
  if (!overflow && isDict(error) && typeof error['message'] === 'string') {
    try {
      const inner = JSON.parse(error['message']) as unknown;
      overflow = isDict(inner) && inner['type'] === 'error' && isDict(inner['error']) && inner['error']['code'] === 'context_length_exceeded';
    } catch {
      /* not JSON */
    }
  }
  const text = JSON.stringify(obj);
  return { overflow, retryable: !overflow && RETRYABLE_UNKNOWN.test(text), message: isDict(error) && typeof error['message'] === 'string' ? error['message'] : text };
}

// ---------------------------------------------------------------- the client's own message store

interface OcUser {
  role: 'user';
  text: string;
  /** virtual creation time (Kilo environment_details) */
  created: number;
}
interface OcCall {
  id: string;
  name: string;
  /** the arguments string the model produced (baseline-compat wire) */
  args: string;
  /** JSON.parse(args) (OpenCode re-serializes it) */
  input: unknown;
  output: string;
  cleared: boolean;
}
interface OcAssistant {
  role: 'assistant';
  text: string;
  reasoning: string;
  calls: OcCall[];
  /** baseline-compat: the assistant message exactly as agent_client.py parses it */
  raw: ChatMessage;
  /** baseline-compat: the scenario's tool messages */
  results: ChatMessage[];
}
type OcMsg = OcUser | OcAssistant;

export interface OpenCodeOptions {
  /** base URL; requests go to <base>/v1/chat/completions */
  base: string;
  counter: PromptCounter;
  /** default: the reference scenario (reference.ts via bench/lib/ref-spec.ts) with `scenario` */
  spec?: ScenarioSpec;
  scenario?: ScenarioOptions;
  /** session of the spec to run (id or index; default the first) */
  session?: string | number;
  mode?: 'faithful' | 'baseline-compat';
  variant?: 'opencode' | 'kilo';
  /** limit.context / limit.output declared in the client config (truthful: W / O) */
  context: number;
  output: number;
  steps?: number;
  /** 'opencode' (faithful default): long text after an overflow; 'baseline' (compat default): always the short one */
  continueText?: 'opencode' | 'baseline';
  /** send the title request after the first step (faithful default true, compat false) */
  title?: boolean;
  /** attempts per step before giving up (3, like baseline.py / Kilo MAX_COMPACTION_ATTEMPTS) */
  maxAttempts?: number;
  /** retry.ts retries (5) */
  maxRetries?: number;
  /** seed of the retry jitter (virtual clock) */
  retrySeed?: number;
  /** compaction.preserve_recent_tokens (default: the formula) */
  preserveRecentTokens?: number;
  /** compaction.tail_turns (OpenCode: all; Kilo: 2) */
  tailTurns?: number;
  /** Kilo prunes (default true for kilo) */
  prune?: boolean;
  /** steps before which the user runs a manual compaction (plus the spec's `client-compact` events) */
  manualCompactAt?: number[];
  /**
   * what those compactions count as: 'manual' (short Continue) or 'overflow' (long Continue, F10 cc60-oc-overflow).
   * Default: the scenario's `clientCompact.trigger` (bench/scenarios ScenarioDef) or 'manual'.
   */
  manualCompactTrigger?: 'manual' | 'overflow';
  /** send x-sim-scenario (default: true when `spec` was given) */
  routeScenario?: boolean;
  model?: string;
  sessionId?: string;
  outDir?: string | null;
  /**
   * append to <outDir>/client.jsonl instead of truncating it (a driver that runs the sessions of one scenario one
   * call at a time into the same outDir passes true after the first session; origs/ names carry the session)
   */
  appendLog?: boolean;
  log?: (line: string) => void;
  /** see http.ts */
  closeWaitMs?: number;
  /** template of orig_qwen_tokens (default: the spec's mock.render, else 'sim'; match the mock's render) */
  origRender?: 'sim' | 'qwen3';
}

export interface OpenCodeRequest {
  session: string;
  step: number;
  /** main: attempt within the step (0 = first send); summarizer/title: 0 */
  attempt: number;
  kind: 'main' | 'summarizer' | 'title';
  /** retry.ts retries before this one */
  retry: number;
  status: number;
  overflow: boolean;
  retryable: boolean;
  error_message?: string;
  client_error_kind?: ClientErrorKind;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  finish_reason: string | null;
  max_tokens: number;
  req_bytes: number;
  messages: number;
  virtual_ms: number;
  /** with outDir: the client's own request body (the C_k of benchmark contract ), shared by retries of one attempt */
  orig_file?: string;
  /** with outDir: the mock-render count of that body (bench/metrics reads it as the client prompt) */
  orig_qwen_tokens?: number;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface OpenCodeCompaction {
  n: number;
  /** the step the compaction happens before */
  step: number;
  reason: 'overflow' | 'usage' | 'manual';
  /** usage-triggered: the reported prompt+completion */
  reported: number | null;
  headMessages: number;
  tailMessages: number;
  continueText: 'short' | 'long';
  summaryChars: number;
  summaryTokens: number | null;
}

export interface OpenCodeResult {
  session: string;
  requests: OpenCodeRequest[];
  compactions: OpenCodeCompaction[];
  stepsCompleted: number;
  steps: number;
  failedAt: number | null;
  error: { step: number; kind: ClientErrorKind | 'compaction_overflow' | 'could_not_fit'; status: number; message: string } | null;
  virtualMs: number;
  /** baseline.py's summ_in estimate: Σ count_text(head text + prior summary) + 600 */
  baselineSummIn: number;
  usable: number;
  preserve: number;
  /** the last main request's messages */
  lastMessages: ChatMessage[];
}

const utf16Len = (s: string): number => s.length;

/** The Kilo <environment_details> part of a user message (kilocode/editor-context.ts), with a virtual timestamp. */
export function environmentDetails(createdMs: number): string {
  const iso = new Date(createdMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `\n\n<environment_details>\nMessage time: ${iso}\nWorking directory: /repo\nWorkspace root folder: /repo\n</environment_details>`;
}

const VIRTUAL_EPOCH = Date.UTC(2026, 8, 28, 9, 0, 0);

export async function runOpenCode(o: OpenCodeOptions): Promise<OpenCodeResult> {
  const compat = (o.mode ?? 'faithful') === 'baseline-compat';
  const kilo = (o.variant ?? 'opencode') === 'kilo';
  const spec = o.spec ?? referenceScenario(o.scenario ?? {});
  const sess: SessionSpec =
    typeof o.session === 'number' ? spec.sessions[o.session]! : o.session !== undefined ? spec.sessions.find((s) => s.id === o.session)! : spec.sessions[0]!;
  if (!sess) throw new Error(`no session ${String(o.session)} in ${spec.id}`);
  const counter = o.counter;
  const steps = o.steps ?? sess.steps;
  const usable = usableTokens(o.context, o.output);
  const preserve = o.preserveRecentTokens ?? preserveRecent(usable);
  const configuredMax = Math.min(o.output, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX;
  const continueMode = o.continueText ?? (compat ? 'baseline' : 'opencode');
  const sendTitle = o.title ?? !compat;
  const maxAttempts = o.maxAttempts ?? 3;
  const maxRetries = o.maxRetries ?? 5;
  const tailTurns = o.tailTurns ?? (kilo ? 2 : undefined);
  const prune = o.prune ?? kilo;
  const route = o.routeScenario ?? o.spec !== undefined;
  const model = o.model ?? 'local-model';
  const sessionId = o.sessionId ?? 'ses_' + createHash('sha256').update(`${spec.id}/${sess.id}`).digest('hex').slice(0, 26);
  const manual = new Set([...(o.manualCompactAt ?? []), ...(spec.events ?? []).filter((e) => e.kind === 'client-compact').map((e) => e.atStep)]);
  const ccTrigger = (spec as { clientCompact?: { trigger?: unknown } }).clientCompact?.trigger;
  const manualAsOverflow = (o.manualCompactTrigger ?? (ccTrigger === 'overflow' ? 'overflow' : 'manual')) === 'overflow';
  const u = new URL(o.base);
  const url = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}/v1/chat/completions`;
  const rng = new PyRandom(o.retrySeed ?? 7);
  const out = o.outDir ?? null;
  const logPath = out ? join(out, 'client.jsonl') : null;
  if (out) {
    mkdirSync(join(out, 'origs'), { recursive: true });
    if (!o.appendLog) writeFileSync(logPath!, '');
  }
  const origRender = o.origRender ?? spec.mock?.render ?? 'sim';
  /** sends per (kind, step, attempt): a step can have several summarizer requests (manual + overflow, repeated overflows) */
  const origSeq = new Map<string, number>();

  const system: ChatMessage = { role: 'system', content: sess.system() };
  const rawTools = sess.tools();
  const tools: unknown[] = compat
    ? rawTools
    : rawTools
        .map((t) => {
          const fn = isDict(t) && isDict(t['function']) ? t['function'] : {};
          return { type: 'function', function: { name: fn['name'], description: fn['description'], parameters: fn['parameters'] } };
        })
        .sort((a, b) => String(a.function.name).localeCompare(String(b.function.name), 'en'));
  let userSeq = 0;
  const newUser = (text: string): OcUser => ({ role: 'user', text, created: VIRTUAL_EPOCH + 60_000 * userSeq++ });
  const goal = sess.goal();
  let msgs: OcMsg[] = [newUser(contentText(goal.content))];
  let summary: { text: string; reasoning: string } | null = null;
  const marker = newUser(COMPACTION_MARKER);
  const requests: OpenCodeRequest[] = [];
  const compactions: OpenCodeCompaction[] = [];
  let virtualMs = 0;
  let baselineSummIn = 0;
  let lastReported: number | null = null;
  let lastMessages: ChatMessage[] = [];
  let failure: OpenCodeResult['error'] = null;

  // ---- wire conversion
  const userWire = (m: OcUser): ChatMessage =>
    kilo ? { role: 'user', content: [{ type: 'text', text: m.text }, { type: 'text', text: environmentDetails(m.created) }] } : { role: 'user', content: m.text };
  const toWire = (m: OcMsg): ChatMessage[] => {
    if (m.role === 'user') return [compat ? { role: 'user', content: m.text } : userWire(m)];
    if (compat) return [m.raw, ...m.results];
    const a: ChatMessage = { role: 'assistant', content: m.calls.length && !m.text && kilo ? null : m.text };
    if (m.reasoning) a.reasoning_content = m.reasoning;
    if (m.calls.length) a.tool_calls = m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }));
    return [a, ...m.calls.map((c): ChatMessage => ({ role: 'tool', tool_call_id: c.id, content: c.cleared ? CLEARED : c.output }))];
  };
  const wireMessages = (): ChatMessage[] => {
    const w: ChatMessage[] = [system];
    if (summary) {
      w.push(compat ? { role: 'user', content: COMPACTION_MARKER } : userWire(marker));
      const s: ChatMessage = { role: 'assistant', content: summary.text };
      if (summary.reasoning && !compat) s.reasoning_content = summary.reasoning;
      w.push(s);
    }
    for (const m of msgs) w.push(...toWire(m));
    return w;
  };

  // ---- estimates
  const dumpLen = new WeakMap<object, number>();
  const pyMsgLen = (m: ChatMessage): number => {
    let n = dumpLen.get(m);
    if (n === undefined) dumpLen.set(m, (n = pyLen(pyDumps(m, { ensureAscii: false }))));
    return n;
  };
  /** baseline.py est(): len(json.dumps(msgs, ensure_ascii=False)) // 4 */
  const estBaseline = (ms: OcMsg[]): number => {
    const flat = ms.flatMap(toWire);
    return Math.floor((flat.length ? 2 + flat.reduce((a, m) => a + pyMsgLen(m), 0) + 2 * (flat.length - 1) : 2) / 4);
  };
  const modelMessages = (ms: OcMsg[]): unknown[] =>
    ms.flatMap((m): unknown[] => {
      if (m.role === 'user') {
        const content: unknown[] = [{ type: 'text', text: m.text }];
        if (kilo) content.push({ type: 'text', text: environmentDetails(m.created) });
        return [{ role: 'user', content }];
      }
      const content: unknown[] = [];
      if (m.reasoning) content.push({ type: 'reasoning', text: m.reasoning });
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.calls) content.push({ type: 'tool-call', toolCallId: c.id, toolName: c.name, input: c.input });
      const res: unknown[] = [{ role: 'assistant', content }];
      if (m.calls.length)
        res.push({ role: 'tool', content: m.calls.map((c) => ({ type: 'tool-result', toolCallId: c.id, toolName: c.name, output: { type: 'text', value: c.cleared ? CLEARED : c.output } })) });
      return res;
    });
  /** OpenCode estimate(): round(JSON.stringify(AI-SDK ModelMessages).length / 4) */
  const estOpenCode = (ms: OcMsg[]): number => Math.max(0, Math.round(utf16Len(JSON.stringify(modelMessages(ms))) / 4));
  const estimate = compat ? estBaseline : estOpenCode;

  // ---- serialize (summarizer conversation)
  const cutCp = (t: string): string => (pyLen(t) <= 2000 ? t : pySliceHead(t, 2000) + '\n[truncated]');
  const cut = (t: string): string => (t.length <= 2000 ? t : t.slice(0, 2000) + '\n[truncated]');
  const serializeBaseline = (m: OcMsg): string => {
    const lines: string[] = [];
    for (const w of toWire(m)) {
      if (w.role === 'user') lines.push(`[User]: ${contentText(w.content)}`);
      else if (w.role === 'assistant') {
        if (w.content) lines.push(`[Assistant]: ${contentText(w.content)}`);
        for (const c of w.tool_calls ?? []) lines.push(`[Assistant tool call]: ${c.function.name}(${c.function.arguments})`);
      } else if (w.role === 'tool') lines.push('[Tool result]: ' + cutCp(contentText(w.content)));
    }
    return lines.join('\n');
  };
  const serializeOpenCode = (m: OcMsg): string => {
    if (m.role === 'user') return m.text ? `[User]: ${m.text}` : '';
    const lines: string[] = [];
    if (m.reasoning) lines.push(`[Assistant reasoning]: ${m.reasoning}`);
    if (m.text) lines.push(`[Assistant]: ${m.text}`);
    for (const c of m.calls) {
      lines.push(`[Assistant tool call]: ${c.name}(${JSON.stringify(c.input)})`);
      lines.push(`[Tool result]: ${c.cleared ? CLEARED : cut(c.output)}`);
    }
    return lines.join('\n');
  };

  // ---- select (compaction.ts:223-269)
  const select = (ms: OcMsg[]): { head: OcMsg[]; tail: OcMsg[] } => {
    const starts = ms.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
    const recent = tailTurns === undefined ? starts : tailTurns <= 0 ? [] : starts.slice(-tailTurns);
    let keep: number | null = null;
    let total = 0;
    for (let t = recent.length - 1; t >= 0; t--) {
      const s = recent[t]!;
      const next = starts.find((x) => x > s);
      const e = next ?? ms.length;
      const size = estimate(ms.slice(s, e));
      if (total + size <= preserve) {
        total += size;
        keep = s;
        continue;
      }
      for (let s2 = s + 1; s2 < e; s2++) {
        if (estimate(ms.slice(s2, e)) <= preserve - total) {
          keep = s2;
          break;
        }
      }
      break;
    }
    if (keep === null || keep === 0) return { head: ms, tail: [] };
    return { head: ms.slice(0, keep), tail: ms.slice(keep) };
  };

  // ---- Kilo prune (compaction.ts:299-354): protect the newest 40k estimated tokens of tool output, need > 20k
  const kiloPrune = (): number => {
    const turnOf: number[] = [];
    let turn = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      turnOf[i] = turn;
      if (msgs[i]!.role === 'user') turn++;
    }
    const newestSteps = msgs.filter((m, i) => turnOf[i] === 0 && m.role === 'assistant').length;
    let total = 0;
    let pruned = 0;
    const victims: OcCall[] = [];
    outer: for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role !== 'assistant' || (turnOf[i] === 0 && newestSteps <= 2)) continue;
      for (let k = m.calls.length - 1; k >= 0; k--) {
        const c = m.calls[k]!;
        if (c.cleared) break outer;
        const est = Math.max(0, Math.round(c.output.length / 4));
        total += est;
        if (total > 40_000) {
          pruned += est;
          victims.push(c);
        }
      }
    }
    if (pruned <= 20_000) return 0;
    for (const c of victims) c.cleared = true;
    return victims.length;
  };

  // ---- HTTP
  const write = (r: OpenCodeRequest): void => {
    requests.push(r);
    if (logPath) appendFileSync(logPath, JSON.stringify(r) + '\n');
  };
  interface Sent {
    ok: boolean;
    status: number;
    parsed: ParsedResponse | null;
    cls: ErrorClass | null;
    kind: ClientErrorKind | null;
  }
  const send = async (kind: OpenCodeRequest['kind'], step: number, attempt: number, messages: ChatMessage[], maxTokens: number): Promise<Sent> => {
    const body: Json = compat
      ? { model, messages, ...(kind === 'main' ? { tools } : {}), max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } }
      : { model, max_tokens: maxTokens, messages, ...(kind === 'main' && tools.length ? { tools, tool_choice: 'auto' } : {}), stream: true, stream_options: { include_usage: true } };
    const data = Buffer.from(compat ? pyDumps(body) : JSON.stringify(body), compat ? 'latin1' : 'utf8');
    const headers: Array<[string, string]> = [
      ['content-type', 'application/json'],
      ['authorization', 'Bearer sim-key'],
      ['x-session-affinity', sessionId],
      ['X-Session-Id', sessionId],
      ['User-Agent', kilo ? `Kilo-Code/${KILO_VERSION}` : `opencode/${OPENCODE_VERSION}`],
    ];
    if (kilo) headers.push(['HTTP-Referer', 'https://kilocode.ai'], ['X-Title', 'Kilo Code']);
    headers.push(['x-sim-step', String(step)], ['x-sim-session', sess.id], ['x-sim-kind', kind]);
    if (route) headers.push(['x-sim-scenario', spec.id]);
    if (compat && kind === 'summarizer') headers.push(['x-sim-summary', 'baseline']);
    let origFile: string | undefined;
    let origTokens: number | undefined;
    if (out) {
      const key = `${kind}_step${step}_a${attempt}`;
      const n = origSeq.get(key) ?? 0;
      origSeq.set(key, n + 1);
      origFile = `origs/${sess.id}_${key}${n ? `_${n}` : ''}.json`;
      writeFileSync(join(out, origFile), data);
      try {
        origTokens = origRender === 'qwen3' ? counter.countText(renderQwen3(data.toString('utf8'))) : counter.countBody(body);
      } catch {
        origTokens = -1;
      }
    }
    for (let retry = 0; ; retry++) {
      const res = await httpRequest({ method: 'POST', url, headers, body: data, closeWaitMs: o.closeWaitMs ?? 10_000 });
      const text = res.body.toString('utf8');
      const parsed = res.status === 200 ? parseResponse(header(res, 'content-type') ?? '', res.body) : null;
      let cls: ErrorClass | null = null;
      let ckind: ClientErrorKind | null = null;
      if (res.status !== 200) {
        cls = classifyHttpError(res.status, res.reason, text, kilo ? 'kilo' : 'opencode');
        ckind = `http_${res.status}`;
      } else if (parsed!.errors.length) {
        cls = classifyStreamError(parsed!.errors[0]!);
        ckind = 'stream_error';
      } else if (!parsed!.done && parsed!.finishReason === null) ckind = 'truncated_stream';
      else if (parsed!.finishReason === 'length' && !parsed!.toolCalls.length && kind === 'main') ckind = 'length_no_tool';
      const usage = parsed?.usage ?? null;
      const rec: OpenCodeRequest = {
        session: sess.id, step, attempt, kind, retry, status: res.status, overflow: cls?.overflow ?? false, retryable: cls?.retryable ?? false,
        prompt_tokens: typeof usage?.['prompt_tokens'] === 'number' ? (usage['prompt_tokens'] as number) : null,
        completion_tokens: typeof usage?.['completion_tokens'] === 'number' ? (usage['completion_tokens'] as number) : null,
        finish_reason: parsed?.finishReason ?? null, max_tokens: maxTokens, req_bytes: data.length, messages: messages.length, virtual_ms: virtualMs,
      };
      if (cls) rec.error_message = cls.message.slice(0, 300);
      if (ckind) rec.client_error_kind = ckind;
      if (rec.prompt_tokens !== null) rec.usage = { prompt_tokens: rec.prompt_tokens, completion_tokens: rec.completion_tokens ?? 0 };
      if (origFile !== undefined) {
        rec.orig_file = origFile;
        rec.orig_qwen_tokens = origTokens!;
      }
      write(rec);
      if (!ckind) return { ok: true, status: res.status, parsed, cls: null, kind: null };
      if (cls?.retryable && retry < maxRetries) {
        // retry.ts: 2000·2^(n−1)·(1 + 0.25·rand), response headers present => no 30 s cap
        virtualMs += 2000 * 2 ** retry * (1 + 0.25 * rng.random());
        continue;
      }
      return { ok: false, status: res.status, parsed, cls, kind: ckind };
    }
  };

  /** One compaction; false when the summarizer failed (the session stops). */
  const compact = async (step: number, reason: OpenCodeCompaction['reason'], reported: number | null, asOverflow = reason === 'overflow'): Promise<boolean> => {
    const { head, tail } = select(msgs);
    const conversation = compat ? head.map(serializeBaseline).join('\n\n') : head.map(serializeOpenCode).filter(Boolean).join('\n\n');
    if (compat) baselineSummIn += counter.countText(conversation + (summary ? summary.text : '')) + Math.floor(2400 / 4);
    const previous = summary ? summary.text.trim() : null;
    const messages: ChatMessage[] = [{ role: 'system', content: COMPACTION_SYSTEM }, { role: 'user', content: buildSummarizerPrompt(conversation, previous) }];
    const r = await send('summarizer', step, 0, messages, configuredMax);
    if (!r.ok) {
      failure = { step, kind: r.cls?.overflow ? 'compaction_overflow' : r.kind!, status: r.status, message: r.cls?.message ?? r.kind! };
      return false;
    }
    summary = { text: r.parsed!.content, reasoning: r.parsed!.reasoning };
    const long = continueMode === 'opencode' && asOverflow;
    msgs = [...tail, newUser(long ? CONTINUE_OVERFLOW : CONTINUE_PROACTIVE)];
    const usage = r.parsed!.usage;
    compactions.push({
      n: compactions.length + 1, step, reason, reported, headMessages: head.length, tailMessages: tail.length, continueText: long ? 'long' : 'short',
      summaryChars: summary.text.length, summaryTokens: typeof usage?.['completion_tokens'] === 'number' ? (usage['completion_tokens'] as number) : null,
    });
    o.log?.(`compaction ${compactions.length} before step ${step} (${reason}): head ${head.length}, tail ${tail.length}`);
    if (kilo && prune) kiloPrune(); // post-compaction prune
    return true;
  };

  const maxTokensFor = (messages: ChatMessage[]): number => {
    if (!kilo || o.context === 0) return configuredMax;
    // KiloLLM.capOutputTokens
    const estimated = Math.ceil((Math.round(JSON.stringify(messages).length / 4) + Math.round(JSON.stringify(tools).length / 4)) * 1.3);
    const tokens = Math.max(lastReported ?? 0, estimated);
    const available = o.context - tokens - 2048;
    return available <= 0 || available >= configuredMax ? configuredMax : Math.max(1024, available);
  };

  let stepsCompleted = 0;
  let failedAt: number | null = null;
  let titleSent = false;
  steps: for (let step = 0; step < steps; step++) {
    if (manual.has(step) && !(await compact(step, 'manual', null, manualAsOverflow))) {
      failedAt = step;
      break;
    }
    let sent: Sent | null = null;
    for (let attempt = 0; ; attempt++) {
      if (kilo && prune && Buffer.byteLength(JSON.stringify(modelMessages(msgs))) > 1_250_000) kiloPrune(); // payload-limit prune
      const messages = wireMessages();
      lastMessages = messages;
      const r = await send('main', step, attempt, messages, maxTokensFor(messages));
      if (r.ok) {
        sent = r;
        break;
      }
      if (r.cls?.overflow) {
        const compacted = await compact(step, 'overflow', null);
        if (!compacted) {
          failedAt = step;
          break steps;
        }
        if (attempt + 1 >= maxAttempts) {
          failure = { step, kind: 'could_not_fit', status: r.status, message: `step ${step}: could not fit after compaction` };
          failedAt = step;
          break steps;
        }
        continue;
      }
      failure = { step, kind: r.kind!, status: r.status, message: r.cls?.message ?? r.kind! };
      failedAt = step;
      break steps;
    }
    const p = sent!.parsed!;
    if (sendTitle && !titleSent) {
      titleSent = true;
      const first = msgs.find((m): m is OcUser => m.role === 'user');
      const t = await send('title', step, 0, [{ role: 'system', content: TITLE_SYSTEM }, { role: 'user', content: TITLE_USER_PREFIX }, ...(first ? [userWire(first)] : [])], configuredMax);
      if (!t.ok) o.log?.(`title request failed (${t.kind}); ignored like OpenCode`);
    }
    // the assistant step as OpenCode stores it, then the tool results and any user message of the scenario
    const calls: ToolCall[] = p.toolCalls;
    const results = sess.toolResults(step, calls);
    const raw: ChatMessage = { role: 'assistant', content: p.content || null, tool_calls: calls.map((c) => ({ id: c.id, type: c.type ?? 'function', function: { name: c.function.name, arguments: c.function.arguments } })) };
    const byId = new Map(results.map((r) => [r.tool_call_id, contentText(r.content)]));
    const a: OcAssistant = {
      role: 'assistant', text: p.content, reasoning: p.reasoning, raw, results,
      calls: calls.map((c) => {
        let input: unknown;
        try {
          input = JSON.parse(c.function.arguments || '{}');
        } catch {
          input = { tool: c.function.name, error: 'invalid JSON arguments' };
        }
        return { id: c.id, name: c.function.name, args: c.function.arguments, input, output: byId.get(c.id) ?? '', cleared: false };
      }),
    };
    msgs.push(a);
    for (const um of sess.userAfter(step)) msgs.push(newUser(contentText(um.content)));
    stepsCompleted++;
    const usage = p.usage;
    const count = usage && typeof usage['prompt_tokens'] === 'number' ? (usage['prompt_tokens'] as number) + ((usage['completion_tokens'] as number | undefined) ?? 0) : 0;
    lastReported = usage ? count : lastReported;
    if (o.context !== 0 && count >= usable && !(await compact(step + 1, 'usage', count))) {
      failedAt = step + 1;
      break;
    }
  }
  return {
    session: sess.id, requests, compactions, stepsCompleted, steps, failedAt, error: failure, virtualMs, baselineSummIn, usable, preserve, lastMessages,
  };
}

// ---------------------------------------------------------------- totals from the mock's records

export interface ProcessedTotals {
  main: number;
  rejected: number;
  summarizer: number;
  title: number;
  /** benchmark contract `processed`: every upstream attempt */
  total: number;
  rejections: number;
  summarizerRequests: number;
}

/** processed, split as benchmark contract reports it, from mock records (kind defaults to main). */
export function processedTotals(records: ReadonlyArray<{ prompt_tokens: number; status?: number; rejected_for_length?: true; kind?: string }>): ProcessedTotals {
  const t: ProcessedTotals = { main: 0, rejected: 0, summarizer: 0, title: 0, total: 0, rejections: 0, summarizerRequests: 0 };
  for (const r of records) {
    t.total += r.prompt_tokens;
    const kind = r.kind ?? 'main';
    if (kind === 'summarizer') {
      t.summarizer += r.prompt_tokens;
      t.summarizerRequests++;
    } else if (kind === 'title') t.title += r.prompt_tokens;
    else if (r.rejected_for_length) {
      t.rejected += r.prompt_tokens;
      t.rejections++;
    } else if (r.status === 200) t.main += r.prompt_tokens;
  }
  return t;
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let base: string | null = null;
  const o: Partial<OpenCodeOptions> & { capBytes?: number; long?: boolean } = {};
  let outDir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const num = (): number => Number(args[++i]);
    if (a === '--baseline-compat') o.mode = 'baseline-compat';
    else if (a === '--kilo') o.variant = 'kilo';
    else if (a === '--context') o.context = num();
    else if (a === '--output') o.output = num();
    else if (a === '--steps') o.steps = num();
    else if (a === '--cap-bytes') o.capBytes = num();
    else if (a === '--long-continue') o.long = true;
    else if (a === '--no-title') o.title = false;
    else if (a === '--out') outDir = args[++i] ?? null;
    else if (!a.startsWith('--')) base = a;
    else {
      console.error(`unknown argument ${a}`);
      process.exit(2);
    }
  }
  const { PromptCounter } = await import('../lib/render.js');
  const { benchTokenizer } = await import('../lib/paths.js');
  const { MockServer } = await import('../mock/server.js');
  const { fmtInt } = await import('../lib/stats.js');
  const counter = new PromptCounter(benchTokenizer());
  const context = o.context ?? 100_000;
  const output = o.output ?? 32_000;
  const scenario: ScenarioOptions = { capBytes: o.capBytes ?? 51_200 };
  const mock = base ? null : new MockServer({ counter, limit: context, scenario, outDir });
  if (mock) await mock.start(0);
  try {
    const r = await runOpenCode({
      base: base ?? mock!.url, counter, scenario, context, output, mode: o.mode ?? 'faithful', variant: o.variant ?? 'opencode',
      ...(o.steps !== undefined ? { steps: o.steps } : {}), ...(o.long ? { continueText: 'opencode' as const } : {}),
      ...(o.title !== undefined ? { title: o.title } : {}), outDir, log: (l) => console.log(l),
    });
    console.log(`steps ${r.stepsCompleted}/${r.steps}${r.error ? `; error at step ${r.error.step}: ${r.error.kind} ${r.error.message}` : ''}; ` +
      `compactions ${r.compactions.length} (${r.compactions.map((c) => `${c.step}:${c.reason}`).join(', ')}); usable=${r.usable} preserve=${r.preserve}; virtual retry ms ${Math.round(r.virtualMs)}`);
    if (mock) {
      const t = processedTotals(mock.records);
      console.log(`main ${fmtInt(t.main)} + rejected ${fmtInt(t.rejected)} (${t.rejections}) + summarizer ${fmtInt(t.summarizer)} (${t.summarizerRequests}) + title ${fmtInt(t.title)} = processed ${fmtInt(t.total)}`);
      if ((o.mode ?? 'faithful') === 'baseline-compat')
        console.log(`baseline.py basis: main + rejected + summ_in estimate ${fmtInt(r.baselineSummIn)} = ${fmtInt(t.main + t.rejected + r.baselineSummIn)}`);
    }
  } finally {
    await mock?.stop();
  }
}
