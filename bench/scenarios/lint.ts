// Scenario linter (bench/README.md). Runs every rule on the scripted client history of each session (no HTTP):
//
//  structure   ids, sessions, steps, events, gates; fact ids and markers unique; supersededBy targets exist and are
//              typed right; no marker is a substring of another
//  planting    every fact's marker reaches a client request (the client-summary channel: the scenario's summary text)
//  channels    a marker appears ONLY in messages of its channel (head / user / assistant text / reasoning / todowrite
//              args+result / tool-call args / navigate args+snapshot / tool outputs), with per-channel multiplicity
//  placement   in the first 200 characters of the planting message (tally, output-tail: the last 200; output-mid:
//              neither); exempt: the byte-exact reference facts, report-only facts, output-path, client-summary
//  ordering    a superseded fact is planted strictly before its successor and never in the head; latest chains ordered
//  supersession the DESIGN.md rule (), re-implemented here independently of src/engine, run over every user
//              message pair; its verdict must equal the scenario's intent: exactly the declared user facts are
//              superseded, by the declared messages, and nothing else (no false supersession)
//  USER- IDs   a USER- prefix marks an intentionally shared ID: it must occur in >= 2 user messages
//  pairing     scripted tool results answer their calls positionally
//  -ref        byte-exact variants plant nothing: exactly the 7 reference facts

import type { ChatMessage } from '../../src/types.js';
import { contentText } from '../lib/render.js';
import { FACT_KEYS } from './reference.js';
import { dumpText, simulateSession, visibleText, type ScenarioDef, type SimMessage } from './common.js';
import type { FactSpec, GateId } from './types.js';

export interface LintIssue {
  scenario: string;
  rule: string;
  message: string;
}

// ---------------------------------------------------------------- supersession rule (independent implementation)

const CUE_EN =
  /\b(?:actually|instead|correction|scratch that|ignore (?:my|the|that) (?:previous|earlier|last)|disregard|no longer|change of plan|rather than|not [^.]{1,40} anymore)\b/i;
const CUE_HE = /בעצם|במקום|תתעלם|לא משנה|תיקון/;
const ADDITIVE_EN = /\b(?:too|also|additionally|in addition|as well)\b/i;
const ADDITIVE_HE = /גם/;
const EXPLICIT_ID = /[A-Z]{2,}(?:-[A-Z0-9]+)*-[A-Z]*\d[A-Z0-9]*/g;
const MIN_OVERLAP = 0.34;

/** Words that belong to the cue vocabularies (removed from content words). */
const CUE_WORDS = new Set([
  'actually', 'instead', 'correction', 'scratch', 'that', 'ignore', 'previous', 'earlier', 'last', 'disregard', 'longer',
  'change', 'plan', 'rather', 'than', 'not', 'anymore', 'too', 'also', 'additionally', 'addition', 'well',
  'בעצם', 'במקום', 'תתעלם', 'משנה', 'תיקון',
]);

/** A small English + Hebrew stop list (bench-side; the proxy ships its own). */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'this', 'that', 'these', 'those', 'are', 'was', 'were', 'will',
  'would', 'should', 'could', 'can', 'has', 'have', 'had', 'but', 'not', 'any', 'all', 'every', 'each', 'our', 'your',
  'you', 'its', 'his', 'her', 'their', 'them', 'they', 'then', 'there', 'here', 'what', 'when', 'where', 'which', 'who',
  'how', 'why', 'use', 'using', 'please', 'just', 'only', 'also', 'too', 'very', 'more', 'most', 'some', 'such', 'than',
  'out', 'off', 'over', 'under', 'again', 'still', 'now', 'yet', 'about', 'after', 'before', 'while', 'both', 'either',
  'neither', 'nor', 'own', 'same', 'other', 'another', 'does', 'did', 'doing', 'done', 'been', 'being', 'is', 'be',
  'את', 'של', 'על', 'עם', 'לא', 'כל', 'גם', 'אבל', 'אם', 'כי', 'זה', 'זו', 'זאת', 'הוא', 'היא', 'הם', 'הן', 'אני', 'אתה',
  'אנחנו', 'או', 'רק', 'עוד', 'כבר', 'יש', 'אין', 'לגבי', 'בלי', 'אל', 'מה', 'איך', 'למה', 'שבו', 'בו', 'בה', 'להם',
]);

export interface UserSentence {
  /** message index in the session history */
  msg: number;
  /** sentence ordinal in the message */
  n: number;
  text: string;
}

