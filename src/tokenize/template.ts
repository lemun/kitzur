// Chat-template profiles (DESIGN.md): render a Chat Completions request as the exact prompt text
// the server tokenizes, split into per-message pieces so that counts can be cached per message.
//
// Contract of a layout (for the additive profiles sim, qwen3, chatml):
//   prompt = prefix ++ message(0) ++ ... ++ message(n-1) ++ suffix          (byte-exact)
// and every piece boundary is next to an added token (<|im_start|>, </tool_response>, ...), except
// where noted, so count(prompt) = Σ count(piece) exactly: HF tokenizers split on added tokens first
// and count each segment independently (reference implementation). The counter re-checks every
// boundary and counts unsafe neighbours jointly, so exactness never depends on this assumption.
//
// A message's piece depends only on (the message, its render context `ctx[i]`, the profile options);
// `ctx[i]` is part of the counter's cache key. Merged segments (the tools block inside the first
// system message) belong to message 0; a tools block without a system message is `prefix` overhead.
import { createHash } from 'node:crypto';
import type { ChatMessage, ChatRequest } from '../types.js';
import type { ContentClass } from './estimate.js';
import { parsePyJson, pyDumps, pyFloatRepr, PyFloat, type PyValue } from './pyjson.js';

export type TemplateName = 'sim' | 'qwen3' | 'chatml' | 'generic';

/**
 * One span of a rendered piece. 'g' = template glue, 'c' = message content (its class is a hint for
 * the estimator), 'i' = image/video placeholder (counted as imageTokens, never tokenized),
 * 'x' = a fixed number of tokens with no text (the generic profile's per-message overhead).
 */
export interface Part {
  k: 'g' | 'c' | 'i' | 'x';
  s: string;
  cls?: ContentClass;
  n?: number;
}

/** A request the template itself rejects (the server answers 400). The engine forwards the original. */
export class TemplateError extends Error {
  readonly code = 'template_error';
  constructor(message: string, readonly index: number | null = null) {
    super(message);
    this.name = 'TemplateError';
  }
}

export interface RenderLayout {
  /** per-message render context (cache-key suffix); pieces with equal (message, ctx) are identical */
  readonly ctx: readonly string[];
  /** the piece of message i (may be empty, e.g. a system message whose text lives in the header) */
  message(i: number): Part[];
  /** overhead before the first message piece (a tools block when there is no system message) */
  readonly prefix: readonly Part[];
  /** cache key of the prefix ('' when empty) */
  readonly prefixKey: string;
  /** overhead after the last message piece (the generation prompt) */
  readonly suffix: readonly Part[];
}

export interface RenderEnv {
  /** digest of req.tools; the counter memoizes it */
  toolsKey(): string;
}

export interface TemplateProfile {
  readonly name: TemplateName;
  /** identity including options (goes into the counter id / planning hash) */
  readonly id: string;
  /** false for 'generic': pieces are independent estimates, not substrings of a real prompt */
  readonly additive: boolean;
  /** Scans the request and returns its layout. Throws TemplateError where the template raises. */
  layout(req: ChatRequest, env?: RenderEnv): RenderLayout;
}

export const partsText = (parts: readonly Part[]): string => {
  let s = '';
  for (const p of parts) s += p.s;
  return s;
};

/** The full rendered prompt (exact for sim/qwen3/chatml). */
export function renderPrompt(profile: TemplateProfile, req: ChatRequest): string {
  const L = profile.layout(req, { toolsKey: () => '' });
  let s = partsText(L.prefix);
  for (let i = 0; i < L.ctx.length; i++) s += partsText(L.message(i));
  return s + partsText(L.suffix);
}

const g = (s: string): Part => ({ k: 'g', s });
const c = (s: string, cls?: ContentClass): Part => (cls ? { k: 'c', s, cls } : { k: 'c', s });

// ---------------------------------------------------------------- shared helpers

