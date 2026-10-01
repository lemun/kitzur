// Message-level rewrites of DESIGN.md (R3–R5, R8), §5.5a and §5.6: slim a snapshot result
// (through the injected ToolRules), truncate text head+tail (array content: text parts only, largest
// first), omit images, drop reasoning, and cut an assistant's content and tool-call argument strings
// (arguments stay valid JSON, key order kept). Every function returns a NEW message computed from the
// message it is given; callers pass the original message () and keep a result only if it is
// strictly smaller (messageSize).
import type { ChatMessage, ContentPart, TextPart, ToolCall } from '../types.js';
import type { ToolRules } from './contracts.js';
import { parsePyJson, pyDumps, PyFloat, type PyValue } from '../tokenize/pyjson.js';
import { contentText, isImagePart, isTextPart, reasoningText, toolCallsOf, withContent, withoutReasoning } from './message.js';
import { savedPathOf, truncateHeadTail } from './text.js';

/** Text part that replaces an omitted image (R4). */
export const IMAGE_OMITTED = '[kitzur: image omitted to fit the context window]';

export interface OpsEnv {
  /** tokens of plain text (the engine's counter, cached) */
  text: (s: string) => number;
  /** oversize.headShare */
  headShare: number;
  /** tokenizer.imageTokens */
  imageTokens: number;
}

/**
 * Context-free size of a message in tokens: its content text, reasoning, tool-call names and argument
 * strings, plus imageTokens per image. Used for the "strictly smaller" rule (§5.6, ) and to order
 * candidates; the prompt count of a candidate is always measured by the counter.
 */
export function messageSize(m: ChatMessage, env: OpsEnv): number {
  let n = 0;
  const c = m.content;
  if (typeof c === 'string') n += env.text(c);
  else if (Array.isArray(c)) {
    for (const p of c) {
      if (isTextPart(p)) n += env.text(p.text);
      else if (isImagePart(p)) n += env.imageTokens;
    }
  }
  const r = reasoningText(m);
  if (r) n += env.text(r);
  for (const call of toolCallsOf(m)) {
    const f = call.function;
    if (f && typeof f.name === 'string') n += env.text(f.name);
    if (f && typeof f.arguments === 'string') n += env.text(f.arguments);
  }
  return n;
}

/** Content tokens of a tool result or user message (text parts + images). */
export function contentTokens(m: ChatMessage, env: OpsEnv): number {
  const c = m.content;
  if (typeof c === 'string') return env.text(c);
  if (!Array.isArray(c)) return 0;
  let n = 0;
  for (const p of c) {
    if (isTextPart(p)) n += env.text(p.text);
    else if (isImagePart(p)) n += env.imageTokens;
  }
  return n;
}

export interface TextEdit {
  message: ChatMessage;
  /** at least one text was cut to the marker alone */
  markerOnly: boolean;
}

/**
 * Truncates the text of `m` head+tail so that its content tokens drop by at least `over` (to
 * `content − over`). String content is cut as a whole; array content in its text parts only, largest
 * first (ties: lower index), leaving images alone. Returns null when nothing could be cut.
 */
export function truncateText(m: ChatMessage, over: number, env: OpsEnv): TextEdit | null {
  if (over <= 0) return null;
  const c = m.content;
  const savedPath = savedPathOf(contentText(m));
  if (typeof c === 'string') {
    const t = env.text(c);
    const r = truncateHeadTail(c, t - over, env.text, { headShare: env.headShare, savedPath });
    if (!r || r.tokens >= t) return null;
    return { message: withContent(m, r.text), markerOnly: r.markerOnly };
  }
  if (!Array.isArray(c)) return null;
  const parts = c.map((p, index) => ({ index, p, tokens: isTextPart(p) ? env.text(p.text) : 0 }));
  const order = parts.filter((x) => isTextPart(x.p)).sort((a, b) => b.tokens - a.tokens || a.index - b.index);
  const next: ContentPart[] = c.slice();
  let left = over;
  let changed = false;
  let markerOnly = false;
  for (const x of order) {
    if (left <= 0) break;
    const tp = x.p as TextPart;
    const r = truncateHeadTail(tp.text, x.tokens - left, env.text, { headShare: env.headShare, savedPath });
    if (!r || r.tokens >= x.tokens) continue;
    next[x.index] = { ...tp, text: r.text };
    left -= x.tokens - r.tokens;
    changed = true;
    markerOnly ||= r.markerOnly;
  }
  return changed ? { message: withContent(m, next), markerOnly } : null;
}

