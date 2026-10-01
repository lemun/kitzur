// The mock's `render: 'qwen3'` (bench/README.md): an INDEPENDENT port of the real Qwen3.6-27B chat template
// (reference implementation, sha256 e84f32a2…9574259) plus the vLLM request preprocessing that decides what
// the template sees. It is written from the Jinja source and from vLLM's own code
// (vllm/entrypoints/chat_utils.py `_parse_chat_message_content`, `_postprocess_messages`;
// vllm/entrypoints/openai/chat_completion/protocol.py `_normalize_messages_before`;
// vllm/renderers/hf.py `_convert_developer_to_system`, `_consolidate_system_messages`;
// vllm/entrypoints/generate/base/protocol.py tool serializers), NOT from src/tokenize/template.ts (the proxy's
// counter), so the bench can catch the proxy's template bugs. Golden-checked against jinja2 3.1.6 driven by the
// same vLLM functions (bench/mock/make-qwen3-goldens.py → test/fixtures/bench/qwen3-render.json.gz).
//
// Input is the request body parsed with bench/lib/jsonparse.ts (Python json.loads semantics: key order, big ints,
// floats), because the template prints tool definitions and tool-call arguments in key order via `tojson`.
//
// vLLM preprocessing, in order (what a Qwen3.6 server on vLLM ≥0.18 does before rendering):
//  1. `reasoning_content` is renamed to `reasoning` unless `reasoning` is set; an assistant's `reasoning` then
//     reaches the template as both `reasoning` and `reasoning_content`;
//  2. content: null → [], a string → [{"type":"text","text":s}], parts → {"type":"text","text":…} (text,
//     input_text, output_text, refusal, thinking; a text/refusal part with null text is skipped),
//     {"type":"image"} (image_url, input_image, image_embeds, image_pil), {"type":"video"}, {"type":"audio"};
//     tool messages whose parts are all text become the texts joined with "\n";
//  3. assistant tool_calls: [] is dropped; `arguments` "" / null / {} → {}, a JSON string → its object, anything
//     that is not an object (invalid JSON, "[1]", 42) → {};
//  4. `developer` messages become `system` and, when a system message is then not first (or there are two), all
//     system contents (text parts joined "\n") are merged, joined "\n\n", into one leading system message;
//  5. tools are re-serialized as {"type":"function","function":{"name","description","parameters"[,"strict"]
//     [,"defer_loading"]}[,"defer_loading"]} (missing description/parameters become null; other keys dropped);
//  6. `chat_template_kwargs` are template variables (enable_thinking, preserve_thinking); `add_generation_prompt`
//     defaults to true.
// Template `raise_exception` → Qwen3TemplateError; vLLM request validation → VllmValidationError. vLLM answers both
// with HTTP 400.

import { PyFloat, pyDumps, pyFloatRepr } from '../lib/pyjson.js';
import { parsePyJson, type PyObject, type PyValue } from '../lib/jsonparse.js';
import { pyStrip } from '../lib/stats.js';

export class Qwen3TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}
export class VllmValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VLLMValidationError';
  }
}

const isMap = (v: unknown): v is PyObject => v instanceof Map;
const TOOLS_INSTRUCTIONS =
  '\n\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n\n<tool_call>\n<function=example_function_name>\n<parameter=example_parameter_1>\nvalue_1\n</parameter>\n<parameter=example_parameter_2>\nThis is the value for the second parameter\nthat can span\nmultiple lines\n</parameter>\n</function>\n</tool_call>\n\n<IMPORTANT>\nReminder:\n- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags\n- Required parameters MUST be specified\n- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after\n- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls\n</IMPORTANT>';

// ---------------------------------------------------------------- Python / Jinja value semantics

/** Python repr() of a str (quote choice and the common escapes; exotic non-printables are not escaped). */
function reprStr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\' || ch === q) out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + q;
}

function repr(v: PyValue | undefined): string {
  if (typeof v === 'string') return reprStr(v);
  if (Array.isArray(v)) return '[' + v.map(repr).join(', ') + ']';
  if (isMap(v)) return '{' + [...v].map(([k, x]) => `${reprStr(k)}: ${repr(x)}`).join(', ') + '}';
  return pyStrOf(v);
}

