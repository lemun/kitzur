/**
 * Shared contracts. Shared across the engine, proxy, configuration and benchmark modules.
 * See DESIGN.md for semantics.
 */

// ---------------------------------------------------------------- wire model (OpenAI Chat Completions)

export interface TextPart { type: 'text'; text: string; [k: string]: unknown }
export interface ImagePart { type: 'image_url'; image_url: { url: string; detail?: string }; [k: string]: unknown }
export interface OtherPart { type: string; [k: string]: unknown }
export type ContentPart = TextPart | ImagePart | OtherPart;
export type MessageContent = string | ContentPart[] | null | undefined;

export interface ToolCall {
  id: string;
  type?: 'function' | string;
  function: { name: string; arguments: string };
  [k: string]: unknown;
}

export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function' | string;
  content?: MessageContent;
  tool_calls?: ToolCall[] | null;
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string | null;
  reasoning?: string | null;
  [k: string]: unknown;
}

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: unknown[];
  max_tokens?: number | null;
  max_completion_tokens?: number | null;
  stream?: boolean;
  stream_options?: { include_usage?: boolean; [k: string]: unknown } | null;
  [k: string]: unknown;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [k: string]: unknown;
}

// ---------------------------------------------------------------- counting

/** 'remote' exists only as a calibration source used by the proxy (DESIGN §4, ); the engine refuses it. */
export type CounterMode = 'exact' | 'remote' | 'estimate';

/** Context a template profile needs to count one message exactly (neighbours change wrappers in some templates). */
/** Render context of one message, computed on the counted candidate alone (DESIGN §4, ). */
export interface MessageContext {
  /** index inside the candidate being counted */
  index: number;
  prevRole: string | null;
  /** null for the candidate's last message */
  nextRole: string | null;
  firstInToolGroup: boolean;
  lastInToolGroup: boolean;
  /** after the candidate's last user message whose trimmed text is not entirely <tool_response>…</tool_response>
   *  (the kitzur summary counts as a query) */
  afterLastQuery: boolean;
  preserveThinking: boolean;
}

export interface Measure {
  /** token contribution of each message, aligned with req.messages. When a template merges the tools
   *  block into the first system message's segment (sim, qwen3), that whole segment is attributed to message 0. */
  perMessage: number[];
  /** everything not attributable to a message: tools block (when not merged), generation prompt, BOS, ... */
  overhead: number;
  /** exact prompt tokens of the rendered request = Σ perMessage + overhead (no calibration applied) */
  total: number;
}

export interface TokenCounter {
  readonly mode: CounterMode;
  /** identity of tokenizer + template (goes into the planning-config hash) */
  readonly id: string;
  /** Tokens of plain text (no template); added/special tokens inside the text count as one each. */
  countText(text: string): number;
  /**
   * Exact (mode 'exact') or estimated token accounting of the rendered prompt. Pure and synchronous.
   * Callers must not mutate measured message objects or the tools array afterwards (the counter memoizes by
   * object identity when no digests are supplied); the engine always passes its digests.
   * `digests` are the engine's per-message digests (same order), used as cache keys; the counter computes
   * its own if absent. The render context of a message (neighbours) is part of its cache key.
   */
  measure(req: ChatRequest, digests?: string[]): Measure;
  /** = measure(req, digests).total */
  countRequest(req: ChatRequest, digests?: string[]): number;
  /**
   * Remote mode only: fetch counts for the request's message segments from the gateway tokenize endpoint
   * so that the following synchronous measure() hits the cache. Proxy-generated text (summaries, stubs,
   * truncations) is estimated. Resolves (never rejects) — on failure the estimate is used.
   */
  prefetch?(req: ChatRequest): Promise<void>;
}

// ---------------------------------------------------------------- engine

