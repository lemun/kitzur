// Facts ledger assembly (DESIGN.md): turns the per-message facts of H[0..b) into the summary's
// items. Items come from the summarized region [hEnd, cut); their status is evaluated over H[0..b):
//   - an item whose key recurs in [cut, b) is not an item (the verbatim tail carries the latest state);
//   - supersession of user instructions considers corrections anywhere after the instruction, tail included.
// Each item carries its category, its rank inside the category (the one strict total order of items) and its
// position inside its section (first appearance, for rendering).
import type { ChatMessage, ToolCall } from '../../types.js';
import type { RetentionSource, RetentionAttribution } from '../contracts.js';
import type { Config } from '../../config/schema.js';
import { contentText, capHeadTail, collapseWs, capHead, neutralizeRules, oneLine } from './text.js';
import type { AssistantFacts, CallFacts, Extractor, MessageFacts, ResultFacts, UserFacts } from './extract.js';
import { explicitIds, supersede, type SupersedeRules, type UserText } from './supersede.js';
import { isConfigLike, longerSpelling, PathIndex, samePath } from './paths.js';

export type ItemCategory = RetentionAttribution['category'];

/** Category priority, highest first. */
export const CATEGORY_ORDER: readonly ItemCategory[] = ['user', 'decision', 'todo', 'file', 'rest', 'narrative1', 'narrative2', 'toolLog'];

/** The floor: everything but narrative tier 2 and the tool log. */
export const FLOOR_CATEGORIES: ReadonlySet<ItemCategory> = new Set(['user', 'decision', 'todo', 'file', 'rest', 'narrative1']);

export type SectionId = 'user' | 'decisions' | 'todos' | 'files' | 'browser' | 'test' | 'paths' | 'notes' | 'log';

/** Fixed section order of the summary. */
export const SECTION_ORDER: readonly SectionId[] = ['user', 'decisions', 'todos', 'files', 'browser', 'test', 'paths', 'notes', 'log'];

export interface UserItemText {
  index: number;
  /** remaining text after supersession ('' when fully superseded) */
  body: string;
  /** " (superseded by #j)" etc. */
  suffix: string;
}

export interface LedgerItem {
  /** unique and stable identity */
  id: string;
  category: ItemCategory;
  sources: RetentionSource[];
  supersededBy?: number[];
  section: SectionId;
  /** message index the item came from (latest occurrence) */
  index: number;
  /** rank inside the category, compared lexicographically (smaller = kept longer) */
  rank: number[];
  /** position inside the section, compared lexicographically (first appearance) */
  pos: number[];
  /** rendered line(s) for non-user items */
  line: string;
  /** user items are shaped at render time (shortening step) */
  user?: UserItemText;
  /** todo-state items: the heading annotation, e.g. "todowrite #7" */
  todoHeading?: string;
}

export interface Ledger {
  items: LedgerItem[];
}

const cmpArr = (a: readonly number[], b: readonly number[]): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
};

