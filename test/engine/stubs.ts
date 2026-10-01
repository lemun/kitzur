// Test doubles for the engine: a small deterministic Summarizer and ToolRules that honour the
// contracts of src/engine/contracts.ts (the real ones are benchmark component's; test/engine/integration.test.ts
// uses them when present), a config builder, counters and the reference-scenario history builder.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, ToolCall, TokenCounter } from '../../src/types.js';
import { DEFAULT_CONFIG, type Config } from '../../src/config/schema.js';
import {
  SUMMARY_HEADER, type ResultKind, type SnapshotInfo, type Summarizer, type SummaryInput, type SummaryOptions,
  type SummaryRender, type ToolRules,
} from '../../src/engine/contracts.js';
import { createCounter, type Counter } from '../../src/tokenize/counter.js';
import { loadTokenizerCached, type LoadedTokenizer } from '../../src/tokenize/load.js';
import type { TemplateName } from '../../src/tokenize/template.js';
import { testTokenizerPath } from '../helpers.js';
import {
  assistantMessage, initialHistory, toolOutput, tools as scenarioTools, USER_INJECT, type ScenarioOptions,
} from '../../bench/scenarios/reference.js';

// ---------------------------------------------------------------- config

type DeepPartial<T> = { [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (over === undefined) return base;
  const out = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = out[k];
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) && b !== null && typeof b === 'object' && !Array.isArray(b)
      ? merge(b, v as DeepPartial<typeof b>)
      : v;
  }
  return out as T;
}

/** DEFAULT_CONFIG with overrides (deep merge; arrays replace). */
export function testConfig(over?: DeepPartial<Config>): Config {
  return merge(structuredClone(DEFAULT_CONFIG), over);
}

/** The preset windows of DESIGN §3 (W, T_plan). */
export const PRESETS: Record<string, { window: number; out: number }> = {
  '32k': { window: 32_000, out: 8_000 },
  '64k': { window: 64_000, out: 16_000 },
  '100k': { window: 100_000, out: 32_000 },
  '128k': { window: 128_000, out: 32_000 },
};

export function presetConfig(name: keyof typeof PRESETS, over?: DeepPartial<Config>): Config {
  const p = PRESETS[name]!;
  return testConfig(merge<DeepPartial<Config>>({ budget: { window: p.window, defaultMaxTokens: p.out } }, over));
}

// ---------------------------------------------------------------- counters

let tokMemo: LoadedTokenizer | null | undefined;
/** The dev tokenizer (null when absent: tests that need it skip). */
export function devTokenizer(): LoadedTokenizer | null {
  if (tokMemo !== undefined) return tokMemo;
  const p = testTokenizerPath();
  tokMemo = p ? loadTokenizerCached(p, null, { stateDir: join(tmpdir(), 'kitzur-test-tokenizer-cache') }) : null;
  return tokMemo;
}

/** A fresh exact counter (own caches) for `template`, or null without the dev tokenizer. */
export function exactCounter(template: TemplateName = 'sim', cacheEntries = 200_000): Counter | null {
  const tok = devTokenizer();
  if (!tok) return null;
  return createCounter({ mode: 'exact', template, tokenizer: tok, tokenizerId: tok.sha256, cacheEntries });
}

/** A fresh estimate counter (no tokenizer needed). */
export function estimateCounter(template: TemplateName = 'sim'): Counter {
  return createCounter({ mode: 'estimate', template, cacheEntries: 50_000 });
}

// ---------------------------------------------------------------- stub summarizer

interface Item {
  cat: 'user' | 'decision' | 'narrative' | 'tool';
  index: number;
  text: string;
}

const cap = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, Math.max(0, n - 3)) + '...');

function textOf(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.filter((p) => p && (p as { type?: unknown }).type === 'text').map((p) => String((p as { text?: unknown }).text ?? '')).join('\n');
  }
  return '';
}

/**
 * A deterministic stand-in for the ledger summarizer: user messages are floor items (never evicted,
 * shortened by userShortenStep), DECISION lines are floor items (evictable only with
 * allowFloorEviction), assistant text and one tool-log line per result are evictable, in that order.
 */
