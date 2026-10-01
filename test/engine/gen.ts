// Seeded random chains for the engine property tests: a history, the boundaries at which the client
// sends it, per-request knobs, and a config (window 2k–32k). The histories cover roles and shapes the
// engine must survive: consecutive assistants, parallel calls, null/empty/array content, images,
// reasoning, huge and empty results, snapshot-like results, orphan and duplicate calls, mid-history
// system/developer/function/unknown roles, OpenCode client-summary shapes and Continue texts,
// corrections, Hebrew/emoji/lone surrogates, oversized heads and tools blocks.
import type { ChatMessage, ChatRequest, LearnedEntry } from '../../src/types.js';
import type { Config } from '../../src/config/schema.js';
import type { TemplateName } from '../../src/tokenize/template.js';
import { testConfig } from './stubs.js';

/** mulberry32 */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
}

const VOCAB = 'checkout cart promo page object selector test spec staging config payment shipping review order the a to of and is'.split(' ');
const ROLES = ['button', 'link', 'textbox', 'generic', 'heading', 'row', 'cell', 'img', 'option', 'listitem'];

function prose(r: Rng, chars: number): string {
  let s = '';
  while (s.length < chars) {
    s += r.pick(VOCAB) + (r.chance(0.08) ? '.\n' : ' ');
    if (r.chance(0.002)) s += r.pick(['שלום עולם ', '😀 ', 'naïve ', '\ud800', 'DECISION-D9: use testids. ', 'TODO: retry. ']);
  }
  return s.slice(0, chars);
}

function code(r: Rng, chars: number): string {
  let s = '';
  let i = 0;
  while (s.length < chars) s += `export function step${i++}(page) {\n  await page.getByTestId('${r.pick(VOCAB)}-${r.int(1, 99)}').click();\n}\n`;
  return s.slice(0, chars);
}

function snapshotText(r: Rng, chars: number, url: string, saved: boolean): string {
  const lines = ['### Page state', `- Page URL: ${url}`, '- Page Title: Checkout - Shop', '- Page Snapshot:', '```yaml'];
  let n = 1;
  let size = 0;
  while (size < chars) {
    const l = '  '.repeat(r.int(0, 4)) + `- ${r.pick(ROLES)} "${r.pick(VOCAB)} ${r.pick(VOCAB)}" [ref=e${n++}]`;
    lines.push(l);
    size += l.length + 1;
  }
  lines.push('```');
  if (saved) lines.push('', '...12345 bytes truncated...', '', 'The tool call succeeded but the output was truncated. Full output saved to: /users/example/.local/share/opencode/tool-output/tool_abc', 'Use Grep to search the full content or Read with offset/limit to view specific sections.');
  return lines.join('\n');
}

export interface Chain {
  seed: number;
  cfg: Config;
  template: TemplateName;
  mode: 'exact' | 'estimate';
  /** the final history; request k is history[0..ends[k]) */
  history: ChatMessage[];
  ends: number[];
  requests: ChatRequest[];
  /** per request: learned entry to pass (null = the engine's own) */
  learned: Array<LearnedEntry | null>;
  /** per request: the client rewrote an older message (not an append-extension of the previous request) */
  mutated: boolean[];
  tags: Set<string>;
}

export interface GenOptions {
  /** allow the exact counter (tokenizer present) */
  exact: boolean;
}

const CONTINUE = 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';

