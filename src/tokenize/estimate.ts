// Per-content-class token estimate (DESIGN.md fallback 2): chars / charsPerToken[class] x safetyFactor.
// Used when no tokenizer is available ('estimate' mode) and for text the tokenize endpoint has not
// counted yet ('remote' mode). Deterministic: the class is a pure function of the text.
import type { Config } from '../config/schema.js';
import { ONIG_L, ONIG_M } from './unicode-tables.js';

export type ContentClass = keyof Config['tokenizer']['fallback']['charsPerToken'];
export type CharsPerToken = Config['tokenizer']['fallback']['charsPerToken'];

export const CONTENT_CLASSES: readonly ContentClass[] = ['prose', 'code', 'snapshot', 'testOutput', 'json', 'snapshotNonLatin'];

// Letters of non-Latin scripts: U+0370 (Greek) and up. Latin-1/Extended letters count as Latin.
const NON_ASCII = /[^\u0000-\u007f]/;
const ASCII_LETTER = /[A-Za-z]/g;

export interface TextStats {
  /** UTF-16 length */
  chars: number;
  /** letters at U+0370 and above (non-Latin scripts) */
  nonLatinLetters: number;
  /** combining marks at U+0370 and above (niqqud, harakat, ...): about one token each */
  nonLatinMarks: number;
  /** all letters (ASCII + non-ASCII) */
  letters: number;
}

