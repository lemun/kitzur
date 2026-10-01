// Superseded user instructions (DESIGN.md, ): per sentence, explicit IDs first, additive cues never
// supersede, otherwise the best overlap coefficient of content words above ledger.correctionMinOverlap.
//
// A false supersession deletes a priority-1 rule, while a missed one only leaves the older instruction
// visible next to the newer one; every rule here errs towards missing.
import type { Config } from '../../config/schema.js';
import { CUE_WORDS, ENGLISH_STOP_WORDS, HEBREW_STOP_WORDS } from './stopwords.js';
import { splitSentences, type Sentence } from './text.js';

/**
 * DESIGN §6.1 explicit ID (`USER-RULE-Q7`, `VP-OLD-K7Q2M`; not `E2E`, `S3`, `HTTP2`) between word boundaries in
 * Python's Unicode sense (the review's probe used `\\b`), so a Hebrew prefix such as `ל-USER-VIEW-R4` still yields
 * the ID. Compile with the 'u' flag.
 */
export const EXPLICIT_ID_SOURCE = '(?<![\\p{L}\\p{N}_])[A-Z]{2,}(?:-[A-Z0-9]+)*-[A-Z]*\\d[A-Z0-9]*(?![\\p{L}\\p{N}_])';

const WORDISH = /[\p{L}\p{N}_]/u;
/** The code point that ends just before index i / starts at index i ('' at the ends). */
const cpBefore = (t: string, i: number): string => {
  if (i <= 0) return '';
  const lo = t.charCodeAt(i - 1);
  return lo >= 0xdc00 && lo <= 0xdfff && i >= 2 ? t.slice(i - 2, i) : t[i - 1]!;
};
const cpAt = (t: string, i: number): string => (i >= t.length ? '' : String.fromCodePoint(t.codePointAt(i)!));

/**
 * The spans of EXPLICIT_ID_SOURCE matches (the same matches as `text.matchAll(new RegExp(EXPLICIT_ID_SOURCE, 'gu'))`),
 * found in linear time. The regex restarts at every `-`-separated segment and rescans the rest of the run: 11 s on
 * an 80 KB run like `ABC-ABC-…` in a user message or the system prompt (whose IDs every ledger build collects).
 *
 * Every match lies inside a maximal run of [A-Z0-9-]: it starts at a segment (after a `-`, or at the run start
 * when the character before the run is not a letter, number or `_`), its first segment is 2+ letters, every later
 * segment is non-empty, and it ends after the last segment of that chain that holds a digit (greedy) and is
 * followed by a `-` or, at the run end, by a character that is not a letter, number or `_`.
 */
export function explicitIdSpans(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  if (!text.includes('-')) return out;
  for (const r of text.matchAll(/[A-Z0-9-]+/g)) {
    const run = r[0];
    if (!run.includes('-')) continue;
    const at = r.index;
    const startOk0 = !WORDISH.test(cpBefore(text, at));
    const endOkLast = !WORDISH.test(cpAt(text, at + run.length));
    const segs = run.split('-');
    const offs: number[] = [];
    let o = 0;
    for (const sg of segs) {
      offs.push(o);
      o += sg.length + 1;
    }
    // per segment: the last digit segment (with a valid end) of the chain of non-empty segments that follows it
    const lastDigit = new Array<number>(segs.length).fill(-1);
    for (let j = segs.length - 1, best = -1; j >= 0; j--) {
      if (segs[j] === '') {
        best = -1;
        continue;
      }
      lastDigit[j] = best; // the furthest valid digit segment strictly after j within the chain (greedy)
      if (best === -1 && /\d/.test(segs[j]!) && (j < segs.length - 1 || endOkLast)) best = j;
    }
    for (let i = 0; i < segs.length; ) {
      const j = lastDigit[i]!;
      if ((i > 0 || startOk0) && /^[A-Z]{2,}$/.test(segs[i]!) && j > i) {
        out.push({ start: at + offs[i]!, end: at + offs[j]! + segs[j]!.length });
        i = j + 1;
      } else i++;
    }
  }
  return out;
}

export function explicitIds(text: string): string[] {
  return explicitIdSpans(text).map((x) => text.slice(x.start, x.end));
}