/** One random chain. */
export function genChain(seed: number, o: GenOptions): Chain {
  const r = new Rng(seed);
  const tags = new Set<string>();
  const W = r.pick([2000, 4000, 4000, 8000, 8000, 16000, 32000]);
  const out = Math.floor(W / r.pick([4, 8]));
  const template: TemplateName = r.chance(0.7) ? 'sim' : r.pick(['qwen3', 'chatml', 'generic'] as const);
  const mode = o.exact && r.chance(0.35) && W <= 16000 ? 'exact' : 'estimate';
  const type = r.chance(0.8) ? 'vllm' : r.pick(['llamacpp', 'tgi', 'ollama'] as const);
  // some shapes are forced by the seed so that every run of ≥ 20 chains covers them
  const clamp = seed % 20 === 11 || r.chance(0.1);
  const forceHeadError = seed % 10 === 3;
  const forceHugeTools = seed % 10 === 7;
  if (clamp) tags.add('cfg:clamp');
  const cfg = testConfig({
    server: { type },
    budget: {
      window: W, defaultMaxTokens: out, safetyMarginTokens: Math.max(16, Math.floor(W / 64)),
      maxTokensClamp: { enabled: clamp, floorTokens: Math.floor(W / 16) },
      maxTokensRestore: { enabled: r.chance(0.05), toTokens: null },
    },
    client: { compactionPointTokens: clamp ? W : null },
    compaction: {
      keepRecent: r.pick([1, 1, 1, 2, 3]),
      summaryRole: r.chance(0.05) ? 'merge-into-first-user' : 'user',
    },
    oversize: { admission: !r.chance(0.1), headPolicy: forceHeadError || r.chance(0.12) ? 'error' : 'truncate' },
    reasoning: { tail: r.chance(0.1) ? 'drop' : 'keep' },
    rules: { snapshot: { stub: r.chance(0.05) ? 'eager' : r.chance(0.05) ? 'off' : 'boundary', slim: !r.chance(0.1) } },
    upstream: { maxBodyBytes: r.chance(0.1) ? W * r.pick([3, 6]) : null },
    tokenizer: { template: { name: template } },
  });
  if (cfg.rules.snapshot.stub === 'eager') tags.add('cfg:eager');
  if (cfg.compaction.summaryRole !== 'user') tags.add('cfg:merge');
  const C = W * 3; // ~ characters per window (the estimate counts ~2.5–5 chars per token)
  const h: ChatMessage[] = [];
  if (!r.chance(0.08)) h.push({ role: r.chance(0.9) ? 'system' : 'developer', content: prose(r, r.int(20, Math.floor(C / 10))) });
  const hugeGoal = forceHeadError || r.chance(0.08);
  if (hugeGoal) tags.add('huge-goal');
  h.push({ role: 'user', content: 'Task GOAL-7: ' + prose(r, hugeGoal ? r.int(C, 3 * C) : r.int(20, Math.floor(C / 20))) });
  if (r.chance(0.1)) {
    tags.add('client-summary');
    h.push({ role: 'user', content: 'What did we do so far?' });
    h.push({ role: 'assistant', content: `## Objective\n- CS-ONLY-${seed} ${prose(r, r.int(50, Math.floor(C / 8)))}\n\n## Next Move\n1. go` });
  }
  let call = 0;
  const steps = r.int(3, 18);
  for (let s = 0; s < steps; s++) {
    const nCalls = r.pick([0, 1, 1, 1, 1, 2, 3, 4]);
    const ids: string[] = [];
    for (let k = 0; k < nCalls; k++) ids.push(r.chance(0.01) && ids.length ? ids[0]! : r.chance(0.01) ? '' : `call_${call++}`);
    const a: ChatMessage = { role: 'assistant', content: r.chance(0.25) ? (r.chance(0.5) ? null : '') : prose(r, r.int(5, r.chance(0.05) ? C / 2 : C / 25)) };
    if (r.chance(0.2)) a.reasoning_content = prose(r, r.int(10, C / 20));
    if (ids.length) {
      a.tool_calls = ids.map((id) => {
        const name = r.pick(['read', 'bash', 'browser_snapshot', 'playwright_browser_click', 'todowrite', 'edit']);
        const args = name === 'edit' ? JSON.stringify({ filePath: '/x.ts', oldString: code(r, r.int(10, C / 10)), newString: 'y' }) : JSON.stringify({ filePath: `/repo/${r.pick(VOCAB)}.ts` });
        return { id, type: 'function', function: { name, arguments: args } };
      });
    }
    if (a.tool_calls === undefined && r.chance(0.3)) {
      h.push(a);
      h.push({ role: 'assistant', content: prose(r, 40) }); // consecutive assistants
      tags.add('consecutive');
    } else h.push(a);
    const order = r.chance(0.1) ? [...ids].reverse() : ids;
    for (const id of order) {
      if (r.chance(0.02)) continue; // missing result
      let content: ChatMessage['content'];
      const k = r.next();
      if (k < 0.05) {
        content = r.pick([code, prose])(r, r.int(Math.floor(1.5 * C), 3 * C));
        tags.add('huge');
      } else if (k < 0.3) {
        content = snapshotText(r, r.int(C / 10, Math.floor(1.2 * C)), `https://staging.shop/${r.pick(VOCAB)}`, r.chance(0.3));
        tags.add('snapshot');
      } else if (k < 0.34) content = '';
      else if (k < 0.36) content = null;
      else if (k < 0.41) {
        content = [{ type: 'text', text: prose(r, r.int(10, C / 3)) }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }, { type: 'text', text: code(r, r.int(10, C / 2)) }];
        tags.add('array');
      } else content = r.pick([code, prose])(r, r.int(10, Math.floor(C / 4)));
      h.push({ role: 'tool', tool_call_id: id, content });
    }
    if (r.chance(0.02)) h.push({ role: 'tool', tool_call_id: 'orphan_' + s, content: 'stray' });
    const u = r.next();
    if (u < 0.12) h.push({ role: 'user', content: r.pick(['Actually, use staging-4 instead of staging-3.', 'Also keep the legacy tests.', prose(r, r.int(10, C / 10))]) });
    else if (u < 0.15) h.push({ role: 'user', content: CONTINUE });
    else if (u < 0.17) h.push({ role: 'user', content: [{ type: 'text', text: 'see screenshot' }, { type: 'image_url', image_url: { url: 'https://img/x.png' } }] });
    else if (u < 0.18 && template !== 'qwen3') h.push({ role: r.pick(['system', 'developer', 'function', 'weird']), content: prose(r, 30) });
  }
  // request ends: a random subset of boundaries, always the last
  const bs: number[] = [];
  for (let b = 1; b < h.length; b++) if (h[b]!.role === 'assistant' && h[b - 1]!.role !== 'assistant') bs.push(b);
  bs.push(h.length);
  const ends = bs.filter((b, i) => i === bs.length - 1 || r.chance(0.6));
  const tools = forceHugeTools || r.chance(0.8) ? [{ type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object' } } }] : undefined;
  if (tools && (forceHugeTools || r.chance(0.06))) {
    (tools[0]!.function as { description: string }).description = prose(r, 2 * C);
    tags.add('huge-tools');
  }
  const kw = template === 'qwen3' && r.chance(0.3);
  const mutateAt = r.chance(0.07) && ends.length > 2 ? r.int(1, ends.length - 1) : -1;
  const learnAt = r.chance(0.07) && ends.length > 2 ? r.int(1, ends.length - 1) : -1;
  const requests: ChatRequest[] = [];
  const learned: Array<LearnedEntry | null> = [];
  const mutated: boolean[] = [];
  for (let k = 0; k < ends.length; k++) {
    let msgs = h.slice(0, ends[k]!);
    if (mutateAt >= 0 && k >= mutateAt) {
      const i = msgs.findIndex((m, j) => j > 1 && m.role === 'tool');
      if (i >= 0) msgs = msgs.map((m, j) => (j === i ? { ...m, content: '[Old tool result content cleared]' } : m));
      tags.add('mutation');
    }
    mutated.push(mutateAt >= 0 && k === mutateAt);
    const mt = r.next();
    const req: ChatRequest = { model: 'm', messages: msgs };
    if (tools) req.tools = tools;
    if (mt < 0.5) req.max_tokens = out;
    else if (mt < 0.6) req.max_tokens = null;
    else if (mt < 0.7) req.max_tokens = 0;
    else if (mt < 0.8) req.max_completion_tokens = r.int(Math.floor(out / 2), out * 2);
    else if (mt < 0.9) req.max_tokens = r.int(Math.floor(out / 4), out * 3);
    if (kw && r.chance(0.5)) req['chat_template_kwargs'] = { preserve_thinking: r.chance(0.5), enable_thinking: r.chance(0.8) };
    requests.push(req);
    learned.push(learnAt >= 0 && k >= learnAt ? null : null);
  }
  if (learnAt >= 0) {
    tags.add('learned');
    for (let k = learnAt; k < ends.length; k++) learned[k] = { ...learnedStub(cfg), tighten: Math.floor(W / 20), correction: 1.02 };
  }
  return { seed, cfg, template, mode, history: h, ends, requests, learned, mutated, tags };
}

function learnedStub(cfg: Config): LearnedEntry {
  return {
    configuredWindow: cfg.budget.window, counterId: '', window: null, maxPrompt: null, maxBodyBytes: null, tighten: 0,
    tightenLog: [], correction: 1, samples: 0, meanRatio: 1, ratios: [], pendingTighten: [], includeUsageRejected: false, updatedAt: null,
  };
}
