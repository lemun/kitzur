// Shared building blocks of the scenario families (bench/README.md§5): the extension of the
// ScenarioSpec, a memoizing SessionSpec wrapper, deterministic marker codes, the OpenCode tool-output cap,
// and a client-side history simulator used by the linter and the tests (no HTTP, no mock).

import type { ChatMessage, ToolCall } from '../../src/types.js';
import { PyRandom } from '../lib/pyrandom.js';
import { pyDumps } from '../lib/pyjson.js';
import { contentText } from '../lib/render.js';
import { pad4, type ScenarioOptions } from './reference.js';
import type { FactSpec, ScenarioSpec, SessionSpec } from './types.js';
import type { WindowId, WindowSpec } from './windows.js';

export interface ScenarioContext {
  window: WindowSpec;
}

/** The intended outcome of one supersession probe (F9 confusion matrix; lint checks the rule agrees). */
export interface SupersessionCase {
  /** a short label, e.g. "(b) cue+overlap" */
  label: string;
  /** fact id of the earlier instruction */
  fact: string;
  /** fact id of the later message, or null for a pure false-positive probe */
  by: string | null;
  /** true: the earlier instruction must be superseded; false: both must survive */
  supersede: boolean;
}

/**
 * A scenario as this module builds it: the ScenarioSpec plus metadata. Extra fields are
 * structural additions (a ScenarioDef IS a ScenarioSpec); consumers that only know ScenarioSpec ignore them.
 */
export interface ScenarioDef extends ScenarioSpec {
  /** human-readable one-liner for reports */
  description: string;
  /**
   * Set on the byte-exact `-ref` variants: the reference.ts options that reproduce the scenario, so the harness can
   * drive it with the unchanged Python-parity path (bench/harness.ts). Nothing is planted in these (benchmark contract ).
   */
  reference?: ScenarioOptions;
  /** default windows (benchmark contract "Windows") */
  windows: WindowId[];
  /** report-only realism variant (qwen3 render; benchmark contract ) */
  realism?: boolean;
  /** client-side knobs that are not part of ScenarioSpec */
  clientOptions?: { includeUsage?: boolean; stream?: boolean };
  /** F10: the client's own compaction (OpenCode shapes, reference implementation) */
  clientCompact?: {
    atStep: number;
    trigger: 'manual' | 'overflow';
    /** the placeholder summary the summarizer request returns (template-shaped; §5.3 F10) */
    summaryText: string;
    summaryTokens: number;
  };
  /** F11 http413: maxBodyBytes = floor(factor · B_max) of the named cell of the same system and window */
  maxBodyBytesFrom?: { scenario: string; factor: number };
  /** F9: the probes of the supersession confusion matrix */
  supersession?: SupersessionCase[];
  /** F8: the solo scenario ids of each session, for the "canonically equal to its solo run" comparison */
  soloOf?: Record<string, string>;
  /** F13: the control scenario */
  controlOf?: string;
}

// ---------------------------------------------------------------- markers

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A deterministic 5-char code (no 0/O/1/I), e.g. "K7Q2M". */
export function code5(rng: PyRandom): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += rng.choice([...CODE_ALPHABET]);
  // ensure at least one digit so the code is never a plain word
  if (!/\d/.test(s)) s = s.slice(0, 4) + String(2 + (s.charCodeAt(4) % 8));
  return s;
}

/** A family of markers `${prefix}-${code}` from one seed; codes never repeat within a MarkerFactory. */
export class MarkerFactory {
  private readonly rng: PyRandom;
  private readonly seen = new Set<string>();
  constructor(seed: number) {
    this.rng = new PyRandom(seed);
  }
  make(prefix: string): string {
    for (;;) {
      const m = `${prefix}-${code5(this.rng)}`;
      if (!this.seen.has(m)) {
        this.seen.add(m);
        return m;
      }
    }
  }
}

export const fact = (id: string, marker: string, channel: FactSpec['channel'], expect: FactSpec['expect'], gate: boolean, supersededBy?: string): FactSpec =>
  supersededBy === undefined ? { id, marker, channel, expect, gate } : { id, marker, channel, expect, gate, supersededBy };

// ---------------------------------------------------------------- the OpenCode tool-output cap

const utf8Len = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * reference.toolOutput()'s cap (scenario.py tool_output: OpenCode Truncate.output in head mode), applied to any raw
 * output. Identical to reference.toolOutput(step, {capBytes}) on reference.toolOutputRaw(step) (tested).
 */
export function capOutput(out: string, step: number, capBytes: number | null | undefined): string {
  const cap = capBytes ?? 0;
  if (!cap) return out;
  const lines = out.split('\n');
  const kept: string[] = [];
  let size = 0;
  const lim = Math.min(lines.length, 2000);
  for (let i = 0; i < lim; i++) {
    const b = utf8Len(lines[i]!) + (i ? 1 : 0);
    if (size + b > cap) break;
    kept.push(lines[i]!);
    size += b;
  }
  if (kept.length < lines.length) {
    const removed = utf8Len(out) - size;
    return (
      kept.join('\n') +
      `\n\n...${removed} bytes truncated...\n\nThe tool call succeeded but the ` +
      `output was truncated. Full output saved to: /users/example/.local/share/opencode/tool-output/` +
      `tool_${pad4(step)}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`
    );
  }
  return out;
}

