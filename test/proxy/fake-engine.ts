// A scripted Engine (src/types.ts) for the proxy tests: the component never depends on the real
// engine. Results are built with the helpers below; `shrinkingEngine` is a small budget-aware engine
// (drops the oldest non-head messages until the request fits the §3 budget of the learned entry plus
// the request-local extra tighten), enough to exercise the recovery ladder end to end.
import type { Config } from '../../src/config/schema.js';
import type { Budget, ChatRequest, Engine, EngineAction, EngineResult, LearnedEntry, ProcessOptions, TokenCounter } from '../../src/types.js';
import { corrected, serverFits, serverLimits } from '../../src/proxy/budget.js';
import { requestBytes, requestMaxTokens } from '../../src/dialect/openai-chat.js';
import { freshLearnedEntry } from '../../src/proxy/state.js';

export type Script = (req: ChatRequest, opts: ProcessOptions, engine: FakeEngine) => EngineResult;

export class FakeEngine implements Engine {
  readonly calls: Array<{ req: ChatRequest; opts: ProcessOptions }> = [];
  readonly learnedMap = new Map<string, LearnedEntry>();
  readonly setCalls: Array<{ key: string; entry: LearnedEntry }> = [];
  constructor(public script: Script) {}
  process(req: ChatRequest, opts: ProcessOptions): EngineResult {
    this.calls.push({ req, opts });
    return this.script(req, opts, this);
  }
  learned(key: string): LearnedEntry {
    return this.learnedMap.get(key) ?? freshLearnedEntry(100_000, 'test');
  }
  setLearned(key: string, e: LearnedEntry): void {
    this.learnedMap.set(key, e);
    this.setCalls.push({ key, entry: e });
  }
}

export function makeBudget(p: Partial<Budget> = {}): Budget {
  return {
    window: 100_000, maxTokensRequested: 32_000, planMaxTokens: 32_000, margin: 1000, budget: 67_000, clientPoint: 68_000,
    allowance: 7000, hard: 61_000, trigger: 61_000, target: 21_350, mode: 'strict_total', tighten: 0, byteLimit: null,
    summaryBudget: 2680, admitTokens: null, headRoom: 33_500, ...p,
  };
}

export interface ResultOpts {
  action?: EngineAction;
  budget?: Partial<Budget>;
  tokensIn?: number;
  tokensOut?: number;
  maxTokens?: EngineResult['maxTokens'];
  error?: EngineResult['error'];
  impossibleKind?: EngineResult['impossibleKind'];
  guard?: string;
  sessionKey?: string;
}

export function result(req: ChatRequest, out: ChatRequest | null, changed: boolean, o: ResultOpts = {}): EngineResult {
  const r: EngineResult = {
    action: o.action ?? (changed ? 'compact' : 'passthrough'),
    request: out,
    changed,
    maxTokens: o.maxTokens ?? null,
    plan: null,
    sessionKey: o.sessionKey ?? 'sess-1',
    stats: {
      messagesIn: req.messages.length, messagesOut: out?.messages.length ?? 0, tokensIn: o.tokensIn ?? 0, tokensOut: o.tokensOut ?? 0,
      budget: makeBudget(o.budget), compactions: changed ? 1 : 0, summaryTokens: 0, ledgerTokens: 0, rewrites: 0, boundariesReplayed: 0,
      cacheHits: 0, engineMs: 0.1, ...(o.guard ? { guard: o.guard } : {}),
    },
  };
  if (o.error) r.error = o.error;
  if (o.impossibleKind) r.impossibleKind = o.impossibleKind;
  return r;
}

/** Forwards everything unchanged. */
export const passthroughEngine = (): FakeEngine => new FakeEngine((req) => result(req, req, false));

/**
 * Budget-aware test engine: keeps messages [0, keepHead) and drops the oldest of the rest until
 * ceil(raw · correction) ≤ budget (§3 with the learned entry and extraTighten). Unchanged when it
 * already fits; `impossible` when even the head alone does not fit.
 */
export function shrinkingEngine(cfg: Config, counter: TokenCounter, keepHead = 2): FakeEngine {
  return new FakeEngine((req, opts) => {
    const e = opts.learned ?? freshLearnedEntry(cfg.budget.window, counter.id);
    const lim = serverLimits(cfg, e, opts.extraTighten ?? 0);
    const budget: Partial<Budget> = { budget: lim.budget, hard: lim.hard, trigger: lim.hard, window: lim.window, margin: lim.margin, tighten: lim.tighten };
    const tIn = counter.countRequest(req);
    const byteLimit = Math.min(cfg.upstream.maxBodyBytes ?? Infinity, e.maxBodyBytes ?? Infinity);
    const fits = (r: ChatRequest): boolean => corrected(counter.countRequest(r), e.correction) <= lim.budget && requestBytes(r) <= byteLimit;
    if (fits(req)) return result(req, req, false, { budget, tokensIn: tIn, tokensOut: tIn });
    const msgs = [...req.messages];
    while (msgs.length > keepHead + 1) {
      // drop the oldest message after the head, with the tool results that belong to it (pairing kept)
      let n = 1;
      while (keepHead + n < msgs.length - 1 && msgs[keepHead + n]!.role === 'tool') n++;
      msgs.splice(keepHead, n);
      const cand = { ...req, messages: [...msgs] };
      if (fits(cand)) {
        const out = cand;
        const M = requestMaxTokens(req, cfg.budget.defaultMaxTokens);
        const cnt = corrected(counter.countRequest(out), e.correction);
        const mt = serverFits(cnt, M, lim) ? null : { value: lim.window - lim.margin - lim.tighten - cnt, fields: ['max_tokens' as const] };
        return result(req, out, true, { budget, tokensIn: tIn, tokensOut: counter.countRequest(out), maxTokens: mt });
      }
    }
    return result(req, null, false, {
      action: 'impossible', budget, impossibleKind: 'content', tokensIn: tIn,
      error: { status: 400, body: { error: { message: 'kitzur: test engine cannot fit this', type: 'invalid_request_error', param: null, code: 'context_length_exceeded' } } },
    });
  });
}
