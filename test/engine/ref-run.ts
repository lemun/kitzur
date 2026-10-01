// Offline run of the reference scenario through the engine (no HTTP): the client's 46 requests
// (bench/scenarios/reference.ts, capBytes 51200, sim template) are processed in order by one engine,
// and every forwarded body is counted by the bench mock's own counter (bench/lib/render.ts), exactly
// as the mock would report prompt_tokens. Used by reference.test.ts and runnable as a script:
//
//   node dist/test/engine/ref-run.js [32k|64k|100k|128k ...] [--stub] [--chatty] [--huge=<step>:<chars>] [--steps=N]
import { pathToFileURL } from 'node:url';
import type { ChatMessage, EngineResult, TokenCounter } from '../../src/types.js';
import type { Config } from '../../src/config/schema.js';
import type { Summarizer, ToolRules } from '../../src/engine/contracts.js';
import { createEngine } from '../../src/engine/engine.js';
import { createCounter } from '../../src/tokenize/counter.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { FACTS, type ScenarioOptions } from '../../bench/scenarios/reference.js';
import { devTokenizer, presetConfig, PRESETS, referenceRequests, StubRules, StubSummarizer } from './stubs.js';

export interface RunOptions {
  window: keyof typeof PRESETS;
  steps?: number;
  scenario?: ScenarioOptions;
  /** use the stub summarizer/rules even when the real ones are available */
  stub?: boolean;
  config?: (cfg: Config) => Config;
}

export interface RunReport {
  window: string;
  summarizer: 'real' | 'stub';
  steps: number;
  budget: number;
  hard: number;
  compactions: number;
  compactionSteps: number[];
  backToBack: number;
  tokens: number;
  peak: number;
  overHard: number;
  overBudget: number;
  fits: Record<string, number>;
  actions: Record<string, number>;
  admissionRewrites: number;
  hit: number;
  engineMsP50: number;
  engineMsP99: number;
  engineMsMax: number;
  /** requests that did not compact (reuse, passthrough, admit) */
  steadyMsP50: number;
  steadyMsMax: number;
  compactMsP50: number;
  compactMsMax: number;
  /** request body bytes (the client's) at the slowest steady request */
  steadyMaxBytes: number;
  restartReplayMs: number;
  restartReplayWarmMs: number;
  restartEqual: boolean;
  /** per fact marker: requests after it first appeared in which it was absent */
  factMisses: Record<string, number>;
  results: EngineResult[];
  forwarded: ChatMessage[][];
}

interface Parts {
  summarizer: (cfg: Config, c: TokenCounter) => Summarizer;
  rules: (cfg: Config) => ToolRules;
  real: boolean;
}

/** The real summarizer and rules (benchmark component) when they load, else the stubs. */
export async function loadParts(stub = false): Promise<Parts> {
  if (!stub) {
    try {
      const s = (await import('../../src/engine/summary.js')) as { createSummarizer?: Parts['summarizer'] };
      const r = (await import('../../src/engine/rules/index.js')) as { createToolRules?: Parts['rules'] };
      if (typeof s.createSummarizer === 'function' && typeof r.createToolRules === 'function') {
        return { summarizer: s.createSummarizer, rules: r.createToolRules, real: true };
      }
    } catch {
      /* not built yet */
    }
  }
  return { summarizer: (cfg, c) => new StubSummarizer(cfg, c), rules: (cfg) => new StubRules(cfg), real: false };
}

const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