export function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function explicitIds(text: string, head: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EXPLICIT_ID)) if (!head.includes(m[0]) && !out.includes(m[0])) out.push(m[0]);
  return out;
}

export function contentWords(text: string, head: string): Set<string> {
  const idTokens = new Set<string>();
  for (const id of explicitIds(text, head)) for (const t of id.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) idTokens.add(t);
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    if (STOP.has(w) || CUE_WORDS.has(w) || idTokens.has(w)) continue;
    out.add(w);
  }
  return out;
}

export const isCued = (s: string): boolean => CUE_EN.test(s) || CUE_HE.test(s);
export const isAdditive = (s: string): boolean => ADDITIVE_EN.test(s) || ADDITIVE_HE.test(s);

export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / Math.min(a.size, b.size);
}

export interface Supersession {
  /** the superseded sentence */
  target: UserSentence;
  /** the cued sentence that superseded it */
  by: UserSentence;
  rule: 'id' | 'overlap';
}

/**
 * DESIGN.md over the user sentences of one history (in order). `head` is the text of the head messages
 * (system + first user message): IDs occurring there are not explicit IDs, and head sentences are never candidates.
 */
export function supersede(sentences: UserSentence[], head: string): Supersession[] {
  const out: Supersession[] = [];
  const dead = new Set<UserSentence>();
  for (let j = 0; j < sentences.length; j++) {
    const s = sentences[j]!;
    if (!isCued(s.text)) continue;
    const earlier = sentences.slice(0, j).filter((e) => !dead.has(e));
    const ids = explicitIds(s.text, head);
    const shared = earlier.filter((e) => explicitIds(e.text, head).some((x) => ids.includes(x)));
    if (shared.length) {
      for (const e of shared) {
        dead.add(e);
        out.push({ target: e, by: s, rule: 'id' });
      }
      continue;
    }
    if (isAdditive(s.text)) continue;
    const cw = contentWords(s.text, head);
    let best: UserSentence | null = null;
    let bestScore = -1;
    for (const e of earlier) {
      const sc = overlap(cw, contentWords(e.text, head));
      if (sc >= bestScore) {
        // ties go to the newest (later in order)
        best = e;
        bestScore = sc;
      }
    }
    if (best && bestScore >= MIN_OVERLAP) {
      dead.add(best);
      out.push({ target: best, by: s, rule: 'overlap' });
    }
  }
  return out;
}

const BOILERPLATE = [
  'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.',
];
const SUMMARY_PREFIX = 'The following is a summary of your previous actions';

/** User sentences of a simulated history (after the head; boilerplate and prior summaries excluded). */
export function userSentences(hist: SimMessage[]): UserSentence[] {
  const out: UserSentence[] = [];
  for (const m of hist) {
    if (m.origin !== 'user') continue;
    const t = contentText(m.message.content);
    const trimmed = t.trim();
    if (BOILERPLATE.some((b) => trimmed === b || trimmed.endsWith(b)) || trimmed.startsWith(SUMMARY_PREFIX)) continue;
    splitSentences(t).forEach((text, n) => out.push({ msg: m.index, n, text }));
  }
  return out;
}

// ---------------------------------------------------------------- channel classification

type Where = 'content' | 'args' | 'reasoning' | 'result' | 'system' | 'goal' | 'user';

interface Hit {
  session: string;
  msg: SimMessage;
  where: Where;
  /** the tool name for args / result hits */
  tool: string | null;
  /** text the placement rule looks at */
  text: string;
}

/** Message dumps for marker search, computed once per message (JSON.stringify: markers are printable ASCII without
 * quotes or backslashes, so it agrees with the ensure_ascii=False dump on whether a marker occurs). */
const dumpCache = new WeakMap<SimMessage, string>();
function dumpOf(m: SimMessage): string {
  let d = dumpCache.get(m);
  if (d === undefined) dumpCache.set(m, (d = JSON.stringify(m.message)));
  return d;
}