/** Replacement for one original message (DESIGN.md step 1, §5.5a, §5.6). */
export interface Rewrite {
  /** stub (superseded snapshot), slim (snapshot slimming), truncate (head+tail cut), reasoning (dropped),
   *  image (image parts omitted), args (assistant content / tool-call argument strings cut, JSON kept valid) */
  kind: 'stub' | 'slim' | 'truncate' | 'reasoning' | 'image' | 'args';
  /** 'admission' = applied to a message never forwarded before (§5.5a); otherwise made at a compaction */
  stage: 'admission' | 'compaction';
  message: ChatMessage;
}

/** Bumped on any change of engine behaviour; part of the planning inputs (§5.3). */
export const ENGINE_ALGO_VERSION = 'kitzur-engine/3';

export interface Plan {
  version: 2;
  /** ENGINE_ALGO_VERSION that produced it */
  engine: string;
  /** number of original messages this plan was made for (a boundary) */
  n: number;
  /** end of the head: first assistant index, extended over a client-written summary (§5.1) */
  hEnd: number;
  /** first original index kept after the summary; == hEnd when nothing is summarized */
  cut: number;
  /** full text of the summary message; null iff cut == hEnd */
  summary: string | null;
  /** head replacements (indices < hEnd; only oversize.headPolicy 'truncate' of the first user message) */
  headRewrites: Record<number, Rewrite>;
  /** original index -> replacement, only for indices in [cut, n) */
  rewrites: Record<number, Rewrite>;
  compactions: number;
  /** result of the fit loop (§5.4 step 4) */
  fit: 'ok' | 'over_hard' | 'over_budget';
  /** plan key (chain key of H[0..n) combined with the planning-inputs hash) */
  key: string;
  /** diagnostics only (never affects output) */
  meta?: Record<string, number | string | boolean>;
}

export type EngineAction =
  | 'passthrough'     // forwarded unchanged (below trigger, never compacted)
  | 'reuse'           // existing plan applied, appended messages verbatim
  | 'compact'         // new plan made at this request
  | 'admit'           // only admission rewrites of never-forwarded messages (§5.5a)
  | 'truncate'        // final plan over budget but serverFits: forwarded with fitted max_tokens (§5.7a)
  | 'clamp'           // plan reused, max_tokens lowered instead of compacting (§3)
  | 'restore'         // max_tokens raised back (Kilo) (§3)
  | 'shadow'          // shadow mode: computed but forwarded unchanged
  | 'impossible'      // documented 400 returned, no upstream call (§5.7)
  | 'guard_fallback'  // guard failed or engine threw; original forwarded because it fits the server limit (§5.8)
  | 'guard_reject';   // guard failed or engine threw; original does not fit; §5.7 400 returned

export interface Budget {
  window: number;
  /** T_req of this request */
  maxTokensRequested: number;
  /** T_plan (config only) */
  planMaxTokens: number;
  margin: number;
  budget: number;
  clientPoint: number;
  allowance: number;
  hard: number;
  trigger: number;
  target: number;
  mode: 'strict_total' | 'prompt_only' | 'tgi' | 'silent_truncate';
  /** effective tighten (learned + request-local) */
  tighten: number;
  /** effective byte limit of bytes(JSON.stringify(messages)) + fixedBytes; null = none */
  byteLimit: number | null;
  summaryBudget: number;
  admitTokens: number | null;
  headRoom: number;
}

export interface EngineStats {
  messagesIn: number;
  messagesOut: number;
  tokensIn: number;
  tokensOut: number;
  budget: Budget;
  compactions: number;
  summaryTokens: number;
  ledgerTokens: number;
  rewrites: number;
  boundariesReplayed: number;
  cacheHits: number;
  engineMs: number;
  guard?: string;
}