/** Python str.isspace() set (what jinja's |trim / str.strip() remove). JS trim() differs: it strips U+FEFF, keeps U+001C-1F and U+0085. */
const PY_WS = new Set([
  0x9, 0xa, 0xb, 0xc, 0xd, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

export function pyStrip(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && PY_WS.has(s.charCodeAt(a))) a++;
  while (b > a && PY_WS.has(s.charCodeAt(b - 1))) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}

/**
 * `s` without trailing "\n" (Jinja's rstrip('\n')). Not `replace(/\n+$/, '')`: a backtracking regex retries
 * the run at every newline of it, quadratic on a long newline run that is not at the end (40k newlines: 5 s).
 */
export function trimTrailingNewlines(s: string): string {
  let b = s.length;
  while (b > 0 && s.charCodeAt(b - 1) === 0x0a) b--;
  return b === s.length ? s : s.slice(0, b);
}

/** Python str.strip() applied to the concatenation of text/placeholder parts, keeping part structure. */
function stripParts(parts: Part[]): Part[] {
  const out = parts.filter((p) => p.s.length > 0 || p.k === 'x');
  while (out.length > 0 && out[0]!.k === 'c') {
    const p = out[0]!;
    let a = 0;
    while (a < p.s.length && PY_WS.has(p.s.charCodeAt(a))) a++;
    if (a < p.s.length) {
      if (a > 0) out[0] = { ...p, s: p.s.slice(a) };
      break;
    }
    out.shift();
  }
  while (out.length > 0 && out[out.length - 1]!.k === 'c') {
    const p = out[out.length - 1]!;
    let b = p.s.length;
    while (b > 0 && PY_WS.has(p.s.charCodeAt(b - 1))) b--;
    if (b > 0) {
      if (b < p.s.length) out[out.length - 1] = { ...p, s: p.s.slice(0, b) };
      break;
    }
    out.pop();
  }
  return out;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const EMPTY: Record<string, unknown> = {};
/** tool_call.function (or the call itself when it has no `function`, like the template's fallback) */
const fnOf = (tc: unknown, selfIfNoFunction = false): Record<string, unknown> =>
  isObj(tc) && isObj(tc['function']) ? tc['function'] : selfIfNoFunction && isObj(tc) ? tc : EMPTY;

/** Python str(x) for the scalar types a JSON body can hold. */
function pyStrValue(x: unknown): string {
  if (x === null || x === undefined) return 'None';
  if (x === true) return 'True';
  if (x === false) return 'False';
  if (typeof x === 'number') return Number.isInteger(x) ? String(x) : pyFloatRepr(x);
  if (typeof x === 'string') return x;
  return pyDumps(x, { ensureAscii: false }); // dict/list repr differs (quotes); never produced by agents
}

/** OpenAI tool-call `arguments` as the server's template sees them (vLLM chat_utils._postprocess_messages). */
function toolArguments(raw: unknown): Map<string, PyValue> {
  if (!raw) return new Map(); // None, '' -> {}
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = parsePyJson(raw);
    } catch {
      return new Map(); // invalid JSON -> {} (vLLM coerces with a warning)
    }
  }
  if (parsed instanceof Map) return parsed as Map<string, PyValue>;
  if (isObj(parsed)) return new Map(Object.entries(parsed) as [string, PyValue][]);
  return new Map(); // valid JSON but not an object -> {}
}

// ---------------------------------------------------------------- sim (benchmark mock render())

/** sim/scenario.py content_text(): None -> "", str, list -> "\n".join(p.get("text","") for dict parts), else str(). */
function simContentText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => isObj(p))
      .map((p) => {
        const t = (p as Record<string, unknown>)['text'];
        return t === undefined ? '' : typeof t === 'string' ? t : pyStrValue(t);
      })
      .join('\n');
  }
  return pyStrValue(content);
}

/**
 * Byte-exact port of sim/scenario.py render(): system text + "\n\n# Tools\n\n<tools>\n" + one
 * json.dumps(tool, ensure_ascii=False) per line + "\n</tools>" in one system block (always emitted),
 * assistant tool calls as json.dumps({"name", "arguments": <the arguments string>}), tool results as
 * a user <tool_response> turn, other roles verbatim, then "<|im_start|>assistant\n". Reasoning, names
 * and images are ignored (the mock never counts them).
 */