/**
 * Slims a snapshot result (§5.6 step 1, ) through ToolRules.slimSnapshot to at most `maxTokens`
 * content tokens. Only string content (or the largest text part) is slimmed. Returns null when the
 * rules cannot get under maxTokens or the result would not be smaller.
 */
export function slimText(m: ChatMessage, maxTokens: number, rules: ToolRules, env: OpsEnv): ChatMessage | null {
  const c = m.content;
  if (typeof c === 'string') {
    const s = rules.slimSnapshot(c, maxTokens, env.text);
    if (s === null || env.text(s) >= env.text(c)) return null;
    return withContent(m, s);
  }
  if (!Array.isArray(c)) return null;
  let best = -1;
  let bestTokens = -1;
  c.forEach((p, i) => {
    if (!isTextPart(p)) return;
    const t = env.text(p.text);
    if (t > bestTokens) {
      best = i;
      bestTokens = t;
    }
  });
  if (best < 0) return null;
  const tp = c[best] as TextPart;
  const others = contentTokens(m, env) - bestTokens;
  const s = rules.slimSnapshot(tp.text, maxTokens - others, env.text);
  if (s === null || env.text(s) >= bestTokens) return null;
  const next = c.slice();
  next[best] = { ...tp, text: s };
  return withContent(m, next);
}

/** Replaces the first remaining image part of `m` with the IMAGE_OMITTED text part; null if none. */
export function omitOneImage(m: ChatMessage): ChatMessage | null {
  const c = m.content;
  if (!Array.isArray(c)) return null;
  const i = c.findIndex((p) => isImagePart(p));
  if (i < 0) return null;
  const next = c.slice();
  next[i] = { type: 'text', text: IMAGE_OMITTED };
  return withContent(m, next);
}

/** Image parts of `m` replaced where `from` (a rewrite of the same original) has them replaced. */
export function carryImageOmissions(orig: ChatMessage, from: ChatMessage): ChatMessage {
  const a = orig.content;
  const b = from.content;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return orig;
  let next: ContentPart[] | null = null;
  a.forEach((p, i) => {
    const q = b[i];
    if (isImagePart(p) && isTextPart(q) && q.text === IMAGE_OMITTED) {
      next ??= a.slice();
      next[i] = { type: 'text', text: IMAGE_OMITTED };
    }
  });
  return next ? withContent(orig, next) : orig;
}

/** The assistant without reasoning (kind 'reasoning'), or null when it has none. */
export function dropReasoning(m: ChatMessage): ChatMessage | null {
  if (!('reasoning_content' in m) && !('reasoning' in m)) return null;
  return withoutReasoning(m);
}

// ---------------------------------------------------------------- R5: assistant content and arguments

/**
 * Arguments nested deeper than this are left unchanged, like unparsable ones. The walk below, the re-serialization
 * and the counter's renderers recurse once per level, and a stack overflow would depend on the Node version's frame
 * sizes; a fixed cap keeps the cut deterministic (I5) and the step total.
 */
export const MAX_ARGS_DEPTH = 256;

/** Nesting depth of a parsed value (iterative: it must not overflow on the values it rejects). */
function depthOf(v: PyValue): number {
  let max = 0;
  const stack: Array<[PyValue, number]> = [[v, 0]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (d > max) max = d;
    if (max > MAX_ARGS_DEPTH) return max;
    if (Array.isArray(x)) for (const y of x) stack.push([y, d + 1]);
    else if (x instanceof Map) for (const y of x.values()) stack.push([y, d + 1]);
  }
  return max;
}

