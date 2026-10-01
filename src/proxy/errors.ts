// Upstream error classification (DESIGN.md "Error map", ; reference implementation).
//
// An error is a non-2xx HTTP response, or the first SSE event of a 200 stream when it carries a
// top-level `error` (in-stream, status from error.code / error.http_status_code). Classification:
//   1. exclusions first (config errors.exclusions, then the built-ins: rate limits, stream_options);
//   2. rules in order (config errors.custom, then the built-ins when errors.useBuiltin), first match wins.
//      A rule's `status` gates it: omitted = any status (in-stream included), `null` = in-stream only.
//      Built-in *specific-text* rules omit `status`, so they still match a vLLM body that a gateway
//      re-statused as 500; only the generic ones (413, gateway 5xx, the vague "suspect" wording) are
//      status-gated (). The regex runs on the raw body (`on: 'body'`, default) or on the extracted
//      message (`on: 'message'`: error.message ?? error-as-string ?? message).
//   3. numbers from named groups (window, prompt, completion, total, maxInput, chars, atLeast) and from
//      `json` paths; `lowerBound` / `lowerBoundIf` mark the prompt number as a lower bound.
// Numbers count as "from the message" ( (i)) when the same regex also matches the extracted message
// (its groups are then used), or when they come from structured JSON fields: a number that appears
// only elsewhere in the body (echoed input) never teaches a window.
import type { Config } from '../config/schema.js';
import type { ClassifiedError, ErrorExclusion, ErrorKind, ErrorRule } from '../types.js';
import { extractErrorMessage } from '../dialect/openai-chat.js';

