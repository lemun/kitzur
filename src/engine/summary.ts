// The summary message (DESIGN.md): one `user` message right after the head, stable parts first ():
//
//   SUMMARY_HEADER
//
//   Facts below are extracted mechanically; the latest state wins.
//
//   ## User instructions … ## Tool log        (fixed section order; empty sections omitted)
//
//   [kitzur] Messages a–b were compacted (compaction k).
//
// Eviction (§6.4, ADR-9): every user fact is always rendered (at the current shortening step); then the longest
// prefix of the one strict total order (ledger/index.ts compareItems) that fits `budgetTokens`, counted exactly as
// the summary message inside the prompt. Without allowFloorEviction the floor (decision, todo, file, rest,
// narrative tier 1) is always rendered in full. Items inside a section render in first-appearance order.
import { createHash } from 'node:crypto';
import type { ChatMessage, TokenCounter, ToolCall } from '../types.js';
import type { Config } from '../config/schema.js';
import type { SummarizerFactory, Summarizer, SummaryInput, SummaryOptions, SummaryRender } from './contracts.js';
import { SUMMARY_HEADER } from './contracts.js';
import { digestOf } from '../tokenize/canonical.js';
import { createToolRulesExt } from './rules/index.js';
import { createExtractor, type MessageFacts } from './ledger/extract.js';
import { supersedeRules } from './ledger/supersede.js';
import { buildLedger, CATEGORY_ORDER, compareItems, comparePos, FLOOR_CATEGORIES, renderUserItem, SECTION_ORDER, type Ledger, type LedgerItem, type SectionId } from './ledger/index.js';
import { Lru } from './ledger/lru.js';
import { maxFitting } from './ledger/fit.js';

export const FACTS_LINE = 'Facts below are extracted mechanically; the latest state wins.';

const HEADINGS: Record<SectionId, string> = {
  user: '## User instructions',
  decisions: '## Decisions',
  todos: '## Open todos',
  files: '## Files',
  browser: '## Browser',
  test: '## Last test run',
  paths: '## Referenced paths',
  notes: '## Assistant notes',
  log: '## Tool log',
};

/** The trailing per-compaction line (last, so it never breaks the shared prefix of consecutive summaries). */
export function trailerLine(hEnd: number, cut: number, compaction: number): string {
  const last = cut - 1;
  return last === hEnd
    ? `[kitzur] Message ${hEnd} was compacted (compaction ${compaction}).`
    : `[kitzur] Messages ${hEnd}–${last} were compacted (compaction ${compaction}).`;
}

/** The summary text for a given set of items (users + kept), in section order and first-appearance order. */
export function layoutSummary(items: readonly LedgerItem[], userMaxChars: number, trailer: string): string {
  const bySection = new Map<SectionId, LedgerItem[]>();
  for (const it of items) {
    let a = bySection.get(it.section);
    if (!a) bySection.set(it.section, (a = []));
    a.push(it);
  }
  const lines: string[] = [];
  for (const sec of SECTION_ORDER) {
    const its = bySection.get(sec);
    if (!its || its.length === 0) continue;
    its.sort(comparePos);
    const todo = sec === 'todos' ? its.find((i) => i.todoHeading !== undefined)?.todoHeading : undefined;
    lines.push(todo ? `${HEADINGS[sec]} (${todo})` : HEADINGS[sec]);
    for (const it of its) lines.push(it.user ? renderUserItem(it.user, userMaxChars) : it.line);
  }
  return `${SUMMARY_HEADER}\n\n${FACTS_LINE}\n\n${lines.length ? lines.join('\n') + '\n\n' : ''}${trailer}`;
}

/** Details of one render, for tests and diagnostics. */
export interface SummaryDetail {
  render: SummaryRender;
  /** every item in the total order (users first), with whether it was rendered */
  items: Array<{ id: string; category: string; floor: boolean; kept: boolean }>;
  /** exact tokens of the summary with every user fact plus the first k non-user items of the order */
  prefixTokens(k: number): number;
  /** number of non-user items, and how many of them are floor items (they come first in the order) */
  orderLength: number;
  floorCount: number;
}

export interface SummarizerExt extends Summarizer {
  renderDetailed(input: SummaryInput, opts: SummaryOptions): SummaryDetail;
  /** exact tokens of a text as the summary user message in the prompt */
  messageTokens(text: string): number;
}

const EMPTY: SummaryRender = { text: null, tokens: 0, floorTokens: 0, kept: 0, dropped: 0, categories: {} };