// Letters and marks from the pinned Unicode tables the tokenizer uses (unicode-tables.ts), not the runtime's
// /\p{L}/u: Node 20 and Node 26 ship different Unicode versions, and an estimate that changed with the Node binary
// would make a restarted proxy plan differently from the live one (I5) for text in newly assigned scripts.
const inRanges = (ranges: readonly number[], c: number): boolean => {
  let lo = 0;
  let hi = (ranges.length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c < ranges[2 * mid]!) hi = mid - 1;
    else if (c > ranges[2 * mid + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
};
export const isLetterCp = (c: number): boolean => inRanges(ONIG_L, c);
export const isMarkCp = (c: number): boolean => inRanges(ONIG_M, c);

export function textStats(text: string): TextStats {
  let asciiLetters = 0;
  ASCII_LETTER.lastIndex = 0;
  while (ASCII_LETTER.exec(text) !== null) asciiLetters++;
  let nonLatinLetters = 0;
  let nonLatinMarks = 0;
  let otherLetters = 0;
  if (NON_ASCII.test(text)) {
    for (let i = 0; i < text.length; i++) {
      let c = text.charCodeAt(i);
      if (c < 0x80) continue;
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
        const d = text.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      if (isLetterCp(c)) {
        if (c < 0x370) otherLetters++;
        else nonLatinLetters++;
      } else if (c >= 0x370 && isMarkCp(c)) nonLatinMarks++;
    }
  }
  return { chars: text.length, nonLatinLetters, nonLatinMarks, letters: asciiLetters + otherLetters + nonLatinLetters };
}

function countOf(text: string, needle: string, cap: number): number {
  let n = 0;
  for (let i = text.indexOf(needle); i >= 0 && n < cap; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

// The indentation class must not match line terminators: with /m, `^\s*` restarts at every line of a
// blank-line run and rescans the rest of it (quadratic: 40k newlines took 10 s).
const TEST_TALLY = /\b\d+ (?:passed|failed|skipped|flaky)\b|^[^\S\r\n\u2028\u2029]*Tests?:\s+\d|^Running \d+ tests? using|^(?:FAIL|PASS) \S/m;
// a line that is just a path (ls/glob/find output); grep's path:line: code lines are left to CODE_LINE
const PATH_LINE = /^\s*\.{0,2}\/?(?:[\w.@+-]+\/)+[\w.@+-]+\/?\s*$/;
const CODE_LINE =
  /^\s*(?:import|export|from|const|let|var|function|def|class|return|if|else|elif|for|while|async|await|public|private|protected|package|fn|use|type|interface|struct|enum|#include|#!|@\w+)\b|[;{}(]\s*$|^\s*(?:\/\/|\/\*|\*\/|\* |#\s)|^\s*[)}\]];?\s*$/;

/**
 * The content class of a text, in this order:
 * - snapshot: >= 10 `[ref=` markers and a Playwright header (`- Page Snapshot:` / `Page URL:`) or
 *   mostly YAML-list lines; snapshotNonLatin when >= 20% of its letters are non-Latin;
 * - testOutput: a test-runner tally or >= 3 ✓/✘ marks;
 * - json: starts with { or [ and parses, or is quote-dense with key syntax (truncated JSON);
 * - json also for path lists (ls/glob output: >= 50% of the lines are a bare path);
 * - code: >= 30% of the non-empty lines look like code;
 * - snapshotNonLatin for other text whose letters are >= 20% non-Latin (Hebrew UI/prose; there is
 *   no separate non-Latin prose ratio);
 * - prose otherwise.
 */
export function classifyContent(text: string, stats: TextStats = textStats(text)): ContentClass {
  const nonLatin = stats.letters > 0 && stats.nonLatinLetters / stats.letters >= 0.2;
  if (text.length === 0) return 'prose';
  const refs = countOf(text, '[ref=', 10);
  if (refs >= 10) {
    let header = text.includes('- Page Snapshot:') || text.includes('Page URL:');
    if (!header) {
      const lines = text.split('\n', 2000);
      const yaml = lines.filter((l) => /^\s*- /.test(l)).length;
      header = yaml >= lines.length * 0.5;
    }
    if (header) return nonLatin ? 'snapshotNonLatin' : 'snapshot';
  }
  if (TEST_TALLY.test(text) || countOf(text, '✓', 3) + countOf(text, '✘', 3) >= 3) return 'testOutput';
  const t = text.trim();
  const f = t[0];
  const l = t[t.length - 1];
  if (f === '{' || f === '[') {
    if ((l === '}' || l === ']') && t.length <= 4_000_000) {
      try {
        JSON.parse(t);
        return 'json';
      } catch {
        /* not JSON; maybe truncated JSON below */
      }
    }
    // truncated / JSON-lines payloads: quote-dense with key syntax
    if (countOf(t, '"', t.length) >= t.length * 0.05 && countOf(t, '":', 3) >= 3) return 'json';
  }
  const lines = text.split('\n', 4000);
  let nonEmpty = 0;
  let code = 0;
  let paths = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    nonEmpty++;
    if (PATH_LINE.test(line)) paths++;
    else if (CODE_LINE.test(line)) code++;
  }
  // ls/glob output: path lines tokenize like JSON (punctuation, digits), not like prose or code
  if (nonEmpty > 0 && paths >= nonEmpty * 0.5) return 'json';
  if (nonEmpty > 0 && code >= nonEmpty * 0.3) return 'code';
  if (nonLatin) return 'snapshotNonLatin';
  return 'prose';
}

/**
 * The matches, in order, of `/"(?:[^"\\\n]|\\.){40,}"/g` (a JSON string literal of >= 40 units: candidate prose
 * inside JSON), as [start, end) ranges, in linear time. The regex itself is quadratic: after a failed attempt it
 * retries at every escaped quote of the failed literal (40k `\"` took 11 s). A literal's units are determined from
 * its opening quote, and an attempt that starts at an escaped quote inside it continues on the same units, so it
 * ends where the outer attempt ended, with fewer units: it fails too, and the scan resumes at the end of the attempt.
 */
export function jsonProseStrings(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const n = text.length;
  let i = 0;
  for (;;) {
    const s = text.indexOf('"', i);
    if (s < 0) return out;
    let p = s + 1;
    let units = 0;
    for (;;) {
      if (p >= n) return out; // unterminated: no later quote can start a match either (they are all inside)
      const c = text.charCodeAt(p);
      if (c === 0x22) {
        if (units >= 40) {
          out.push([s, p + 1]);
          i = p + 1;
        } else i = p; // the closing quote may open the next literal
        break;
      }
      if (c === 0x0a) {
        i = p;
        break;
      }
      if (c === 0x5c) {
        const d = p + 1 < n ? text.charCodeAt(p + 1) : -1;
        // `\.`: `.` matches anything but a line terminator
        if (d < 0 || d === 0x0a || d === 0x0d || d === 0x2028 || d === 0x2029) {
          i = p;
          break;
        }
        p += 2;
      } else p++;
      units++;
    }
  }
}

/** Letters per token of non-Latin scripts on Qwen3.6 (measured: Hebrew 1.7, CJK 1.8, Arabic 3.0, Cyrillic 3.4). */
const NON_LATIN_LETTERS_PER_TOKEN = 1.6;

/**
 * Unrounded token estimate of content text (before the safety factor): chars at the class ratio,
 * non-Latin combining marks at ~1 token each, and, for mostly-Latin text that still contains
 * non-Latin letters (e.g. an English snapshot with Hebrew labels), those letters at no less than
 * 1/1.6 token each: the class ratio alone would cost them at ~1/3 token. In JSON, long string
 * literals with spaces are costed at the prose ratio.
 */
export function rawEstimate(text: string, cls: ContentClass, cpt: CharsPerToken, stats: TextStats = textStats(text)): number {
  const ratio = cpt[cls] > 0 ? cpt[cls] : 4;
  let chars = stats.chars;
  let raw = 0;
  if (cls === 'json') {
    // JSON with prose inside (tool schemas: long English descriptions) tokenizes like prose there:
    // long string literals containing spaces are costed at the prose ratio, the rest at the json ratio
    const prose = cpt.prose > 0 ? cpt.prose : 4;
    for (const [a, b] of jsonProseStrings(text)) {
      const sp = text.indexOf(' ', a);
      if (sp < 0 || sp >= b) continue;
      chars -= b - a;
      raw += (b - a) / prose;
    }
  }
  raw += chars / ratio + stats.nonLatinMarks * Math.max(0, 1 - 1 / ratio);
  if (cls !== 'snapshotNonLatin' && stats.nonLatinLetters > 0) {
    const L = stats.nonLatinLetters;
    const M = stats.nonLatinMarks;
    raw = Math.max(raw, (stats.chars - L - M) / ratio + L / NON_LATIN_LETTERS_PER_TOKEN + M);
  }
  return raw;
}

export interface EstimateOptions {
  charsPerToken: CharsPerToken;
  safetyFactor: number;
}

/** ceil(rawEstimate x safetyFactor) of one text, class chosen by classifyContent unless given. */
export function estimateText(text: string, opts: EstimateOptions, cls?: ContentClass): number {
  if (text.length === 0) return 0;
  const st = textStats(text);
  return Math.ceil(rawEstimate(text, cls ?? classifyContent(text, st), opts.charsPerToken, st) * opts.safetyFactor);
}
