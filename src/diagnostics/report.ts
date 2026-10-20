import { createHash } from 'node:crypto';

type JsonRecord = Record<string, unknown>;

export interface ReportResult {
  coverage: { records: number; malformed: number; partialFinalLine: boolean; oversized: number; from: string | null; to: string | null; historyComplete: false; droppedRecords: null };
  requests: number; uniqueSessions: number; sessionCoverage: { approximate: true; limit: number; lowerBound: boolean; missing: number }; localRejects: number; shadowRequests: number; incompleteStreams: number;
  compactions: number;
  retries: number;
  failures: number;
  tokenTotals: { input: number; forwarded: number; shadowEstimatedForwarded: number; reductionEligibleInput: number; reductionEligibleForwarded: number; reductionPercent: number | null; attemptedRaw: number; actualUpstreamPrompt: number; actualUpstreamCompletion: number; actualUsageRecords: number };
  fieldCoverage: { tokensIn: number; tokensOut: number; attempts: number; attemptedRaw: number; shadowEstimatedForwarded: number; actualPromptUsage: number; actualCompletionUsage: number; totalMs: number; engineMs: number; upstreamMs: number; requestPathMs: number; responsePathMs: number };
  upstreamStatusCounts: Record<string, number>;
  timingMs: { total: number; engine: number; upstream: number; requestPath: number; responsePath: number; recordsWithTotal: number };
}

const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const obj = (v: unknown): v is JsonRecord => !!v && typeof v === 'object' && !Array.isArray(v);
const ACTIONS = new Set(['passthrough', 'reuse', 'compact', 'admit', 'truncate', 'clamp', 'restore', 'shadow', 'impossible', 'guard_fallback', 'guard_reject']);
function validRecord(v: JsonRecord): boolean {
  const status = num(v.client_status);
  const hasTokenOrAttempts = num(v.tokens_in) !== null || num(v.tokens_out) !== null || Array.isArray(v.attempts);
  return Number.isInteger(num(v.seq)) && typeof v.action === 'string' && ACTIONS.has(v.action) && status !== null && Number.isInteger(status) && status >= 100 && status <= 599 && hasTokenOrAttempts;
}

export const MAX_RECORD_BYTES = 1024 * 1024;
export const MAX_TRACKED_SESSIONS = 10_000;