export function simProfile(): TemplateProfile {
  return {
    name: 'sim',
    id: 'sim/1',
    additive: true,
    layout(req, env) {
      const msgs: ChatMessage[] = Array.isArray(req.messages) ? req.messages : [];
      const tools = Array.isArray(req.tools) ? req.tools : [];
      const hasSys = msgs.length > 0 && msgs[0]!.role === 'system';
      const toolsKey = tools.length ? env?.toolsKey() ?? '' : '';
      const header = (sysText: string): Part[] => {
        const parts: Part[] = [g('<|im_start|>system\n')];
        if (sysText) parts.push(c(sysText));
        if (tools.length) {
          parts.push(g('\n\n# Tools\n\n<tools>\n'));
          parts.push(c(tools.map((t) => pyDumps(t, { ensureAscii: false })).join('\n'), 'json'));
          parts.push(g('\n</tools>'));
        }
        parts.push(g('<|im_end|>\n'));
        return parts;
      };
      const ctx = msgs.map((_, i) => (i === 0 && hasSys ? 'S' + toolsKey : ''));
      return {
        ctx,
        prefix: hasSys ? [] : header(''),
        prefixKey: hasSys ? '' : 'sim-sys|' + toolsKey,
        suffix: [g('<|im_start|>assistant\n')],
        message(i) {
          const m = msgs[i]!;
          if (i === 0 && hasSys) return header(simContentText(m.content));
          const role = m.role;
          const text = simContentText(m.content);
          if (role === 'assistant') {
            const parts: Part[] = [g('<|im_start|>assistant\n')];
            if (text) parts.push(c(text));
            for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
              const f = fnOf(tc);
              parts.push(g('\n<tool_call>\n'));
              parts.push(c(pyDumps(new Map<string, unknown>([['name', f['name'] ?? null], ['arguments', f['arguments'] ?? null]]), { ensureAscii: false }), 'json'));
              parts.push(g('\n</tool_call>'));
            }
            parts.push(g('<|im_end|>\n'));
            return parts;
          }
          if (role === 'tool') {
            const parts: Part[] = [g('<|im_start|>user\n<tool_response>\n')];
            if (text) parts.push(c(text));
            parts.push(g('\n</tool_response><|im_end|>\n'));
            return parts;
          }
          const parts: Part[] = [g(`<|im_start|>${role === undefined || role === null ? 'None' : String(role)}\n`)];
          if (text) parts.push(c(text));
          parts.push(g('<|im_end|>\n'));
          return parts;
        },
      };
    },
  };
}

// ---------------------------------------------------------------- qwen3 (real Qwen3.6 template)

export interface Qwen3Options {
  /** chat_template_kwargs.enable_thinking default; null/undefined = template default (thinking on).
   *  A request's own chat_template_kwargs.enable_thinking (boolean) wins. */
  enableThinking?: boolean | null;
  /** chat_template_kwargs.preserve_thinking default (Qwen3.6); a request's own value wins */
  preserveThinking?: boolean;
  /** 'vllm' (default): tools reduced to {type, function:{name, description, parameters[, strict]
   *  [, defer_loading]}} as vLLM's pydantic models serialize them; 'raw': tools as sent */
  tools?: 'vllm' | 'raw';
  /** vLLM renames `developer` to `system` when the template has no developer role and then, if a
   *  system message is not first, merges all of them into one leading system message (default true) */
  developerAsSystem?: boolean;
}

const QWEN_TOOLS_HEAD = '# Tools\n\nYou have access to the following functions:\n\n<tools>';
const QWEN_TOOLS_INSTR =
  '\n\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n\n<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n</parameter>\n<parameter=example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n</parameter>\n</function>\n</tool_call>\n\n<IMPORTANT>\nReminder:\n- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags\n- Required parameters MUST be specified\n- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n</IMPORTANT>';
const IMAGE_PH = '<|vision_start|><|image_pad|><|vision_end|>';
const VIDEO_PH = '<|vision_start|><|video_pad|><|vision_end|>';
/**
 * Qwen3.6 token counts of the fixed glue strings the built-in profiles emit, for 'estimate' mode
 * (no tokenizer there). test/tokenize/counter.test.ts checks every entry against the tokenizer.
 * Glue not listed (role names of unusual roles) is estimated from its characters.
 */
