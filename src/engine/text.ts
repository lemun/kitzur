// Head+tail truncation of one text (DESIGN.md, ), code-point safe, with the exact marker.
//
// Cut sizes come from ONE count of the original (its chars-per-token ratio) and a proportional estimate
// of the kept head and tail; one verification count follows, and when the result is over the room both
// parts shrink by the overshoot converted at the same ratio, at most 3 times. No binary search over
// counts (a 180k-character output would cost hundreds of milliseconds). The cut is a pure function of
// (text, room, headShare, marker), so it is deterministic.

/** 180000 -> "180,000" (en-US grouping, no Intl dependency). */
export function fmtInt(n: number): string {
  const s = String(Math.trunc(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return (n < 0 ? '-' : '') + out;
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

const PAIR_RE = /[\ud800-\udbff][\udc00-\udfff]/g;

/** Number of code points (a lone surrogate counts as one). */
export function codePointLength(s: string): number {
  if (!/[\ud800-\udbff]/.test(s)) return s.length;
  return s.length - (s.match(PAIR_RE)?.length ?? 0);
}

/** A head cut [0, i): moved left when it would split a surrogate pair. */
export function headCut(s: string, i: number): number {
  if (i <= 0) return 0;
  if (i >= s.length) return s.length;
  return isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i)) ? i - 1 : i;
}

/** A tail cut [i, len): moved right when it would split a surrogate pair. */
export function tailCut(s: string, i: number): number {
  if (i <= 0) return 0;
  if (i >= s.length) return s.length;
  return isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i)) ? i + 1 : i;
}

const SAVED_RE = /Full output saved to: ([^\n]+)/;

/**
 * Longest saved-output path the marker repeats (Linux PATH_MAX). The marker is kept even when nothing else of the
 * output fits, so a longer "path" (a hostile or garbled line) would make the output impossible to truncate.
 */
export const MAX_SAVED_PATH_CHARS = 4096;

/** OpenCode's `Full output saved to: <path>` notice (§5.6), or null (also for a path over MAX_SAVED_PATH_CHARS). */
export function savedPathOf(text: string): string | null {
  const m = SAVED_RE.exec(text);
  const p = m?.[1]?.trim();
  return p && p.length <= MAX_SAVED_PATH_CHARS ? p : null;
}

/** The §5.6 marker. `savedPath` (OpenCode's saved output) replaces the re-run advice. */
export function truncationMarker(keptHead: number, keptTail: number, total: number, savedPath: string | null): string {
  return (
    `[kitzur: this output was truncated to fit the model's context window: kept the first ${fmtInt(keptHead)} and ` +
    `the last ${fmtInt(keptTail)} of ${fmtInt(total)} characters. The middle is not visible to you. ` +
    (savedPath
      ? `The full output is saved at ${savedPath}; use grep, or Read with offset/limit, on that file to see it.]`
      : 'To see it, re-run the tool with narrower arguments (for example Read with offset/limit, grep, or a scoped snapshot).]')
  );
}

export interface CutOptions {
  /** share of the kept characters that goes to the head (oversize.headShare) */
  headShare: number;
  /** saved-output path for the marker (default: detected in the text) */
  savedPath?: string | null;
}

export interface CutResult {
  text: string;
  /** tokens of `text` (counted) */
  tokens: number;
  /** tokens of the original text */
  originalTokens: number;
  /** code points kept at the head / tail, and of the original */
  keptHead: number;
  keptTail: number;
  total: number;
  /** only the marker was kept (no positive room) */
  markerOnly: boolean;
}

/** Max corrections after the first verification count (). */
const MAX_CORRECTIONS = 3;
const SEP = '\n\n';

/**
 * Truncates `text` head+tail so that count(result) ≤ room, keeping the marker in the middle. Returns
 * null when the text already fits. When no positive room exists the result is the marker alone (which
 * may exceed the room). Cuts land on line boundaries when a newline is near, and never split a
 * surrogate pair.
 */
export function truncateHeadTail(text: string, room: number, count: (s: string) => number, opts: CutOptions): CutResult | null {
  const T = count(text);
  if (T <= room) return null;
  const total = codePointLength(text);
  const savedPath = opts.savedPath === undefined ? savedPathOf(text) : opts.savedPath;
  const markerOnly = (): CutResult => {
    const t = truncationMarker(0, 0, total, savedPath);
    return { text: t, tokens: count(t), originalTokens: T, keptHead: 0, keptTail: 0, total, markerOnly: true };
  };
  const len = text.length;
  const ratio = len / Math.max(1, T); // UTF-16 units per token
  // the marker's size barely depends on its numbers: measure it once with the widest ones
  const markerTokens = count(truncationMarker(total, total, total, savedPath)) + 2;
  let keep = Math.floor((room - markerTokens) * ratio);
  if (keep <= 0) return markerOnly();
  const share = Math.min(1, Math.max(0, opts.headShare));
  for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
    if (keep <= 0 || keep >= len) return keep <= 0 ? markerOnly() : null;
    const hc = Math.floor(keep * share);
    const tc = keep - hc;
    const headEnd = snapHead(text, hc);
    const tailStart = snapTail(text, len - tc, headEnd);
    const head = text.slice(0, headEnd);
    const tail = text.slice(tailStart);
    if (!head && !tail) return markerOnly();
    const kh = codePointLength(head);
    const kt = codePointLength(tail);
    const out = (head ? head + SEP : '') + truncationMarker(kh, kt, total, savedPath) + (tail ? SEP + tail : '');
    const n = count(out);
    if (n <= room) return { text: out, tokens: n, originalTokens: T, keptHead: kh, keptTail: kt, total, markerOnly: false };
    // shrink both parts by the overshoot at the same ratio (+10% and a line's worth, so it converges)
    keep -= Math.ceil((n - room) * ratio * 1.1) + 16;
  }
  return markerOnly();
}

/** End of the head part: the last newline at or before hc when it is within the last quarter. */
function snapHead(text: string, hc: number): number {
  if (hc <= 0) return 0;
  const j = text.lastIndexOf('\n', hc);
  if (j > 0 && j >= hc - Math.max(1, Math.floor(hc / 4))) return j;
  return headCut(text, hc);
}

/** Start of the tail part: just after the first newline at or after ts when within a quarter of the tail. */
function snapTail(text: string, ts: number, headEnd: number): number {
  const len = text.length;
  if (ts >= len) return len;
  const start = Math.max(ts, headEnd);
  const tc = len - start;
  const k = text.indexOf('\n', Math.max(0, start - 1));
  if (k >= 0 && k + 1 <= len && k + 1 - start <= Math.max(1, Math.floor(tc / 4))) return k + 1;
  return tailCut(text, start);
}
