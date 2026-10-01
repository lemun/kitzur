// The wire dialect behind the proxy (DESIGN.md). v1 ships only OpenAI Chat Completions
// (openai-chat.ts); Anthropic Messages and Responses can be added behind the same shape later.
// A dialect owns everything that depends on the wire format: which paths it serves, how a body is
// parsed and serialized, where usage and finish reasons live, and how client-facing errors look.
import type { ChatRequest, Usage } from '../types.js';

/** A parsed client request plus what the proxy must know about its bytes. */
export interface ParsedRequest {
  /** the parsed body; object key order is the client's (JSON.parse keeps it, except integer-like keys) */
  req: ChatRequest;
  /** the client's bytes, forwarded verbatim whenever the request is unchanged */
  raw: Buffer;
  /**
   * an integer outside Number.isSafeInteger was seen (). Such a body is never rewritten: a
   * re-serialization would change the number.
   */
  unsafeInteger: boolean;
}

export type ParseResult = { ok: true; value: ParsedRequest } | { ok: false; reason: string };

/** Usage and finish state tapped from a response (non-stream body or SSE events). */
export interface ResponseTap {
  /** the last non-null usage object seen (: "the last usage seen in any event") */
  usage: Usage | null;
  /** the last non-null finish_reason seen */
  finishReason: string | null;
}

export interface Dialect {
  readonly name: string;
  /** true when this dialect serves the request path (query string excluded) */
  matches(method: string, pathname: string): boolean;
  parse(raw: Buffer): ParseResult;
  serialize(req: ChatRequest): Buffer;
}