export class StubSummarizer implements Summarizer {
  calls = 0;
  constructor(private readonly cfg: Config, private readonly counter: TokenCounter) {}

  private items(input: SummaryInput, step: number): Item[] {
    const out: Item[] = [];
    const umax = Math.max(16, Math.floor(this.cfg.compaction.userMaxChars / 2 ** step));
    for (let i = input.hEnd; i < input.cut; i++) {
      const m = input.messages[i]!;
      const t = textOf(m);
      if (m.role === 'user') {
        if (t.startsWith(SUMMARY_HEADER) || this.cfg.client.boilerplateUserTexts.includes(t.trim())) continue;
        out.push({ cat: 'user', index: i, text: `- #${i}: ${cap(t.replace(/\n/g, ' '), umax)}` });
      } else if (m.role === 'assistant') {
        for (const line of t.split('\n')) if (/^\s*DECISION\b/i.test(line)) out.push({ cat: 'decision', index: i, text: `- #${i}: ${cap(line.trim(), 200)}` });
        if (t.trim()) out.push({ cat: 'narrative', index: i, text: `- #${i} assistant: ${cap(t.replace(/\n/g, ' '), 160)}` });
      } else if (m.role === 'tool') {
        out.push({ cat: 'tool', index: i, text: `- #${i} tool → ${t.length} chars omitted` });
      }
    }
    return out;
  }

  private tokensOf(text: string): number {
    return this.counter.measure({ messages: [{ role: 'user', content: text }] }).perMessage[0]!;
  }

  private build(items: Item[], input: SummaryInput): string {
    const lines = [SUMMARY_HEADER, ''];
    for (const it of items) lines.push(it.text);
    lines.push('', `[kitzur] Messages ${input.hEnd}–${input.cut - 1} were compacted (compaction ${input.compaction}).`);
    return lines.join('\n');
  }

  render(input: SummaryInput, opts: SummaryOptions): SummaryRender {
    this.calls++;
    if (input.cut <= input.hEnd) return { text: null, tokens: 0, floorTokens: 0, kept: 0, dropped: 0, categories: {} };
    const all = this.items(input, opts.userShortenStep);
    const users = all.filter((x) => x.cat === 'user');
    const decisions = all.filter((x) => x.cat === 'decision');
    const rest = [...all.filter((x) => x.cat === 'narrative').reverse(), ...all.filter((x) => x.cat === 'tool').reverse()];
    const floorAll = this.items(input, 0).filter((x) => x.cat === 'user' || x.cat === 'decision');
    const floorTokens = this.tokensOf(this.build(floorAll.sort((a, b) => a.index - b.index), input));
    // the longest prefix of [decisions (floor, evictable only in R6), narrative newest first, tool log newest first]
    const order = [...decisions, ...rest];
    const text = (k: number): string => this.build([...users, ...order.slice(0, k)].sort((a, b) => a.index - b.index), input);
    const minKept = opts.allowFloorEviction ? 0 : decisions.length;
    // estimate the longest fitting prefix from per-item costs, then verify with exact counts
    let kept = minKept;
    let acc = this.tokensOf(text(minKept));
    for (let k = minKept; k < order.length; k++) {
      acc += this.counter.countText(order[k]!.text + '\n');
      if (acc > opts.budgetTokens) break;
      kept = k + 1;
    }
    while (kept > minKept && this.tokensOf(text(kept)) > opts.budgetTokens) kept--;
    const t = text(kept);
    return {
      text: t, tokens: this.tokensOf(t), floorTokens, kept: users.length + kept, dropped: order.length - kept,
      categories: { user: { kept: users.length, dropped: 0 } },
    };
  }
}

// ---------------------------------------------------------------- stub tool rules

const INTERACTIVE = /^\s*- (link|button|textbox|combobox|option|checkbox|radio|tab|menuitem|switch|slider|searchbox|spinbutton|heading)\b/;

