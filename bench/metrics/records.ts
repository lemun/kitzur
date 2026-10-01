// Compact per-request records, the input of every metric in bench/metrics (bench/README.md§6, §13).
//
// UpstreamRec  one upstream attempt, as the mock saw it (A-side): sizes, status, per-message canonical digests,
//              per-message render tokens, the token LCP with the previous accepted main request of the session, the
//              facts present in each message, strict pairing defects.
// ClientRec    one client request (C-side): per-message digests and facts, what the client got back.
//
// Metrics are pure functions of these arrays, so they are unit-testable on hand-built sequences and independent of
// how a run was driven (HTTP harness, offline simulator, recorded run directory).

export type ReqKind = 'main' | 'summarizer' | 'title';

export interface UpstreamRec {
  /** the mock's request counter (order of arrival) */
  seq: number;
  session: string;
  /** client step (x-sim-step) */
  step: number;
  kind: ReqKind;
  /** HTTP status the mock answered */
  status: number;
  /** rejected for length (context overflow) by the mock */
  rejected: boolean;
  /** the mock's prompt_tokens (its render + tokenizer; hidden overhead included when configured) */
  prompt: number;
  /** the hidden overhead the mock added to `prompt` (benchmark contract `-hidden` variants); absent = 0 */
  hidden?: number;
  completion: number | null;
  maxTokens: number;
  bytes: number;
  /** token LCP of render(this) with render(previous accepted main request of the session); 0 for the first */
  lcp: number;
  /** max token LCP with ANY earlier accepted main request (any session); null when not computed */
  lcpGlobal: number | null;
  /** canonical per-message digests (sha256 of canonical JSON, DESIGN.md) */
  digests: string[];
  /** render tokens attributed to each message (Σ + overhead = prompt without hidden overhead) */
  msgTokens: number[];
  /** tokens not attributable to a message (tools block when not merged, generation prompt, hidden overhead) */
  overhead: number;
  /** fact ids whose marker occurs in each message (ensure_ascii=False dump) */
  facts: string[][];
  /** the mock's lenient (Python) pairing check */
  pairingError: string | null;
  /** strict positional pairing defects (bench/lib/pairing-strict.ts) */
  pairingStrict: string[];
  /** the system's own count of this request, when it reports one (countError) */
  ownCount?: number | null;
  finishReason?: string | null;
  /** HTTP 200 whose stream carried an error event */
  streamError?: boolean;
}

export interface ClientRec {
  session: string;
  step: number;
  kind: ReqKind;
  /** attempt number of this client request within (session, step, kind), 1-based */
  attempt: number;
  digests: string[];
  facts: string[][];
  /** the mock's count of the client's request (what it would cost uncompacted), when known */
  prompt: number | null;
  bytes: number | null;
  /** HTTP status the client received (null: transport failure / no response) */
  status: number | null;
  /** benchmark contract : null = no client-visible error */
  clientErrorKind: string | null;
  usage: { prompt: number; completion: number } | null;
  maxTokens: number | null;
  pairingStrict: string[];
  /** the first 600 characters of an error response body, when the client recorded one */
  errorBody?: string | null;
}

export interface RunRecords {
  up: UpstreamRec[];
  client: ClientRec[];
  /** client steps per session (the scenario's step count) */
  steps: Record<string, number>;
}

/** Group by a key, keeping input order inside each group. */
export function groupBy<T, K>(xs: readonly T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    let g = m.get(k);
    if (!g) m.set(k, (g = []));
    g.push(x);
  }
  return m;
}

export const isPrefix = (a: readonly string[], b: readonly string[]): boolean => a.length <= b.length && a.every((d, i) => d === b[i]);
