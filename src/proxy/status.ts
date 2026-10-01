// GET /status and /kitzur/status (DESIGN.md "Routes"): version, uptime, config summary, the §3
// budget quantities, counter mode and correction, learned entries with their tightenLog, counters by
// action, error kind, guard reason and replan, upstream_rejected_rewrite, usage_mismatch, active
// warnings, sessions, latency p50/p99 and memory. Counters are in-process (they reset on restart);
// the learned entries come from the state store.
import type { Config } from '../config/schema.js';
import type { LearnedEntry } from '../types.js';
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
}

export class StatusTracker {
  readonly startedAt: number;
  requests = 0;
  chatRequests = 0;
  passthroughRequests = 0;
  hostRejected = 0;
  retries = 0;
  usageRetries = 0;
  usageMismatch = 0;
  upstreamIncomplete = 0;
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
      name: 'kitzur',
      version: this.version,
      uptime_s: Math.round((this.now() - this.startedAt) / 1000),
      config: {
        upstream: cfg.upstream.origin,
        server: { type: cfg.server.type, budgetMode: cfg.server.budgetMode },
        window: cfg.budget.window,
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
      learned,
      counters: {
        requests: this.requests,
        chat_requests: this.chatRequests,
        passthrough_requests: this.passthroughRequests,
        host_rejected: this.hostRejected,
        retries: this.retries,
        include_usage_retries: this.usageRetries,
        usage_mismatch: this.usageMismatch,
        upstream_incomplete: this.upstreamIncomplete,
        upstream_unavailable: this.upstreamUnavailable,
        original_resent: this.originalResent,
        aborted: this.aborted,
        fail_open: this.failOpen,
      },
      actions: obj(this.actions),
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