/** The built-in error map (reference implementation, adapted to ). Order matters. */
export const BUILTIN_RULES: readonly ErrorRule[] = [
  { id: 'vllm.v018.total', server: 'vllm>=0.18', kind: 'overflow_total', lowerBoundIf: 'atLeast',
    match: "This model's maximum context length is (?<window>\\d+) tokens\\. However, you requested (?<completion>\\d+) output tokens and your prompt contains (?<atLeast>at least )?(?<prompt>\\d+) input tokens" },
  { id: 'vllm.v018.chars', server: 'vllm>=0.18', kind: 'overflow_total',
    match: "This model's maximum context length is (?<window>\\d+) tokens\\. However, you requested (?<completion>\\d+) output tokens and your prompt contains (?<chars>\\d+) characters \\(more than \\d+ characters, which is the upper bound for (?<maxInput>\\d+) input tokens\\)" },
  { id: 'vllm.v016.tokens', server: 'vllm 0.16-0.17', kind: 'overflow_total', lowerBound: true,
    match: "You passed (?<prompt>\\d+) input tokens and requested (?<completion>\\d+) output tokens\\. However, the model's context length is only (?<window>\\d+) tokens, resulting in a maximum input length of (?<maxInput>\\d+) tokens" },
  { id: 'vllm.v016.chars', server: 'vllm 0.16-0.17', kind: 'overflow_total',
    match: "You passed (?<chars>\\d+) input characters and requested (?<completion>\\d+) output tokens\\. However, the model's context length is only (?<window>\\d+) tokens" },
  { id: 'vllm.v011.total', server: 'vllm 0.11-0.15', kind: 'overflow_total',
    match: "'max_tokens' or 'max_completion_tokens' is too large: (?<completion>\\d+)\\. This model's maximum context length is (?<window>\\d+) tokens and your request has (?<prompt>\\d+) input tokens" },
  { id: 'vllm.v011.prompt', server: 'vllm 0.11-0.15', kind: 'overflow_prompt',
    match: "This model's maximum context length is (?<window>\\d+) tokens\\. However, your request has (?<prompt>\\d+) input tokens" },
  { id: 'vllm.legacy.total', server: 'vllm<=0.10', kind: 'overflow_total',
    match: "This model's maximum context length is (?<window>\\d+) tokens\\. However, you requested (?<total>\\d+) tokens \\((?<prompt>\\d+) in the messages, (?<completion>\\d+) in the completion\\)" },
  { id: 'vllm.legacy.prompt', server: 'vllm<=0.10', kind: 'overflow_prompt',
    match: "This model's maximum context length is (?<window>\\d+) tokens\\. However, you requested (?<prompt>\\d+) tokens in the (?:messages|input)" },
  { id: 'vllm.max_tokens_gt_window', server: 'vllm>=0.16', kind: 'max_tokens_too_large',
    match: '(?:max_tokens|max_completion_tokens)=(?<completion>\\d+) cannot be greater than max_model_len=(?<window>\\d+)' },
  { id: 'vllm.engine.prompt', server: 'vllm (engine)', kind: 'overflow_prompt',
    match: 'The (?:decoder )?prompt \\(length (?<prompt>\\d+)\\) (?:plus the number of requested output tokens \\(at least 1\\) )?is longer than the maximum model length of (?<window>\\d+)' },
  { id: 'vllm.any', server: 'vllm (any, fallback)', kind: 'overflow_total',
    match: "This model's maximum context length is (?<window>\\d+) tokens" },
  { id: 'sglang.total', server: 'sglang', kind: 'overflow_total',
    match: "Requested token count exceeds the model's maximum context length of (?<window>\\d+) tokens\\. You requested a total of (?<total>\\d+) tokens: (?<prompt>\\d+) tokens from the input messages and (?<completion>\\d+) tokens for the completion" },
  { id: 'sglang.prompt', server: 'sglang', kind: 'overflow_prompt',
    match: "The input \\((?<prompt>\\d+) tokens\\) is longer than the model's context length \\((?<window>\\d+) tokens\\)" },
  { id: 'sglang.sched', server: 'sglang (scheduler)', kind: 'overflow_prompt',
    match: 'Input length \\((?<prompt>\\d+) tokens\\) exceeds the maximum allowed length \\((?<maxInput>\\d+) tokens\\)' },
  { id: 'sglang.kv', server: 'sglang (scheduler)', kind: 'overflow_prompt',
    match: 'Request prompt exceeds the KV memory budget: input_len=(?<prompt>\\d+)' },
  { id: 'llamacpp.new', server: 'llama.cpp >= b7498', kind: 'overflow_prompt',
    match: 'request \\((?<prompt>\\d+) tokens\\) exceeds the available context size \\((?<window>\\d+) tokens\\)',
    json: { prompt: 'error.n_prompt_tokens', window: 'error.n_ctx' } },
  { id: 'llamacpp.new.nosplit', server: 'llama.cpp >= b7498', kind: 'overflow_prompt',
    match: 'input \\((?<prompt>\\d+) tokens\\) is larger than the max context size \\((?<window>\\d+) tokens\\)',
    json: { prompt: 'error.n_prompt_tokens', window: 'error.n_ctx' } },
  { id: 'llamacpp.old', server: 'llama.cpp <= b6936', kind: 'overflow_prompt',
    match: '(?:the request exceeds the available context size|input is larger than the max context size)',
    json: { prompt: 'error.n_prompt_tokens', window: 'error.n_ctx' } },
  { id: 'llamacpp.type', server: 'llama.cpp', kind: 'overflow_prompt',
    match: '"type"\\s*:\\s*"exceed_context_size_error"',
    json: { prompt: 'error.n_prompt_tokens', window: 'error.n_ctx' } },
  { id: 'tgi.total', server: 'tgi', kind: 'overflow_total',
    match: '`inputs` tokens \\+ `max_new_tokens` must be <= (?<window>\\d+)\\. Given: (?<prompt>\\d+) `inputs` tokens and (?<completion>\\d+) `max_new_tokens`',
    note: 'completion is min(max_tokens, 1024), not the requested max_tokens' },
  { id: 'tgi.prompt', server: 'tgi', kind: 'overflow_prompt',
    match: '`inputs` must have less than (?<maxInput>\\d+) tokens\\. Given: (?<prompt>\\d+)' },
  { id: 'lmstudio.keep', server: 'lmstudio', kind: 'overflow_prompt', lowerBound: true,
    match: 'Trying to keep the first (?<prompt>\\d+) tokens when context the overflows\\. However, the model is loaded with context length of only (?<window>\\d+) tokens',
    note: 'prompt = the part LM Studio must keep (system + first user message): a lower bound' },
  { id: 'llamacpp.nkeep.legacy', server: 'lmstudio / old llama.cpp', kind: 'overflow_prompt',
    match: '(?:The number of tokens to keep from the initial prompt is greater than the context length|n_keep: (?<prompt>\\d+)\\s*>= n_ctx: (?<window>\\d+))' },
  { id: 'ollama.prompt', server: 'ollama', kind: 'overflow_prompt',
    match: '(?:the prompt is longer than the context length currently available to the model|input (?:after truncation )?exceeds (?:the )?maximum context length|the input length exceeds the context length)' },
  { id: 'litellm.cwe', server: 'litellm proxy', kind: 'overflow_unknown',
    match: '(?:ContextWindowExceededError|litellm\\._pre_call_checks: Context Window exceeded)' },
  { id: 'openai.code', server: 'generic OpenAI-style', kind: 'overflow_unknown', match: 'context_length_exceeded' },
  // generic entries stay status-gated ()
  { id: 'http.413', server: 'gateway', status: [413], kind: 'payload_too_large', match: '' },
  { id: 'gateway.5xx', server: 'gateway', status: [502, 503, 504], kind: 'gateway_error', match: '' },
  { id: 'generic.suspect', server: 'unknown', status: [400, 413, 422], kind: 'overflow_suspect', flags: 'i',
    match: 'context (?:length|window|size)|maximum context|too many tokens|prompt is too long|reduce the length|token limit' },
];

