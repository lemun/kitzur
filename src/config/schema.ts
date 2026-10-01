/**
 * kitzur configuration: types and built-in defaults.
 * Every knob is documented in CONFIG.md (default, meaning, what breaks if it is wrong).
 * Presets (presets/*.json) override the window-related values; gateway-probes import writes a config file.
 */
import type { ErrorExclusion, ErrorRule } from '../types.js';

export type ServerType = 'vllm' | 'sglang' | 'llamacpp' | 'tgi' | 'ollama' | 'lmstudio' | 'litellm' | 'unknown';
export type BudgetMode = 'strict_total' | 'prompt_only' | 'tgi' | 'silent_truncate';

export interface Config {
  listen: {
    host: string;
    port: number;
    /** accepted Host header names (port ignored); ['*'] disables the DNS-rebinding guard */
    allowedHosts: string[];
  };
  upstream: {
    /** scheme://host[:port] of the gateway; the client's request path is appended unchanged */
    origin: string | null;
    timeoutMs: number;
    /** max silence between streamed chunks */
    idleTimeoutMs: number;
    caFile: string | null;
    insecureTls: boolean;
    /** extra headers added to every upstream request (values never logged) */
    headers: Record<string, string>;
    /** serialized body limit (nginx default 1 MiB); null = none */
    maxBodyBytes: number | null;
    /** close idle upstream keep-alive sockets after this (uvicorn keep-alive is 5 s) */
    keepAliveIdleMs: number;
  };
  server: {
    type: ServerType;
    /** null = derived from type: vllm/sglang/litellm strict_total, llamacpp/lmstudio prompt_only, tgi tgi, ollama silent_truncate, unknown strict_total */
    budgetMode: BudgetMode | null;
  };
  budget: {
    window: number;
    /** whether the server checks prompt + max_tokens (vLLM) or the prompt alone; null = from server.budgetMode/type (§3 precedence) */
    limitCountsMaxTokens: boolean | null;
    /** used when a request has neither max_tokens nor max_completion_tokens */
    defaultMaxTokens: number;
    /** session-stable max_tokens used for planning; null = defaultMaxTokens (DESIGN ADR-7) */
    planMaxTokens: number | null;
    safetyMarginTokens: number;
    safetyMarginFraction: number;
    maxTokensClamp: { enabled: boolean; floorTokens: number };
    /** raise a shrunken max_tokens back (Kilo); toTokens null = T_plan */
    maxTokensRestore: { enabled: boolean; toTokens: number | null };
    /** informational (gateway-probes): measured fixed prompt size */
    observedFixedPromptTokens: number | null;
  };
  client: {
    /** where the agent compacts by itself (prompt+completion tokens); null = W - min(outputLimit ?? T_plan, outputTokenMax) */
    compactionPointTokens: number | null;
    outputLimit: number | null;
    /** the client's output cap (OPENCODE_/KILO_EXPERIMENTAL_OUTPUT_TOKEN_MAX, default 32000) */
    outputTokenMax: number;
    /** tokens kept free below the client point for completion + reasoning; null = min(7000, floor(T_plan/2)) */
    outputAllowanceTokens: number | null;
    /** the client's own per-tool output cap (OpenCode tool_output.max_bytes) */
    toolOutputMaxBytes: number;
    /** text markers of client-written summaries (OpenCode template) */
    summaryMarkers: string[];
    /** trimmed first text of the user message that precedes a client summary */
    compactionMarkers: string[];
    /** client-generated user texts that are not user facts (OpenCode/Kilo Continue texts) */
    boilerplateUserTexts: string[];
  };
  compaction: {
    enabled: boolean;
    /** absolute overrides; null = derived from the fractions */
    triggerTokens: number | null;
    targetTokens: number | null;
    triggerFraction: number;
    targetFraction: number;
    keepRecent: number;
    summaryRole: 'user' | 'merge-into-first-user';
    summaryFraction: number;
    /** upper cap of the summary budget as a fraction of budget (the ledger floor may exceed summaryFraction) */
    summaryMaxFraction: number;
    narrativeMaxCharsPerMessage: number;
    userMaxChars: number;
  };
  oversize: {
    enabled: boolean;
    headShare: number;
    /** head too large: 'truncate' the first user message (only it) or return an 'error' */
    headPolicy: 'truncate' | 'error';
    /** admission rewrites of new tool results (§5.5a) on/off */
    admission: boolean;
    /** admission threshold for new tool results (§5.5a); null = floor((budget - count(head) - floor(budget*summaryFraction)) / 2) */
    admitTokens: number | null;
    /** room reserved for the tail when truncating the head; null = floor(0.25*budget) */
    minTailTokens: number | null;
  };
  reasoning: {
    summary: 'drop' | 'cap' | 'keep';
    summaryCapChars: number;
    tail: 'keep' | 'drop';
    /** informational (gateway-probes): which field the server emits / the client sends back */
    field: string | null;
    serverEmits: boolean | null;
    sentBackByClient: boolean | null;
  };
  ledger: {
    enabled: boolean;
    tags: { decision: string[]; todo: string[]; blocked: string[]; note: string[] };
    /** generic labelled-sentence pattern for narrative tier 1 (JS regex source) */
    labelPattern: string;
    pathArgKeys: string[];
    correctionCues: string;
    /** overlap coefficient |A∩B|/min(|A|,|B|) of content words needed to supersede */
    correctionMinOverlap: number;
    /** sentences with these cues never supersede (JS regex source, case-insensitive) */
    additiveCues: string;
    /** extra stop words (the built-in English + Hebrew list is in src/engine/ledger/stopwords.ts) */
    stopWords: string[];
    outputPaths: { enabled: boolean; maxPerResult: number; maxTotal: number };
    mirrorPath: string | null;
  };
  rules: {
    /** tool-name globs per role ('*' wildcard) */
    toolNames: {
      snapshot: string[];
      browserNavigate: string[];
      todo: string[];
      read: string[];
      edit: string[];
      write: string[];
      shell: string[];
    };
    mcpServers: string[];
    snapshot: {
      stub: 'boundary' | 'eager' | 'off';
      slim: boolean;
      interactiveRoles: string[];
      /** informational (gateway-probes) */
      p90Tokens: number | null;
    };
    test: { commands: string; maxFailureLines: number };
    excerpt: { headChars: number; tailChars: number; shortVerbatimChars: number };
  };
  tokenizer: {
    /** auto = exact when path loads, else estimate; 'estimate' forces the estimate (ablation) */
    mode: 'auto' | 'estimate';
    path: string | null;
    /** compiled cache file for fast cold start; null = stateDir/tokenizer-<sha>.lctk */
    cachePath: string | null;
    template: {
      name: 'sim' | 'qwen3' | 'chatml' | 'generic';
      /** Qwen3 enable_thinking (generation prompt); null = template default; a request's chat_template_kwargs wins */
      enableThinking: boolean | null;
      /** Qwen3.6 preserve_thinking: render <think> for every assistant turn (append-only rendering) */
      preserveThinking: boolean | null;
    };
    endpoint: { style: 'vllm' | 'sglang' | 'llamacpp' | 'tgi' | null; path: string | null; timeoutMs: number };
    fallback: {
      charsPerToken: { prose: number; code: number; snapshot: number; testOutput: number; json: number; snapshotNonLatin: number };
      safetyFactor: number;
      /** per-message overhead for the 'generic' template */
      perMessageOverhead: number;
    };
    imageTokens: number;
    cacheEntries: number;
  };
  calibration: {
    enabled: boolean;
    usageAvailable: boolean | null;
    upwardOnly: boolean;
    minSamples: number;
    maxCorrection: { exact: number; estimate: number };
    /** samples from requests smaller than max(this, 0.1*budget) are ignored */
    minCountedTokens: number;
  };
  stream: {
    injectIncludeUsage: boolean;
    holdFirstEvent: boolean;
    firstEventTimeoutMs: number;
  };
  errors: {
    useBuiltin: boolean;
    custom: ErrorRule[];
    exclusions: ErrorExclusion[];
    inStream: boolean;
    maxRetries: number;
    nearBudgetFraction: number;
    /** cap of the learned tighten as a fraction of W - T_plan - margin */
    maxTightenFraction: number;
    translateForClient: boolean;
  };
  cache: { prefixCaching: 'on' | 'off' | 'unknown' };
  store: { persist: boolean; maxPlans: number; maxBytes: number };
  stateDir: string | null;
  stats: { path: string | null };
  shadow: boolean;
  /** documented hook for an optional model-written digest; not implemented in v1 */
  digestHook: { enabled: false };
  logLevel: 'error' | 'warn' | 'info' | 'debug';
}