export interface EngineResult {
  action: EngineAction;
  /** request to forward (the input object itself when unchanged); null for impossible / guard_reject */
  request: ChatRequest | null;
  changed: boolean;
  /** forwarded max tokens value and which fields carry it; null = unchanged (§3 "Forwarded max_tokens") */
  maxTokens: { value: number; fields: Array<'max_tokens' | 'max_completion_tokens'> } | null;
  plan: Plan | null;
  sessionKey: string;
  stats: EngineStats;
  /** for impossible / guard_reject: the client-facing error (HTTP 400 body) */
  error?: { status: number; body: unknown };
  impossibleKind?: 'fixed' | 'content';
  /** human-readable reason (logs only; never content) */
  reason?: string;
  /** why the memo missed (stats) */
  replan?: 'inputs_changed' | 'client_mutation' | 'new_session';
}

export interface ProcessOptions {
  /** learned entry to plan with (defaults to the engine's current one); recovery passes an updated copy */
  learned?: LearnedEntry;
  /** request-local extra tighten (ambiguous-error retries, §8) — not persisted */
  extraTighten?: number;
  /** 1 = first attempt; >= 2 = retry (the original is never forwarded on a retry) */
  attempt: number;
  /** never use the clamp path */
  noClamp?: boolean;
  /** compute but do not store plans */
  dryRun?: boolean;
}

export interface Engine {
  process(req: ChatRequest, opts: ProcessOptions): EngineResult;
  /** learned entry for (origin, model) currently applied */
  learned(key: string): LearnedEntry;
  /** replace a learned entry (after an overflow or calibration update); the caller persists it before the next request */
  setLearned(key: string, e: LearnedEntry): void;
}

// ---------------------------------------------------------------- stats (one JSONL record per client chat request; sizes only)

export interface AttemptRecord {
  status: number | null;
  kind: ErrorKind | 'ok';
  inStream: boolean;
  /** raw (uncorrected) prompt tokens and serialized bytes of what was sent */
  raw: number;
  bytes: number;
  maxTokens: number;
  overshoot?: number;
  upstreamMs: number;
}