/** Built-in exclusions: never an overflow (checked before every rule). */
export const BUILTIN_EXCLUSIONS: readonly ErrorExclusion[] = [
  { id: 'rate_limit', match: 'rate limit|too many requests|throttl', flags: 'i' },
  { id: 'stream_options', match: 'Stream options can only be defined when `stream=True`' },
];

/** The exclusion id whose match triggers the include_usage retry (). */
export const STREAM_OPTIONS_EXCLUSION = 'stream_options';

export interface ErrorInput {
  /** effective status: the HTTP status, or the status an in-stream error carries */
  status: number;
  /** raw error body (HTTP) or the event payload (in-stream `data:` JSON, or the `error:` field value) */
  body: string;
  inStream: boolean;
}

export interface Classification extends ClassifiedError {
  maxInput?: number;
  total?: number;
  chars?: number;
  /** the numbers come from the extracted message or from structured JSON fields ( (i)) */
  numbersInMessage: boolean;
}

type NumKey = 'window' | 'prompt' | 'completion' | 'total' | 'maxInput' | 'chars';
const NUM_KEYS: readonly NumKey[] = ['window', 'prompt', 'completion', 'total', 'maxInput', 'chars'];

interface CompiledRule {
  rule: ErrorRule;
  re: RegExp | null;
}