export interface SupersedeRules {
  cues: RegExp;
  additive: RegExp;
  minOverlap: number;
  /** stop words and cue words, lower case */
  ignore: ReadonlySet<string>;
}

/** The rule set of ledger.* (regexes compiled with flags 'iu', as the config documents). */
export function supersedeRules(ledger: Config['ledger']): SupersedeRules {
  const compile = (src: string, what: string): RegExp => {
    try {
      return new RegExp(src, 'iu');
    } catch (e) {
      throw new Error(`ledger.${what} is not a valid regular expression: ${(e as Error).message}`);
    }
  };
  const ignore = new Set<string>();
  for (const w of [...ENGLISH_STOP_WORDS, ...HEBREW_STOP_WORDS, ...CUE_WORDS, ...ledger.stopWords]) ignore.add(w.toLowerCase());
  return {
    cues: compile(ledger.correctionCues, 'correctionCues'),
    additive: compile(ledger.additiveCues, 'additiveCues'),
    minOverlap: ledger.correctionMinOverlap,
    ignore,
  };
}

/**
 * Quoted spans: straight / curly / low-9 / guillemet double quotes, backticks, and single quotes that open after a
 * non-letter and close before one (so the apostrophes of "don't" and "users'" never pair up; neither does the
 * Hebrew acronym quote of צה"ל). Compile with 'gu'.
 */
const QUOTED_SOURCE =
  '(?<![\\p{L}\\p{N}])(?:"[^"\\n]*"|\u201c[^\u201d\\n]*\u201d|\u201e[^\u201c\u201d\\n]*[\u201c\u201d]|\u00ab[^\u00bb\\n]*\u00bb|`[^`\\n]*`|\'[^\'\\n]*\'|\u2018[^\u2019\\n]*\u2019)(?![\\p{L}\\p{N}])';
/** Opening quote → the closing quotes that end it (the low-9 quote closes with either curly double quote). */
const QUOTE_PAIRS: Record<string, string> = {
  '"': '"', '\u201c': '\u201d', '\u201e': '\u201c\u201d', '\u00ab': '\u00bb', '`': '`', "'": "'", '\u2018': '\u2019',
};
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Replaces every quoted span (QUOTED_SOURCE semantics: opener after a non-letter/digit, closer on the same line
 * before a non-letter/digit, leftmost first) by one space, in linear time. The regex form backtracks
 * quadratically on long runs of unclosed quotes (e.g. 20k "\u201c" took 4.6 s), so the next closer position per quote
 * type is cached: a search that found nothing up to the end of the line stays valid for later openers on that line.
 */
export function stripQuoted(s: string): string {
  const isWordAt = (i: number): boolean => i >= 0 && i < s.length && WORD_CHAR.test(String.fromCodePoint(s.codePointAt(i)!));
  const wordBefore = (i: number): boolean => {
    if (i <= 0) return false;
    const c = s.charCodeAt(i - 1);
    return isWordAt(c >= 0xdc00 && c <= 0xdfff && i >= 2 ? i - 2 : i - 1);
  };
  // closer set -> first closer index after the last searched opener on line `lineEnd` (-1 = none on that line)
  const cache = new Map<string, { lineEnd: number; at: number }>();
  let out = '';
  let last = 0;
  let i = 0;
  let lineEnd = -1; // index of the newline ending the line that contains i (or s.length)
  while (i < s.length) {
    const closers = QUOTE_PAIRS[s[i]!];
    if (closers === undefined || wordBefore(i)) { i++; continue; }
    if (i >= lineEnd || lineEnd === -1) {
      lineEnd = s.indexOf('\n', i + 1);
      if (lineEnd < 0) lineEnd = s.length;
    }
    const c = cache.get(closers);
    let j: number;
    if (c && c.lineEnd === lineEnd && (c.at === -1 || c.at > i)) j = c.at;
    else {
      j = -1;
      for (let k = i + 1; k < lineEnd; k++) if (closers.includes(s[k]!)) { j = k; break; }
      cache.set(closers, { lineEnd, at: j });
    }
    // like QUOTED_SOURCE: [^q\n]* stops at the FIRST closer; the match fails if a letter/digit follows it
    if (j !== -1 && !isWordAt(j + 1)) {
      out += s.slice(last, i) + ' ';
      i = j + 1;
      last = i;
    } else i++;
  }
  return last === 0 ? s : out + s.slice(last);
}