function accumulator() {
  const coverage: ReportResult['coverage'] = { records: 0, malformed: 0, oversized: 0, partialFinalLine: false, from: null, to: null, historyComplete: false, droppedRecords: null };
  const result: ReportResult = {
    coverage, requests: 0, uniqueSessions: 0, sessionCoverage: { approximate: true, limit: MAX_TRACKED_SESSIONS, lowerBound: false, missing: 0 }, localRejects: 0, shadowRequests: 0, incompleteStreams: 0, compactions: 0, retries: 0, failures: 0,
    tokenTotals: { input: 0, forwarded: 0, shadowEstimatedForwarded: 0, reductionEligibleInput: 0, reductionEligibleForwarded: 0, reductionPercent: null, attemptedRaw: 0, actualUpstreamPrompt: 0, actualUpstreamCompletion: 0, actualUsageRecords: 0 },
    fieldCoverage: { tokensIn: 0, tokensOut: 0, attempts: 0, attemptedRaw: 0, shadowEstimatedForwarded: 0, actualPromptUsage: 0, actualCompletionUsage: 0, totalMs: 0, engineMs: 0, upstreamMs: 0, requestPathMs: 0, responsePathMs: 0 },
    timingMs: { total: 0, engine: 0, upstream: 0, requestPath: 0, responsePath: 0, recordsWithTotal: 0 },
    upstreamStatusCounts: {},
  };
  const sessions = new Set<string>();
  function record(line: string) {
    if (!line.trim()) return;
    let r: unknown;
    try { r = JSON.parse(line); } catch { coverage.malformed++; return; }
    if (!obj(r) || !validRecord(r)) { coverage.malformed++; return; }
    coverage.records++; result.requests++;
    if (typeof r.session === 'string' && r.session.length > 0) {
      // Fixed-size digests bound retained bytes even for very long identifiers.
      const digest = createHash('sha256').update(r.session).digest('hex');
      if (!sessions.has(digest)) {
        if (sessions.size < MAX_TRACKED_SESSIONS) sessions.add(digest);
        else result.sessionCoverage.lowerBound = true;
      }
    } else result.sessionCoverage.missing++;
    const ts = typeof r.ts === 'string' && Number.isFinite(Date.parse(r.ts)) ? new Date(r.ts).toISOString() : null;
    if (ts && (!coverage.from || ts < coverage.from)) coverage.from = ts;
    if (ts && (!coverage.to || ts > coverage.to)) coverage.to = ts;
    if (r.compacted === true) result.compactions++;
    const validAttempts = Array.isArray(r.attempts) && r.attempts.every(obj);
    const attempts = validAttempts ? r.attempts as JsonRecord[] : [];
    if (validAttempts) result.fieldCoverage.attempts++;
    if (validAttempts) result.retries += Math.max(0, attempts.length - 1);
    result.failures += (num(r.client_status) ?? 0) >= 400 || r.upstream_incomplete === true || (attempts.length > 0 && typeof attempts.at(-1)!.kind === 'string' && attempts.at(-1)!.kind !== 'ok') ? 1 : 0;
    if (validAttempts && attempts.length === 0 && (num(r.client_status) ?? 0) >= 400) result.localRejects++;
    if (r.shadow === true || r.action === 'shadow') result.shadowRequests++;
    if (r.upstream_incomplete === true) result.incompleteStreams++;
    const input = num(r.tokens_in); const forwarded = num(r.tokens_out);
    if (input !== null) { result.tokenTotals.input += input; result.fieldCoverage.tokensIn++; }
    if (forwarded !== null) { result.tokenTotals.forwarded += forwarded; result.fieldCoverage.tokensOut++; }
    const shadowOut = num(r.shadow_tokens_out); if (shadowOut !== null) { result.tokenTotals.shadowEstimatedForwarded += shadowOut; result.fieldCoverage.shadowEstimatedForwarded++; }
    const eligible = attempts.length > 0 && r.shadow !== true && r.action !== 'shadow' && r.action !== 'impossible' && r.action !== 'guard_reject' && input !== null && forwarded !== null;
    if (eligible) { result.tokenTotals.reductionEligibleInput += input!; result.tokenTotals.reductionEligibleForwarded += forwarded!; }
    for (const a of attempts) {
      const raw = num(a.raw); if (raw !== null) { result.tokenTotals.attemptedRaw += raw; result.fieldCoverage.attemptedRaw++; }
      const status = num(a.status);
      if (status !== null && Number.isInteger(status) && status >= 100 && status <= 599) {
        const key = String(status); result.upstreamStatusCounts[key] = (result.upstreamStatusCounts[key] ?? 0) + 1;
      }
    }
    if (obj(r.usage)) {
      const p = num(r.usage.prompt_tokens); const c = num(r.usage.completion_tokens);
      if (p !== null || c !== null) {
        result.tokenTotals.actualUsageRecords++;
        result.tokenTotals.actualUpstreamPrompt += p ?? 0;
        result.tokenTotals.actualUpstreamCompletion += c ?? 0;
      }
      if (p !== null) result.fieldCoverage.actualPromptUsage++;
      if (c !== null) result.fieldCoverage.actualCompletionUsage++;
    }
    for (const [key, dest] of [['total_ms', 'total'], ['engine_ms', 'engine'], ['upstream_ms', 'upstream'], ['req_path_ms', 'requestPath'], ['resp_path_ms', 'responsePath']] as const) {
      const v = num(r[key]); if (v !== null) { result.timingMs[dest] += v; const cov = ({ total_ms: 'totalMs', engine_ms: 'engineMs', upstream_ms: 'upstreamMs', req_path_ms: 'requestPathMs', resp_path_ms: 'responsePathMs' } as const)[key]; result.fieldCoverage[cov]++; }
    }
    if (num(r.total_ms) !== null) result.timingMs.recordsWithTotal++;
  }
  function finish(): ReportResult {
    result.uniqueSessions = sessions.size;
    const denominator = result.tokenTotals.reductionEligibleInput;
    if (denominator > 0) result.tokenTotals.reductionPercent = 100 * (denominator - result.tokenTotals.reductionEligibleForwarded) / denominator;
    return result;
  }
  return { record, finish, coverage };
}

