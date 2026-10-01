// Shrinks a failing fuzz chain to a small repro (bench/README.md: "print the seed and a shrunk repro JSON").
//
// Greedy, deterministic passes while the same invariant still fails:
//   1. drop the requests after the first failing one;
//   2. drop earlier requests one at a time (the chain keeps its last request);
//   3. drop messages from the final history (applied to every request that contains them), units first;
//   4. halve long string contents (applied consistently to every request).
// Each candidate is re-checked with the same checks. The result carries the config, the requests and the
// violation, so `checkChain(fromRepro(json), …)` replays it.
import type { ChatMessage, ChatRequest } from '../../src/types.js';
import type { Tokenizer } from '../../src/tokenize/tokenizer.js';
import type { FuzzChain } from './gen.js';
import { checkChain, type CheckOptions, type Violation } from './invariants.js';

export interface Repro {
  seed: number;
  inv: string;
  violation: Violation | null;
  template: FuzzChain['template'];
  mode: FuzzChain['mode'];
  preset: string | null;
  cfg: FuzzChain['cfg'];
  requests: ChatRequest[];
  learned: FuzzChain['learned'];
  mutated: boolean[];
  messages: number;
  checks: number;
}

export function fromRepro(r: Repro): FuzzChain {
  return { seed: r.seed, cfg: r.cfg, template: r.template, mode: r.mode, preset: r.preset, requests: r.requests, learned: r.learned, mutated: r.mutated, tags: [] };
}

const MAX_CHECKS = 400;

export function shrink(c0: FuzzChain, inv: string, tok: Tokenizer | null, checks: CheckOptions): Repro {
  let n = 0;
  const failing = (c: FuzzChain): Violation | null => {
    n++;
    try {
      const o = checkChain(c, tok, checks);
      return o.violations.find((x) => x.inv === inv) ?? null;
    } catch {
      return null;
    }
  };
  let c = c0;
  let viol = failing(c);
  if (!viol) return out(c, null);
  const sub = (cc: FuzzChain, keep: number[]): FuzzChain => ({
    ...cc, requests: keep.map((i) => cc.requests[i]!), learned: keep.map((i) => cc.learned[i]!), mutated: keep.map((i, j) => (j === 0 ? false : cc.mutated[i]!)),
  });
  // 1. cut after the failing request
  if (viol.request >= 0 && viol.request < c.requests.length - 1) {
    const cand = sub(c, [...Array(viol.request + 1).keys()]);
    const f = failing(cand);
    if (f) [c, viol] = [cand, f];
  }
  // 2. drop earlier requests
  for (let i = c.requests.length - 2; i >= 0 && n < MAX_CHECKS; i--) {
    const keep = [...Array(c.requests.length).keys()].filter((j) => j !== i);
    const cand = sub(c, keep);
    const f = failing(cand);
    if (f) [c, viol] = [cand, f];
  }
  // 3. drop messages of the final history from every request
  const mapMsgs = (cc: FuzzChain, f: (m: ChatMessage) => ChatMessage | null): FuzzChain => ({
    ...cc,
    requests: cc.requests.map((r) => ({ ...r, messages: r.messages.map(f).filter((m): m is ChatMessage => m !== null) })),
  });
  let progress = true;
  while (progress && n < MAX_CHECKS) {
    progress = false;
    const H = c.requests[c.requests.length - 1]!.messages;
    for (let i = H.length - 1; i >= 0 && n < MAX_CHECKS; i--) {
      const victim = H[i]!;
      const cand = mapMsgs(c, (m) => (m === victim ? null : m));
      if (cand.requests.some((r) => r.messages.length === 0)) continue;
      const f = failing(cand);
      if (f) {
        [c, viol] = [cand, f];
        progress = true;
      }
    }
  }
  // 4. halve long strings
  progress = true;
  while (progress && n < MAX_CHECKS) {
    progress = false;
    const H = c.requests[c.requests.length - 1]!.messages;
    for (let i = 0; i < H.length && n < MAX_CHECKS; i++) {
      const victim = H[i]!;
      if (typeof victim.content !== 'string' || victim.content.length < 64) continue;
      const half: ChatMessage = { ...victim, content: victim.content.slice(0, Math.floor(victim.content.length / 2)) };
      const cand = mapMsgs(c, (m) => (m === victim ? half : m));
      const f = failing(cand);
      if (f) {
        [c, viol] = [cand, f];
        progress = true;
      }
    }
  }
  return out(c, viol);

  function out(cc: FuzzChain, v: Violation | null): Repro {
    return {
      seed: cc.seed, inv, violation: v, template: cc.template, mode: cc.mode, preset: cc.preset, cfg: cc.cfg, requests: cc.requests,
      learned: cc.learned, mutated: cc.mutated, messages: cc.requests[cc.requests.length - 1]?.messages.length ?? 0, checks: n,
    };
  }
}