/** A small ToolRules double: content-detected snapshots, a glob role lookup, a line-based slim. */
export class StubRules implements ToolRules {
  constructor(private readonly cfg: Config) {}

  role(toolName: string): Array<keyof Config['rules']['toolNames']> {
    const out: Array<keyof Config['rules']['toolNames']> = [];
    for (const [role, globs] of Object.entries(this.cfg.rules.toolNames)) {
      if (globs.some((g) => new RegExp('^' + g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(toolName))) {
        out.push(role as keyof Config['rules']['toolNames']);
      }
    }
    return out;
  }

  classify(text: string, _call: ToolCall | null): ResultKind {
    if (text.includes('- Page Snapshot:') || (text.match(/\[ref=/g)?.length ?? 0) >= 10) return 'snapshot';
    if (/\b\d+ (?:passed|failed)\b/.test(text)) return 'test';
    return 'other';
  }

  snapshotInfo(text: string): SnapshotInfo | null {
    const refs = text.match(/\[ref=/g)?.length ?? 0;
    const url = /- Page URL: ([^\n]+)/.exec(text)?.[1] ?? null;
    const title = /- Page Title: ([^\n]+)/.exec(text)?.[1] ?? null;
    if (!url && refs === 0) return null;
    return { url, title, refs, savedPath: /Full output saved to: ([^\n]+)/.exec(text)?.[1]?.trim() ?? null };
  }

  stubText(info: SnapshotInfo): string {
    return `[superseded snapshot: ${info.url ?? 'unknown URL'} — "${info.title ?? ''}", ${info.refs} refs; take a new browser_snapshot for current refs]`;
  }

  slimSnapshot(text: string, maxTokens: number, count: (s: string) => number): string | null {
    const lines = text.split('\n');
    const kept = lines.filter((l) => l.startsWith('- Page') || l.startsWith('###') || l.includes('Full output saved to:') || (l.includes('[ref=') && INTERACTIVE.test(l)));
    const total = lines.filter((l) => l.includes('[ref=')).length;
    const n = kept.filter((l) => l.includes('[ref=')).length;
    const out = kept.join('\n') + `\n[kitzur: snapshot slimmed to fit this model's context: kept ${n} of ${total} elements (interactive and headings); text of other elements omitted. Re-requesting the snapshot will not show more. Use browser_evaluate for specific text.]`;
    return count(out) <= maxTokens ? out : null;
  }

  condense(text: string): string {
    return `${text.length} chars omitted`;
  }
}

// ---------------------------------------------------------------- reference scenario histories

/**
 * The client's messages at `step` of the reference session (what agent_client.py sends before the
 * step's response): the initial history plus the assistant, tool result(s) and user injections of
 * every earlier step.
 */
export function referenceHistory(step: number, o: ScenarioOptions = { capBytes: 51200 }): ChatMessage[] {
  const h = initialHistory();
  for (let s = 0; s < step; s++) {
    const a = assistantMessage(s, o);
    h.push(a);
    for (const c of a.tool_calls) h.push({ role: 'tool', tool_call_id: c.id, content: toolOutput(s, o) });
    const inj = USER_INJECT.get(s);
    if (inj !== undefined) h.push({ role: 'user', content: inj });
  }
  return h;
}

/** Every request of the reference session (steps 0..steps-1), sharing message objects like a client. */
export function referenceRequests(steps: number, o: ScenarioOptions = { capBytes: 51200 }, maxTokens = 32_000) {
  const tools = scenarioTools();
  const out: Array<{ model: string; messages: ChatMessage[]; tools: unknown[]; max_tokens: number; stream: boolean }> = [];
  const h = initialHistory();
  for (let s = 0; s < steps; s++) {
    out.push({ model: 'local-model', messages: h.slice(), tools, max_tokens: maxTokens, stream: true });
    const a = assistantMessage(s, o);
    h.push(a);
    for (const c of a.tool_calls) h.push({ role: 'tool', tool_call_id: c.id, content: toolOutput(s, o) });
    const inj = USER_INJECT.get(s);
    if (inj !== undefined) h.push({ role: 'user', content: inj });
  }
  return out;
}