function byteParser() {
  const stats = accumulator();
  const line = Buffer.allocUnsafe(MAX_RECORD_BYTES);
  let size = 0; let oversized = false; let partial = false;
  function endLine() {
    if (oversized) { stats.coverage.oversized++; stats.coverage.malformed++; }
    else stats.record(line.toString('utf8', 0, size));
    size = 0; oversized = false;
  }
  return {
    write(chunk: Uint8Array) {
      let start = 0;
      for (let i = 0; i <= chunk.length; i++) {
        if (i < chunk.length && chunk[i] !== 10) continue;
        const length = i - start;
        if (!oversized) {
          if (size + length > MAX_RECORD_BYTES) oversized = true;
          else { line.set(chunk.subarray(start, i), size); size += length; }
        }
        if (i < chunk.length) { endLine(); partial = false; }
        else if (length > 0) partial = true;
        start = i + 1;
      }
    },
    finish() {
      stats.coverage.partialFinalLine = partial;
      if (partial) endLine();
      return stats.finish();
    },
  };
}

/** Aggregate byte chunks without retaining the file or unbounded records. */
export async function reportStream(chunks: AsyncIterable<Uint8Array>): Promise<ReportResult> {
  const parser = byteParser();
  for await (const chunk of chunks) parser.write(chunk);
  return parser.finish();
}

/** Convenience API for callers that already hold a string. Uses the same caps. */
export function report(text: string): ReportResult {
  const parser = byteParser();
  // Keep conversion buffers bounded; avoid splitting a UTF-16 surrogate pair.
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 16384, text.length);
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
    parser.write(Buffer.from(text.slice(start, end)));
    start = end;
  }
  return parser.finish();
}

export function renderReport(r: ReportResult): string {
  const t = r.tokenTotals; const tm = r.timingMs;
  const reduction = t.reductionPercent === null ? 'n/a' : `${t.reductionPercent.toFixed(1)}%`;
  return [
    `Coverage: ${r.coverage.records} records (${r.coverage.malformed} malformed, ${r.coverage.oversized} oversized${r.coverage.partialFinalLine ? ', final line has no newline' : ''})${r.coverage.from ? `, ${r.coverage.from} to ${r.coverage.to}` : ''}`,
    'History incomplete; dropped-record total unavailable.',
    `Requests: ${r.requests} across ${r.sessionCoverage.lowerBound ? 'at least ' : ''}${r.uniqueSessions} sessions (approximate hashed count; ${r.sessionCoverage.missing} records without session IDs); compactions: ${r.compactions}; retries: ${r.retries}; failures: ${r.failures}; local rejects: ${r.localRejects}; shadow requests: ${r.shadowRequests}; incomplete streams: ${r.incompleteStreams}`,
    `Tokens: input ${t.input} (${r.fieldCoverage.tokensIn} records); last-attempt forwarded ${t.forwarded} (${r.fieldCoverage.tokensOut}); reduction ${reduction} across eligible non-shadow requests (${t.reductionEligibleInput} input tokens); attempted raw across recorded attempts ${t.attemptedRaw} (${r.fieldCoverage.attemptedRaw} attempts with raw counts).`,
    `Shadow estimated forwarded tokens: ${t.shadowEstimatedForwarded} (${r.fieldCoverage.shadowEstimatedForwarded} records). Upstream usage: prompt ${t.actualUpstreamPrompt} (${r.fieldCoverage.actualPromptUsage}), completion ${t.actualUpstreamCompletion} (${r.fieldCoverage.actualCompletionUsage}); usage fields cover the final response only and may be absent.`,
    `Upstream HTTP status counts: ${Object.entries(r.upstreamStatusCounts).map(([s, n]) => `${s}=${n}`).join(', ') || 'none'}.`,
    `Timing totals (ms): total ${tm.total} (${r.fieldCoverage.totalMs} records), engine ${tm.engine} (${r.fieldCoverage.engineMs}), upstream ${tm.upstream} (${r.fieldCoverage.upstreamMs}), request path ${tm.requestPath} (${r.fieldCoverage.requestPathMs}), response path ${tm.responsePath} (${r.fieldCoverage.responsePathMs}).`,
    'Request token reduction is not a billing estimate.',
  ].join('\n');
}