export const GLUE_TOKENS: ReadonlyMap<string, number> = new Map<string, number>([
  ['\n', 1], ['\n\n', 1], ['>\n', 2], ['\n</tools>', 4], ['<|im_end|>\n', 2], ['\n</think>\n\n', 3], ['<parameter=', 3],
  ['\n<tool_call>\n', 3], ['\n</tool_call>', 2], ['\n</parameter>\n', 5], ['<|im_start|>user\n', 3], ['\n</tool_response>', 2],
  ['\n<tool_response>\n', 3], ['# Tools\n\n<tools>\n', 7], ['<|im_start|>system\n', 3], ['\n\n# Tools\n\n<tools>\n', 8],
  ['<tool_call>\n<function=', 5], ['<|im_start|>assistant\n', 3], ['\n<tool_call>\n<function=', 6], ['\n\n<tool_call>\n<function=', 6],
  ['</function>\n</tool_call>', 5], ['\n</tool_response><|im_end|>\n', 4], ['<|im_start|>assistant\n<think>\n', 5],
  ['<|im_start|>user\n<tool_response>\n', 5], ['<|im_start|>assistant\n<think>\n\n</think>\n\n', 7],
  ['<|im_start|>system\n' + QWEN_TOOLS_HEAD, 18], ['\n</tools>' + QWEN_TOOLS_INSTR, 181],
  ['<|im_start|>tool\n', 3], ['<|im_start|>developer\n', 3],
]);

// vLLM content-part types (chat_utils.MM_PARSER_MAP): text-like parts become {"type":"text"}, media
// parts {"type":"image"} / {"type":"video"}, which the template renders as vision placeholders.
// a Map, not an object literal: a part type like "constructor" or "__proto__" must not find Object.prototype members
const TEXT_PART_KEY: ReadonlyMap<string, string> = new Map([['text', 'text'], ['input_text', 'text'], ['output_text', 'text'], ['thinking', 'thinking'], ['refusal', 'refusal']]);
const IMAGE_PART_TYPES = new Set(['image_url', 'input_image', 'image_embeds', 'image_pil', 'image']);
const VIDEO_PART_TYPES = new Set(['video_url', 'video_embeds', 'video']);

/** vLLM's FunctionDefinition / ChatCompletionToolsParam serialization (null strict/defer_loading dropped). */
function vllmTool(t: unknown): unknown {
  if (!isObj(t) || !isObj(t['function'])) return t;
  const f = t['function'];
  const fn = new Map<string, unknown>([
    ['name', f['name'] ?? null],
    ['description', f['description'] ?? null],
    ['parameters', f['parameters'] ?? null],
  ]);
  if (f['strict'] !== undefined && f['strict'] !== null) fn.set('strict', f['strict']);
  const defer = f['defer_loading'] ?? t['defer_loading'] ?? null;
  if (defer !== null) fn.set('defer_loading', defer);
  const out = new Map<string, unknown>([['type', 'function'], ['function', fn]]);
  if (t['defer_loading'] !== undefined && t['defer_loading'] !== null) out.set('defer_loading', t['defer_loading']);
  return out;
}

/**
 * The real Qwen3.6-27B chat template (reference implementation), applied to the messages as
 * vLLM prepares them (vllm/entrypoints/chat_utils.py): tool-call arguments parsed to a mapping
 * (invalid or non-object -> {}), `reasoning` preferred over `reasoning_content`, content as OpenAI
 * parts (strings -> one text part), text-only tool contents joined with "\n", developer -> system
 * (then all system messages merged into one leading one when any is not first, see consolidatedLayout).
 * Tools block with its fixed instructions (system text after it), XML tool calls (string values
 * raw, others tojson), consecutive tool results grouped into one user turn, <think> wrappers only
 * after the last real user query (or with preserve_thinking), generation prompt per enable_thinking.
 */