/** Dotted path lookup (`error.n_ctx`); array indices allowed. */
export function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const toInt = (x: unknown): number | undefined => {
  const n = typeof x === 'number' ? x : typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

function compile(source: string, flags: string | undefined, id: string): RegExp {
  try {
    return new RegExp(source, flags ?? '');
  } catch (e) {
    throw new Error(`errors: invalid regex in entry ${id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export class ErrorClassifier {
  private readonly exclusions: Array<{ id: string; re: RegExp }>;
  private readonly rules: CompiledRule[];

  /** Throws on an invalid regex (a config error, reported at startup). */
  constructor(cfg: Pick<Config['errors'], 'useBuiltin' | 'custom' | 'exclusions'>) {
    this.exclusions = [...cfg.exclusions, ...BUILTIN_EXCLUSIONS].map((x) => ({ id: x.id, re: compile(x.match, x.flags, x.id) }));
    const rules = [...cfg.custom, ...(cfg.useBuiltin ? BUILTIN_RULES : [])];
    this.rules = rules.map((rule) => ({ rule, re: rule.match === '' ? null : compile(rule.match, rule.flags, rule.id) }));
  }

  classify(input: ErrorInput): Classification {
    const { status, body, inStream } = input;
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      json = undefined;
    }
    // Non-JSON bodies (HTML pages, plain text) have no structure to hide echoed input in.
    const message = json === undefined ? body : extractErrorMessage(json);
    const base: Classification = { kind: 'unmatched', status, inStream, numbersInMessage: false };
    if (message !== undefined) base.message = message;

    for (const x of this.exclusions) {
      if (x.re.test(body)) return { ...base, kind: 'excluded', ruleId: x.id };
    }
    for (const { rule, re } of this.rules) {
      if (rule.status !== undefined && !rule.status.includes(inStream ? null : status)) continue;
      const target = rule.on === 'message' ? message : body;
      if (target === undefined) continue;
      const m = re ? re.exec(target) : null;
      if (re && !m) continue;
      return this.extract(base, rule, re, m, message, json);
    }
    return base;
  }

  private extract(
    base: Classification,
    rule: ErrorRule,
    re: RegExp | null,
    m: RegExpExecArray | null,
    message: string | undefined,
    json: unknown,
  ): Classification {
    const out: Classification = { ...base, kind: rule.kind as ErrorKind, ruleId: rule.id };
    let groups = m?.groups ?? {};
    let inMessage = rule.on === 'message';
    if (re && !inMessage && message !== undefined) {
      const mm = re.exec(message);
      if (mm) {
        groups = mm.groups ?? {};
        inMessage = true;
      }
    }
    const nums: Partial<Record<NumKey, number>> = {};
    for (const k of NUM_KEYS) {
      const v = toInt(groups[k]);
      if (v !== undefined) nums[k] = v;
    }
    let fromJson = false;
    if (rule.json && json !== undefined) {
      for (const [k, path] of Object.entries(rule.json)) {
        if (!(NUM_KEYS as readonly string[]).includes(k)) continue;
        const v = toInt(getPath(json, path));
        if (v !== undefined) {
          nums[k as NumKey] = v; // structured fields beat regex groups
          fromJson = true;
        }
      }
    }
    const any = Object.keys(nums).length > 0;
    out.numbersInMessage = any && (inMessage || fromJson);
    if (nums.window !== undefined) out.window = nums.window;
    if (nums.prompt !== undefined) out.promptTokens = nums.prompt;
    if (nums.completion !== undefined) out.completionTokens = nums.completion;
    if (nums.total !== undefined) out.total = nums.total;
    if (nums.maxInput !== undefined) out.maxInput = nums.maxInput;
    if (nums.chars !== undefined) out.chars = nums.chars;
    if (out.promptTokens !== undefined) {
      out.promptIsLowerBound = rule.lowerBound === true || (rule.lowerBoundIf !== undefined && groups[rule.lowerBoundIf] !== undefined);
    }
    return out;
  }
}

// ---------------------------------------------------------------- validation of learned numbers ()

export interface NumbersContext {
  /** budget.window (the configured window) */
  configuredWindow: number;
  /** raw (uncorrected) count of the rejected request */
  rejectedRaw: number;
}

export interface ValidatedNumbers {
  /** an accepted window (only ever lower than configured) */
  window: number | null;
  /** an accepted server-side prompt limit (SGLang scheduler maxInput, TGI max_input_tokens) */
  maxPrompt: number | null;
  /** an exact prompt count in the [0.8, 1.25]× band of our count */
  promptExact: number | null;
  /** a lower-bound prompt count */
  promptLowerBound: number | null;
  /** why a window or limit number was refused (logs/status only) */
  refused: string | null;
}

/**
 * Accepts learned numbers only when ():
 *  (i) they were matched in the extracted message (or structured JSON fields), not in echoed input;
 *  (ii) 0.5 · budget.window ≤ window < budget.window;
 *  (iii) any exact prompt number in the same body is within [0.8, 1.25]× our count of the rejected request.
 * maxPrompt is learned only from a limit that is not a window (maxInput with no window number):
 * SGLang's scheduler and TGI's max_input_tokens, never vLLM's L − M. TGI's "must have less than N"
 * is stored as N − 1.
 */
export function validateNumbers(c: Classification, ctx: NumbersContext): ValidatedNumbers {
  const out: ValidatedNumbers = { window: null, maxPrompt: null, promptExact: null, promptLowerBound: null, refused: null };
  if (!c.numbersInMessage) {
    if (c.window !== undefined || c.maxInput !== undefined) out.refused = 'numbers not in the error message';
    return out;
  }
  const W = ctx.configuredWindow;
  const raw = ctx.rejectedRaw;
  let bandOk = true;
  if (c.promptTokens !== undefined) {
    if (c.promptIsLowerBound) out.promptLowerBound = c.promptTokens;
    else if (raw > 0 && c.promptTokens >= 0.8 * raw && c.promptTokens <= 1.25 * raw) out.promptExact = c.promptTokens;
    else bandOk = false;
  }
  if (!bandOk) {
    out.refused = 'prompt number outside [0.8, 1.25] of our count';
    return out;
  }
  if (c.window !== undefined) {
    if (c.window >= 0.5 * W && c.window < W) out.window = c.window;
    else out.refused = `window ${c.window} outside [0.5, 1) of the configured window`;
  } else if (c.maxInput !== undefined) {
    const limit = c.ruleId === 'tgi.prompt' ? c.maxInput - 1 : c.maxInput;
    if (limit >= 0.25 * W && limit < W) out.maxPrompt = limit;
    else out.refused = `prompt limit ${limit} outside [0.25, 1) of the configured window`;
  }
  return out;
}

/** Kinds that are overflows the ladder re-plans for. */
export const OVERFLOW_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['overflow_prompt', 'overflow_total', 'overflow_unknown']);

/** Kinds that are translated to a 400 context_length_exceeded once recovery is exhausted (). */
export const TRANSLATED_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>(['overflow_prompt', 'overflow_total', 'overflow_unknown', 'max_tokens_too_large']);

/**
 * Overshoot of a rejection (§8), recorded in stats and /status: total-mode bodies P + M − W, prompt-mode
 * bodies P − W, lower-bound bodies P_lb − W. Undefined without both numbers.
 */
export function overshootOf(c: Classification): number | undefined {
  if (c.window === undefined || c.promptTokens === undefined) return undefined;
  if (c.promptIsLowerBound) return c.promptTokens - c.window;
  if (c.kind === 'overflow_total') return c.promptTokens + (c.completionTokens ?? 0) - c.window;
  return c.promptTokens - c.window;
}