/** Python str() of a value, as `{{ x }}` prints it (undefined prints ''). */
function pyStrOf(v: PyValue | undefined): string {
  if (v === undefined) return '';
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof PyFloat) return pyFloatRepr(v.value);
  return repr(v);
}

/** Jinja attribute access on a dict (`x.key` = x['key'] for mappings; undefined elsewhere). */
const attr = (v: PyValue | undefined, k: string): PyValue | undefined => (isMap(v) ? v.get(k) : undefined);

/** Python truthiness (undefined is falsy, like jinja2.Undefined). */
function truthy(v: PyValue | undefined): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === 0n || v === '') return false;
  if (v instanceof PyFloat) return v.value !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isMap(v)) return v.size > 0;
  return true;
}

/** Python `needle in container` for a str needle. */
function contains(container: PyValue | undefined, needle: string): boolean {
  if (typeof container === 'string') return container.includes(needle);
  if (Array.isArray(container)) return container.some((x) => x === needle);
  if (isMap(container)) return container.has(needle);
  const t = container === undefined ? 'Undefined' : container === null ? 'NoneType' : typeof container;
  throw new Qwen3TemplateError(`argument of type '${t}' is not iterable`);
}

/** Jinja `'str' + x`: x must be a str (Undefined and None raise). */
function strCat(x: PyValue | undefined): string {
  if (typeof x === 'string') return x;
  throw new Qwen3TemplateError(x === undefined ? "'dict object' has no attribute" : 'can only concatenate str (not "' + (x === null ? 'NoneType' : typeof x) + '") to str');
}

/** transformers' `tojson` override: json.dumps(x, ensure_ascii=False) with the default separators. */
const tojson = (v: PyValue | undefined): string => pyDumps(v === undefined ? null : v, { ensureAscii: false });

const rstripNl = (s: string): string => s.replace(/\n+$/, '');
const lstripNl = (s: string): string => s.replace(/^\n+/, '');

// ---------------------------------------------------------------- the template (reference implementation)

/** macro render_content(content, do_vision_count, is_system_content) — image counting only matters with add_vision_id. */
function renderContent(content: PyValue | undefined, isSystem: boolean): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const item of content) {
      if (contains(item, 'image') || contains(item, 'image_url') || attr(item, 'type') === 'image') {
        if (isSystem) throw new Qwen3TemplateError('System message cannot contain images.');
        out += '<|vision_start|><|image_pad|><|vision_end|>';
      } else if (contains(item, 'video') || attr(item, 'type') === 'video') {
        if (isSystem) throw new Qwen3TemplateError('System message cannot contain videos.');
        out += '<|vision_start|><|video_pad|><|vision_end|>';
      } else if (contains(item, 'text')) {
        out += pyStrOf(attr(item, 'text'));
      } else {
        throw new Qwen3TemplateError('Unexpected item type in content.');
      }
    }
    return out;
  }
  if (content === null || content === undefined) return '';
  throw new Qwen3TemplateError('Unexpected content type.');
}

export interface Qwen3Vars {
  add_generation_prompt?: PyValue;
  enable_thinking?: PyValue;
  preserve_thinking?: PyValue;
}