// ---------------------------------------------------------------- sessions

/** What a family writes: pure functions of the step. `results` returns one content per scripted call. */
export interface SessionScript {
  id: string;
  seed: number;
  steps: number;
  system(): string;
  tools(): unknown[];
  goal(): ChatMessage;
  assistant(step: number): ChatMessage;
  /** tool-result contents for the step's scripted calls, by position */
  results(step: number): string[];
  users(step: number): ChatMessage[];
}

const clone = <T>(x: T): T => structuredClone(x);

/**
 * SessionSpec over a SessionScript: memoized per step (the mock and the client ask repeatedly), and every call returns
 * a fresh deep copy (callers may mutate what they get). toolResults answers the calls the client actually parsed, in
 * order, like agent_client.py: `{role, tool_call_id, content}` with the scripted content at the same position (the
 * last content when a client passes more calls than were scripted, which is Python's one-output-per-step behaviour).
 */
export function makeSession(s: SessionScript): SessionSpec {
  const asst = new Map<number, ChatMessage>();
  const res = new Map<number, string[]>();
  const usr = new Map<number, ChatMessage[]>();
  let sys: string | null = null;
  let tls: unknown[] | null = null;
  let gl: ChatMessage | null = null;
  return {
    id: s.id,
    seed: s.seed,
    steps: s.steps,
    system: () => (sys ??= s.system()),
    tools: () => clone((tls ??= s.tools())),
    goal: () => clone((gl ??= s.goal())),
    assistantAt: (step) => {
      let m = asst.get(step);
      if (!m) asst.set(step, (m = s.assistant(step)));
      return clone(m);
    },
    toolResults: (step, calls) => {
      let c = res.get(step);
      if (!c) res.set(step, (c = s.results(step)));
      if (!c.length) return [];
      return calls.map((call, i) => ({ role: 'tool', tool_call_id: call.id, content: c[Math.min(i, c.length - 1)]! }));
    },
    userAfter: (step) => {
      let u = usr.get(step);
      if (!u) usr.set(step, (u = s.users(step)));
      return clone(u);
    },
  };
}

/** An assistant message with one or more function calls, ids `call_{step:04d}_{i}` like the reference. */
export function assistantWithCalls(step: number, text: string | null, calls: Array<[string, Record<string, unknown>]>, extra: Record<string, unknown> = {}): ChatMessage {
  const tc: ToolCall[] = calls.map(([name, args], i) => ({
    id: `call_${pad4(step)}_${i}`,
    type: 'function',
    function: { name, arguments: pyDumps(args) },
  }));
  return { role: 'assistant', content: text || null, tool_calls: tc, ...extra };
}

export const userMsg = (text: string): ChatMessage => ({ role: 'user', content: text });

// ---------------------------------------------------------------- simulation (client view, no HTTP)

export interface SimMessage {
  /** index in the session history */
  index: number;
  /** the client step after whose response the message was appended (-1 = the initial [system, goal]) */
  step: number;
  /** 'system' | 'goal' | 'assistant' | 'tool' | 'user' */
  origin: 'system' | 'goal' | 'assistant' | 'tool' | 'user';
  message: ChatMessage;
  /** for tool results: the name of the call they answer */
  toolName?: string;
}

/**
 * The client-side history of one session after `steps` steps, as a sim client would build it from scripted replies
 * (assistantAt → toolResults(calls) → userAfter). Message i was first sent in client request C_k with k = step + 1.
 */
export function simulateSession(s: SessionSpec, steps = s.steps): SimMessage[] {
  const out: SimMessage[] = [];
  const push = (step: number, origin: SimMessage['origin'], message: ChatMessage, toolName?: string): void => {
    out.push(toolName === undefined ? { index: out.length, step, origin, message } : { index: out.length, step, origin, message, toolName });
  };
  push(-1, 'system', { role: 'system', content: s.system() });
  push(-1, 'goal', s.goal());
  for (let k = 0; k < steps; k++) {
    const a = s.assistantAt(k);
    push(k, 'assistant', a);
    const calls = Array.isArray(a.tool_calls) ? a.tool_calls : [];
    const results = s.toolResults(k, calls);
    results.forEach((r, i) => push(k, 'tool', r, calls[Math.min(i, calls.length - 1)]?.function.name));
    for (const u of s.userAfter(k)) push(k, 'user', u);
  }
  return out;
}

/** The text a reader sees in a message: content text, then each call as `name(arguments)`, one per line. */
export function visibleText(m: ChatMessage): string {
  let t = contentText(m.content);
  for (const c of Array.isArray(m.tool_calls) ? m.tool_calls : []) t += `\n${c.function.name}(${c.function.arguments})`;
  return t;
}

/** benchmark contract text(r) of one message: the ensure_ascii=False dump (content, tool args and names, reasoning). */
export const dumpText = (m: unknown): string => pyDumps(m, { ensureAscii: false });

/** Every ScenarioDef's sessions, by id (throws on duplicates). */
export function sessionsById(sc: ScenarioSpec): Map<string, SessionSpec> {
  const m = new Map<string, SessionSpec>();
  for (const s of sc.sessions) {
    if (m.has(s.id)) throw new Error(`${sc.id}: duplicate session id ${s.id}`);
    m.set(s.id, s);
  }
  return m;
}