export function qwen3Profile(opts: Qwen3Options = {}): TemplateProfile {
  const toolsMode = opts.tools ?? 'vllm';
  const devAsSys = opts.developerAsSystem ?? true;
  const id = `qwen3.6/1;think=${opts.enableThinking ?? 'default'};preserve=${opts.preserveThinking ?? false};tools=${toolsMode};dev=${devAsSys}`;

  const roleOf = (m: ChatMessage): string => (m.role === 'developer' && devAsSys ? 'system' : m.role);

  /** render_content() over vLLM-normalized parts; isSystem raises on images like the template. */
  const renderContent = (m: ChatMessage, role: string, isSystem: boolean, index: number): Part[] => {
    const content = m.content;
    if (content === null || content === undefined) return [];
    if (typeof content === 'string') return content ? [c(content)] : [];
    if (!Array.isArray(content)) throw new TemplateError('Unexpected content type.', index);
    const parts: Part[] = [];
    let textOnly = true;
    for (const item of content as unknown[]) {
      if (typeof item === 'string') {
        parts.push(c(item));
        continue;
      }
      if (!isObj(item)) throw new TemplateError('Unexpected item type in content.', index);
      const type = item['type'];
      const typed = typeof type === 'string';
      const textKey = typed ? TEXT_PART_KEY.get(type as string) : undefined;
      if (textKey !== undefined) {
        const t = item[textKey];
        if (t === null || t === undefined) continue; // vLLM skips text parts without content
        parts.push(c(typeof t === 'string' ? t : pyStrValue(t)));
      } else if (typed ? IMAGE_PART_TYPES.has(type as string) : 'image' in item || 'image_url' in item) {
        if (isSystem) throw new TemplateError('System message cannot contain images.', index);
        parts.push({ k: 'i', s: IMAGE_PH });
        textOnly = false;
      } else if (typed ? VIDEO_PART_TYPES.has(type as string) : 'video' in item) {
        if (isSystem) throw new TemplateError('System message cannot contain videos.', index);
        parts.push({ k: 'i', s: VIDEO_PH });
        textOnly = false;
      } else if (!typed && 'text' in item) {
        const t = item['text'];
        parts.push(c(typeof t === 'string' ? t : t === null || t === undefined ? '' : pyStrValue(t)));
      } else {
        // audio parts reach the template as {"type": "audio"}, which it rejects; unknown types are a vLLM 400
        throw new TemplateError('Unexpected item type in content.', index);
      }
    }
    // vLLM joins text-only tool contents with "\n" before the template sees them
    if (role === 'tool' && textOnly) {
      const joined = parts.map((p) => p.s).join('\n');
      return joined ? [c(joined)] : [];
    }
    return parts;
  };

  const contentString = (parts: Part[]): string => partsText(parts);

  /** Re-split a string that may contain placeholders into c/i parts (after the </think> split). */
  const reparse = (s: string): Part[] => {
    if (!s.includes('<|vision_start|>')) return s ? [c(s)] : [];
    const out: Part[] = [];
    const re = /<\|vision_start\|><\|(?:image|video)_pad\|><\|vision_end\|>/g;
    let last = 0;
    for (let m = re.exec(s); m !== null; m = re.exec(s)) {
      if (m.index > last) out.push(c(s.slice(last, m.index)));
      out.push({ k: 'i', s: m[0] });
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push(c(s.slice(last)));
    return out;
  };

  /** The template over `msgs` (req supplies tools and chat_template_kwargs). */
  const baseLayout = (req: ChatRequest, msgs: ChatMessage[], env?: RenderEnv): RenderLayout => {
    const n = msgs.length;
    if (n === 0) throw new TemplateError('No messages provided.');
    const kw = isObj(req['chat_template_kwargs']) ? (req['chat_template_kwargs'] as Record<string, unknown>) : {};
    const enableThinking = typeof kw['enable_thinking'] === 'boolean' ? kw['enable_thinking'] : opts.enableThinking ?? null;
    const preserve = typeof kw['preserve_thinking'] === 'boolean' ? kw['preserve_thinking'] : opts.preserveThinking === true;
    const tools = Array.isArray(req.tools) && req.tools.length > 0 ? req.tools : null;
    const roles = msgs.map(roleOf);

    // the header renders first: an image in the system message is the template's first error
    if (roles[0] === 'system') renderContent(msgs[0]!, 'system', true, 0);
    // last real user query (template :67-80)
    let lastQuery = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (roles[i] !== 'user') continue;
      const s = pyStrip(contentString(renderContent(msgs[i]!, 'user', false, i)));
      if (!(s.startsWith('<tool_response>') && s.endsWith('</tool_response>'))) {
        lastQuery = i;
        break;
      }
    }
    if (lastQuery < 0) throw new TemplateError('No user query found in messages.');
    for (let i = 0; i < n; i++) {
      const r = roles[i];
      if (r === 'system') {
        if (i > 0) throw new TemplateError('System message must be at the beginning.', i);
      } else if (r !== 'user' && r !== 'assistant' && r !== 'tool') {
        throw new TemplateError('Unexpected message role.', i);
      }
    }

    const toolsKey = tools ? env?.toolsKey() ?? '' : '';
    const toolsBlock = (): Part[] => {
      const parts: Part[] = [g('<|im_start|>system\n' + QWEN_TOOLS_HEAD)];
      for (const t of tools!) {
        parts.push(g('\n'));
        parts.push(c(pyDumps(toolsMode === 'vllm' ? vllmTool(t) : t, { ensureAscii: false }), 'json'));
      }
      parts.push(g('\n</tools>' + QWEN_TOOLS_INSTR));
      return parts;
    };
    const hasSys = roles[0] === 'system';
    const ctx = msgs.map((_, i) => {
      const r = roles[i];
      if (r === 'system') return 'S' + toolsKey;
      if (r === 'assistant') return preserve || i > lastQuery ? 'AT' : 'A';
      if (r === 'tool') return 'T' + (i > 0 && roles[i - 1] !== 'tool' ? 'f' : '') + (i === n - 1 || roles[i + 1] !== 'tool' ? 'l' : '');
      return 'U';
    });
    const prefix: Part[] = tools && !hasSys ? [...toolsBlock(), g('<|im_end|>\n')] : [];

    return {
      ctx,
      prefix,
      prefixKey: prefix.length ? 'qwen-tools|' + toolsKey : '',
      suffix: [g(enableThinking === false ? '<|im_start|>assistant\n<think>\n\n</think>\n\n' : '<|im_start|>assistant\n<think>\n')],
      message(i) {
        const m = msgs[i]!;
        const r = roles[i]!;
        if (r === 'system') {
          // i === 0 (validated); the whole header is this message's piece
          const text = stripParts(renderContent(m, r, true, i));
          if (tools) {
            const parts = toolsBlock();
            if (text.length) parts.push(g('\n\n'), ...text);
            parts.push(g('<|im_end|>\n'));
            return parts;
          }
          return [g('<|im_start|>system\n'), ...text, g('<|im_end|>\n')];
        }
        if (r === 'user') return [g('<|im_start|>user\n'), ...stripParts(renderContent(m, r, false, i)), g('<|im_end|>\n')];
        if (r === 'tool') {
          const cx = ctx[i]!;
          const parts: Part[] = [];
          parts.push(g((cx.includes('f') ? '<|im_start|>user' : '') + '\n<tool_response>\n'));
          parts.push(...stripParts(renderContent(m, r, false, i)));
          parts.push(g('\n</tool_response>' + (cx.includes('l') ? '<|im_end|>\n' : '')));
          return parts;
        }
        // assistant (template :89-130)
        let content = stripParts(renderContent(m, r, false, i));
        const rsn = m.reasoning !== undefined && m.reasoning !== null ? m.reasoning : m.reasoning_content;
        let reasoning = '';
        if (typeof rsn === 'string') {
          reasoning = rsn;
        } else {
          const s = contentString(content);
          if (s.includes('</think>')) {
            const pieces = s.split('</think>');
            reasoning = (trimTrailingNewlines(pieces[0]!).split('<think>').pop() ?? '').replace(/^\n+/, '');
            content = reparse(pieces[pieces.length - 1]!.replace(/^\n+/, ''));
          }
        }
        reasoning = pyStrip(reasoning);
        const parts: Part[] = [];
        if (ctx[i] === 'AT') {
          parts.push(g('<|im_start|>assistant\n<think>\n'));
          if (reasoning) parts.push(c(reasoning));
          parts.push(g('\n</think>\n\n'));
        } else {
          parts.push(g('<|im_start|>assistant\n'));
        }
        parts.push(...content);
        const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
        const hasText = pyStrip(contentString(content)).length > 0;
        calls.forEach((tc0, j) => {
          const tc = fnOf(tc0, true);
          const name = tc['name'];
          if (typeof name !== 'string') throw new TemplateError('tool call without a string name', i);
          parts.push(g((j === 0 ? (hasText ? '\n\n' : '') : '\n') + '<tool_call>\n<function='), c(name), g('>\n'));
          for (const [k, v] of toolArguments(tc['arguments'])) {
            parts.push(g('<parameter='), c(k), g('>\n'));
            const val = typeof v === 'string' ? v : pyDumps(v, { ensureAscii: false });
            if (val) parts.push(c(val, typeof v === 'string' ? undefined : 'json'));
            parts.push(g('\n</parameter>\n'));
          }
          parts.push(g('</function>\n</tool_call>'));
        });
        parts.push(g('<|im_end|>\n'));
        return parts;
      },
    };
  };

  /**
   * vLLM (renderers/hf.py safe_apply_chat_template): with a developer message present and no
   * developer role in the template, developer messages become system messages and, when a system
   * message then sits anywhere but first, _consolidate_system_messages merges all of them into one
   * leading system message: their non-empty texts (text parts joined with "\n", images dropped)
   * joined with "\n\n". That header is attributed to message 0 (whatever its role, its own piece
   * follows); the other system/developer messages contribute nothing. ctx[0] carries a hash of the
   * merged text, since it depends on other messages.
   */
  const consolidatedLayout = (req: ChatRequest, msgs: ChatMessage[], env?: RenderEnv): RenderLayout => {
    const texts: string[] = [];
    const rest: ChatMessage[] = [];
    const origOf: number[] = [0]; // virtual index -> original index (virtual 0 = the merged message)
    const virt: number[] = []; // original index -> virtual index, -1 for merged system/developer messages
    msgs.forEach((m, i) => {
      if (roleOf(m) === 'system') {
        const t = renderContent(m, 'system', false, i).filter((p) => p.k === 'c').map((p) => p.s).join('\n');
        if (t) texts.push(t);
        virt.push(-1);
      } else {
        virt.push(origOf.length);
        origOf.push(i);
        rest.push(m);
      }
    });
    const merged = texts.join('\n\n');
    const remap = (e: unknown): never => {
      if (e instanceof TemplateError && e.index !== null) throw new TemplateError(e.message, origOf[e.index] ?? null);
      throw e;
    };
    let L: RenderLayout;
    try {
      L = baseLayout(req, [{ role: 'system', content: merged }, ...rest], env);
    } catch (e) {
      return remap(e);
    }
    const v0 = virt[0]!;
    const mergedKey = 'M' + createHash('sha256').update(merged, 'utf8').digest('hex').slice(0, 32) + L.ctx[0];
    return {
      ctx: msgs.map((_, i) => (i === 0 ? mergedKey + (v0 >= 0 ? '|' + L.ctx[v0] : '') : virt[i]! >= 0 ? L.ctx[virt[i]!]! : 'X')),
      prefix: L.prefix,
      prefixKey: L.prefixKey,
      suffix: L.suffix,
      message(i) {
        try {
          if (i === 0) return v0 >= 0 ? [...L.message(0), ...L.message(v0)] : L.message(0);
          return virt[i]! >= 0 ? L.message(virt[i]!) : [];
        } catch (e) {
          return remap(e);
        }
      },
    };
  };

  return {
    name: 'qwen3',
    id,
    additive: true,
    layout(req, env) {
      const msgs: ChatMessage[] = Array.isArray(req.messages) ? req.messages : [];
      const consolidate = devAsSys && msgs.some((m) => m.role === 'developer') && msgs.some((m, i) => i > 0 && roleOf(m) === 'system');
      return consolidate ? consolidatedLayout(req, msgs, env) : baseLayout(req, msgs, env);
    },
  };
}

