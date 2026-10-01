// Stats JSONL (DESIGN.md "Stats JSONL"; reference implementation; bench/README.md§12).
// One record per client chat request, written after the request completed, in completion order.
// Sizes and timings only: never message content, query strings or header values, with one exception:
// client_session, the client's own session id header (x-session-id / x-sim-session, at most 128 chars).
//
// The gobstopper-compatible fields let the frozen analyze.py and sim-real/replay_session.py read the
// ledger unchanged; they carry kitzur's exact numbers (est_tokens_* are exact counts, not chars/4):
//   compacted          a compaction happened while serving this request (proactive or on a retry)
//   reused_prefix      a plan with earlier compactions was applied without compacting again
//   rung               the fit-loop rung of the plan (plan.meta.rung when the engine reports it)
//   over_budget        plan.fit === 'over_budget'
//   est_tokens_in/out  exact tokens of the client request / of what was forwarded
//   est_summary_tokens summary tokens of the plan
//   carry_chars        always 0 (kitzur has no carry)
//   threshold_tokens   the trigger
//   ratio_permille     the calibration correction × 1000
import { createWriteStream, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import type { AttemptRecord, EngineResult, StatsRecord } from '../types.js';
import { mkdirs } from './state.js';

/** StatsRecord plus kitzur-only diagnostics (all sizes or timings). */
export interface ProxyStatsRecord extends StatsRecord {
  /** the client's session header (x-session-id / x-sim-session), when sent: an id, not content */
  client_session?: string;
  shadow?: boolean;
  /** shadow mode: what the engine would have forwarded */
  shadow_tokens_out?: number;
  reason?: string;
  /** forwarded max_tokens value (last attempt) */
  max_tokens?: number;
  /** a stream ended with no [DONE] and no finish_reason () */
  upstream_incomplete?: boolean;
  /** the  resend of the original happened */
  original_resent?: boolean;
  /** kitzur injected include_usage and stripped the usage chunk */
  usage_injected?: boolean;
  /** body fully received → upstream request fully written (bench/README.mdreqPath) */
  req_path_ms?: number;
  /** first upstream body byte → first client body byte (respPath) */
  resp_path_ms?: number;
  /** time spent in upstream attempts (all of them) */
  upstream_ms?: number;
  cpu_us?: number;
}

export class StatsWriter {
  private stream: WriteStream | null = null;
  private seqNo = 0;
  written = 0;
  lastError: string | null = null;

  constructor(readonly path: string | null) {
    if (!path) return;
    try {
      mkdirs(dirname(path));
      this.stream = createWriteStream(path, { flags: 'a', mode: 0o600 });
      this.stream.on('error', (e) => {
        this.lastError = e.message;
        this.stream = null;
      });
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
    }
  }

  /** Monotonic request sequence number, taken when a chat request arrives. */
  nextSeq(): number {
    return ++this.seqNo;
  }

  write(rec: ProxyStatsRecord): void {
    this.written++;
    this.stream?.write(JSON.stringify(rec) + '\n');
  }

  close(): Promise<void> {
    const s = this.stream;
    this.stream = null;
    if (!s) return Promise.resolve();
    return new Promise((resolve) => s.end(() => resolve()));
  }
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

export interface StatsInput {
  seq: number;
  ts: Date;
  path: string;
  /** engine result of attempt 1 (null: the engine threw or was not run) */
  first: EngineResult | null;
  /** engine result of the last forwarded attempt */
  last: EngineResult | null;
  action: StatsRecord['action'];
  attempts: AttemptRecord[];
  clientStatus: number;
  /** our raw count of the client request (when known) */
  tokensIn: number | null;
  correction: number;
  engineMs: number;
  totalMs: number;
  compacted: boolean;
  shadow: boolean;
  /** what reached the upstream last: the client's request, the engine's output, or nothing */
  forwarded: 'original' | 'engine' | 'none';
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
  usageMismatch: boolean;
  rewriteRejected: boolean;
  guard?: string;
  reason?: string;
  clientSession?: string;
  incomplete?: boolean;
  originalResent?: boolean;
  usageInjected?: boolean;
  reqPathMs?: number;
  respPathMs?: number;
  cpuUs?: number;
  upstreamMs?: number;
}

/** Builds the JSONL record (StatsRecord field order first, then kitzur extras). */
export function buildStatsRecord(s: StatsInput): ProxyStatsRecord {
  const r = s.last ?? s.first;
  const plan = r?.plan ?? null;
  const st = r?.stats;
  const tokensIn = s.first?.stats.tokensIn ?? s.tokensIn ?? 0;
  const lastAttempt = s.attempts[s.attempts.length - 1];
  const forwardedTokens = s.forwarded === 'none' ? 0 : s.shadow || !r || s.forwarded === 'original' ? tokensIn : st?.tokensOut ?? tokensIn;
  const rungMeta = plan?.meta?.['rung'];
  const rec: ProxyStatsRecord = {
    seq: s.seq,
    ts: s.ts.toISOString(),
    session: s.first?.sessionKey ?? '',
    path: s.path,
    action: s.action,
    ...(s.first?.replan ? { replan: s.first.replan } : {}),
    ...(plan ? { fit: plan.fit } : {}),
    messages_in: s.first?.stats.messagesIn ?? 0,
    messages_out: s.forwarded === 'none' ? 0 : s.shadow || s.forwarded === 'original' ? (s.first?.stats.messagesIn ?? 0) : (st?.messagesOut ?? s.first?.stats.messagesIn ?? 0),
    tokens_in: tokensIn,
    tokens_out: forwardedTokens,
    budget: st?.budget.budget ?? 0,
    trigger: st?.budget.trigger ?? 0,
    ...(r?.maxTokens ? { maxtokens_fit: true } : {}),
    attempts: s.attempts,
    ...(s.usage ? { usage: s.usage } : {}),
    ...(s.usageMismatch ? { usage_mismatch: true } : {}),
    ...(s.rewriteRejected ? { upstream_rejected_rewrite: true } : {}),
    ...(s.guard ? { guard: s.guard } : {}),
    engine_ms: round1(s.engineMs),
    total_ms: round1(s.totalMs),
    client_status: s.clientStatus,
    compacted: s.compacted,
    reused_prefix: !s.compacted && (plan?.compactions ?? 0) > 0 && s.action !== 'passthrough',
    rung: typeof rungMeta === 'number' ? rungMeta : 0,
    over_budget: plan?.fit === 'over_budget',
    est_tokens_in: tokensIn,
    est_tokens_out: forwardedTokens,
    est_summary_tokens: s.shadow ? 0 : st?.summaryTokens ?? 0,
    carry_chars: 0,
    threshold_tokens: st?.budget.trigger ?? 0,
    ratio_permille: Math.round(s.correction * 1000),
  };
  if (s.clientSession) rec.client_session = s.clientSession;
  if (s.shadow) {
    rec.shadow = true;
    if (s.first) rec.shadow_tokens_out = s.first.stats.tokensOut;
  }
  if (s.reason) rec.reason = s.reason;
  if (lastAttempt) rec.max_tokens = lastAttempt.maxTokens;
  if (s.incomplete) rec.upstream_incomplete = true;
  if (s.originalResent) rec.original_resent = true;
  if (s.usageInjected) rec.usage_injected = true;
  if (s.reqPathMs !== undefined) rec.req_path_ms = round1(s.reqPathMs);
  if (s.respPathMs !== undefined) rec.resp_path_ms = round1(s.respPathMs);
  if (s.upstreamMs !== undefined) rec.upstream_ms = round1(s.upstreamMs);
  if (s.cpuUs !== undefined) rec.cpu_us = Math.round(s.cpuUs);
  return rec;
}
