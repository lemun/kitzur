// GET /status and /kitzur/status (DESIGN.md "Routes"): version, uptime, config summary, the §3
// budget quantities, counter mode and correction, learned entries with their tightenLog, counters by
// action, error kind, guard reason and replan, upstream_rejected_rewrite, usage_mismatch, active
// warnings, sessions, latency p50/p99 and memory. Counters are in-process (they reset on restart);
// the learned entries come from the state store.
import type { Config } from '../config/schema.js';
import { computeBudget } from '../config/derived.js';
import { isAutoWindow } from '../config/window.js';
import { firstText } from '../engine/message.js';
import type { ChatRequest, LearnedEntry } from '../types.js';
import { budgetQuantities } from './budget.js';

/** A fixed-size ring of samples for percentiles. */
class Ring {
  private readonly xs: number[] = [];
  private i = 0;
  constructor(private readonly cap: number) {}
  push(x: number): void {
    if (this.xs.length < this.cap) this.xs.push(x);
    else {
      this.xs[this.i] = x;
      this.i = (this.i + 1) % this.cap;
    }
  }
  pct(p: number): number | null {
    if (!this.xs.length) return null;
    const s = [...this.xs].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]! * 10) / 10;
  }
  get n(): number {
    return this.xs.length;
  }
}

const inc = (m: Map<string, number>, k: string, by = 1): void => {
  m.set(k, (m.get(k) ?? 0) + by);
};
const obj = (m: Map<string, number>): Record<string, number> => Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export interface StatusExtras {
  counter: { mode: string; id: string };
  learned: Record<string, LearnedEntry>;
  stateError?: string | null;
  statsPath?: string | null;
  statsError?: string | null;
  upstream?: Record<string, unknown>;
  modelTokenizers?: Record<string, unknown>;
}

/** Content-free diagnostics, in request completion order. */
export interface RecentRequest {
  action: 'passthrough' | 'reuse' | 'compact' | 'clamp' | 'truncate' | 'refuse';
  tokens: { in: number | null; out: number | null; trigger: number | null };
  model: string | null;
  ms: number;
}

export class StatusTracker {
  private readonly recent: RecentRequest[] = [];
  private readonly modelCounts = new Map<string, { actions: Record<string, number>; errors: number; retries: number }>();
  private readonly modelOther = { actions: {} as Record<string, number>, errors: 0, retries: 0 };
  private modelBucket(model: string | null): { actions: Record<string, number>; errors: number; retries: number } {
    const id = model && model.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(model) ? model : null;
    let counts = id && id !== 'other' ? this.modelCounts.get(id) : undefined;
    if (!counts && id && id !== 'other' && this.modelCounts.size < 64) {
      counts = { actions: {}, errors: 0, retries: 0 };
      this.modelCounts.set(id, counts);
    }
    return counts ?? this.modelOther;
  }
  private lastCompaction: { at: string; in: number | null; out: number | null; trigger: number | null } | null = null;

  recordRequest(r: RecentRequest): void {
    this.recent.push({ ...r, tokens: { ...r.tokens } });
    if (this.recent.length > 64) this.recent.shift();
    if (r.action === 'compact') this.lastCompaction = { at: new Date(this.now()).toISOString(), ...r.tokens };
    const counts = this.modelBucket(r.model);
    counts.actions[r.action] = (counts.actions[r.action] ?? 0) + 1;
    if (r.action === 'refuse') counts.errors++;
  }

  modelRetry(model: string | null): void {
    this.modelBucket(model).retries++;
  }

  private readonly forwarded = new Map<string, number>();
  private readonly completions = new Ring(2048);
  private clientCompactions = 0;
  private lastClientCompaction: { previous_prompt_tokens: number | null; trigger: number } | null = null;

