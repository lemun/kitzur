/**
 * Internal contracts between the engine core (src/engine/*.ts) and the summary / ledger / tool-rules
 * modules (src/engine/summary.ts, src/engine/ledger/*, src/engine/rules/*). Owned by the lead.
 * Semantics: DESIGN.md (fit loop), §6 (summary, ledger, eviction), §7 (tool rules).
 */
import type { ChatMessage, ToolCall, TokenCounter } from '../types.js';
import type { Config } from '../config/schema.js';

// ---------------------------------------------------------------- summary

export interface SummaryInput {
  /** original (un-rewritten) messages of the virtual request H[0..b) */
  messages: ChatMessage[];
  /** engine digests, aligned with messages (cache keys for per-message extraction) */
  digests: string[];
  /** end of the head (after the client-summary extension) */
  hEnd: number;
  /** the summary covers original messages [hEnd, cut); facts are extracted from [0, b) where b = messages.length */
  cut: number;
  /** number this compaction will have (1-based), rendered in the trailing [kitzur] line */
  compaction: number;
}

export interface SummaryOptions {
  /** token budget of the summary MESSAGE as counted in the prompt (template overhead included) */
  budgetTokens: number;
  /** fit-loop R6: floor items (narrative tier 1, rest, file, todo, decision) may be evicted */
  allowFloorEviction: boolean;
  /** fit-loop R7: user facts shortened to userMaxChars / 2^step (0..3); user facts are never evicted */
  userShortenStep: 0 | 1 | 2 | 3;
}

export interface SummaryRender {
  /** full summary message text (starts with SUMMARY_HEADER); null iff cut == hEnd */
  text: string | null;
  /** exact tokens of the summary as a user message in the prompt (counter.measure of that single message) */
  tokens: number;
  /** tokens of the floor categories alone at userShortenStep 0 (§6.4) — used for summaryBudget */
  floorTokens: number;
  kept: number;
  dropped: number;
  /** per category kept/dropped counts (diagnostics) */
  categories: Record<string, { kept: number; dropped: number }>;
}

export interface Summarizer {
  render(input: SummaryInput, opts: SummaryOptions): SummaryRender;
}

export type SummarizerFactory = (cfg: Config, counter: TokenCounter) => Summarizer;

/** Byte-identical to gobstopper's and CliffCompaction's header (DESIGN.md). */
export const SUMMARY_HEADER = 'The following is a summary of your previous actions (long observations omitted):';

// ---------------------------------------------------------------- tool rules

export interface SnapshotInfo {
  url: string | null;
  title: string | null;
  /** number of [ref=...] markers */
  refs: number;
  /** OpenCode "Full output saved to: <path>" if present */
  savedPath: string | null;
}

export type ResultKind = 'snapshot' | 'test' | 'other';

export interface ToolRules {
  /** tool-name role lookup by glob (rules.toolNames) */
  role(toolName: string): Array<keyof Config['rules']['toolNames']>;
  /** classify a tool result; content detection of snapshots beats the test rule (§7) */
  classify(resultText: string, call: ToolCall | null): ResultKind;
  snapshotInfo(resultText: string): SnapshotInfo | null;
  /** the stub text that replaces a superseded snapshot (§7) */
  stubText(info: SnapshotInfo): string;
  /**
   * Slim a snapshot (§5.6 step 1, ) to at most maxTokens (counted with `count`), keeping the page-state
   * header, the saved-output line, interactive/heading elements with refs and, room allowing, their direct
   * text//url children; appends the slim marker. Returns null if slimming cannot get under maxTokens.
   */
  slimSnapshot(resultText: string, maxTokens: number, count: (s: string) => number): string | null;
  /** condensed one-line result for the summary tool log (§6.3) */
  condense(resultText: string, call: ToolCall | null): string;
}

export type ToolRulesFactory = (cfg: Config) => ToolRules;