// ---------------------------------------------------------------- chatml (generic <|im_start|> models)

/**
 * Generic ChatML: `<|im_start|>{role}\n{text}<|im_end|>\n` per message, text parts joined with "\n",
 * tools as a `# Tools` JSON-lines block in the system turn (Hermes/Qwen2.5 convention), tool calls as
 * `<tool_call>\n{"name": ..., "arguments": {...}}\n</tool_call>`, roles verbatim, reasoning dropped.
 * An approximation for ChatML models without a dedicated profile; calibration corrects the rest.
 */
export function chatmlProfile(): TemplateProfile {
  const text = (m: ChatMessage): Part[] => {
    const ct = m.content;
    if (ct === null || ct === undefined) return [];
    if (typeof ct === 'string') return ct ? [c(ct)] : [];
    if (!Array.isArray(ct)) return [c(pyStrValue(ct))];
    const out: Part[] = [];
    (ct as unknown[]).forEach((p, j) => {
      if (j > 0) out.push(g('\n'));
      if (typeof p === 'string') out.push(c(p));
      else if (isObj(p) && typeof p['text'] === 'string') out.push(c(p['text']));
      else if (isObj(p) && (p['type'] === 'image_url' || 'image_url' in p || 'image' in p)) out.push({ k: 'i', s: IMAGE_PH });
    });
    return out.filter((p) => p.s.length > 0);
  };
  return {
    name: 'chatml',
    id: 'chatml/1',
    additive: true,
    layout(req, env) {
      const msgs: ChatMessage[] = Array.isArray(req.messages) ? req.messages : [];
      const tools = Array.isArray(req.tools) && req.tools.length > 0 ? req.tools : null;
      const hasSys = msgs.length > 0 && msgs[0]!.role === 'system';
      const toolsKey = tools ? env?.toolsKey() ?? '' : '';
      const toolParts = (): Part[] =>
        tools ? [g('# Tools\n\n<tools>\n'), c(tools.map((t) => pyDumps(t, { ensureAscii: false })).join('\n'), 'json'), g('\n</tools>')] : [];
      const prefix = tools && !hasSys ? [g('<|im_start|>system\n'), ...toolParts(), g('<|im_end|>\n')] : [];
      return {
        ctx: msgs.map((_, i) => (i === 0 && hasSys ? 'S' + toolsKey : '')),
        prefix,
        prefixKey: prefix.length ? 'chatml-tools|' + toolsKey : '',
        suffix: [g('<|im_start|>assistant\n')],
        message(i) {
          const m = msgs[i]!;
          const parts: Part[] = [g(`<|im_start|>${String(m.role)}\n`), ...text(m)];
          if (i === 0 && hasSys && tools) {
            if (parts.length > 1) parts.push(g('\n\n'));
            parts.push(...toolParts());
          }
          for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
            const f = fnOf(tc);
            const args = toolArguments(f['arguments']);
            parts.push(g('\n<tool_call>\n'));
            parts.push(c(pyDumps(new Map<string, unknown>([['name', f['name'] ?? null], ['arguments', args]]), { ensureAscii: false }), 'json'));
            parts.push(g('\n</tool_call>'));
          }
          parts.push(g('<|im_end|>\n'));
          return parts;
        },
      };
    },
  };
}

