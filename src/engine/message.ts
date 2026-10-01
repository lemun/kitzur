// Chat message helpers shared by the engine modules. Messages are treated as immutable: every
// helper that "changes" a message returns a shallow copy that keeps the original key order.
import type { ChatMessage, ContentPart, TextPart, ToolCall } from '../types.js';

/** The message role as a string ('' when missing or not a string). */
export const roleOf = (m: ChatMessage | undefined): string => (m && typeof m.role === 'string' ? m.role : '');

/** Roles that start a unit (DESIGN §5.1, ); every other role attaches to the previous unit. */
export const isUnitStart = (m: ChatMessage): boolean => {
  const r = roleOf(m);
  return r === 'assistant' || r === 'user' || r === 'system' || r === 'developer';
};

/** A tool result (the legacy `function` role included). */
export const isToolResult = (m: ChatMessage): boolean => {
  const r = roleOf(m);
  return r === 'tool' || r === 'function';
};

export const toolCallsOf = (m: ChatMessage): ToolCall[] =>
  Array.isArray(m.tool_calls) ? (m.tool_calls.filter((c) => typeof c === 'object' && c !== null) as ToolCall[]) : [];

export const hasToolCalls = (m: ChatMessage): boolean => Array.isArray(m.tool_calls) && m.tool_calls.length > 0;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export const isTextPart = (p: unknown): p is TextPart => isObj(p) && p['type'] === 'text' && typeof p['text'] === 'string';

/** Image-like parts (never tokenized; replaced by rung R4). */
export const isImagePart = (p: unknown): boolean =>
  isObj(p) && (p['type'] === 'image_url' || p['type'] === 'input_image' || p['type'] === 'image');

/** Visible text of a message: string content as is, array content = its text parts joined with "\n". */
export function contentText(m: ChatMessage): string {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    let out = '';
    let first = true;
    for (const p of c) {
      if (!isTextPart(p)) continue;
      out += (first ? '' : '\n') + p.text;
      first = false;
    }
    return out;
  }
  return '';
}

/** The first text part (the whole string for string content); '' when there is none. */
export function firstText(m: ChatMessage): string {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) for (const p of c) if (isTextPart(p)) return p.text;
  return '';
}

/** Reasoning text of an assistant (reasoning_content and/or reasoning). */
export function reasoningText(m: ChatMessage): string {
  let s = '';
  if (typeof m.reasoning_content === 'string') s += m.reasoning_content;
  if (typeof m.reasoning === 'string') s += (s ? '\n' : '') + m.reasoning;
  return s;
}

export const hasReasoning = (m: ChatMessage): boolean =>
  (typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0) ||
  (typeof m.reasoning === 'string' && m.reasoning.length > 0);

/** Copy with `content` replaced (key position kept when present). */
export function withContent(m: ChatMessage, content: ChatMessage['content']): ChatMessage {
  return { ...m, content };
}

/**
 * Copy without `reasoning_content` / `reasoning` (other keys in their original order). The copy is made
 * by spreading, which defines own data properties: an assignment `out[k] = m[k]` would turn a client's own
 * `"__proto__"` key (JSON.parse keeps it as an own property) into the copy's prototype, dropping the field
 * from the forwarded message and making its contents (e.g. `tool_calls`) visible as inherited properties.
 */
export function withoutReasoning(m: ChatMessage): ChatMessage {
  const out: ChatMessage = { ...m };
  delete out['reasoning_content'];
  delete out['reasoning'];
  return out;
}

/** Copy with the given tool calls. */
export function withToolCalls(m: ChatMessage, calls: ToolCall[]): ChatMessage {
  return { ...m, tool_calls: calls };
}

/** Text parts of array content with their positions. */
export function textParts(content: ContentPart[]): Array<{ index: number; text: string }> {
  const out: Array<{ index: number; text: string }> = [];
  content.forEach((p, index) => {
    if (isTextPart(p)) out.push({ index, text: p.text });
  });
  return out;
}

/** Number of image parts in the content. */
export function imageCount(m: ChatMessage): number {
  const c = m.content;
  if (!Array.isArray(c)) return 0;
  let n = 0;
  for (const p of c) if (isImagePart(p)) n++;
  return n;
}