export async function runReference(o: RunOptions): Promise<RunReport> {
  const tok = devTokenizer();
  if (!tok) throw new Error('dev tokenizer missing (scripts/fetch-tokenizer.sh)');
  const parts = await loadParts(o.stub);
  let cfg = presetConfig(o.window, { tokenizer: { template: { name: 'sim' } } });
  if (o.config) cfg = o.config(cfg);
  const mkCounter = () => createCounter({ mode: 'exact', template: 'sim', tokenizer: tok, tokenizerId: tok.sha256, cacheEntries: cfg.tokenizer.cacheEntries });
  const counter = mkCounter();
  const engine = createEngine(cfg, { counter, summarizer: parts.summarizer(cfg, counter), rules: parts.rules(cfg), faults: null });
  const steps = o.steps ?? 46;
  const reqs = referenceRequests(steps, o.scenario ?? { capBytes: 51_200 }, PRESETS[o.window]!.out);
  const mock = new PromptCounter(tok);
  const results: EngineResult[] = [];
  const forwarded: ChatMessage[][] = [];
  const ms: number[] = [];
  let tokens = 0;
  let peak = 0;
  let lcp = 0;
  let prevSegs: string[] | null = null;
  const actions: Record<string, number> = {};
  const fits: Record<string, number> = {};
  const compactionSteps: number[] = [];
  let admissionRewrites = 0;
  let overHard = 0;
  let overBudget = 0;
  const firstSeen = new Map<string, number>();
  const factMisses: Record<string, number> = Object.fromEntries(FACTS.map((f) => [f[0], 0]));
  let lastCompactions = 0;
  const steadyMs: number[] = [];
  const compactMs: number[] = [];
  let steadyMaxBytes = 0;
  for (let k = 0; k < reqs.length; k++) {
    const r = reqs[k]!;
    const t0 = performance.now();
    const res = engine.process(r, { attempt: 1 });
    ms.push(performance.now() - t0);
    results.push(res);
    const out = res.request?.messages ?? r.messages;
    forwarded.push(out);
    const m = mock.measureBody({ messages: out, tools: r.tools });
    tokens += m.tokens;
    peak = Math.max(peak, m.tokens);
    if (prevSegs) lcp += mock.lcp(prevSegs, m.segments);
    prevSegs = m.segments;
    const b = res.stats.budget;
    (res.action === 'compact' ? compactMs : steadyMs).push(ms[ms.length - 1]!);
    if (res.action !== 'compact' && ms[ms.length - 1]! >= Math.max(...steadyMs)) steadyMaxBytes = Buffer.byteLength(JSON.stringify(r));
    if (m.tokens > b.hard) overHard++;
    if (m.tokens > b.budget) overBudget++;
    actions[res.action] = (actions[res.action] ?? 0) + 1;
    const p = res.plan;
    if (p && p.compactions > lastCompactions) {
      compactionSteps.push(k);
      fits[p.fit] = (fits[p.fit] ?? 0) + 1;
      lastCompactions = p.compactions;
    }
    if (res.action === 'admit') admissionRewrites += Object.values(p?.rewrites ?? {}).filter((x) => x.stage === 'admission').length;
    // fact survival: once a marker is in the client's history, it must be in every forwarded request
    const inText = JSON.stringify(r.messages);
    const outText = JSON.stringify(out);
    for (const [marker] of FACTS) {
      if (!firstSeen.has(marker) && inText.includes(marker)) firstSeen.set(marker, k);
      if (firstSeen.has(marker) && !outText.includes(marker)) factMisses[marker]!++;
    }
  }
  // simulated restart: a new process has neither plans nor counter caches; replay the last request
  const last = reqs[reqs.length - 1]!;
  tok.clearCache();
  const cold = mkCounter();
  const restarted = createEngine(cfg, { counter: cold, summarizer: parts.summarizer(cfg, cold), rules: parts.rules(cfg), faults: null });
  let t0 = performance.now();
  const rr = restarted.process(last, { attempt: 1 });
  const restartReplayMs = performance.now() - t0;
  const warm = createEngine(cfg, { counter, summarizer: parts.summarizer(cfg, counter), rules: parts.rules(cfg), faults: null });
  t0 = performance.now();
  warm.process(last, { attempt: 1 });
  const restartReplayWarmMs = performance.now() - t0;
  const lastRes = results[results.length - 1]!;
  const restartEqual = JSON.stringify(rr.request?.messages) === JSON.stringify(lastRes.request?.messages) && JSON.stringify(rr.plan) === JSON.stringify(lastRes.plan);
  const b = results[0]!.stats.budget;
  let backToBack = 0;
  for (let i = 1; i < compactionSteps.length; i++) if (compactionSteps[i] === compactionSteps[i - 1]! + 1) backToBack++;
  return {
    window: o.window, summarizer: parts.real ? 'real' : 'stub', steps: reqs.length, budget: b.budget, hard: b.hard,
    compactions: lastCompactions, compactionSteps, backToBack, tokens, peak, overHard, overBudget, fits, actions, admissionRewrites,
    hit: tokens ? lcp / tokens : 0, engineMsP50: pct(ms, 50), engineMsP99: pct(ms, 99), engineMsMax: Math.max(...ms),
    steadyMsP50: pct(steadyMs, 50), steadyMsMax: Math.max(0, ...steadyMs), compactMsP50: pct(compactMs, 50), compactMsMax: Math.max(0, ...compactMs),
    steadyMaxBytes,
    restartReplayMs, restartReplayWarmMs, restartEqual, factMisses, results, forwarded,
  };
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

export function describe(r: RunReport): string {
  return [
    `${r.window} (${r.summarizer} summarizer, ${r.steps} steps): compactions ${r.compactions} at [${r.compactionSteps.join(',')}], back-to-back ${r.backToBack}`,
    `  forwarded prompt tokens ${fmt(r.tokens)}, peak ${fmt(r.peak)} (hard ${fmt(r.hard)}, budget ${fmt(r.budget)}), over hard ${r.overHard}, over budget ${r.overBudget}`,
    `  prefix hit ${(100 * r.hit).toFixed(2)}%, fits ${JSON.stringify(r.fits)}, actions ${JSON.stringify(r.actions)}, admission rewrites ${r.admissionRewrites}`,
    `  engine ms p50 ${r.engineMsP50.toFixed(1)} p99 ${r.engineMsP99.toFixed(1)} max ${r.engineMsMax.toFixed(1)} ` +
      `(steady p50 ${r.steadyMsP50.toFixed(1)} max ${r.steadyMsMax.toFixed(1)} at ${fmt(r.steadyMaxBytes)} B; compaction p50 ${r.compactMsP50.toFixed(1)} max ${r.compactMsMax.toFixed(1)})`,
    `  restart replay of the last request ${r.restartReplayMs.toFixed(0)} ms cold (${r.restartReplayWarmMs.toFixed(0)} ms with warm counter caches), equal to live: ${r.restartEqual}`,
    `  fact misses ${JSON.stringify(r.factMisses)}`,
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const windows = args.filter((a) => !a.startsWith('--')) as Array<keyof typeof PRESETS>;
  const scenario: ScenarioOptions = { capBytes: 51_200 };
  if (args.includes('--chatty')) scenario.chatty = true;
  const huge = args.find((a) => a.startsWith('--huge='));
  if (huge) {
    const [at, chars] = huge.slice(7).split(':');
    scenario.hugeAt = Number(at);
    scenario.hugeChars = Number(chars ?? 240_000);
  }
  const stepsArg = args.find((a) => a.startsWith('--steps='));
  for (const w of windows.length ? windows : (['100k', '64k', '32k', '128k'] as const)) {
    const r = await runReference({ window: w, stub: args.includes('--stub'), scenario, ...(stepsArg ? { steps: Number(stepsArg.slice(8)) } : {}) });
    console.log(describe(r));
  }
}
