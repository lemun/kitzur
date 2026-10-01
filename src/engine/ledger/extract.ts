// Per-message fact extraction (DESIGN.md–§6.3). Each function depends only on its message (and, for a
// tool result, on the call that produced it), so results are cached by digest and a cache hit is identical
// to a recomputation.
import type { ChatMessage, ToolCall } from '../../types.js';
import { DEFAULT_CONFIG, type Config } from '../../config/schema.js';
import type { ResultKind, SnapshotInfo } from '../contracts.js';
import { SUMMARY_HEADER } from '../contracts.js';
import { canonicalJSON } from '../../tokenize/canonical.js';
import { callName, commandOf, parseArgs, type ToolRole, type ToolRulesExt } from '../rules/index.js';
import { parseOpenTabs, type OpenTab } from '../rules/snapshot.js';
import { tallyLine } from '../rules/testrun.js';
import { outputPaths } from './paths.js';
import { explicitIdSpans } from './supersede.js';
import { capHead, capHeadTail, collapseWs, contentText, splitThink, stripEnvironmentDetails, textParts } from './text.js';

/** Cap of one decision / todo / note / tier-1 line (: 300 characters, head-first). */
export const ITEM_MAX_CHARS = 300;
/** Cap of the tool-log key args (§6.3). */
export const KEY_ARGS_MAX_CHARS = 120;
/** OpenCode's synthetic user message that carries images extracted from a tool result. */
const MEDIA_USER_TEXT = 'Attached media from tool result:';

export type TagKind = 'decision' | 'todo' | 'blocked' | 'note';

export interface TodoItem {
  content: string;
  status: string;
}

export interface UserFacts {
  kind: 'user';
  /** false for client boilerplate, compaction markers, empty messages and prior summaries that carry no user instructions */
  fact: boolean;
  /** the text (Kilo environment details removed, trimmed); for a prior summary, its carried instructions */
  text: string;
}

export interface CallFacts {
  /** position in tool_calls */
  ord: number;
  id: string;
  name: string;
  roles: ToolRole[];
  /** the tool-log key args (§6.3), already capped; '' when there are none */
  keyArgs: string;
  /** file actions from path args and patch headers */
  files: Array<{ path: string; action: string }>;
  /** the todo list when this is a todo-tool call with a readable list */
  todos: TodoItem[] | null;
  /** browser_navigate url */
  navigateUrl: string | null;
  /** browser_tabs action */
  tabs: { action: string; index: number | null } | null;
  /** shell command (command / cmd arg) */
  command: string | null;
  /** the command matches rules.test.commands */
  test: boolean;
}

export interface AssistantFacts {
  kind: 'assistant';
  /** lines/sentences starting with a ledger tag, in order */
  tagged: Array<{ tag: TagKind; text: string }>;
  /** narrative tier 1: labelled lines () */
  labels: Array<{ text: string; priority: boolean }>;
  /** narrative tier 2: the other visible text, capped head+tail at narrativeMaxCharsPerMessage, one line */
  narrative: string;
  /** reasoning_content / reasoning / inline <think> text under reasoning.summary ('' for drop), one line */
  reasoning: string;
  calls: CallFacts[];
}

export interface ResultFacts {
  kind: 'result';
  resultKind: ResultKind;
  snapshot: SnapshotInfo | null;
  /** `### Open tabs` entries */
  tabs: OpenTab[];
  /** `- Page URL:` / `- Page Title:` */
  pageUrl: string | null;
  pageTitle: string | null;
  /** test tally line when resultKind is 'test' */
  tally: string | null;
  /** condensed result for the tool log (§6.3) */
  condensed: string;
  /** output paths (§6.2): per-result cap applied, config-like first */
  paths: string[];
}

export interface OtherFacts {
  kind: 'other';
}

export type MessageFacts = UserFacts | AssistantFacts | ResultFacts | OtherFacts;

/** First line of the carried instructions of a prior summary (see carriedInstructions). */
export const CARRIED_LINE = 'User instructions carried from an earlier summary:';

/**
 * The `## User instructions` section of a prior summary as one user-fact text: CARRIED_LINE, then one `- text`
 * line per still-valid instruction (the `#k: ` numbers of the old summary dropped, fully superseded items left
 * out, `(part superseded by …)` / `(amends the task)` suffixes removed, continuation lines kept). ''
 * when the summary has no such section (another compactor's format, or nothing to carry).
 */