function hitsIn(session: string, m: SimMessage, marker: string): Hit[] {
  const out: Hit[] = [];
  const msg = m.message;
  if (!dumpOf(m).includes(marker)) return out;
  const push = (where: Where, tool: string | null, text: string): void => {
    out.push({ session, msg: m, where, tool, text });
  };
  if (m.origin === 'system') push('system', null, contentText(msg.content));
  else if (m.origin === 'goal') push('goal', null, contentText(msg.content));
  else if (m.origin === 'user') push('user', null, contentText(msg.content) || dumpText(msg.content));
  else if (m.origin === 'tool') push('result', m.toolName ?? null, contentText(msg.content));
  else {
    const text = contentText(msg.content);
    if (text.includes(marker)) push('content', null, visibleText(msg));
    for (const c of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
      // placement of an argument marker is measured inside its call (`name(arguments)`), not after the message text
      if (c.function.arguments.includes(marker) || c.function.name.includes(marker)) push('args', c.function.name, `${c.function.name}(${c.function.arguments})`);
    }
    const r = (msg as ChatMessage & { reasoning_content?: unknown }).reasoning_content;
    if (typeof r === 'string' && r.includes(marker)) push('reasoning', null, r);
  }
  if (!out.length) push(m.origin === 'assistant' ? 'content' : 'result', null, dumpText(msg)); // e.g. a field we do not classify
  return out;
}

const TODO_TOOLS = new Set(['todowrite', 'todo_write']);

function channelAccepts(ch: FactSpec['channel'], h: Hit): boolean {
  switch (ch) {
    case 'head':
      return h.where === 'system' || h.where === 'goal';
    case 'user':
      return h.where === 'user';
    case 'assistant':
    case 'decision':
      return h.where === 'content';
    case 'reasoning':
      return h.where === 'reasoning';
    case 'todo':
      return (h.where === 'args' || h.where === 'result') && h.tool !== null && TODO_TOOLS.has(h.tool);
    case 'arg-path':
      return h.where === 'args' && (h.tool === null || !TODO_TOOLS.has(h.tool));
    case 'url':
      // the navigate call and its result, then the `- Page URL:` line of every later snapshot / click result on that
      // page (browser-gen currentUrl)
      return ((h.where === 'args' || h.where === 'result') && h.tool === 'browser_navigate') ||
        (h.where === 'result' && (h.tool === 'browser_snapshot' || h.tool === 'browser_click'));
    case 'output-path':
    case 'output-head':
    case 'output-tail':
    case 'output-mid':
    case 'tally':
      return h.where === 'result';
    case 'client-summary':
      return false;
  }
}

/** How many distinct messages may carry a marker of this channel. */
function multiplicity(ch: FactSpec['channel']): [number, number] {
  switch (ch) {
    case 'todo':
      return [2, 1000]; // every todowrite call that lists it, plus its result
    case 'url':
      return [2, 1000]; // the navigate call and its snapshot, plus the later snapshots / clicks on that page
    case 'head':
      return [1, 2];
    default:
      return [1, 1];
  }
}

function placement(f: FactSpec, text: string, marker: string): string | null {
  const i = text.indexOf(marker);
  if (i < 0) return 'marker not found in the planting text';
  const fromEnd = text.length - i;
  switch (f.channel) {
    case 'tally':
    case 'output-tail':
      return fromEnd <= 200 ? null : `not in the last 200 chars (starts ${fromEnd} from the end)`;
    case 'output-mid':
      return i >= 200 && fromEnd > 200 ? null : 'not in the middle (within the first or last 200 chars)';
    case 'output-path':
    case 'client-summary':
      return null;
    default:
      if (f.expect === 'report-only') return null;
      return i < 200 ? null : `at offset ${i}, not in the first 200 chars`;
  }
}

// ---------------------------------------------------------------- lint