/** A sentence that ends in a question mark (ASCII, full-width, Arabic), before closing quotes / brackets / emphasis. */
const QUESTION_END = /[?\uff1f\u061f][\s"'`\u201d\u2019\u00bb)\]*_]*$/u;

/**
 * English discourse cues that also open plain status reports: "Actually, the tests passed now.", "Actually that
 * worked!", "I no longer see the error.", "The flaky spec does not fail anymore." A sentence whose only cues are
 * these cues a correction only when it also carries a directive word (below).
 */
const WEAK_CUE = /^(?:actually|no longer|not\b[\s\S]*\banymore|בעצם)$/i;
/**
 * Directive words: an instruction ("Actually, use staging-4", "skip firefox", "we no longer need 2 workers",
 * "the network mock is not needed anymore", "we are not using the old page object anymore") rather than a report.
 */
const DIRECTIVE =
  /\b(?:use[sd]?|using|run|running|keep|set|switch|skip|stop|start|don'?t|do not|never|always|only|should|must|need(?:s|ed)?|please|let'?s|go with|make|change|target|prefer|avoid|try|add|remove|drop|put|move|pick|choose|instead|rather|leave|turn|disable|enable|want(?:s|ed)?|required?|allowed?)\b|(?<![\p{L}\p{N}])(?:תשתמש|השתמש|להשתמש|תריץ|הרץ|להריץ|אל|תמיד|רק|צריך|צריכה|חייב|חייבת|במקום|תעבור|עבור ל|תשאיר|תוסיף|תוריד|תדלג|נא|בבקשה)(?![\p{L}\p{N}])/iu;

/**
 * True when sentence `s` cues a correction (DESIGN §6.1) under the rules' cue pattern, with three exclusions that
 * keep the rule erring towards missing ('s intent: a false supersession deletes a priority-1 rule):
 *   - a question never cues ("Why did you use staging-4 instead of staging-3?" asks, it does not correct);
 *   - a cue word inside quotation marks does not count (`The linter prints "use getByRole instead" …` reports
 *     someone else's words);
 *   - a status report never cues: a sentence whose only cues are the discourse cues `actually`, `no longer` or
 *     `not … anymore` and that has no directive word ("Actually, the tests passed now." would otherwise delete
 *     "Run the tests after each change." on the shared word "tests").
 * A missed correction only leaves the older instruction visible next to the newer one.
 */
export function cues(s: string, rules: SupersedeRules): boolean {
  if (QUESTION_END.test(s)) return false;
  const bare = /["'`\u201c\u201e\u00ab\u2018]/.test(s) ? stripQuoted(s) : s;
  if (!rules.cues.test(bare)) return false;
  if (DIRECTIVE.test(bare)) return true;
  const all = new RegExp(rules.cues.source, rules.cues.flags.includes('g') ? rules.cues.flags : rules.cues.flags + 'g');
  for (const m of bare.matchAll(all)) {
    if (m[0].length === 0) continue;
    if (!WEAK_CUE.test(m[0].trim())) return true;
  }
  return false;
}

/** Content words: lower-cased runs of 3+ letters/digits, minus stop and cue words, minus explicit-ID tokens. */
export function contentWords(text: string, ignore: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  let t = text;
  const spans = explicitIdSpans(text);
  if (spans.length) {
    t = '';
    let last = 0;
    for (const x of spans) {
      t += text.slice(last, x.start) + ' ';
      last = x.end;
    }
    t += text.slice(last);
  }
  for (const m of t.matchAll(/[\p{L}\p{N}]{3,}/gu)) {
    const w = m[0].toLowerCase();
    if (!ignore.has(w)) out.add(w);
  }
  return out;
}

/** |A∩B| / min(|A|,|B|); 0 when either is empty. */
export function overlapCoefficient(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const small = a.size <= b.size ? a : b;
  const large = small === a ? b : a;
  let n = 0;
  for (const w of small) if (large.has(w)) n++;
  return n / small.size;
}

export interface UserText {
  /** original message index */
  index: number;
  text: string;
  /** a head message: can be matched (amends the task) but never superseded */
  head: boolean;
}

export interface SentenceStatus {
  sentence: Sentence;
  /** message indices that superseded this sentence (one in practice; ID matches may name several sentences) */
  supersededBy: number | null;
}

export interface SupersedeEvent {
  /** message index of the correcting sentence */
  by: number;
  /** message index and sentence ordinal of the superseded one (for 'amends', the head sentence matched) */
  target: number;
  sentence: number;
  rule: 'id' | 'overlap' | 'amends';
  score: number;
}

export interface SupersedeResult {
  /** per non-head message index: its sentences and their status */
  sentences: Map<number, SentenceStatus[]>;
  /** messages whose best match was a head sentence: rendered with "(amends the task)" */
  amends: Set<number>;
  events: SupersedeEvent[];
}

/** A sentence compared for verbatim repeats: case, runs of whitespace and trailing punctuation ignored. */
const normSentence = (t: string): string => {
  const x = t.toLowerCase().replace(/\s+/g, ' ');
  // a loop, not /[\s.!?;:,]+$/: that regex is quadratic on a long run of punctuation inside the sentence
  let e = x.length;
  while (e > 0 && ' .!?;:,'.includes(x[e - 1]!)) e--;
  return x.slice(0, e).trim();
};

/** The rule-independent part of one sentence's analysis (a pure function of the text and the rules). */
interface SentenceInfo {
  sentence: Sentence;
  ids: string[];
  words: Set<string>;
  /** normSentence(text), for verbatim repeats */
  norm: string;
}

/**
 * Sentence analyses per rule set, keyed by message text and bounded by total characters. Every ledger build
 * re-runs supersession over all user texts of H[0..b); without this, each build re-split and re-scanned every
 * user message (a 300k-character goal dominated compaction steps).
 */
class SentenceCache {
  private readonly m = new Map<string, readonly SentenceInfo[]>();
  private chars = 0;
  constructor(private readonly maxChars: number) {}
  get(text: string, rules: SupersedeRules): readonly SentenceInfo[] {
    let v = this.m.get(text);
    if (v !== undefined) return v;
    v = splitSentences(text).map((sentence) => ({ sentence, ids: explicitIds(sentence.text), words: contentWords(sentence.text, rules.ignore), norm: normSentence(sentence.text) }));
    this.m.set(text, v);
    this.chars += text.length;
    while (this.m.size > 1 && this.chars > this.maxChars) {
      const k = this.m.keys().next().value as string;
      this.m.delete(k);
      this.chars -= k.length;
    }
    return v;
  }
}
// Keyed by the ignore set's content (the only rule input of the analysis), so that engines built from equal
// configs share it, like the counter caches.
const cacheKeys = new WeakMap<SupersedeRules, string>();
const sentenceCaches = new Map<string, SentenceCache>();
function analyse(text: string, rules: SupersedeRules): readonly SentenceInfo[] {
  let key = cacheKeys.get(rules);
  if (key === undefined) {
    key = [...rules.ignore].sort().join('\u0000');
    cacheKeys.set(rules, key);
  }
  let c = sentenceCaches.get(key);
  if (!c) {
    if (sentenceCaches.size >= 4) sentenceCaches.delete(sentenceCaches.keys().next().value as string);
    c = new SentenceCache(16 * 1024 * 1024);
    sentenceCaches.set(key, c);
  }
  return c.get(text, rules);
}

interface Candidate {
  index: number;
  ord: number;
  head: boolean;
  ids: string[];
  words: Set<string>;
  norm: string;
  status: SentenceStatus;
}

/**
 * Runs the §6.1 rule over the user texts in order (head messages first). Each cued sentence of message j (see
 * `cues`: questions and quoted cue words do not cue) considers the non-superseded sentences of strictly earlier
 * messages:
 *   1. every such sentence that shares an explicit ID (one not occurring in the head) is superseded;
 *   2. otherwise, an additive sentence supersedes nothing;
 *   3. otherwise the sentence with the highest overlap coefficient (ties: the newest) is superseded when the
 *      coefficient reaches minOverlap, together with its verbatim repeats in earlier messages (the same rule pasted
 *      twice); if it is a head sentence nothing is removed and j "amends the task".
 */
export function supersede(msgs: readonly UserText[], rules: SupersedeRules, headIds: ReadonlySet<string>): SupersedeResult {
  const pool: Candidate[] = [];
  /** normSentence -> the pool sentences with that text (verbatim repeats) */
  const byNorm = new Map<string, Candidate[]>();
  /** content word -> pool positions of the sentences that contain it (ascending) */
  const index = new Map<string, number[]>();
  let indexed = 0;
  const sentences = new Map<number, SentenceStatus[]>();
  const amends = new Set<number>();
  const events: SupersedeEvent[] = [];
  for (const msg of msgs) {
    const own: Candidate[] = analyse(msg.text, rules).map((a, ord) => ({
      index: msg.index,
      ord,
      head: msg.head,
      ids: a.ids,
      words: a.words,
      norm: a.norm,
      status: { sentence: a.sentence, supersededBy: null },
    }));
    if (!msg.head) {
      sentences.set(msg.index, own.map((c) => c.status));
      for (const c of own) {
        const text = c.status.sentence.text;
        if (!cues(text, rules)) continue;
        const ids = c.ids.filter((id) => !headIds.has(id));
        if (ids.length > 0) {
          const hit = pool.filter((p) => !p.head && p.status.supersededBy === null && p.ids.some((x) => ids.includes(x)));
          if (hit.length > 0) {
            for (const p of hit) {
              p.status.supersededBy = msg.index;
              events.push({ by: msg.index, target: p.index, sentence: p.ord, rule: 'id', score: 1 });
            }
            continue;
          }
        }
        if (rules.additive.test(text)) continue;
        let best: Candidate | null = null;
        let bestScore = -1;
        if (rules.minOverlap > 0) {
          // only sentences sharing a content word can reach a positive threshold: visit those through the index
          // (the same choice as the full scan: the highest coefficient, ties to the newest)
          // index the pool lazily (most ledgers have no cued sentence at all), in pool order
          for (; indexed < pool.length; indexed++) {
            for (const w of pool[indexed]!.words) {
              const l = index.get(w);
              if (l) l.push(indexed);
              else index.set(w, [indexed]);
            }
          }
          let bestAt = -1;
          const seen = new Set<number>();
          for (const w of c.words) {
            for (const at of index.get(w) ?? []) {
              if (seen.has(at)) continue;
              seen.add(at);
              const p = pool[at]!;
              if (p.status.supersededBy !== null) continue;
              const s = overlapCoefficient(p.words, c.words);
              if (s >= rules.minOverlap && (s > bestScore || (s === bestScore && at > bestAt))) {
                best = p;
                bestScore = s;
                bestAt = at;
              }
            }
          }
        } else {
          for (const p of pool) {
            if (p.status.supersededBy !== null) continue;
            const s = overlapCoefficient(p.words, c.words);
            if (s >= rules.minOverlap && s >= bestScore) {
              best = p;
              bestScore = s; // >= : ties go to the newest (pool is in message order)
            }
          }
        }
        if (best === null) continue;
        if (best.head) {
          amends.add(msg.index);
          events.push({ by: msg.index, target: best.index, sentence: best.ord, rule: 'amends', score: bestScore });
        } else {
          best.status.supersededBy = msg.index;
          events.push({ by: msg.index, target: best.index, sentence: best.ord, rule: 'overlap', score: bestScore });
          // verbatim repeats of the superseded sentence are the same instruction: a rule the user pasted twice and
          // then corrected must not survive in its older copy (ties go to the newest, which left the first copy
          // visible next to the correction)
          for (const p of byNorm.get(best.norm) ?? []) {
            if (p === best || p.head || p.status.supersededBy !== null) continue;
            p.status.supersededBy = msg.index;
            events.push({ by: msg.index, target: p.index, sentence: p.ord, rule: 'overlap', score: bestScore });
          }
        }
      }
    }
    pool.push(...own);
    for (const c of own) {
      const l = byNorm.get(c.norm);
      if (l) l.push(c);
      else byNorm.set(c.norm, [c]);
    }
  }
  return { sentences, amends, events };
}