export interface StatsRecord {
  seq: number;
  ts: string;
  session: string;
  path: string;
  action: EngineAction;
  replan?: 'inputs_changed' | 'client_mutation' | 'new_session';
  fit?: Plan['fit'];
  messages_in: number;
  messages_out: number;
  tokens_in: number;
  tokens_out: number;
  budget: number;
  trigger: number;
  maxtokens_fit?: boolean;
  attempts: AttemptRecord[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  usage_mismatch?: boolean;
  upstream_rejected_rewrite?: boolean;
  guard?: string;
  engine_ms: number;
  total_ms: number;
  client_status: number;
  /* gobstopper-compatible fields (analyze.py / replay_session.py read these) */
  compacted: boolean;
  reused_prefix: boolean;
  rung: number;
  over_budget: boolean;
  est_tokens_in: number;
  est_tokens_out: number;
  est_summary_tokens: number;
  carry_chars: number;
  threshold_tokens: number;
  ratio_permille: number;
}

// ---------------------------------------------------------------- ledger

export type FactCategory = 'user' | 'decision' | 'todo' | 'file' | 'rest';

export interface Fact {
  category: FactCategory;
  /** stable identity used for "latest wins" (e.g. file path, tab id, 'todo-state', 'test-last', user message index) */
  key: string;
  /** original message index the fact came from (latest occurrence) */
  index: number;
  text: string;
  /** set when a later message superseded this fact (user instructions) */
  supersededBy?: number;
}

export interface LedgerRenderResult {
  text: string;
  tokens: number;
  dropped: number;
  kept: number;
}

// ---------------------------------------------------------------- store

export interface PlanStore {
  get(key: string): Plan | undefined;
  set(key: string, plan: Plan): void;
  /** number of plans in memory */
  size(): number;
}

// ---------------------------------------------------------------- errors

export type ErrorKind =
  | 'overflow_prompt'       // prompt alone exceeds the window
  | 'overflow_total'        // prompt + max_tokens exceeds the window
  | 'overflow_unknown'      // recognised overflow, numbers unknown (e.g. LiteLLM wrapper, context_length_exceeded code)
  | 'max_tokens_too_large'  // max_tokens alone is too large (clamp is the right fix)
  | 'payload_too_large'     // HTTP 413 (bytes)
  | 'gateway_error'         // 502/503/504 with a generic body: an overflow only if we were near the budget
  | 'overflow_suspect'      // generic wording, low confidence
  | 'excluded'              // matched an exclusion (rate limit, stream_options misuse): never an overflow
  | 'unmatched';            // nothing matched: returned unchanged

export interface ErrorRule {
  id: string;
  server: string;
  /** HTTP statuses this entry applies to; null inside the array = in-stream error after HTTP 200; omitted = any */
  status?: Array<number | null>;
  /** JS regex source (named groups: window, prompt, completion, total, maxInput, chars, atLeast); '' = match any body */
  match: string;
  /** RegExp flags, e.g. 'i' (Node 20 has no inline (?i:) modifiers) */
  flags?: string;
  /** dotted JSON paths to numeric fields, e.g. { prompt: 'error.n_prompt_tokens', window: 'error.n_ctx' } */
  json?: Record<string, string>;
  kind: Exclude<ErrorKind, 'excluded' | 'unmatched'>;
  /** what the regex runs on: the raw body (default) or the extracted message (error.message ?? error-as-string ?? message) */
  on?: 'body' | 'message';
  /** the prompt number is only a lower bound */
  lowerBound?: boolean;
  /** lower bound only when this named group matched */
  lowerBoundIf?: string;
  note?: string;
}

export interface ErrorExclusion { id: string; match: string; flags?: string }

export interface ClassifiedError {
  kind: ErrorKind;
  ruleId?: string;
  status: number;
  /** true when the error arrived inside a 200 SSE stream */
  inStream: boolean;
  promptTokens?: number;
  promptIsLowerBound?: boolean;
  window?: number;
  completionTokens?: number;
  /** the human-readable message extracted from the body (never logged, only returned to the client) */
  message?: string;
}

// ---------------------------------------------------------------- learned state (persisted, part of planning inputs)

/** Learned per (origin, model) (DESIGN.md, ). */
export interface LearnedEntry {
  /** budget.window when learned; a mismatch discards the entry */
  configuredWindow: number;
  /** counter id when learned; a mismatch discards the entry */
  counterId: string;
  /** window learned from an exact, validated overflow body; only ever lower than configured */
  window: number | null;
  /** server-side prompt limit (SGLang maxInput, TGI max_input_tokens) */
  maxPrompt: number | null;
  /** learned from HTTP 413: floor(0.9 * rejected bytes) */
  maxBodyBytes: number | null;
  /** tokens subtracted from the budget after unexplained overflows (idempotent, capped) */
  tighten: number;
  tightenLog: Array<{ rule: string; at: string; rejectedRaw: number }>;
  /** usage calibration: ceil_1% of the p90 reported/counted ratio, with hysteresis; 1 = none */
  correction: number;
  samples: number;
  meanRatio: number;
  /** last accepted calibration ratios (<= 64), for the running p90 () */
  ratios: number[];
  /** gateway_error/overflow_suspect tightens waiting for a second distinct chain key within 24 h () */
  pendingTighten: Array<{ chainKey: string; at: string; rejectedRaw: number }>;
  includeUsageRejected: boolean;
  updatedAt: string | null;
}

export interface LearnedState {
  version: 2;
  /** key: `${origin}|${model}` */
  entries: Record<string, LearnedEntry>;
}

/** Everything besides the messages that planning depends on (DESIGN.md). */
export interface PlanningInputs {
  engineVersion: string;
  configPlanHash: string;
  tokenizerSha256: string | null;
  counterMode: Exclude<CounterMode, 'remote'>;
  templateName: string;
  /** canonical JSON of the request's chat_template_kwargs merged over tokenizer.template.{enableThinking,preserveThinking} (request wins) */
  templateKwargs: string;
  tPlan: number;
  window: number;
  maxPrompt: number | null;
  tighten: number;
  correction: number;
  maxBodyBytes: number | null;
  toolsDigest: string;
  fixedBytes: number;
}