/** True when `v` holds a float that is not finite (it would not re-serialize as strict JSON). */
function hasNonFinite(v: PyValue): boolean {
  if (v instanceof PyFloat) return !Number.isFinite(v.value);
  if (typeof v === 'number') return !Number.isFinite(v);
  if (Array.isArray(v)) return v.some(hasNonFinite);
  if (v instanceof Map) {
    for (const x of v.values()) if (hasNonFinite(x)) return true;
  }
  return false;
}

interface Slot {
  text: string;
  tokens: number;
  /** stable order for ties: content first, then calls in order, then leaves in document order */
  order: number;
  set: (s: string) => void;
}

/**
 * R5 (§5.4): cuts the assistant's visible content head+tail and the string values inside its
 * tool-call arguments (parsed losslessly, cut, re-serialized compactly with key order kept) so that
 * its size drops by at least `over` tokens. Arguments that do not parse as JSON are left unchanged.
 * Reasoning is dropped too. Returns null when nothing changed.
 */
export function cutAssistant(m: ChatMessage, over: number, env: OpsEnv): ChatMessage | null {
  const base = withoutReasoning(m);
  const slots: Slot[] = [];
  let order = 0;
  let content: ChatMessage['content'] = base.content;
  if (typeof content === 'string' && content.length) {
    const t = content;
    slots.push({ text: t, tokens: env.text(t), order: order++, set: (s) => (content = s) });
  } else if (Array.isArray(content)) {
    const arr = content.slice();
    content = arr;
    arr.forEach((p, i) => {
      if (!isTextPart(p) || !p.text) return;
      slots.push({ text: p.text, tokens: env.text(p.text), order: order++, set: (s) => (arr[i] = { ...p, text: s }) });
    });
  }
  const calls = toolCallsOf(base);
  const parsed: Array<{ value: PyValue; dirty: boolean } | null> = calls.map((call) => {
    const a = call.function?.arguments;
    if (typeof a !== 'string' || !a) return null;
    try {
      const value = parsePyJson(a);
      // a number that is not a finite double (1e400, or Python's NaN/Infinity literals) would be re-serialized as
      // Infinity/NaN, which strict JSON parsers reject: such arguments are left unchanged, like unparsable ones
      return depthOf(value) > MAX_ARGS_DEPTH || hasNonFinite(value) ? null : { value, dirty: false };
    } catch {
      return null;
    }
  });
  parsed.forEach((pv) => {
    if (!pv) return;
    const visit = (v: PyValue, set: (x: PyValue) => void): void => {
      if (typeof v === 'string') {
        if (v.length) slots.push({ text: v, tokens: env.text(v), order: order++, set: (s) => { set(s); pv.dirty = true; } });
      } else if (Array.isArray(v)) {
        v.forEach((x, i) => visit(x, (y) => (v[i] = y)));
      } else if (v instanceof Map) {
        for (const [k, x] of v) visit(x, (y) => v.set(k, y));
      }
    };
    visit(pv.value, (y) => (pv.value = y));
  });
  slots.sort((a, b) => b.tokens - a.tokens || a.order - b.order);
  let left = over;
  let changed = false;
  for (const s of slots) {
    if (left <= 0) break;
    const r = truncateHeadTail(s.text, s.tokens - left, env.text, { headShare: env.headShare, savedPath: null });
    if (!r || r.tokens >= s.tokens) continue;
    s.set(r.text);
    left -= s.tokens - r.tokens;
    changed = true;
  }
  if (!changed) return dropReasoning(m);
  const out: ChatMessage = { ...base, content };
  if (calls.length) {
    out.tool_calls = calls.map((call, ci): ToolCall => {
      const pv = parsed[ci];
      if (!pv || !pv.dirty) return call;
      return { ...call, function: { ...call.function, arguments: pyDumps(pv.value, { ensureAscii: false, separators: [',', ':'] }) } };
    });
  }
  return out;
}