export function carriedInstructions(text: string): string {
  const at = text.search(/^## User instructions[ \t]*$/m);
  if (at < 0) return '';
  const out: string[] = [];
  /** inside an item that is itself an earlier carry: its indented `- x` lines are items of their own */
  let nested = false;
  /** an item's text without the old summary's status suffixes; '' for a fully superseded item */
  const clean = (t: string): string => {
    const x = t.replace(/ ?\((?:part superseded by #[\d#, ]+|amends the task)\)/g, '').trim();
    return /^\(superseded by #[\d#, ]+\)$/.test(x) ? '' : x;
  };
  for (const l of text.slice(at).split('\n').slice(1)) {
    if (/^## /.test(l) || l.startsWith('[kitzur]')) break;
    if (!l.trim()) continue;
    const item = /^- (?:#\d+: ?)?(.*)$/.exec(l);
    const sub = nested ? /^\s+- (.*)$/.exec(l) : null;
    if (item || sub) {
      const t = clean((item ?? sub)![1]!);
      if (item) nested = t === CARRIED_LINE;
      // a placeholder for a dropped item (or the carry line itself), so its continuation lines go with it
      out.push(!t || (item && nested) ? '' : `- ${t}`);
    } else if (/^\s/.test(l) && out.length > 0 && out[out.length - 1] !== '') {
      out[out.length - 1] += `\n${l.trim()}`; // the summary indents continuation lines itself
    }
  }
  const kept = out.filter((x) => x !== '');
  return kept.length ? `${CARRIED_LINE}\n${kept.join('\n')}` : '';
}

/** Trailing `**` / `__` emphasis removed (a loop: /(?:\*\*|__)+$/ is quadratic on a long run of them). */
function stripEmphasisEnd(t: string): string {
  let e = t.length;
  while (e >= 2 && (t.slice(e - 2, e) === '**' || t.slice(e - 2, e) === '__')) e -= 2;
  return t.slice(0, e);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

export interface Extractor {
  user(m: ChatMessage): UserFacts;
  assistant(m: ChatMessage): AssistantFacts;
  result(m: ChatMessage, call: ToolCall | null): ResultFacts;
  /** tool arguments that name files, for the own-path exclusion of §6.2 */
  pathArgs(args: Record<string, unknown> | null): string[];
}

export function createExtractor(cfg: Config, rules: ToolRulesExt): Extractor {
  const L = cfg.ledger;
  const boiler = new Set([...cfg.client.boilerplateUserTexts, ...cfg.client.compactionMarkers, MEDIA_USER_TEXT].map((s) => s.trim()));
  const ledgerOn = L.enabled;

  // --- tags: a sentence start followed by a tag, optional -ID suffixes, then ':'
  const tagAlt = (xs: string[]): string => (xs.length ? xs.map(escapeRe).join('|') : '(?!)');
  const TAG_RE = new RegExp(
    `^(?:(${tagAlt(L.tags.decision)})|(${tagAlt(L.tags.todo)})|(${tagAlt(L.tags.blocked)})|(${tagAlt(L.tags.note)}))(?:-[A-Za-z0-9]+)*\\s*:`,
    'i',
  );
  const allTags = [...L.tags.decision, ...L.tags.todo, ...L.tags.blocked, ...L.tags.note].map((t) => t.toLowerCase());
  let LABEL_RE: RegExp;
  try {
    LABEL_RE = new RegExp(L.labelPattern, 'g');
  } catch (e) {
    throw new Error(`ledger.labelPattern is not a valid regular expression: ${(e as Error).message}`);
  }


  /**
   * Label matches of a line ({0: text, index}). The default pattern restarts at every `-`/`_` segment of a long
   * run like `ABC-ABC-…` and rescans it (42 s on a 200 KB line), so with the default the pattern only runs on the
   * at most LABEL_WINDOW characters of [A-Z0-9_-] before each `:` (every default label is such a run plus its `:`;
   * matches never share a `:`, so they are the same ones, except that a label longer than the window is found by
   * its tail). A custom pattern runs on the whole line.
   */
  const LABEL_WINDOW = 64;
  const windowed = L.labelPattern === DEFAULT_CONFIG.ledger.labelPattern;
  const findLabels = (line: string): Array<{ 0: string; index: number }> => {
    if (!windowed) {
      LABEL_RE.lastIndex = 0;
      return [...line.matchAll(LABEL_RE)].filter((m) => m[0].length > 0).map((m) => ({ 0: m[0], index: m.index }));
    }
    const out: Array<{ 0: string; index: number }> = [];
    for (let p = line.indexOf(':'); p >= 0; p = line.indexOf(':', p + 1)) {
      let q = p;
      while (q > 0 && p - q < LABEL_WINDOW && /[A-Z0-9_-]/.test(line[q - 1]!)) q--;
      if (q === p) continue;
      // one character of context keeps the pattern's \b exactly as in the line
      const ctx = q > 0 ? 1 : 0;
      const w = line.slice(q - ctx, p + 1);
      LABEL_RE.lastIndex = 0;
      for (const m of w.matchAll(LABEL_RE)) {
        if (m.index >= ctx && m.index + m[0].length === w.length) {
          out.push({ 0: m[0], index: q - ctx + m.index });
          break;
        }
      }
    }
    return out;
  };

  /**
   * : a tier-1 item is the whole line holding the label, capped at ITEM_MAX_CHARS head-first. When that cap would
   * cut off the label itself (a label deep inside a long one-line paragraph), the item starts at the sentence that
   * holds the label instead (at the label, if that sentence is too long), marked by a leading "…": otherwise the
   * label is extracted, its line leaves tier 2, and the fact vanishes from the summary.
   */
  const labelItem = (line: string, at: number, len: number): string => {
    const whole = collapseWs(line);
    if (whole.length <= ITEM_MAX_CHARS || collapseWs(line.slice(0, at + len)).length < ITEM_MAX_CHARS) return capHead(whole, ITEM_MAX_CHARS);
    let from = 0;
    for (const m of line.slice(0, at).matchAll(/[.!?;]\s+/g)) from = m.index + m[0].length;
    if (collapseWs(line.slice(from, at + len)).length > ITEM_MAX_CHARS / 2) from = at;
    return capHead('… ' + collapseWs(line.slice(from)), ITEM_MAX_CHARS);
  };

  /** Sentence starts of a line: after leading bullets/emphasis, and after `. ! ? ;` + whitespace. */
  const sentenceStarts = (line: string): number[] => {
    const starts: number[] = [];
    const lead = /^\s*(?:[-*•>]\s+|\d+[.)]\s+)?(?:\*\*|__)?/.exec(line)![0].length;
    starts.push(lead);
    // sentence ends as in DESIGN §6.1's split `(?<=[.!?;])\s+`
    for (const m of line.matchAll(/[.!?;]\s+(?:\*\*|__)?/g)) {
      const p = m.index + m[0].length;
      if (p < line.length && p > lead) starts.push(p);
    }
    return starts;
  };

  const tagOf = (m: RegExpExecArray): TagKind => (m[1] ? 'decision' : m[2] ? 'todo' : m[3] ? 'blocked' : 'note');

  const scanText = (visible: string): Pick<AssistantFacts, 'tagged' | 'labels' | 'narrative'> => {
    const tagged: AssistantFacts['tagged'] = [];
    const labels: AssistantFacts['labels'] = [];
    const rest: string[] = [];
    for (const line of visible.split('\n')) {
      if (!line.trim()) {
        rest.push(line);
        continue;
      }
      if (ledgerOn) {
        const hits: Array<{ at: number; tag: TagKind }> = [];
        for (const s of sentenceStarts(line)) {
          const m = TAG_RE.exec(line.slice(s));
          if (m) hits.push({ at: s, tag: tagOf(m) });
        }
        if (hits.length > 0) {
          hits.forEach((h, k) => {
            const end = k + 1 < hits.length ? hits[k + 1]!.at : line.length;
            // markdown emphasis around the tag (`**BLOCKED:** x`) is not part of the fact
            const t = stripEmphasisEnd(line.slice(h.at, end).trim().replace(/^([^\s:]+:)(?:\*\*|__)\s*/, '$1 '));
            tagged.push({ tag: h.tag, text: capHead(collapseWs(t), ITEM_MAX_CHARS) });
          });
          continue;
        }
        const found = findLabels(line);
        if (found.length > 0) {
          const isPriority = (lab: string): boolean => {
            const name = lab.replace(/:$/, '');
            const base = name.split(/[-_]/, 1)[0]!.toLowerCase();
            return allTags.includes(base) || explicitIdSpans(name).length > 0;
          };
          // the item must show the label that ranks it (a tag or explicit-ID label first)
          const pri = found.find((m) => isPriority(m[0]));
          const anchor = pri ?? found[0]!;
          labels.push({ text: labelItem(line, anchor.index ?? 0, anchor[0].length), priority: pri !== undefined });
          continue;
        }
      }
      rest.push(line);
    }
    // tier 2 is capped here (: only tier 2), so cached facts stay small
    return { tagged, labels, narrative: collapseWs(capHeadTail(rest.join('\n').trim(), cfg.compaction.narrativeMaxCharsPerMessage)) };
  };

  const pathArgs = (args: Record<string, unknown> | null): string[] => {
    if (!args) return [];
    const out: string[] = [];
    for (const k of L.pathArgKeys) {
      const v = args[k];
      if (typeof v === 'string' && v.trim() && !out.includes(v.trim())) out.push(v.trim());
    }
    return out;
  };

  /** apply_patch headers and unified-diff `+++` targets found in any string argument. */
  const patchFiles = (args: Record<string, unknown> | null): Array<{ path: string; action: string }> => {
    if (!args) return [];
    const out: Array<{ path: string; action: string }> = [];
    for (const v of Object.values(args)) {
      if (typeof v !== 'string') continue;
      if (v.includes('*** ')) {
        // `(.+)` then trimEnd(), not `(.+?)\s*$` (quadratic on a header line padded with blanks)
        for (const m of v.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
          const path = m[2]!.trimEnd();
          if (path) out.push({ path, action: m[1] === 'Add' ? 'write' : m[1] === 'Delete' ? 'delete' : 'edit' });
        }
        for (const m of v.matchAll(/^\*\*\* Move to: (.+)$/gm)) if (m[1]!.trimEnd()) out.push({ path: m[1]!.trimEnd(), action: 'edit' });
      }
      if (v.includes('+++ ')) {
        for (const m of v.matchAll(/^\+\+\+ (?:b\/)?(\S+)/gm)) if (m[1] !== '/dev/null') out.push({ path: m[1]!, action: 'edit' });
      }
    }
    return out;
  };

  const parseTodos = (v: unknown): TodoItem[] | null => {
    if (Array.isArray(v)) {
      const out: TodoItem[] = [];
      for (const t of v) {
        if (typeof t === 'string') out.push({ content: t, status: 'pending' });
        else if (typeof t === 'object' && t !== null) {
          const o = t as Record<string, unknown>;
          const c = o['content'] ?? o['text'] ?? o['title'] ?? o['task'];
          const s = o['status'] ?? (o['completed'] === true ? 'completed' : o['completed'] === false ? 'pending' : undefined);
          out.push({ content: typeof c === 'string' ? c : c === undefined ? '' : canonicalJSON(c), status: typeof s === 'string' ? s.toLowerCase() : 'pending' });
        }
      }
      return out;
    }
    if (typeof v === 'string') {
      // Roo/Kilo update_todo_list: a markdown checklist
      const out: TodoItem[] = [];
      // one line per item: `[^\S\n]` keeps every piece on its line, `(.+)` + trim instead of `(.+?)\s*$` (both quadratic)
      for (const m of v.matchAll(/^[^\S\n]*(?:[-*][^\S\n]*)?\[([ xX~-])\][^\S\n]*(.+)$/gm)) {
        const mark = m[1]!;
        const content = m[2]!.trim();
        if (!content) continue;
        out.push({ content, status: mark === ' ' ? 'pending' : mark === 'x' || mark === 'X' ? 'completed' : 'in_progress' });
      }
      return out;
    }
    return null;
  };

  const callFacts = (call: ToolCall, ord: number): CallFacts => {
    const name = callName(call);
    const roles = rules.role(name);
    const args = parseArgs(call);
    const command = commandOf(args);
    const own = pathArgs(args);
    const isTodo = roles.includes('todo');
    const todos = isTodo && args ? parseTodos(args['todos'] ?? args['todo'] ?? args['items']) : null;
    const files: CallFacts['files'] = [];
    const fileRole = roles.find((r) => r === 'read' || r === 'edit' || r === 'write');
    if (fileRole) for (const p of own) files.push({ path: p, action: fileRole });
    for (const f of patchFiles(args)) if (!files.some((x) => x.path === f.path && x.action === f.action)) files.push(f);
    const url = args && typeof args['url'] === 'string' ? (args['url'] as string) : null;
    const lname = name.toLowerCase();
    const navigateUrl = roles.includes('browserNavigate') && /browser_navigate$/.test(lname) ? url : null;
    let tabs: CallFacts['tabs'] = null;
    if (roles.includes('browserNavigate') && /browser_tabs$/.test(lname) && args) {
      const idx = args['index'];
      tabs = { action: typeof args['action'] === 'string' ? (args['action'] as string) : 'list', index: typeof idx === 'number' && Number.isInteger(idx) ? idx : null };
    }
    const cap = (x: string): string => capHead(collapseWs(x), KEY_ARGS_MAX_CHARS);
    let keyArgs: string;
    if (isTodo) keyArgs = `(${todos ? todos.length : '?'} items)`;
    else if (own.length) keyArgs = cap(own[0]!);
    else if (url !== null) keyArgs = cap(url);
    else if (command !== null) keyArgs = '`' + cap(command) + '`';
    else if (files.length) keyArgs = cap(files.map((f) => f.path).join(', '));
    else if (args) {
      const j = canonicalJSON(args);
      keyArgs = j === '{}' ? '' : cap(j);
    } else keyArgs = cap(typeof call.function?.arguments === 'string' ? call.function.arguments : '');
    return {
      ord,
      id: typeof call.id === 'string' ? call.id : '',
      name,
      roles,
      keyArgs,
      files,
      todos,
      navigateUrl,
      tabs,
      command,
      test: rules.isTestCall(call),
    };
  };

  return {
    pathArgs,

    user(m: ChatMessage): UserFacts {
      const parts = textParts(m.content);
      const first = (parts[0] ?? '').trim();
      const text = stripEnvironmentDetails(parts.join('\n')).trim();
      if (text.startsWith(SUMMARY_HEADER) || first.startsWith(SUMMARY_HEADER)) {
        // a prior summary (kitzur, gobstopper, CliffCompaction) is not itself a user fact, but the user
        // instructions it carries are: dropping them lost the goal and every rule of a session that arrived
        // already compacted (a chained compactor, a resumed session) at kitzur's first compaction
        const carried = carriedInstructions(text);
        return { kind: 'user', fact: carried.length > 0, text: carried };
      }
      const fact = text.length > 0 && !boiler.has(first) && !boiler.has(text);
      return { kind: 'user', fact, text };
    },

    assistant(m: ChatMessage): AssistantFacts {
      const { visible, reasoning: inline } = splitThink(contentText(m.content));
      const field = typeof m.reasoning === 'string' && m.reasoning ? m.reasoning : typeof m.reasoning_content === 'string' ? m.reasoning_content : '';
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls.filter((c) => typeof c === 'object' && c !== null).map(callFacts) : [];
      const raw = (field || inline).trim();
      const policy = cfg.reasoning.summary;
      const reasoning = !raw || policy === 'drop' ? '' : collapseWs(policy === 'cap' ? capHeadTail(raw, cfg.reasoning.summaryCapChars) : raw);
      return { kind: 'assistant', ...scanText(visible), reasoning, calls };
    },

    result(m: ChatMessage, call: ToolCall | null): ResultFacts {
      const text = contentText(m.content);
      const resultKind = rules.classify(text, call);
      const snapshot = resultKind === 'snapshot' ? rules.snapshotInfo(text) : null;
      // `[^\S\n]*`, not `\s*`: with /m, `^\s*` rescans a run of blank lines from every line start (quadratic: 15 s on
      // a tool output of 80,000 blank lines, and this runs on every tool result)
      const pageUrl = /^[^\S\n]*- Page URL:[ \t]*(.*)$/m.exec(text)?.[1]?.trim() || snapshot?.url || null;
      const pageTitle = /^[^\S\n]*- Page Title:[ \t]*(.*)$/m.exec(text)?.[1]?.trim() ?? snapshot?.title ?? null;
      const own = call ? pathArgs(parseArgs(call)) : [];
      const paths = ledgerOn && L.outputPaths.enabled && resultKind !== 'snapshot' ? outputPaths(text, own, L.outputPaths.maxPerResult) : [];
      return {
        kind: 'result',
        resultKind,
        snapshot,
        tabs: text.includes('### Open tabs') ? parseOpenTabs(text) : [],
        pageUrl,
        pageTitle,
        tally: resultKind === 'test' ? tallyLine(text) : null,
        condensed: rules.condense(text, call),
        paths,
      };
    },
  };
}