  clientRequest(req: ChatRequest, session: string | undefined, trigger: number): string | null {
    // Count a summary request once, not every later request carrying a prior summary.
    const last = req.messages.at(-1);
    if (!last || last.role !== 'user' || !this.cfg.client.compactionMarkers.includes(firstText(last).trim())) return null;
    this.clientCompactions++;
    const previous = this.forwarded.get(JSON.stringify([session ?? null, req.model ?? null])) ?? null;
    this.lastClientCompaction = { previous_prompt_tokens: previous, trigger };
    if (previous !== null && previous < trigger) {
      const message = `client compacted at ${previous} < kitzur trigger ${trigger}`;
      this.warn('client_compaction', message);
      return message;
    }
    return null;
  }

  forwardedPrompt(model: string | undefined, session: string | undefined, tokens: number | null): void {
    if (tokens === null || !Number.isFinite(tokens) || tokens < 0) return;
    const key = JSON.stringify([session ?? null, model ?? null]);
    if (this.forwarded.size >= 2048 && !this.forwarded.has(key)) this.forwarded.delete(this.forwarded.keys().next().value!);
    this.forwarded.set(key, tokens);
  }

  completionUsage(tokens: number | undefined, allowance = computeBudget(this.cfg).allowance): void {
    if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) return;
    this.completions.push(tokens);
    const p99 = this.completions.pct(0.99)!;
    if (p99 > allowance) this.warn('output_allowance', `Upstream p99 completion_tokens ${p99} exceeds allowance ${allowance}; increase client.outputAllowanceTokens, especially for reasoning models.`);
  }

  readonly startedAt: number;
  requests = 0;
  chatRequests = 0;
  passthroughRequests = 0;
  hostRejected = 0;
  retries = 0;
  usageRetries = 0;
  usageMismatch = 0;
  upstreamIncomplete = 0;
  midstreamErrors = 0;
  upstreamUnavailable = 0;
  originalResent = 0;
  aborted = 0;
  failOpen = 0;
  private readonly actions = new Map<string, number>();
  private readonly errorKinds = new Map<string, number>();
  private readonly guards = new Map<string, number>();
  private readonly replans = new Map<string, number>();
  private readonly rejectedRewrites = new Map<string, number>();
  private readonly failOpenReasons = new Map<string, number>();
  private readonly warnings = new Map<string, { message: string; count: number; last: string }>();
  private readonly sessions = new Set<string>();
  private readonly total = new Ring(2048);
  private readonly overhead = new Ring(2048);
  private readonly engine = new Ring(2048);
  private probe: Record<string, unknown> | null = null;
  /** the last upstream rejections (sizes only), with their overshoot (§8) */
  private readonly rejections: Array<Record<string, unknown>> = [];

  constructor(private readonly cfg: Config, private readonly version: string, private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  action(a: string): void {
    inc(this.actions, a);
  }
  errorKind(k: string): void {
    inc(this.errorKinds, k);
  }
  guard(reason: string): void {
    inc(this.guards, reason);
  }
  replan(r: string): void {
    inc(this.replans, r);
  }
  rewriteRejected(ruleId: string, status: number): void {
    inc(this.rejectedRewrites, `${ruleId}:${status}`);
  }
  failedOpen(reason: string): void {
    this.failOpen++;
    inc(this.failOpenReasons, reason);
  }
  session(key: string): void {
    if (key && this.sessions.size < 100_000) this.sessions.add(key);
  }
  latency(totalMs: number, overheadMs: number | null, engineMs: number): void {
    this.total.push(totalMs);
    if (overheadMs !== null) this.overhead.push(overheadMs);
    this.engine.push(engineMs);
  }
  /** An active warning (shown with a count and the last time it fired). Never content. */
  warn(key: string, message: string): void {
    const w = this.warnings.get(key);
    const at = new Date(this.now()).toISOString();
    if (w) {
      w.count++;
      w.last = at;
      w.message = message;
    } else this.warnings.set(key, { message, count: 1, last: at });
  }
  private discoveredWindows: Record<string, number> = {};
  setDiscoveredWindows(windows: Record<string, number>): void {
    this.discoveredWindows = { ...windows };
  }
  setProbe(p: Record<string, unknown>): void {
    this.probe = p;
  }
  rejection(r: { key: string; kind: string; rule: string | null; status: number | null; inStream: boolean; raw: number; overshoot: number | null }): void {
    this.rejections.push({ at: new Date(this.now()).toISOString(), ...r });
    if (this.rejections.length > 32) this.rejections.shift();
  }

  snapshot(x: StatusExtras): Record<string, unknown> {
    const cfg = this.cfg;
    const mem = process.memoryUsage();
    const learned: Record<string, unknown> = {};
    const budgets: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(x.learned)) {
      learned[k] = {
        window: e.window, maxPrompt: e.maxPrompt, maxBodyBytes: e.maxBodyBytes, tighten: e.tighten, tightenLog: e.tightenLog,
        correction: e.correction, samples: e.samples, meanRatio: Math.round(e.meanRatio * 10000) / 10000,
        pendingTighten: e.pendingTighten.length, includeUsageRejected: e.includeUsageRejected, updatedAt: e.updatedAt,
      };
      budgets[k] = budgetQuantities(cfg, e);
    }
    return {
      client_compactions: this.clientCompactions,
      last_client_compaction: this.lastClientCompaction && { ...this.lastClientCompaction },
      completion_tokens_p99: this.completions.pct(0.99),
      discovered_window: { ...this.discoveredWindows },
      last_compaction: this.lastCompaction && { ...this.lastCompaction },
      recent_requests: this.recent.map((r) => ({ ...r, tokens: { ...r.tokens } })),
      name: 'kitzur',
      version: this.version,
      uptime_s: Math.round((this.now() - this.startedAt) / 1000),
      config: {
        upstream: cfg.upstream.origin,
        server: { type: cfg.server.type, budgetMode: cfg.server.budgetMode },
        window: cfg.budget.window,
        window_mode: isAutoWindow(cfg) ? 'auto' : 'fixed',
        defaultMaxTokens: cfg.budget.defaultMaxTokens,
        planMaxTokens: cfg.budget.planMaxTokens,
        template: cfg.tokenizer.template.name,
        shadow: cfg.shadow,
        maxRetries: cfg.errors.maxRetries,
        holdFirstEvent: cfg.stream.holdFirstEvent,
        injectIncludeUsage: cfg.stream.injectIncludeUsage,
      },
      budget: budgetQuantities(cfg, null),
      budget_by_key: budgets,
      counter: x.counter,
      model_tokenizers: x.modelTokenizers ?? {},
      learned,
      counters: {
        requests: this.requests,
        chat_requests: this.chatRequests,
        passthrough_requests: this.passthroughRequests,
        host_rejected: this.hostRejected,
        retries: this.retries,
        include_usage_retries: this.usageRetries,
        usage_mismatch: this.usageMismatch,
        midstream_errors: this.midstreamErrors,
        upstream_incomplete: this.upstreamIncomplete,
        upstream_unavailable: this.upstreamUnavailable,
        original_resent: this.originalResent,
        aborted: this.aborted,
        fail_open: this.failOpen,
      },
      actions: obj(this.actions),
      model_counters: Object.fromEntries([...this.modelCounts, ['other', this.modelOther]]),
      error_kinds: obj(this.errorKinds),
      guard: obj(this.guards),
      replan: obj(this.replans),
      upstream_rejected_rewrite: obj(this.rejectedRewrites),
      recent_rejections: [...this.rejections],
      fail_open_reasons: obj(this.failOpenReasons),
      warnings: [...this.warnings.entries()].map(([key, w]) => ({ key, ...w })),
      sessions: this.sessions.size,
      latency_ms: {
        n: this.total.n,
        total_p50: this.total.pct(0.5), total_p99: this.total.pct(0.99),
        overhead_p50: this.overhead.pct(0.5), overhead_p99: this.overhead.pct(0.99),
        engine_p50: this.engine.pct(0.5), engine_p99: this.engine.pct(0.99),
      },
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, external: mem.external },
      upstream: { ...(x.upstream ?? {}), probe: this.probe },
      state: { error: x.stateError ?? null },
      stats: { path: x.statsPath ?? null, error: x.statsError ?? null },
    };
  }
}
