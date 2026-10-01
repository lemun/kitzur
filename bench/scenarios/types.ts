/**
 * Shared benchmark contracts (bench/README.md). Shared by benchmark components.
 */
import type { ChatMessage, ToolCall } from '../../src/types.js';

export type FamilyId = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6' | 'F7' | 'F8' | 'F9' | 'F10' | 'F11' | 'F12' | 'F13' | 'F14';
export type GateId = 'T0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'G8' | 'G9' | 'I5';

/**
 * Error styles of the mock. The python-* ids are the 4 byte-exact Python styles; bench/mock/server.ts keeps their
 * Python registry keys (vllm, llamacpp, gateway502, tgi422) so the cross-check (benchmark contract ) is unchanged. The §7 styles
 * use the server_error_map.json bodies and are registered under other keys; MockOptions.errorStyle resolves an
 * ErrorStyleId to its registry key.
 */
export type ErrorStyleId =
  | 'vllm-legacy' | 'vllm-018' | 'sglang' | 'llamacpp' | 'tgi422' | 'litellm'
  | 'http413' | 'gateway502' | 'sse-inline' | 'late400' | 'unknown400'
  | 'python-vllm' | 'python-llamacpp' | 'python-gateway502' | 'python-tgi422';

export type Dist = { kind: 'lognormal'; median: number; p95: number } | { kind: 'fixed'; value: number };

export interface ScenarioSpec {
  id: string;
  family: FamilyId;
  sessions: SessionSpec[];
  interleave?: 'round-robin' | { seed: number; concurrent?: number };
  facts: FactSpec[];
  client: 'sim' | 'opencode' | 'kilo';
  /** tool-output cap (OpenCode 51200); null = uncapped */
  capBytes: number | null;
  mock: Partial<MockOptions>;
  events?: Array<{ atStep: number; kind: 'sigterm' | 'sigkill' | 'fresh-state' | 'client-compact' }>;
  gates: GateId[];
  expect: 'complete' | 'impossible-documented' | 'error-unchanged';
}

export interface SessionSpec {
  id: string;
  seed: number;
  steps: number;
  system(): string;
  tools(): unknown[];
  goal(): ChatMessage;
  /** mock side: the scripted assistant reply for this step */
  assistantAt(step: number): ChatMessage;
  /** client side: tool results for the calls of this step's assistant message */
  toolResults(step: number, calls: ToolCall[]): ChatMessage[];
  /** client side: user messages appended after this step's tool results */
  userAfter(step: number): ChatMessage[];
}

export interface FactSpec {
  id: string;
  /** unique ASCII code that appears only in its channel */
  marker: string;
  channel:
    | 'head' | 'user' | 'assistant' | 'decision' | 'todo' | 'arg-path' | 'output-path' | 'output-head'
    | 'output-tail' | 'output-mid' | 'tally' | 'url' | 'reasoning' | 'client-summary';
  expect: 'survive' | 'absent-after-supersede' | 'latest' | 'report-only';
  supersededBy?: string;
  gate: boolean;
}

export interface MockOptions {
  render: 'sim' | 'qwen3';
  limitMode: 'strict_total' | 'prompt_only' | 'tgi' | 'silent_truncate';
  /** the mock's real limit is W − limitSkewTokens (benchmark contract ) */
  limitSkewTokens: number;
  /** added to the mock's count, in its limit check and in reported usage */
  hiddenOverheadTokens: number | `${number}%`;
  errorStyle: ErrorStyleId;
  inStreamErrors: boolean;
  usage: 'client' | 'never' | 'always';
  /** generation is capped at max_tokens → finish_reason "length" */
  completionModel: 'sim' | { reasoning: Dist; text: Dist; seed: number };
  /** 413 above this */
  maxBodyBytes: number | null;
  /** late status (); applies to rejected requests */
  headerDelayMs: number;
}