const GATES = new Set<GateId>(['T0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'I5']);
const REF_KEYS = new Set(FACT_KEYS);

export interface LintResult {
  issues: LintIssue[];
  /** fact id -> [session, planted client step] */
  planted: Map<string, [string, number]>;
  /** supersessions the rule found, as fact ids (target -> by), plus sentences without facts */
  rule: Array<{ target: string; by: string; rule: string }>;
}

export function lintScenario(def: ScenarioDef): LintResult {
  const issues: LintIssue[] = [];
  const bad = (rule: string, message: string): void => void issues.push({ scenario: def.id, rule, message });
  const planted = new Map<string, [string, number]>();
  const ruleOut: LintResult['rule'] = [];

  // structure
  if (!def.sessions.length) bad('structure', 'no sessions');
  const sids = new Set<string>();
  for (const s of def.sessions) {
    if (sids.has(s.id)) bad('structure', `duplicate session id ${s.id}`);
    sids.add(s.id);
    if (!(s.steps > 0)) bad('structure', `session ${s.id}: steps must be > 0`);
  }
  for (const g of def.gates) if (!GATES.has(g)) bad('structure', `unknown gate ${g}`);
  const maxSteps = Math.max(...def.sessions.map((s) => s.steps));
  for (const e of def.events ?? []) if (!(e.atStep > 0 && e.atStep < maxSteps)) bad('structure', `event ${e.kind} at step ${e.atStep} is outside (0, ${maxSteps})`);
  const byId = new Map<string, FactSpec>();
  const markers = new Map<string, string>();
  for (const f of def.facts) {
    if (byId.has(f.id)) bad('facts', `duplicate fact id ${f.id}`);
    byId.set(f.id, f);
    if (markers.has(f.marker)) bad('facts', `marker ${f.marker} used by ${markers.get(f.marker)} and ${f.id}`);
    markers.set(f.marker, f.id);
    if (!/^[\x21-\x7e]+$/.test(f.marker) || /["\\]/.test(f.marker)) bad('facts', `${f.id}: marker ${JSON.stringify(f.marker)} is not printable ASCII without spaces, quotes or backslashes`);
    if (!REF_KEYS.has(f.marker) && !/[-/.]/.test(f.marker)) bad('facts', `${f.id}: marker ${f.marker} is a plain word`);
    if (f.expect === 'absent-after-supersede' && !f.supersededBy) bad('facts', `${f.id}: absent-after-supersede needs supersededBy`);
    if (f.supersededBy !== undefined && f.expect !== 'absent-after-supersede' && f.expect !== 'latest')
      bad('facts', `${f.id}: supersededBy on an ${f.expect} fact`);
  }
  for (const f of def.facts) {
    if (f.supersededBy !== undefined && !byId.has(f.supersededBy)) bad('facts', `${f.id}: supersededBy ${f.supersededBy} does not exist`);
    for (const g of def.facts) if (g !== f && g.marker.includes(f.marker)) bad('facts', `marker ${f.marker} (${f.id}) is a substring of ${g.marker} (${g.id})`);
  }

  // -ref variants
  if (def.reference) {
    const refs = def.facts.filter((f) => REF_KEYS.has(f.marker));
    if (refs.length !== 7 || def.facts.length !== 7) bad('ref', `a -ref variant carries exactly the 7 reference facts (has ${def.facts.length})`);
    if (!def.id.endsWith('-ref') && !def.realism) bad('ref', 'byte-exact variants are named *-ref');
  } else if (def.id.endsWith('-ref')) bad('ref', 'a *-ref scenario must set `reference`');

  // simulate every session
  const hists = new Map<string, SimMessage[]>();
  for (const s of def.sessions) hists.set(s.id, simulateSession(s));

  // pairing of the scripted history
  for (const [sid, h] of hists) {
    for (let i = 0; i < h.length; i++) {
      const m = h[i]!.message;
      if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      m.tool_calls.forEach((c, j) => {
        const r = h[i + 1 + j]?.message;
        if (!r || r.role !== 'tool' || r.tool_call_id !== c.id) bad('pairing', `${sid}: call ${c.id} is not answered at position ${j} after message ${i}`);
      });
    }
  }

  // planting, channels, multiplicity, placement
  for (const f of def.facts) {
    if (f.channel === 'client-summary') {
      const t = def.clientCompact?.summaryText ?? '';
      if (!t.includes(f.marker)) bad('planting', `${f.id}: client-summary marker ${f.marker} is not in the scenario's summary text`);
      for (const [sid, h] of hists) for (const m of h) if (dumpOf(m).includes(f.marker)) bad('channel', `${f.id}: client-summary marker found in scripted message ${sid}#${m.index}`);
      continue;
    }
    const hits: Hit[] = [];
    for (const [sid, h] of hists) for (const m of h) hits.push(...hitsIn(sid, m, f.marker));
    if (!hits.length) {
      bad('planting', `${f.id}: marker ${f.marker} never appears in a client request`);
      continue;
    }
    const first = hits[0]!;
    const sess = def.sessions.find((s) => s.id === first.session)!;
    const plantedAt = first.msg.step + 1;
    if (plantedAt >= sess.steps) bad('planting', `${f.id}: planted after the last request (message of step ${first.msg.step}, ${sess.steps} steps)`);
    planted.set(f.id, [first.session, plantedAt]);
    if (new Set(hits.map((h) => h.session)).size > 1) bad('channel', `${f.id}: marker appears in more than one session`);
    for (const h of hits) if (!channelAccepts(f.channel, h)) bad('channel', `${f.id} (${f.channel}): marker also in ${h.where}${h.tool ? `:${h.tool}` : ''} of ${h.session}#${h.msg.index}`);
    const nmsg = new Set(hits.map((h) => `${h.session}#${h.msg.index}`)).size;
    const [lo, hi] = multiplicity(f.channel);
    if (!REF_KEYS.has(f.marker) && (nmsg < lo || nmsg > hi)) bad('channel', `${f.id} (${f.channel}): in ${nmsg} messages, expected ${lo}..${hi}`);
    if (!REF_KEYS.has(f.marker)) {
      const p = placement(f, first.text, f.marker);
      if (p) bad('placement', `${f.id} (${f.channel}): ${p}`);
    }
  }

  // ordering of supersessions and latest chains
  for (const f of def.facts) {
    if (f.supersededBy === undefined) continue;
    const a = planted.get(f.id);
    const b = planted.get(f.supersededBy);
    if (!a || !b) continue;
    if (a[0] !== b[0]) bad('ordering', `${f.id} and its successor ${f.supersededBy} are in different sessions`);
    if (!(a[1] < b[1])) bad('ordering', `${f.id} (planted C_${a[1]}) must be planted before ${f.supersededBy} (C_${b[1]})`);
    if (f.channel === 'head') bad('ordering', `${f.id}: a superseded fact is in the head`);
  }

  // supersession rule vs intent (user facts)
  for (const [sid, h] of hists) {
    const head = h.filter((m) => m.origin === 'system' || m.origin === 'goal').map((m) => contentText(m.message.content)).join('\n');
    const sents = userSentences(h);
    const found = supersede(sents, head);
    const factOf = (s: UserSentence): FactSpec | undefined => def.facts.find((f) => f.channel === 'user' && s.text.includes(f.marker));
    const expected = def.facts.filter((f) => f.channel === 'user' && f.expect === 'absent-after-supersede' && planted.get(f.id)?.[0] === sid);
    for (const x of found) {
      const tf = factOf(x.target);
      const bf = factOf(x.by);
      ruleOut.push({ target: tf?.id ?? `${sid}#${x.target.msg}.${x.target.n}`, by: bf?.id ?? `${sid}#${x.by.msg}.${x.by.n}`, rule: x.rule });
      if (!tf || tf.expect !== 'absent-after-supersede') {
        bad('supersession', `rule supersedes "${x.target.text.slice(0, 80)}" (${tf?.id ?? 'no fact'}) by "${x.by.text.slice(0, 80)}" [${x.rule}] — not intended`);
      } else if (tf.supersededBy !== bf?.id) {
        bad('supersession', `rule supersedes ${tf.id} by ${bf?.id ?? 'an unmarked sentence'} [${x.rule}], intent is ${tf.supersededBy}`);
      }
    }
    for (const f of expected) {
      if (!found.some((x) => x.target.text.includes(f.marker))) bad('supersession', `rule does not supersede ${f.id} (${f.marker}); intent: by ${f.supersededBy}`);
    }
    // USER- prefixes are intentionally shared IDs
    const userTexts = h.filter((m) => m.origin === 'user').map((m) => contentText(m.message.content));
    const userIds = new Set<string>();
    for (const t of userTexts) for (const m of t.matchAll(/\bUSER-[A-Z0-9]+(?:-[A-Z0-9]+)*/g)) userIds.add(m[0]);
    for (const id of userIds) {
      if (REF_KEYS.has(id)) continue;
      const n = userTexts.filter((t) => t.includes(id)).length;
      if (n < 2) bad('user-prefix', `${id} is used in ${n} user message; USER- marks an intentionally shared ID`);
    }
  }

  // confusion-matrix intent (F9) agrees with the facts
  for (const c of def.supersession ?? []) {
    const f = byId.get(c.fact);
    if (!f) {
      bad('supersession', `case ${c.label}: fact ${c.fact} does not exist`);
      continue;
    }
    if (c.supersede && f.supersededBy !== c.by) bad('supersession', `case ${c.label}: ${c.fact}.supersededBy = ${f.supersededBy}, case says ${c.by}`);
    if (!c.supersede && f.expect !== 'survive') bad('supersession', `case ${c.label}: ${c.fact} must be a survive fact`);
    if (c.by && !byId.has(c.by)) bad('supersession', `case ${c.label}: fact ${c.by} does not exist`);
  }

  return { issues, planted, rule: ruleOut };
}