// ---------------------------------------------------------------- generic (content + overhead)

/**
 * No template: each message costs its content tokens (text parts, reasoning, each tool call's name
 * and arguments, each counted separately) plus `perMessageOverhead`; tools cost their JSON; the
 * generation prompt costs one more `perMessageOverhead`. Not additive over a real prompt.
 */
export function genericProfile(perMessageOverhead: number): TemplateProfile {
  const x = (n: number): Part => ({ k: 'x', s: '', n });
  return {
    name: 'generic',
    id: `generic/1;overhead=${perMessageOverhead}`,
    additive: false,
    layout(req, env) {
      const msgs: ChatMessage[] = Array.isArray(req.messages) ? req.messages : [];
      const tools = Array.isArray(req.tools) && req.tools.length > 0 ? req.tools : null;
      return {
        ctx: msgs.map(() => ''),
        prefix: tools ? [c(tools.map((t) => JSON.stringify(t)).join('\n'), 'json')] : [],
        prefixKey: tools ? 'generic-tools|' + (env?.toolsKey() ?? '') : '',
        suffix: [x(perMessageOverhead)],
        message(i) {
          const m = msgs[i]!;
          const parts: Part[] = [x(perMessageOverhead)];
          const ct = m.content;
          if (typeof ct === 'string') {
            if (ct) parts.push(c(ct));
          } else if (Array.isArray(ct)) {
            for (const p of ct as unknown[]) {
              if (typeof p === 'string') parts.push(c(p), x(0));
              else if (isObj(p) && typeof p['text'] === 'string') parts.push(c(p['text']), x(0));
              else if (isObj(p) && (p['type'] === 'image_url' || 'image_url' in p || 'image' in p)) parts.push({ k: 'i', s: '' });
            }
          }
          const rsn = typeof m.reasoning === 'string' ? m.reasoning : typeof m.reasoning_content === 'string' ? m.reasoning_content : '';
          if (rsn) parts.push(x(0), c(rsn));
          for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
            const f = fnOf(tc);
            parts.push(x(0), c(String(f['name'] ?? '')), x(0));
            const a = f['arguments'];
            const s = typeof a === 'string' ? a : a === undefined || a === null ? '' : JSON.stringify(a);
            if (s) parts.push(c(s, 'json'));
          }
          return parts.filter((p) => p.k !== 'c' || p.s.length > 0);
        },
      };
    },
  };
}

// ---------------------------------------------------------------- factory

export interface ProfileOptions extends Qwen3Options {
  perMessageOverhead?: number;
}

export function createProfile(name: TemplateName, opts: ProfileOptions = {}): TemplateProfile {
  switch (name) {
    case 'sim':
      return simProfile();
    case 'qwen3':
      return qwen3Profile(opts);
    case 'chatml':
      return chatmlProfile();
    case 'generic':
      return genericProfile(opts.perMessageOverhead ?? 8);
    default:
      throw new Error(`unknown template profile ${String(name)}`);
  }
}

export { PyFloat };