/** The Jinja template over an already preprocessed conversation (step 1-5 above). */
export function renderQwen3Template(messages: PyValue[], tools: PyValue | null | undefined, vars: Qwen3Vars = {}): string {
  let out = '';
  if (!truthy(messages)) throw new Qwen3TemplateError('No messages provided.');
  const m0 = messages[0];
  if (truthy(tools) && Array.isArray(tools)) {
    out += '<|im_start|>system\n';
    out += '# Tools\n\nYou have access to the following functions:\n\n<tools>';
    for (const tool of tools) out += '\n' + tojson(tool);
    out += '\n</tools>';
    out += TOOLS_INSTRUCTIONS;
    if (attr(m0, 'role') === 'system') {
      const content = pyStrip(renderContent(attr(m0, 'content'), true));
      if (content) out += '\n\n' + content;
    }
    out += '<|im_end|>\n';
  } else if (attr(m0, 'role') === 'system') {
    const content = pyStrip(renderContent(attr(m0, 'content'), true));
    out += '<|im_start|>system\n' + content + '<|im_end|>\n';
  }
  // last query: the newest user message whose trimmed content is not wholly <tool_response>…</tool_response>
  let multiStepTool = true;
  let lastQueryIndex = messages.length - 1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (multiStepTool && attr(message, 'role') === 'user') {
      const content = pyStrip(renderContent(attr(message, 'content'), false));
      if (!(content.startsWith('<tool_response>') && content.endsWith('</tool_response>'))) {
        multiStepTool = false;
        lastQueryIndex = index;
      }
    }
  }
  if (multiStepTool) throw new Qwen3TemplateError('No user query found in messages.');
  const preserve = vars.preserve_thinking === true;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    let content = pyStrip(renderContent(attr(message, 'content'), false));
    const role = attr(message, 'role');
    if (role === 'system') {
      if (i !== 0) throw new Qwen3TemplateError('System message must be at the beginning.');
    } else if (role === 'user') {
      out += '<|im_start|>' + role + '\n' + content + '<|im_end|>' + '\n';
    } else if (role === 'assistant') {
      let reasoning = '';
      const rc = attr(message, 'reasoning_content');
      if (typeof rc === 'string') reasoning = rc;
      else if (content.includes('</think>')) {
        reasoning = lstripNl(rstripNl(content.split('</think>')[0]!).split('<think>').at(-1)!);
        content = lstripNl(content.split('</think>').at(-1)!);
      }
      reasoning = pyStrip(reasoning);
      if (preserve || i > lastQueryIndex) out += '<|im_start|>' + role + '\n<think>\n' + reasoning + '\n</think>\n\n' + content;
      else out += '<|im_start|>' + role + '\n' + content;
      const calls = attr(message, 'tool_calls');
      if (truthy(calls) && Array.isArray(calls)) {
        calls.forEach((c, k) => {
          const call = attr(c, 'function') !== undefined ? attr(c, 'function') : c;
          const name = strCat(attr(call, 'name'));
          if (k === 0) out += pyStrip(content) ? '\n\n<tool_call>\n<function=' + name + '>\n' : '<tool_call>\n<function=' + name + '>\n';
          else out += '\n<tool_call>\n<function=' + name + '>\n';
          const args = attr(call, 'arguments');
          if (args !== undefined) {
            if (!isMap(args)) throw new Qwen3TemplateError('Can only get item pairs from a mapping.');
            for (const [argName, argValue] of args) {
              out += '<parameter=' + argName + '>\n';
              out += typeof argValue === 'string' ? argValue : tojson(argValue);
              out += '\n</parameter>\n';
            }
          }
          out += '</function>\n</tool_call>';
        });
      }
      out += '<|im_end|>\n';
    } else if (role === 'tool') {
      const prev = i > 0 ? messages[i - 1] : undefined;
      if (truthy(prev) && attr(prev, 'role') !== 'tool') out += '<|im_start|>user';
      out += '\n<tool_response>\n' + content + '\n</tool_response>';
      const last = i === messages.length - 1;
      if (!last && attr(messages[i + 1], 'role') !== 'tool') out += '<|im_end|>\n';
      else if (last) out += '<|im_end|>\n';
    } else {
      throw new Qwen3TemplateError('Unexpected message role.');
    }
  }
  if (truthy(vars.add_generation_prompt)) {
    out += '<|im_start|>assistant\n';
    out += vars.enable_thinking === false ? '<think>\n\n</think>\n\n' : '<think>\n';
  }
  return out;
}

// ---------------------------------------------------------------- vLLM request preprocessing

const TEXT_TYPES: Record<string, string> = { text: 'text', input_text: 'text', output_text: 'text', refusal: 'refusal', thinking: 'thinking' };
const MEDIA: Record<string, string> = {
  image_url: 'image', input_image: 'image', image_embeds: 'image', image_pil: 'image',
  video_url: 'video', video_embeds: 'video', audio_url: 'audio', input_audio: 'audio', audio_embeds: 'audio',
};
const obj = (entries: Array<[string, PyValue]>): PyObject => new Map(entries);