export function createSummarizerExt(cfg: Config, counter: TokenCounter): SummarizerExt {
  const rules = createToolRulesExt(cfg);
  const extractor = createExtractor(cfg, rules);
  const supRules = supersedeRules(cfg.ledger);
  const factsCache = new Lru<MessageFacts>(16_384);
  const ledgerCache = new Lru<Ledger>(8);
  const lineTokens = new Lru<number>(8192);

  const messageTokens = (text: string): number => {
    const req = { messages: [{ role: 'user', content: text } as ChatMessage] };
    return counter.measure(req).perMessage[0]!;
  };
  const lineCost = (s: string): number => {
    let n = lineTokens.get(s);
    if (n === undefined) {
      n = counter.countText(s) + 1;
      lineTokens.set(s, n);
    }
    return n;
  };

  // the hash of a digest list, once per list object: a compaction step renders the same H[0..b) many times (fit
  // loop rungs), and hashing every digest for each render cost seconds on 1,000-message sessions
  const listHash = new WeakMap<readonly string[], string>();
  const hashOfList = (digests: readonly string[]): string => {
    let h = listHash.get(digests);
    if (h === undefined) {
      h = createHash('sha256').update(digests.join(',')).digest('hex');
      listHash.set(digests, h);
    }
    return h;
  };

  const ledgerFor = (input: SummaryInput): Ledger => {
    const msgs = input.messages;
    const digests = input.digests.length === msgs.length ? input.digests : msgs.map((m) => digestOf(m));
    const key = `${input.hEnd}|${input.cut}|${digests.length}|${hashOfList(digests)}`;
    const hit = ledgerCache.get(key);
    if (hit) return hit;
    const facts = (i: number, call: ToolCall | null, callKey: string): MessageFacts => {
      const m = msgs[i]!;
      const role = m.role;
      const kind = role === 'assistant' ? 'a' : role === 'user' ? 'u' : role === 'system' || role === 'developer' ? 'o' : 'r';
      // a tool result's facts depend on its call: key it by the issuing assistant's digest and the call slot
      const ck = kind === 'r' ? (/^\d+#\d+$/.test(callKey) ? `${digests[Number(callKey.split('#')[0])]}#${callKey.split('#')[1]}` : callKey) : '';
      const k = `${kind}|${digests[i]}|${ck}`;
      let f = factsCache.get(k);
      if (f === undefined) {
        f = kind === 'a' ? extractor.assistant(m) : kind === 'u' ? extractor.user(m) : kind === 'r' ? extractor.result(m, call) : { kind: 'other' };
        factsCache.set(k, f);
      }
      return f;
    };
    const L = buildLedger({ messages: msgs, hEnd: input.hEnd, cut: input.cut }, cfg, extractor, supRules, facts);
    ledgerCache.set(key, L);
    return L;
  };

  const renderDetailed = (input: SummaryInput, opts: SummaryOptions): SummaryDetail => {
    const { hEnd, cut } = input;
    if (!(cut > hEnd) || cut > input.messages.length) {
      return { render: { ...EMPTY, categories: {} }, items: [], prefixTokens: () => 0, orderLength: 0, floorCount: 0 };
    }
    const ledger = ledgerFor(input);
    const users = ledger.items.filter((i) => i.category === 'user');
    const others = ledger.items.filter((i) => i.category !== 'user').sort(compareItems);
    let floorCount = 0;
    while (floorCount < others.length && FLOOR_CATEGORIES.has(others[floorCount]!.category)) floorCount++;
    const trailer = trailerLine(hEnd, cut, input.compaction);
    const step = Math.max(0, Math.min(3, Math.trunc(opts.userShortenStep ?? 0)));
    const maxChars = Math.max(1, Math.floor(cfg.compaction.userMaxChars / 2 ** step));

    const texts = new Map<number, string>();
    const toks = new Map<number, number>();
    const textAt = (k: number): string => {
      let t = texts.get(k);
      if (t === undefined) {
        t = layoutSummary([...users, ...others.slice(0, k)], maxChars, trailer);
        texts.set(k, t);
      }
      return t;
    };
    const tokensAt = (k: number): number => {
      let n = toks.get(k);
      if (n === undefined) {
        n = messageTokens(textAt(k));
        toks.set(k, n);
      }
      return n;
    };
    const budget = opts.budgetTokens;
    const kMin = opts.allowFloorEviction ? 0 : floorCount;
    let k: number;
    if (tokensAt(kMin) > budget) k = kMin;
    else {
      // seed the search with additive per-line estimates; exact counts decide
      let est = tokensAt(kMin);
      const seen = new Set<SectionId>([...users, ...others.slice(0, kMin)].map((i) => i.section));
      let guess = kMin;
      for (let j = kMin; j < others.length; j++) {
        const it = others[j]!;
        est += lineCost(it.line) + (seen.has(it.section) ? 0 : lineCost(HEADINGS[it.section]) + 4);
        seen.add(it.section);
        if (est > budget) break;
        guess = j + 1;
      }
      k = maxFitting(kMin, others.length, guess, (j) => tokensAt(j) <= budget);
    }
    const text = textAt(k);
    const tokens = tokensAt(k);
    const floorTokens = step === 0 ? tokensAt(floorCount) : messageTokens(layoutSummary([...users, ...others.slice(0, floorCount)], cfg.compaction.userMaxChars, trailer));

    const categories: Record<string, { kept: number; dropped: number }> = {};
    for (const c of CATEGORY_ORDER) categories[c] = { kept: 0, dropped: 0 };
    categories['user']!.kept = users.length;
    others.forEach((it, j) => {
      const c = categories[it.category]!;
      if (j < k) c.kept++;
      else c.dropped++;
    });
    const render: SummaryRender = { text, tokens, floorTokens, kept: users.length + k, dropped: others.length - k, categories };
    const items = [
      ...users.map((u) => ({ id: u.id, category: u.category, floor: true, kept: true })),
      ...others.map((it, j) => ({ id: it.id, category: it.category, floor: j < floorCount, kept: j < k })),
    ];
    return { render, items, prefixTokens: (j: number) => tokensAt(Math.max(0, Math.min(others.length, j))), orderLength: others.length, floorCount };
  };

  return {
    render: (input, opts) => renderDetailed(input, opts).render,
    renderDetailed,
    messageTokens,
  };
}

/** SummarizerFactory (src/engine/contracts.ts). */
export const createSummarizer: SummarizerFactory = (cfg: Config, counter: TokenCounter): Summarizer => createSummarizerExt(cfg, counter);