/** The one strict total order of items: category, rank inside it, message index, then id. */
export function compareItems(a: LedgerItem, b: LedgerItem): number {
  return (
    CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
    cmpArr(a.rank, b.rank) ||
    a.index - b.index ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Rendering order inside a section. */
export function comparePos(a: LedgerItem, b: LedgerItem): number {
  return cmpArr(a.pos, b.pos) || a.index - b.index || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Shapes a user fact for the summary: `---` lines neutralized, head+tail cap, continuation lines indented. */
export function renderUserItem(u: UserItemText, maxChars: number): string {
  const body = u.body ? capHeadTail(neutralizeRules(u.body), maxChars).replace(/\r?\n/g, '\n  ') : '';
  const sep = body && u.suffix ? ' ' : '';
  return `- #${u.index}: ${body}${sep}${u.suffix}`;
}

export interface LedgerInput {
  messages: ChatMessage[];
  hEnd: number;
  cut: number;
}

/** Facts of message i; tool results receive their call (null for orphans). */
export type FactsFn = (i: number, call: ToolCall | null, callKey: string) => MessageFacts;

interface CallRef {
  /** index of the assistant message that issued the call */
  at: number;
  facts: CallFacts;
  result: ResultFacts | null;
  resultIndex?: number;
}

const CLOSED = new Set(['completed', 'complete', 'done', 'cancelled', 'canceled']);

/** Cap of a rendered path, URL or page title (a signed URL or a pathological path argument is one floor item). */
const VALUE_MAX_CHARS = 300;
/** A path / URL / title from a tool call or result on one bounded summary line. */
const shown = (s: string): string => oneLine(capHeadTail(s, VALUE_MAX_CHARS));
/** A tool result reads as an error (a "0 failed" style tally does not count). */
const isErrorText = (s: string): boolean =>
  /\b(?:error|errors|exception|traceback|fatal|failed|failure|failures)\b/i.test(s.replace(/\b0 (?:errors?|failed|failures?)\b/gi, ''));

/**
 * Builds the ledger items of [hEnd, cut) evaluated over H[0..b) (b = messages.length). `facts` supplies the
 * (cached) per-message extraction; everything here is a pure function of its results.
 */
export function buildLedger(input: LedgerInput, cfg: Config, extractor: Extractor, rules: SupersedeRules, facts: FactsFn): Ledger {
  const { messages, hEnd, cut } = input;
  const b = messages.length;
  const on = cfg.ledger.enabled;
  const items: LedgerItem[] = [];
  const push = (it: Omit<LedgerItem, 'sources'> & { sources?: RetentionSource[] }): void => {
    items.push({ ...it, sources: it.sources ?? [{ kind: 'message', messageIndex: it.index }] });
  };

  // ------------------------------------------------------------ walk [hEnd, b): facts and call/result pairing
  const assistants: Array<{ at: number; f: AssistantFacts }> = [];
  const users: Array<{ at: number; f: UserFacts }> = [];
  const calls: CallRef[] = [];
  const results: Array<{ at: number; ref: CallRef | null; f: ResultFacts }> = [];
  let cur: { at: number; refs: CallRef[]; raw: ToolCall[]; used: Set<number> } | null = null;
  for (let i = hEnd; i < b; i++) {
    const m = messages[i]!;
    const role = m.role;
    if (role === 'assistant') {
      const f = facts(i, null, '') as AssistantFacts;
      assistants.push({ at: i, f });
      const refs = f.calls.map((c) => ({ at: i, facts: c, result: null }) as CallRef);
      calls.push(...refs);
      const raw = Array.isArray(m.tool_calls) ? m.tool_calls.filter((c) => typeof c === 'object' && c !== null) : [];
      cur = { at: i, refs, raw, used: new Set() };
    } else if (role === 'user' || role === 'system' || role === 'developer') {
      if (role === 'user') users.push({ at: i, f: facts(i, null, '') as UserFacts });
      cur = null;
    } else {
      // tool / function / other: attaches to the current assistant unit
      let k = -1;
      if (cur) {
        const id = typeof m.tool_call_id === 'string' ? m.tool_call_id : null;
        if (id !== null) k = cur.refs.findIndex((r, j) => r.facts.id === id && !cur!.used.has(j));
        if (k < 0) for (let j = 0; j < cur.refs.length && k < 0; j++) if (!cur.used.has(j)) k = j;
      }
      let call: ToolCall | null = null;
      let key = 'orphan';
      if (cur && k >= 0) {
        cur.used.add(k);
        call = cur.raw[k] ?? null;
        key = `${cur.at}#${k}`;
      } else if (role === 'function' && typeof m.name === 'string') {
        call = { id: '', type: 'function', function: { name: m.name, arguments: '' } };
        key = `fn:${m.name}`;
      }
      const f = facts(i, call, key) as ResultFacts;
      const ref = cur && k >= 0 ? cur.refs[k]! : null;
      if (ref && ref.result === null) { ref.result = f; ref.resultIndex = i; }
      results.push({ at: i, ref, f });
    }
  }
  const inR = (at: number): boolean => at < cut;
  const resultAt = (r: { at: number; ref: CallRef | null }): number => r.ref?.at ?? r.at;

  const callSource = (c: CallRef): RetentionSource => ({ kind: 'tool-call', messageIndex: c.at, callIndex: c.facts.ord });
  const resultSource = (r: { at: number; ref: CallRef | null }): RetentionSource => ({
    kind: 'tool-result', messageIndex: r.at,
    ...(r.ref ? { call: { messageIndex: r.ref.at, callIndex: r.ref.facts.ord } } : {}),
  });

  // ------------------------------------------------------------ user instructions (never evicted)
  const headUsers: UserText[] = [];
  const headIds = new Set<string>();
  for (let i = 0; i < Math.min(hEnd, b); i++) {
    const m = messages[i]!;
    const t = contentText(m.content);
    for (const id of explicitIds(t)) headIds.add(id);
    if (m.role === 'user' && t.trim()) headUsers.push({ index: i, text: extractor.user(m).text, head: true });
  }
  const factUsers = users.filter((u) => u.f.fact);
  const sup = on ? supersede([...headUsers, ...factUsers.map((u) => ({ index: u.at, text: u.f.text, head: false }))], rules, headIds) : null;
  for (const u of factUsers) {
    if (!inR(u.at)) continue;
    let body = u.f.text;
    let suffix = '';
    const st = sup?.sentences.get(u.at);
    if (st && st.some((s) => s.supersededBy !== null)) {
      const by = [...new Set(st.filter((s) => s.supersededBy !== null).map((s) => s.supersededBy!))].map((j) => `#${j}`).join(', ');
      const keep = st.filter((s) => s.supersededBy === null);
      if (keep.length === 0) {
        body = '';
        suffix = `(superseded by ${by})`;
      } else {
        // re-join the remaining sentences with their own kind of separator
        let t = '';
        keep.forEach((s, k) => {
          if (k > 0) t += /\n/.test(u.f.text.slice(keep[k - 1]!.sentence.end, s.sentence.start)) ? '\n' : ' ';
          t += s.sentence.text;
        });
        body = t;
        suffix = `(part superseded by ${by})`;
      }
    }
    if (sup?.amends.has(u.at)) suffix = suffix ? `${suffix} (amends the task)` : '(amends the task)';
    push({ id: `u:${u.at}`, category: 'user', section: 'user', index: u.at, rank: [u.at], pos: [u.at], line: '', supersededBy: [...new Set(st?.flatMap((s) => s.supersededBy === null ? [] : [s.supersededBy]) ?? [])], user: { index: u.at, body, suffix } });
  }

  // ------------------------------------------------------------ assistant text: decisions, todo lines, notes, narrative
  for (const { at, f } of assistants) {
    if (!inR(at)) continue;
    f.tagged.forEach((t, ord) => {
      const line = `- #${at}: ${t.text}`;
      if (t.tag === 'decision') push({ id: `d:${at}:${ord}`, category: 'decision', section: 'decisions', index: at, rank: [-at, ord], pos: [at, ord], line });
      else if (t.tag === 'note') push({ id: `n:${at}:${ord}`, category: 'rest', section: 'notes', index: at, rank: [1, -at, ord], pos: [0, at, ord], line });
      else push({ id: `t:${at}:${ord}`, category: 'todo', section: 'todos', index: at, rank: [-at, 1, ord], pos: [at, 1, ord], line });
    });
    f.labels.forEach((l, ord) => {
      push({ id: `l:${at}:${ord}`, category: 'narrative1', section: 'notes', index: at, rank: [l.priority ? 0 : 1, -at, ord], pos: [1, at, ord], line: `- #${at}: ${l.text}` });
    });
    // tier 2 and reasoning arrive capped and on one line (extract.ts), reasoning already filtered by policy
    if (f.narrative) push({ id: `v:${at}`, category: 'narrative2', section: 'notes', index: at, rank: [-at, 0], pos: [2, at, 0], line: `- #${at}: ${f.narrative}` });
    if (f.reasoning) push({ id: `r:${at}`, category: 'narrative2', section: 'notes', index: at, rank: [-at, 1], pos: [2, at, 1], line: `- #${at} (reasoning): ${f.reasoning}` });
  }

  // ------------------------------------------------------------ tool log (one line per summarized call)
  for (const c of calls) {
    if (!inR(c.at)) continue;
    const f = c.facts;
    const args = f.keyArgs ? ` ${f.keyArgs}` : '';
    const res = c.result ? c.result.condensed : '(no result)';
    push({ id: `g:${c.at}:${f.ord}`, sources: [callSource(c), ...(c.resultIndex === undefined ? [] : [resultSource({ at: c.resultIndex, ref: c })])], category: 'toolLog', section: 'log', index: c.at, rank: [-c.at, f.ord], pos: [c.at, f.ord], line: `- #${c.at} ${oneLine(f.name) || '(unnamed)'}${args} → ${res}` });
  }

  // ------------------------------------------------------------ within-category ranking signals (ledger.ranking)
  // Off: ranks stay as assigned above. On: every non-user item's rank is prefixed with, in order,
  //   [duplicate (an earlier copy of a later identical item: 1), error result (0 = yes), -later references, -index]
  // so a category keeps its errors, its most referenced and its newest items longest. Categories (and with them the
  // floor) and items (a call and its result are one tool-log item) are unchanged; only the order inside a category moves.
  const finish = (): Ledger => {
    if (!cfg.ledger.ranking) return { items };
    const errAt = new Set<number>();
    for (const r of results) if (isErrorText(r.f.condensed) || (r.f.tally !== null && isErrorText(r.f.tally))) errAt.add(r.at);
    // a reference: a call naming the path in its args, or a result mentioning it (at its call's message)
    const refs = new PathIndex<{ path: string; at: number }>();
    for (const c of calls) for (const fa of c.facts.files) refs.add(fa.path, { path: fa.path, at: c.at });
    for (const r of results) for (const p of r.f.paths) refs.add(p, { path: p, at: resultAt(r) });
    const callAt = new Map(calls.map((c) => [`g:${c.at}:${c.facts.ord}`, c]));
    const keysOf = (it: LedgerItem): string[] => {
      if (it.category === 'toolLog') return callAt.get(it.id)?.facts.files.map((f) => f.path) ?? [];
      return it.id.startsWith('f:') || it.id.startsWith('p:') ? [it.id.slice(2)] : [];
    };
    const dupKey = (it: LedgerItem): string => {
      const c = it.category === 'toolLog' ? callAt.get(it.id) : undefined;
      return c ? `g|${c.facts.name}|${c.facts.keyArgs}` : `${it.category}|${it.line.replace(/#\d+/g, '#')}`;
    };
    // the latest copy by message index, then position inside the message (copies within one assistant message)
    const at = (it: LedgerItem): number[] => [it.index, ...it.pos];
    const latest = new Map<string, number[]>();
    for (const it of items) {
      if (it.category === 'user') continue;
      const prev = latest.get(dupKey(it));
      if (!prev || cmpArr(at(it), prev) > 0) latest.set(dupKey(it), at(it));
    }
    for (const it of items) {
      if (it.category === 'user') continue;
      const dup = cmpArr(at(it), latest.get(dupKey(it))!) < 0 ? 1 : 0;
      const err = it.sources.some((s) => s.kind === 'tool-result' && errAt.has(s.messageIndex)) ? 0 : 1;
      // distinct later messages that reference one of the item's paths
      const later = new Set<number>();
      for (const p of keysOf(it)) for (const r of refs.near(p)) if (r.at > it.index && samePath(r.path, p)) later.add(r.at);
      it.rank = [dup, err, -later.size, -it.index, ...it.rank];
    }
    return { items };
  };

  if (!on) return finish();

  // ------------------------------------------------------------ todo state (latest todo-tool call wins)
  let todoCall: CallRef | null = null;
  let todoInTail = false;
  for (const c of calls) {
    if (c.facts.todos === null) continue;
    if (inR(c.at)) todoCall = c;
    else todoInTail = true;
  }
  if (todoCall && !todoInTail) {
    const at = todoCall.at;
    const heading = `${oneLine(todoCall.facts.name)} #${at}`;
    const closed = new Map<string, number>();
    todoCall.facts.todos!.forEach((t, k) => {
      const st = t.status || 'pending';
      if (CLOSED.has(st)) {
        const name = st === 'done' || st === 'complete' ? 'completed' : st === 'canceled' ? 'cancelled' : st;
        closed.set(name, (closed.get(name) ?? 0) + 1);
        return;
      }
      push({ id: `s:${at}:${k}`, sources: [callSource(todoCall!)], category: 'todo', section: 'todos', index: at, rank: [-at, 0, k], pos: [at, 0, k], line: `- [${st}] ${capHead(collapseWs(t.content), 300)}`, todoHeading: heading });
    });
    if (closed.size > 0) {
      const parts = [...closed.entries()].sort((x, y) => (x[0] === 'completed' ? -1 : y[0] === 'completed' ? 1 : x[0] < y[0] ? -1 : 1)).map(([s, n]) => `${n} ${s}`);
      push({ id: `s:${at}:closed`, sources: [callSource(todoCall)], category: 'todo', section: 'todos', index: at, rank: [-at, 2, 0], pos: [at, 2, 0], line: `- (${parts.join(', ')})`, todoHeading: heading });
    }
  }

  // ------------------------------------------------------------ files from tool args; output paths
  // one entry per file: spellings that name the same file (samePath: `./src/a.ts`, `src/a.ts`, `/repo/src/a.ts`)
  // share it, shown in the most specific spelling. An entry merges a new spelling only when it matches the entry's
  // longest one, which every other spelling of the entry is a suffix of (x/a/b.ts and y/a/b.ts stay two files).
  interface ArgFile {
    path: string;
    spellings: string[];
    first: number;
    firstOrd: number;
    last: number;
    action: string;
    source: RetentionSource;
  }
  // lookups go through PathIndex buckets (samePath implies an equal pathKey; every spelling of an entry shares
  // its key), so a build is linear in the number of files instead of quadratic
  const argFiles: ArgFile[] = [];
  const argIndex = new PathIndex<ArgFile>();
  const tailIndex = new PathIndex<string>();
  let ordSeq = 0;
  for (const c of calls) {
    for (const fa of c.facts.files) {
      if (!inR(c.at)) {
        tailIndex.add(fa.path, fa.path);
        continue;
      }
      const e = argIndex.near(fa.path).find((x) => samePath(x.path, fa.path));
      if (e) {
        e.last = c.at;
        e.action = fa.action;
        e.source = callSource(c);
        if (!e.spellings.includes(fa.path)) e.spellings.push(fa.path);
        e.path = longerSpelling(e.path, fa.path);
      } else {
        const n: ArgFile = { path: fa.path, spellings: [fa.path], first: c.at, firstOrd: ordSeq++, last: c.at, action: fa.action, source: callSource(c) };
        argFiles.push(n);
        argIndex.add(fa.path, n);
      }
    }
  }
  for (const r of results) if (!inR(resultAt(r))) for (const p of r.f.paths) tailIndex.add(p, p);
  const recurs = (p: string): boolean => tailIndex.near(p).some((t) => samePath(t, p));
  for (const e of argFiles) {
    if (e.spellings.some(recurs)) continue;
    push({ id: `f:${e.path}`, sources: [e.source], category: 'file', section: 'files', index: e.last, rank: [1, -e.last, e.first, e.firstOrd], pos: [e.first, e.firstOrd], line: `- ${shown(e.path)} — ${e.action} #${e.last}` });
  }
  type Out = { path: string; at: number; ord: number; tool: string; source: RetentionSource };
  const outs: Out[] = [];
  const outIndex = new PathIndex<Out>();
  for (const r of results) {
    const at = resultAt(r);
    if (!inR(at)) continue;
    for (const p of r.f.paths) {
      if (argIndex.near(p).some((a) => a.spellings.some((x) => samePath(x, p)))) continue;
      if (recurs(p)) continue;
      // one file mentioned as checkout/a.spec.ts and tests/e2e/checkout/a.spec.ts: first appearance, longest form
      const dup = outIndex.near(p).find((o) => samePath(o.path, p));
      if (dup) {
        dup.path = longerSpelling(dup.path, p);
        continue;
      }
      const o: Out = { path: p, at, ord: ordSeq++, tool: r.ref?.facts.name || messages[r.at]!.role, source: resultSource(r) };
      outs.push(o);
      outIndex.add(p, o);
    }
  }
  const ranked = [...outs.filter((o) => isConfigLike(o.path)), ...outs.filter((o) => !isConfigLike(o.path))].slice(0, Math.max(0, cfg.ledger.outputPaths.maxTotal));
  for (const o of ranked) {
    if (isConfigLike(o.path)) {
      push({ id: `f:${o.path}`, sources: [o.source], category: 'file', section: 'files', index: o.at, rank: [0, o.at, o.ord], pos: [o.at, o.ord], line: `- ${shown(o.path)} — referenced in ${oneLine(o.tool)} #${o.at}` });
    } else {
      push({ id: `p:${o.path}`, sources: [o.source], category: 'rest', section: 'paths', index: o.at, rank: [2, o.at, o.ord], pos: [o.at, o.ord], line: `- ${shown(o.path)} (in ${oneLine(o.tool)} #${o.at})` });
    }
  }

  // ------------------------------------------------------------ browser tabs (last URL + title per tab)
  interface Tab {
    url: string | null;
    title: string | null;
    first: number;
    last: number;
    source: RetentionSource;
  }
  const tabs = new Map<number, Tab>();
  let current = 0;
  const touch = (idx: number, at: number): Tab => {
    let t = tabs.get(idx);
    if (!t) {
      t = { url: null, title: null, first: at, last: at, source: { kind: 'message', messageIndex: at } };
      tabs.set(idx, t);
    }
    t.last = at;
    return t;
  };
  // events in message order: calls (at their assistant) and results (at their own index)
  const events: Array<{ at: number; call?: CallRef; result?: { at: number; ref: CallRef | null; f: ResultFacts } }> = [];
  for (const c of calls) events.push({ at: c.at, call: c });
  for (const r of results) events.push({ at: r.at, result: r });
  events.sort((x, y) => x.at - y.at || (x.call ? x.call.facts.ord : 1e9) - (y.call ? y.call.facts.ord : 1e9));
  for (const ev of events) {
    if (ev.call) {
      const f = ev.call.facts;
      if (f.navigateUrl !== null) {
        const t = touch(current, ev.call.at);
        t.source = callSource(ev.call);
        t.url = f.navigateUrl;
        t.title = null;
      } else if (f.tabs) {
        const a = f.tabs.action.toLowerCase();
        if (a === 'select' && f.tabs.index !== null) current = f.tabs.index;
        else if (a === 'new') {
          current = tabs.size ? Math.max(...tabs.keys()) + 1 : 1;
          touch(current, ev.call.at);
        } else if (a === 'close') {
          const idx = f.tabs.index ?? current;
          if (tabs.has(idx)) {
            const shifted = new Map<number, Tab>();
            for (const [k, v] of tabs) if (k !== idx) shifted.set(k > idx ? k - 1 : k, v);
            tabs.clear();
            for (const [k, v] of shifted) tabs.set(k, v);
          }
          if (current >= idx && current > 0) current--;
        }
      }
    } else if (ev.result) {
      const r = ev.result;
      const at = resultAt(r);
      if (r.f.tabs.length > 0) {
        const next = new Map<number, Tab>();
        for (const t of r.f.tabs) {
          const old = tabs.get(t.index);
          next.set(t.index, { url: t.url, title: t.title, first: old?.first ?? at, last: at, source: resultSource(r) });
          if (t.current) current = t.index;
        }
        tabs.clear();
        for (const [k, v] of next) tabs.set(k, v);
      }
      if (r.f.pageUrl !== null) {
        const t = touch(current, at);
        t.source = resultSource(r);
        t.url = r.f.pageUrl;
        if (r.f.pageTitle !== null) t.title = r.f.pageTitle;
      }
    }
  }
  const shownTabs = [...tabs.entries()].filter(([, t]) => t.url !== null && inR(t.last) && t.last >= hEnd);
  const multi = tabs.size > 1;
  for (const [idx, t] of shownTabs) {
    const title = t.title !== null ? ` — "${shown(t.title)}"` : '';
    push({ id: `b:${idx}`, sources: [t.source], category: 'rest', section: 'browser', index: t.last, rank: [0, -t.last, 0, idx], pos: [t.first, idx], line: `- ${multi ? `tab ${idx}: ` : ''}${shown(t.url!)}${title} (#${t.last})` });
  }

  // ------------------------------------------------------------ last test run
  let lastTest: { at: number; r: (typeof results)[number] } | null = null;
  for (const r of results) if (r.f.resultKind === 'test') lastTest = { at: resultAt(r), r };
  if (lastTest && inR(lastTest.at)) {
    const f = lastTest.r.ref?.facts;
    const what = f?.command ? '`' + capHead(collapseWs(f.command), 120) + '`' : f?.name || 'test';
    push({ id: 'test-last', sources: [resultSource(lastTest.r)], category: 'rest', section: 'test', index: lastTest.at, rank: [0, -lastTest.at, 1, 0], pos: [lastTest.at], line: `- #${lastTest.at} ${what} → ${lastTest.r.f.tally ?? '(no tally line)'}` });
  }

  return finish();
}