/** _parse_chat_message_content_part (wrap_dicts=True); null = skipped. */
function parsePart(part: PyValue): PyObject | null {
  if (typeof part === 'string') return obj([['type', 'text'], ['text', part]]);
  if (!isMap(part)) throw new VllmValidationError('Invalid content part.');
  let type = part.get('type');
  if (type === undefined || type === null || part.get('uuid') !== undefined && part.get('uuid') !== null) {
    const found = ['image_url', 'image_pil', 'image_embeds', 'audio_embeds', 'video_embeds', 'prompt_embeds', 'audio_url', 'input_audio', 'video_url', 'tool_reference'].find((k) => part.has(k));
    if (!found) throw new VllmValidationError("Missing 'type' field in multimodal part.");
    type = found;
  }
  if (typeof type !== 'string') throw new VllmValidationError("Invalid 'type' field in multimodal part.");
  const textKey = TEXT_TYPES[type];
  if (textKey !== undefined) {
    const text = part.get(textKey) ?? null;
    if ((type === 'text' || type === 'refusal') && text === null) return null;
    return obj([['type', 'text'], ['text', text]]);
  }
  const modality = MEDIA[type];
  if (modality !== undefined) return obj([['type', modality]]);
  if (type === 'tool_reference') return obj([['type', 'tool_reference'], ['name', part.get('name') ?? null]]);
  if (type === 'prompt_embeds') throw new VllmValidationError('prompt_embeds are not supported by the mock.');
  throw new VllmValidationError(`Unsupported chat content part type: '${type}'.`);
}

/** _postprocess_messages: tool-call arguments to dicts, [] dropped. */
function postprocessCalls(m: PyObject): void {
  if (m.get('role') !== 'assistant' || !m.has('tool_calls')) return;
  const calls = m.get('tool_calls');
  if (!Array.isArray(calls)) return;
  if (!calls.length) {
    m.delete('tool_calls');
    return;
  }
  const out: PyValue[] = [];
  for (const item of calls) {
    if (!isMap(item)) throw new VllmValidationError('assistant tool_calls entries must be objects.');
    const fn = item.get('function');
    const type = item.has('type') ? item.get('type') : 'function';
    if (type !== 'function' || !isMap(fn)) throw new VllmValidationError("chat completions only support assistant tool_calls of type 'function'.");
    const a = fn.get('arguments');
    let parsed: PyValue = obj([]);
    if (truthy(a)) {
      if (isMap(a)) parsed = a;
      else if (typeof a === 'string') {
        try {
          const p = parsePyJson(a);
          parsed = isMap(p) ? p : obj([]);
        } catch {
          parsed = obj([]);
        }
      }
    }
    const fn2 = new Map(fn);
    fn2.set('arguments', parsed);
    const item2 = new Map(item);
    item2.set('function', fn2);
    out.push(item2);
  }
  m.set('tool_calls', out);
}

