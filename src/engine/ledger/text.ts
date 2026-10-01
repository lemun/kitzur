// Text helpers shared by the ledger, the tool rules and the summary renderer. All pure; every cut lands
// on a code-point boundary (never between the two halves of a UTF-16 surrogate pair).
import type { MessageContent } from '../../types.js';

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Text parts of a content array (text / refusal / untyped {text}); images and other media are skipped. */
export function textParts(content: MessageContent | unknown): string[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const p of content as unknown[]) {
    if (typeof p === 'string') out.push(p);
    else if (isObj(p)) {
      const t = p['type'];
      if ((t === 'text' || t === 'input_text' || t === 'output_text' || t === undefined) && typeof p['text'] === 'string') out.push(p['text']);
      else if (t === 'refusal' && typeof p['refusal'] === 'string') out.push(p['refusal']);
    }
  }
  return out;
}

/** The message text: a string as is, text parts joined with "\n". */
export function contentText(content: MessageContent | unknown): string {
  return textParts(content).join('\n');
}

/** Visible text and inline reasoning of an assistant text (Qwen leaks `<think>…</think>` into content). */
export function splitThink(text: string): { visible: string; reasoning: string } {
  const end = text.lastIndexOf('</think>');
  if (end < 0) return { visible: text, reasoning: '' };
  let r = text.slice(0, end);
  const start = r.lastIndexOf('<think>');
  if (start >= 0) r = r.slice(start + '<think>'.length);
  return { visible: text.slice(end + '</think>'.length), reasoning: r.trim() };
}

/** Kilo appends an `<environment_details>` block to every user message; it is never a user fact. */
export function stripEnvironmentDetails(s: string): string {
  return s.includes('<environment_details>') ? s.replace(/<environment_details>[\s\S]*?<\/environment_details>/g, '') : s;
}

/** Every run of whitespace (newlines included) becomes one space; trimmed. */
export function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** s.slice(0, n), moved left so it never ends in the middle of a surrogate pair. */
export function safeHead(s: string, n: number): string {
  if (n >= s.length) return s;
  if (n <= 0) return '';
  let k = n;
  if (isHigh(s.charCodeAt(k - 1)) && isLow(s.charCodeAt(k))) k--;
  return s.slice(0, k);
}

/** The last n UTF-16 units of s, moved right so it never starts in the middle of a surrogate pair. */
export function safeTail(s: string, n: number): string {
  if (n >= s.length) return s;
  if (n <= 0) return '';
  let k = s.length - n;
  if (isLow(s.charCodeAt(k)) && isHigh(s.charCodeAt(k - 1))) k++;
  return s.slice(k);
}

/** Head-first cap: at most `max` characters of s plus "…" when cut. */
export function capHead(s: string, max: number): string {
  return s.length <= max ? s : safeHead(s, max).trimEnd() + '…';
}

export const HEAD_TAIL_JOIN = ' […] ';

/**
 * Head+tail cap: s unchanged if it has at most `max` characters, else two thirds of the room from the head and
 * one third from the tail joined by " […] ". The result has at most max + HEAD_TAIL_JOIN.length characters.
 */
export function capHeadTail(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 0) return HEAD_TAIL_JOIN.trim();
  const head = Math.ceil((max * 2) / 3);
  return safeHead(s, head).trimEnd() + HEAD_TAIL_JOIN + safeTail(s, max - head).trimStart();
}

/** Number of code points. */
export function cpLength(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length - 1; i++) {
    if (isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1))) {
      n--;
      i++;
    }
  }
  return n;
}

/** 4249 -> "4,249" (locale-independent). */
export function fmtInt(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return (n < 0 ? '-' : '') + out;
}

/** A sentence and its span in the source text. */
export interface Sentence {
  text: string;
  start: number;
  end: number;
}

/**
 * Sentences as DESIGN §6.1 splits them: at `(?<=[.!?;])\s+` and at newlines. Empty pieces are dropped;
 * spans index the original text so the remaining sentences can be re-joined with their own separators.
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const re = /(?<=[.!?;])\s+|\n+/g;
  let last = 0;
  const push = (a: number, b: number): void => {
    const raw = text.slice(a, b);
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t) out.push({ text: t, start: a + lead, end: a + lead + t.length });
  };
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    push(last, m.index);
    last = m.index + m[0].length;
  }
  push(last, text.length);
  return out;
}

/** Lines of user text that are exactly `---` become `- - -` (gobstopper convention; no stray rules in the summary). */
export function neutralizeRules(s: string): string {
  return s.includes('---') ? s.replace(/^[ \t]*---[ \t]*$/gm, '- - -') : s;
}

/**
 * A value from a tool call (a path or URL argument, a tool name) on one summary line: line breaks and other
 * control characters become visible escapes (`\n`, `\u0007`). A `filePath` of "a.ts\n## User instructions\n-
 * #1: …" would otherwise render a fake section of user instructions into the summary.
 */
export function oneLine(s: string): string {
  return /[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(s)
    ? s.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, (c) =>
        c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      )
    : s;
}