/** Built-in defaults = the 100k/32k reference setup. */
export const DEFAULT_CONFIG: Config = {
  listen: { host: '127.0.0.1', port: 8270, allowedHosts: ['127.0.0.1', 'localhost', '[::1]', '::1'] },
  upstream: {
    origin: null, timeoutMs: 900_000, idleTimeoutMs: 300_000, caFile: null, insecureTls: false,
    headers: {}, maxBodyBytes: null, keepAliveIdleMs: 4000,
  },
  server: { type: 'unknown', budgetMode: null },
  budget: {
    window: 100_000, limitCountsMaxTokens: null, defaultMaxTokens: 32_000, planMaxTokens: null,
    safetyMarginTokens: 512, safetyMarginFraction: 0.01,
    maxTokensClamp: { enabled: false, floorTokens: 8192 },
    maxTokensRestore: { enabled: false, toTokens: null },
    observedFixedPromptTokens: null,
  },
  client: {
    compactionPointTokens: null, outputLimit: null, outputTokenMax: 32_000, outputAllowanceTokens: null,
    toolOutputMaxBytes: 51_200,
    summaryMarkers: ['## Objective', '## Next Move'],
    compactionMarkers: ['What did we do so far?'],
    boilerplateUserTexts: [
      'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.',
      "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context. If the user was asking about attached images or files, explain that the attachments were too large to process and suggest they try again with smaller or fewer files.\n\nContinue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
    ],
  },
  compaction: {
    enabled: true, triggerTokens: null, targetTokens: null,
    triggerFraction: 1.0, targetFraction: 0.35, keepRecent: 1,
    summaryRole: 'user', summaryFraction: 0.04, summaryMaxFraction: 0.25,
    narrativeMaxCharsPerMessage: 600, userMaxChars: 4000,
  },
  oversize: { enabled: true, headShare: 0.8, headPolicy: 'truncate', admission: true, admitTokens: null, minTailTokens: null },
  reasoning: { summary: 'drop', summaryCapChars: 400, tail: 'keep', field: null, serverEmits: null, sentBackByClient: null },
  ledger: {
    enabled: true,
    tags: { decision: ['DECISION'], todo: ['TODO'], blocked: ['BLOCKED'], note: ['NOTE'] },
    labelPattern: '\\b[A-Z][A-Z0-9]{2,}(?:[-_][A-Z0-9]+)*:',
    pathArgKeys: ['filePath', 'file_path', 'path', 'filename', 'file'],
    correctionCues:
      '\\b(?:actually|instead|correction|scratch that|ignore (?:my|the|that) (?:previous|earlier|last)|disregard|no longer|change of plan|rather than|not [^.]{1,40} anymore)\\b|(?<![\\p{L}\\p{N}])(?:בעצם|במקום|תתעלם|לא משנה|תיקון)(?![\\p{L}\\p{N}])',
    correctionMinOverlap: 0.34,
    // compiled with flags 'iu'; JS \\b is ASCII-only, so Hebrew cues use Unicode letter lookarounds
    additiveCues: '\\b(?:too|also|additionally|in addition|as well)\\b|(?<![\\p{L}\\p{N}])גם(?![\\p{L}\\p{N}])',
    stopWords: [],
    outputPaths: { enabled: true, maxPerResult: 3, maxTotal: 20 },
    mirrorPath: null,
  },
  rules: {
    toolNames: {
      snapshot: ['*browser_*'],
      browserNavigate: ['*browser_navigate', '*browser_navigate_back', '*browser_tabs'],
      todo: ['todowrite', 'todo_write', '*update_todo_list'],
      read: ['read', '*read_file', 'view'],
      edit: ['edit', 'multiedit', 'apply_patch', '*apply_diff'],
      write: ['write', '*write_to_file'],
      shell: ['bash', 'shell', '*execute_command'],
    },
    mcpServers: ['playwright'],
    snapshot: {
      stub: 'boundary', slim: true,
      interactiveRoles: ['link', 'button', 'textbox', 'combobox', 'option', 'checkbox', 'radio', 'tab', 'menuitem',
        'switch', 'slider', 'searchbox', 'spinbutton', 'heading'],
      p90Tokens: null,
    },
    test: {
      commands:
        '\\b(?:playwright test|jest|vitest|pytest|go test|mvn\\b.*\\btest|gradle\\b.*\\btest|(?:npm|yarn|pnpm)(?: run)? test|cargo test)\\b',
      maxFailureLines: 12,
    },
    excerpt: { headChars: 240, tailChars: 160, shortVerbatimChars: 300 },
  },
  tokenizer: {
    mode: 'auto', path: null, cachePath: null,
    template: { name: 'qwen3', enableThinking: null, preserveThinking: null },
    endpoint: { style: null, path: null, timeoutMs: 5000 },
    fallback: {
      // chars per Qwen token: measured on the Qwen3.6 tokenizer (benchmark component estimate corpus) and the gateway-probes mock
      charsPerToken: { prose: 5.0, code: 4.1, snapshot: 2.9, testOutput: 2.5, json: 2.33, snapshotNonLatin: 2.06 },
      safetyFactor: 1.1,
      perMessageOverhead: 8,
    },
    imageTokens: 1568,
    cacheEntries: 200_000,
  },
  calibration: {
    enabled: true, usageAvailable: null, upwardOnly: true, minSamples: 5,
    maxCorrection: { exact: 1.05, estimate: 2.5 }, minCountedTokens: 4000,
  },
  stream: { injectIncludeUsage: false, holdFirstEvent: true, firstEventTimeoutMs: 15_000 },
  errors: {
    useBuiltin: true, custom: [], exclusions: [], inStream: true, maxRetries: 2, nearBudgetFraction: 0.9,
    maxTightenFraction: 0.2,
    translateForClient: true,
  },
  cache: { prefixCaching: 'unknown' },
  store: { persist: false, maxPlans: 4096, maxBytes: 64 * 1024 * 1024 },
  stateDir: null,
  stats: { path: null },
  shadow: false,
  digestHook: { enabled: false },
  logLevel: 'info',
};