/** vLLM's view of one request: the conversation, the tool dicts and the template variables. */
export function vllmConversation(body: PyValue): { messages: PyObject[]; tools: PyValue[] | null; vars: Qwen3Vars } {
  if (!isMap(body)) throw new VllmValidationError('The request body must be a JSON object.');
  const raw = body.get('messages');
  if (!Array.isArray(raw)) throw new VllmValidationError('messages must be a list.');
  const conversation: PyObject[] = [];
  for (const m0 of raw) {
    if (!isMap(m0)) throw new VllmValidationError('Each message must be an object.');
    // protocol.py _normalize_messages_before: reasoning_content -> reasoning
    const msg = new Map(m0);
    const rc = msg.get('reasoning_content');
    msg.delete('reasoning_content');
    if (rc !== undefined && rc !== null && (msg.get('reasoning') ?? null) === null) msg.set('reasoning', rc);
    const role = msg.get('role') ?? null;
    let content = msg.get('content');
    let parts: PyValue[];
    if (content === undefined || content === null) parts = [];
    else if (typeof content === 'string') parts = [obj([['type', 'text'], ['text', content]])];
    else if (Array.isArray(content)) parts = content.map(parsePart).filter((p): p is PyObject => p !== null);
    else throw new VllmValidationError('Invalid message content.');
    const res: PyObject = obj([['role', role], ['content', parts]]);
    if (role === 'assistant') {
      const calls = msg.get('tool_calls');
      if (calls !== undefined && calls !== null) {
        if (!Array.isArray(calls)) throw new VllmValidationError('tool_calls must be a list.');
        res.set('tool_calls', [...calls]);
      }
      const reasoning = msg.get('reasoning');
      if (reasoning !== undefined && reasoning !== null) {
        res.set('reasoning', reasoning);
        res.set('reasoning_content', reasoning);
      }
    } else if (role === 'tool') {
      if (msg.has('tool_call_id')) res.set('tool_call_id', msg.get('tool_call_id')!);
      const nonText = parts.some((p) => isMap(p) && p.get('type') !== 'text');
      if (!nonText) {
        content = parts.filter((p) => isMap(p) && p.get('type') === 'text').map((p) => pyStrOf(attr(p, 'text') ?? '')).join('\n');
        res.set('content', content);
      }
    }
    conversation.push(res);
  }
  conversation.forEach(postprocessCalls);
  // hf.py: developer -> system, then consolidation (the Qwen3.6 template has no developer role)
  let messages = conversation;
  if (messages.some((m) => m.get('role') === 'developer')) {
    messages = messages.map((m) => (m.get('role') === 'developer' ? new Map([...m, ['role', 'system']]) : m));
    const sys: string[] = [];
    const rest: PyObject[] = [];
    let needs = false;
    messages.forEach((m, i) => {
      if (m.get('role') === 'system') {
        if (i > 0 || sys.length) needs = true;
        let c = m.has('content') ? m.get('content')! : '';
        if (Array.isArray(c)) c = c.flatMap((p) => (isMap(p) && p.has('text') ? [pyStrOf(p.get('text'))] : typeof p === 'string' ? [p] : [])).join('\n');
        if (truthy(c)) sys.push(pyStrOf(c));
      } else rest.push(m);
    });
    if (needs) messages = [obj([['role', 'system'], ['content', sys.join('\n\n')]]), ...rest];
  }
  // tools: ChatCompletionToolsParam.model_dump()
  const t = body.get('tools');
  let tools: PyValue[] | null = null;
  if (t !== undefined && t !== null) {
    if (!Array.isArray(t)) throw new VllmValidationError('tools must be a list.');
    tools = t.map((tool) => {
      const fn = attr(tool, 'function');
      if (!isMap(tool) || !isMap(fn) || typeof fn.get('name') !== 'string' || (tool.has('type') && tool.get('type') !== 'function'))
        throw new VllmValidationError('Invalid tool definition.');
      const top = tool.get('defer_loading') ?? null;
      const f: PyObject = obj([['name', fn.get('name')!], ['description', fn.get('description') ?? null], ['parameters', fn.get('parameters') ?? null]]);
      if ((fn.get('strict') ?? null) !== null) f.set('strict', fn.get('strict')!);
      const defer = fn.get('defer_loading') ?? top;
      if (defer !== null) f.set('defer_loading', defer);
      const out: PyObject = obj([['type', 'function'], ['function', f]]);
      if (top !== null) out.set('defer_loading', top);
      return out;
    });
  }
  const kw = body.get('chat_template_kwargs');
  const vars: Qwen3Vars = { add_generation_prompt: body.has('add_generation_prompt') ? body.get('add_generation_prompt')! : true };
  if (isMap(kw)) {
    if (kw.has('enable_thinking')) vars.enable_thinking = kw.get('enable_thinking')!;
    if (kw.has('preserve_thinking')) vars.preserve_thinking = kw.get('preserve_thinking')!;
  }
  return { messages, tools, vars };
}

/** The prompt text a Qwen3.6 vLLM server builds for this request body (raw JSON text or an already parsed tree). */
export function renderQwen3(body: string | PyValue): string {
  const tree = typeof body === 'string' ? parsePyJson(body) : body;
  const { messages, tools, vars } = vllmConversation(tree);
  return renderQwen3Template(messages, tools, vars);
}
