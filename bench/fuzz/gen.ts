// Fuzz generator (bench/README.md): one seeded random LIVE CHAIN of client requests per seed.
//
// A chain is a history grown step by step (assistant turn, tool results, user messages) and sent at a subset
// of its boundaries, as a client does, with mid-chain events: client mutations (OpenCode prune, edited
// messages), an OpenCode/Kilo client compaction (the history is replaced by the client-summary shape and
// grows again), `chat_template_kwargs` toggles, learned-state changes (tighten, correction, learned window,
// maxPrompt, byte limit), a tools change and per-request `max_tokens` / `max_completion_tokens` variations.
//
// Windows: the small windows {2k, 4k, 8k, 16k, 32k} with randomized knobs, and the four presets
// (32k/8k, 64k/16k, 100k/32k, 128k/32k) with their defaults. Templates: sim and qwen3 (plus a few chatml /
// generic chains); counters: exact (the dev tokenizer) and estimate. Content: null/array/image/empty, huge
// results, snapshots (Page Snapshot, ≥ 10 [ref=], saved-output notices), test runs, todo calls, cue-bearing
// corrections, Hebrew/emoji/lone surrogates, reasoning (reasoning_content and reasoning), parallel calls with
// duplicate/missing ids, orphan results, mid-history system/developer/function/unknown roles, consecutive
// assistants, a user message right after an oversized result, tools blocks larger than the budget and
// oversized heads.
//
// Everything is a pure function of the seed (mulberry32), so a chain is reproduced from its seed alone.
import type { ChatMessage, ChatRequest, LearnedEntry, ToolCall } from '../../src/types.js';
import { DEFAULT_CONFIG, type Config } from '../../src/config/schema.js';
import type { TemplateName } from '../../src/tokenize/template.js';

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
    return a + Math.floor(this.next() * (Math.floor(b) - a + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
}

// ---------------------------------------------------------------- config

type DeepPartial<T> = { [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, over: DeepPartial<T> | undefined): T {
  if (over === undefined) return base;
  const out = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const b = out[k];
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) && b !== null && typeof b === 'object' && !Array.isArray(b)
      ? merge(b, v as DeepPartial<typeof b>)
      : v;
  }
  return out as T;
}

/** DEFAULT_CONFIG with overrides (deep merge; arrays replace). */
export function fuzzConfig(over?: DeepPartial<Config>): Config {
  return merge(structuredClone(DEFAULT_CONFIG), over);
}

export const PRESETS: Record<string, { window: number; out: number }> = {
  '32k': { window: 32_000, out: 8_000 },
  '64k': { window: 64_000, out: 16_000 },
  '100k': { window: 100_000, out: 32_000 },
  '128k': { window: 128_000, out: 32_000 },
};

// ---------------------------------------------------------------- content

const VOCAB = 'checkout cart promo page object selector test spec staging config payment shipping review order the a to of and is with for button field total discount invoice user session'.split(' ');
const ROLES = ['button', 'link', 'textbox', 'generic', 'heading', 'row', 'cell', 'img', 'option', 'listitem', 'combobox', 'checkbox', 'paragraph'];
const ODD = ['שלום עולם ', 'בעצם תשתמש ב-staging-5 ', '😀 ', '👩‍💻 ', 'naïve café ', '\ud800', '\udfff', 'é ', '中文 ', '\u0000', '\t', 'DECISION-D9: use testids. ', 'TODO: retry the flaky spec. ', 'NOTE: cart totals are cached. ', 'BLOCKED: waiting on staging. ', 'https://staging.shop/checkout?x=1 ', '/repo/tests/checkout.spec.ts ', 'staging-3.override.yaml '];

function prose(r: Rng, chars: number, odd = 0.004): string {
  const parts: string[] = [];
  let n = 0;
  while (n < chars) {
    const w = r.pick(VOCAB) + (r.chance(0.08) ? '.\n' : ' ');
    parts.push(w);
    n += w.length;
    if (r.chance(odd)) {
      const o = r.pick(ODD);
      parts.push(o);
      n += o.length;
    }
  }
  return cutCp(parts.join(''), chars);
}

/** slice on a code-point boundary (a generated lone surrogate stays lone on purpose; pairs are kept whole) */
function cutCp(s: string, n: number): string {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return c >= 0xd800 && c <= 0xdbff && n < s.length && (s.charCodeAt(n) & 0xfc00) === 0xdc00 ? s.slice(0, n - 1) : s.slice(0, n);
}

function code(r: Rng, chars: number): string {
  const parts: string[] = [];
  let n = 0;
  let i = r.int(0, 999);
  while (n < chars) {
    const l = `export async function step${i++}(page) {\n  await page.getByTestId('${r.pick(VOCAB)}-${r.int(1, 99)}').click();\n}\n`;
    parts.push(l);
    n += l.length;
  }
  return cutCp(parts.join(''), chars);
}

function snapshotText(r: Rng, chars: number, url: string, opts: { saved: boolean; header: boolean; tabs: boolean }): string {
  const lines: string[] = [];
  if (opts.tabs) lines.push('### Open tabs', `- 0: [Cart - Shop] (https://staging.shop/cart)`, `- 1: (current) [Checkout - Shop] (${url})`, '');
  if (opts.header) lines.push('### Page state', `- Page URL: ${url}`, '- Page Title: Checkout - Shop', '- Page Snapshot:', '```yaml');
  let n = 1;
  let size = 0;
  while (size < chars || n <= 11) {
    const depth = r.int(0, 4);
    const role = r.pick(ROLES);
    const l = '  '.repeat(depth) + `- ${role} "${r.pick(VOCAB)} ${r.pick(VOCAB)}" [ref=e${n++}]${r.chance(0.2) ? ' [cursor=pointer]' : ''}${r.chance(0.3) ? ':' : ''}`;
    lines.push(l);
    size += l.length + 1;
    if (r.chance(0.15)) {
      const c = '  '.repeat(depth + 1) + (r.chance(0.5) ? `- /url: /${r.pick(VOCAB)}/${r.int(1, 99)}` : `- text: ${r.pick(VOCAB)} ${r.pick(VOCAB)}`);
      lines.push(c);
      size += c.length + 1;
    }
  }
  if (opts.header) lines.push('```');
  if (opts.saved) {
    lines.push('', `...${r.int(1000, 99999)} bytes truncated...`, '',
      `The tool call succeeded but the output was truncated. Full output saved to: /users/example/.local/share/opencode/tool-output/tool_${r.int(1, 1e6).toString(36)}`,
      'Use Grep to search the full content or Read with offset/limit to view specific sections.');
  }
  return lines.join('\n');
}

function testRun(r: Rng, chars: number): string {
  const lines = [`Running ${r.int(3, 60)} tests using 4 workers`, ''];
  let size = 0;
  let k = 0;
  while (size < chars) {
    const ok = r.chance(0.8);
    const l = `  ${ok ? '✓' : '✘'}  ${++k} [chromium] › tests/${r.pick(VOCAB)}.spec.ts:${r.int(1, 300)}:${r.int(1, 40)} › ${r.pick(VOCAB)} ${r.pick(VOCAB)} (${r.int(1, 9999)}ms)`;
    lines.push(l);
    size += l.length + 1;
    if (!ok && r.chance(0.5)) {
      const e = `    Error: expect(locator).toHaveText(expected) failed\n    Expected: "${r.pick(VOCAB)}"\n    Received: "${r.pick(VOCAB)}"`;
      lines.push(e);
      size += e.length + 1;
    }
  }
  lines.push('', `  ${r.int(0, 5)} failed`, `  ${r.int(1, 50)} passed (${r.int(1, 99)}.${r.int(0, 9)}s)`);
  return lines.join('\n');
}

const SUMMARY_HEADER_TEXT = 'The following is a summary of your previous actions (long observations omitted):';
const CONTINUE = 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';
const CORRECTIONS = [
  'Actually, use staging-4 instead of staging-3.',
  'Correction: the promo code is SAVE20, not SAVE10.',
  'Scratch that, keep the legacy tests too.',
  'Ignore my previous message about the cart selector; use data-testid="cart-total" rather than the class.',
  'בעצם, תשתמש ב-staging-5 במקום staging-4.',
  'Also run the checkout spec on firefox.',
  'We are not using the old page object anymore.',
];

const TOOL_NAMES = ['read', 'bash', 'playwright_browser_snapshot', 'playwright_browser_click', 'playwright_browser_navigate', 'todowrite', 'edit', 'write', 'grep', 'glob'];

function toolArgs(r: Rng, name: string, C: number): string {
  switch (name) {
    case 'edit':
      return JSON.stringify({ filePath: `/repo/tests/${r.pick(VOCAB)}.spec.ts`, oldString: code(r, r.int(10, Math.max(20, C / 12))), newString: code(r, r.int(5, 200)) });
    case 'write':
      return JSON.stringify({ filePath: `/repo/${r.pick(VOCAB)}.ts`, content: code(r, r.int(10, Math.max(20, C / 10))) });
    case 'bash':
      return JSON.stringify({ command: r.chance(0.5) ? `npx playwright test tests/${r.pick(VOCAB)}.spec.ts` : `ls -la /repo/${r.pick(VOCAB)}`, description: 'run' });
    case 'todowrite':
      return JSON.stringify({ todos: Array.from({ length: r.int(1, 6) }, (_, i) => ({ id: String(i + 1), content: `${r.pick(VOCAB)} ${r.pick(VOCAB)} ${prose(r, r.int(5, 60), 0.05)}`, status: r.pick(['pending', 'in_progress', 'completed']), priority: r.pick(['high', 'medium', 'low']) })) });
    case 'playwright_browser_navigate':
      return JSON.stringify({ url: `https://staging.shop/${r.pick(VOCAB)}` });
    case 'playwright_browser_click':
      return JSON.stringify({ element: `${r.pick(VOCAB)} button`, ref: `e${r.int(1, 300)}` });
    case 'grep':
      return JSON.stringify({ pattern: r.pick(VOCAB), path: '/repo' });
    default:
      return r.chance(0.02) ? '{not json' : JSON.stringify({ filePath: `/repo/${r.pick(VOCAB)}/${r.pick(VOCAB)}.ts`, ...(r.chance(0.3) ? { offset: r.int(1, 500), limit: 200 } : {}) });
  }
}

function resultFor(r: Rng, name: string, C: number, tags: Set<string>, forceHuge: boolean, http = false): ChatMessage['content'] {
  const k = r.next();
  if (!forceHuge && r.chance(0.03)) {
    tags.add('one-line');
    // one long line (no newline to cut at), or CRLF lines
    const t = prose(r, r.int(Math.floor(C / 4), Math.floor(1.5 * C)), 0.01);
    return r.chance(0.5) ? t.replace(/\n/g, ' ') : t.replace(/\n/g, '\r\n');
  }
  if (!forceHuge && !http && r.chance(0.02)) {
    tags.add('odd-parts');
    return [{ type: 'text', text: prose(r, r.int(10, C / 4)) }, { type: 'input_audio', input_audio: { data: 'AAAA', format: 'wav' } }, { type: 'text' }, { type: 'text', text: '' }];
  }
  if (forceHuge || k < 0.05) {
    tags.add('huge');
    const n = r.int(Math.floor(1.2 * C), 3 * C);
    return r.chance(0.3) ? snapshotText(r, n, `https://staging.shop/${r.pick(VOCAB)}`, { saved: r.chance(0.5), header: true, tabs: false }) : r.pick([code, prose])(r, n);
  }
  if (name.includes('browser') && k < 0.6) {
    tags.add('snapshot');
    const header = r.chance(0.85);
    if (!header) tags.add('snapshot-refs');
    return snapshotText(r, r.int(Math.floor(C / 12), Math.floor(1.1 * C)), `https://staging.shop/${r.pick(VOCAB)}`, { saved: r.chance(0.3), header, tabs: r.chance(0.15) });
  }
  if (name === 'bash' && k < 0.5) {
    tags.add('test');
    return testRun(r, r.int(100, Math.floor(C / 3)));
  }
  if (name === 'todowrite') return r.chance(0.5) ? '[]' : JSON.stringify([{ content: 'todo', status: 'pending' }]);
  if (k < 0.64) return '';
  if (k < 0.66) return null;
  if (k < 0.71) {
    tags.add('array');
    return [
      { type: 'text', text: prose(r, r.int(10, Math.floor(C / 4))) },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      { type: 'text', text: code(r, r.int(10, Math.floor(C / 3))) },
    ];
  }
  if (k < 0.73) return [{ type: 'text', text: '' }];
  return r.pick([code, prose])(r, r.int(10, Math.floor(C / 4)));
}

// ---------------------------------------------------------------- chain

export interface FuzzChain {
  seed: number;
  cfg: Config;
  template: TemplateName;
  mode: 'exact' | 'estimate';
  preset: string | null;
  requests: ChatRequest[];
  /** per request: learned entry to plan with (null = the engine's default one) */
  learned: Array<LearnedEntry | null>;
  /** per request: not an append-extension of the previous request (client mutation or client compaction) */
  mutated: boolean[];
  tags: string[];
}

export interface GenOptions {
  /** the exact counter is available (dev tokenizer present) */
  exact: boolean;
  /** restrict to histories the bench mock accepts (intact pairing, no template errors): the HTTP subset */
  http?: boolean;
  /** force a template */
  template?: TemplateName;
}

export function learnedStub(cfg: Config): LearnedEntry {
  return {
    configuredWindow: cfg.budget.window, counterId: '', window: null, maxPrompt: null, maxBodyBytes: null, tighten: 0,
    tightenLog: [], correction: 1, samples: 0, meanRatio: 1, ratios: [], pendingTighten: [], includeUsageRejected: false, updatedAt: null,
  };
}

function genConfig(r: Rng, seed: number, o: GenOptions, tags: Set<string>): { cfg: Config; template: TemplateName; mode: 'exact' | 'estimate'; preset: string | null; W: number; out: number } {
  const usePreset = r.chance(0.22);
  const template: TemplateName = o.template ?? (r.chance(0.92) ? r.pick(['sim', 'sim', 'qwen3'] as const) : r.pick(['chatml', 'generic'] as const));
  if (usePreset) {
    const preset = r.pick(Object.keys(PRESETS));
    const p = PRESETS[preset]!;
    // exact counting is the production mode; the estimate is exercised on the small windows mostly
    const mode = o.exact && (r.chance(0.8) || o.http) ? 'exact' : 'estimate';
    tags.add('preset:' + preset);
    const cfg = fuzzConfig({
      budget: { window: p.window, defaultMaxTokens: p.out },
      tokenizer: { template: { name: template } },
      server: { type: r.chance(0.85) ? 'vllm' : r.pick(['llamacpp', 'tgi', 'ollama'] as const) },
      compaction: { keepRecent: r.chance(0.85) ? 1 : 2 },
      rules: { snapshot: { stub: r.chance(0.04) ? 'eager' : 'boundary', slim: true, interactiveRoles: DEFAULT_CONFIG.rules.snapshot.interactiveRoles, p90Tokens: null } },
    });
    return { cfg, template, mode, preset, W: p.window, out: p.out };
  }
  const W = r.pick([2000, 4000, 4000, 8000, 8000, 16000, 32000]);
  const out = Math.floor(W / r.pick([4, 8]));
  const mode = o.exact && (r.chance(0.45) || o.http) && W <= 32000 ? 'exact' : 'estimate';
  const clamp = seed % 20 === 11 || r.chance(0.1);
  if (clamp) tags.add('cfg:clamp');
  const type = r.chance(0.75) ? 'vllm' : r.pick(['llamacpp', 'tgi', 'ollama', 'sglang', 'lmstudio'] as const);
  const cfg = fuzzConfig({
    server: { type },
    budget: {
      window: W, defaultMaxTokens: out, safetyMarginTokens: Math.max(16, Math.floor(W / 64)),
      planMaxTokens: r.chance(0.05) ? Math.floor(out / 2) : null,
      maxTokensClamp: { enabled: clamp, floorTokens: Math.floor(W / 16) },
      maxTokensRestore: { enabled: r.chance(0.06), toTokens: r.chance(0.5) ? null : out },
    },
    client: { compactionPointTokens: clamp ? W : null },
    compaction: {
      enabled: !r.chance(0.01),
      keepRecent: r.pick([1, 1, 1, 2, 3]),
      summaryRole: r.chance(0.05) ? 'merge-into-first-user' : 'user',
      triggerFraction: r.chance(0.15) ? r.pick([0.8, 0.9, 0.92]) : 1,
      targetFraction: r.chance(0.1) ? r.pick([0.2, 0.5, 0.7]) : 0.35,
    },
    oversize: {
      enabled: !r.chance(0.03), admission: !r.chance(0.1),
      headPolicy: seed % 10 === 3 || r.chance(0.12) ? 'error' : 'truncate',
      admitTokens: r.chance(0.05) ? Math.floor(W / r.pick([4, 10])) : null,
    },
    reasoning: { tail: r.chance(0.1) ? 'drop' : 'keep' },
    rules: { snapshot: { stub: r.chance(0.05) ? 'eager' : r.chance(0.05) ? 'off' : 'boundary', slim: !r.chance(0.1), interactiveRoles: DEFAULT_CONFIG.rules.snapshot.interactiveRoles, p90Tokens: null } },
    upstream: { maxBodyBytes: r.chance(0.1) ? W * r.pick([3, 6]) : null },
    tokenizer: {
      template: {
        name: template,
        enableThinking: template === 'qwen3' && r.chance(0.2) ? r.chance(0.5) : null,
        preserveThinking: template === 'qwen3' && r.chance(0.2) ? r.chance(0.5) : null,
      },
      imageTokens: r.chance(0.5) ? 1568 : r.pick([64, 256]),
    },
  });
  if (cfg.rules.snapshot.stub === 'eager') tags.add('cfg:eager');
  if (cfg.compaction.summaryRole !== 'user') tags.add('cfg:merge');
  return { cfg, template, mode, preset: null, W, out };
}

/** One random live chain for `seed`. */
export function genChain(seed: number, o: GenOptions): FuzzChain {
  const r = new Rng(seed * 2654435761);
  const tags = new Set<string>();
  const { cfg, template, mode, preset, W, out } = genConfig(r, seed, o, tags);
  const http = o.http === true;
  const qwen = template === 'qwen3';
  const C = W * 3; // ~ characters per window (2.5–5 chars per token)
  const strictPairs = http; // the bench mock rejects broken pairing

  // ---- head
  const h: ChatMessage[] = [];
  if (!r.chance(0.08)) h.push({ role: r.chance(0.9) || qwen ? 'system' : 'developer', content: prose(r, r.int(20, Math.floor(C / 10))) });
  const hugeGoal = (!preset && seed % 10 === 3) || r.chance(0.07);
  if (hugeGoal) tags.add('huge-goal');
  const goal = 'Task GOAL-7: ' + prose(r, hugeGoal ? r.int(C, 3 * C) : r.int(20, Math.floor(C / 20)));
  h.push(r.chance(0.08) ? { role: 'user', content: [{ type: 'text', text: goal }, ...(qwen || r.chance(0.5) ? [] : [{ type: 'image_url', image_url: { url: 'https://img/goal.png' } }])] } : { role: 'user', content: goal });
  if (r.chance(0.06)) h.push({ role: 'user', content: 'Second head message: ' + prose(r, r.int(10, 200)) });
  if (r.chance(0.08)) {
    tags.add('client-summary');
    clientSummaryShape(r, h, seed, C, r.chance(0.3));
  } else if (r.chance(0.04)) {
    tags.add('summary-header');
    h.push({ role: 'user', content: `${SUMMARY_HEADER_TEXT}\n\n## User instructions\n- earlier rule SH-${seed}\n\n[kitzur] Messages 2–9 were compacted (compaction 1).` });
  }

  // ---- tools
  const tools: unknown[] | undefined = r.chance(0.85)
    ? TOOL_NAMES.slice(0, r.int(1, TOOL_NAMES.length)).map((name) => ({ type: 'function', function: { name, description: `The ${name} tool`, parameters: { type: 'object', properties: {} } } }))
    : undefined;
  if (tools && ((!preset && seed % 10 === 7) || r.chance(0.05))) {
    (tools[0] as { function: { description: string } }).function.description = prose(r, r.int(Math.floor(C / 2), 2 * C));
    tags.add('huge-tools');
  }

  // ---- steps and requests
  const kwMode = qwen && r.chance(0.35);
  let kw: Record<string, unknown> | null = kwMode && r.chance(0.5) ? { enable_thinking: r.chance(0.7), preserve_thinking: r.chance(0.5) } : null;
  const steps = preset ? r.int(4, 14) : r.int(3, 20);
  const sendP = r.chance(0.3) ? 1 : r.pick([0.5, 0.7, 0.9]);
  const mutateAt = !http && r.chance(0.08) ? r.int(2, steps) : -1;
  const clientCompactAt = r.chance(0.07) ? r.int(2, steps) : -1;
  const learnAt = !http && r.chance(0.08) ? r.int(1, steps) : -1;
  const kwToggleAt = kwMode && r.chance(0.5) ? r.int(1, steps) : -1;
  const toolsChangeAt = tools && r.chance(0.04) ? r.int(1, steps) : -1;
  const hugeAt = r.chance(0.12) ? r.int(0, steps - 1) : -1;
  let learned: LearnedEntry | null = null;
  let mutatePending = false;
  let curTools = tools;

  const requests: ChatRequest[] = [];
  const learnedL: Array<LearnedEntry | null> = [];
  const mutated: boolean[] = [];
  let call = 0;
  let hist = h;
  let prevSent: ChatMessage[] | null = null;
  const send = (force: boolean, mut: boolean): void => {
    if (!force && !r.chance(sendP)) return;
    const req: ChatRequest = { model: 'qwen', messages: hist.slice() };
    if (curTools) req.tools = curTools;
    const mt = r.next();
    if (mt < 0.4) req.max_tokens = out;
    else if (mt < 0.5) req.max_tokens = null;
    else if (mt < 0.55) req.max_tokens = 0;
    else if (mt < 0.7) req.max_completion_tokens = r.int(Math.floor(out / 2), out * 2);
    else if (mt < 0.8) {
      req.max_tokens = r.int(Math.floor(out / 4), out * 3);
      req.max_completion_tokens = r.int(Math.floor(out / 4), out * 3);
    } else if (mt < 0.92) req.max_tokens = r.int(Math.floor(out / 4), out * 3);
    else if (mt < 0.93 && !http) req.max_tokens = r.pick([-5, 1e9, 1.5]);
    if (kw) req['chat_template_kwargs'] = { ...kw };
    if (r.chance(0.3)) req.stream = true;
    // a request is an append-extension of the previous one unless the client rewrote it
    const ext = prevSent !== null && prevSent.length <= hist.length && prevSent.every((m, i) => m === hist[i]);
    requests.push(req);
    learnedL.push(learned ? { ...learned } : null);
    mutated.push(mut || (prevSent !== null && !ext));
    prevSent = req.messages;
  };

  for (let s = 0; s < steps; s++) {
    // mid-chain events take effect from this request on
    if (s === learnAt) {
      tags.add('learned');
      const kind = r.pick(['tighten', 'correction', 'window', 'maxPrompt', 'bytes'] as const);
      learned = { ...learnedStub(cfg), samples: 8 };
      if (kind === 'tighten') learned.tighten = Math.floor(W / r.pick([10, 20, 40]));
      if (kind === 'correction') learned.correction = r.pick([1.02, 1.04, 1.05]);
      if (kind === 'window') learned.window = Math.floor(W * r.pick([0.75, 0.9]));
      if (kind === 'maxPrompt') learned.maxPrompt = Math.floor(W * r.pick([0.5, 0.7]));
      if (kind === 'bytes') learned.maxBodyBytes = W * r.pick([2, 4]);
      tags.add('learned:' + kind);
    }
    if (s === kwToggleAt) {
      tags.add('kwargs-toggle');
      kw = kw ? null : { enable_thinking: r.chance(0.6), preserve_thinking: r.chance(0.6) };
    }
    if (s === toolsChangeAt && curTools) {
      tags.add('tools-change');
      curTools = [...curTools, { type: 'function', function: { name: 'extra_' + s, description: 'added mid-session', parameters: { type: 'object' } } }];
    }
    if (s === clientCompactAt && hist.length > 4) {
      // OpenCode/Kilo compacted on its own: [system, user marker, assistant summary, user Continue] + growth
      tags.add('client-compact');
      const sys = hist[0]!.role === 'system' || hist[0]!.role === 'developer' ? [hist[0]!] : [];
      const nh: ChatMessage[] = [...sys];
      clientSummaryShape(r, nh, seed, C, r.chance(0.3));
      nh.push({ role: 'user', content: CONTINUE });
      hist = nh;
      mutatePending = true;
    }
    if (s === mutateAt && hist.length > 3) {
      tags.add('mutation');
      const kind = r.pick(['prune', 'edit', 'drop'] as const);
      const idx = hist.findIndex((m, j) => j > 1 && (kind === 'prune' ? m.role === 'tool' : m.role === 'user' || m.role === 'assistant'));
      if (idx >= 0) {
        hist = hist.slice();
        if (kind === 'prune') hist[idx] = { ...hist[idx]!, content: '[Old tool result content cleared]' };
        else if (kind === 'edit') hist[idx] = { ...hist[idx]!, content: 'edited: ' + prose(r, 40) };
        else if (hist[idx]!.role === 'user') hist.splice(idx, 1);
        else hist[idx] = { ...hist[idx]!, content: 'x' };
        mutatePending = true;
        tags.add('mutation:' + kind);
      }
    }

    // assistant turn
    const nCalls = r.pick([0, 1, 1, 1, 1, 1, 2, 3, 4]);
    const ids: string[] = [];
    const names: string[] = [];
    for (let k = 0; k < nCalls; k++) {
      const dup = !strictPairs && r.chance(0.01) && ids.length > 0;
      const empty = !strictPairs && r.chance(0.01);
      ids.push(dup ? ids[0]! : empty ? '' : `call_${seed}_${call++}`);
      names.push(r.pick(curTools ? (curTools as Array<{ function: { name: string } }>).map((t) => t.function.name) : TOOL_NAMES));
    }
    if (ids.length > 1 && new Set(ids).size < ids.length) tags.add('dup-ids');
    const bigText = r.chance(0.04);
    const a: ChatMessage = {
      role: 'assistant',
      content: r.chance(0.25) ? (r.chance(0.5) ? null : '') : prose(r, r.int(5, bigText ? C / 2 : C / 25), 0.02),
    };
    if (r.chance(0.18)) {
      a[r.chance(0.8) ? 'reasoning_content' : 'reasoning'] = prose(r, r.int(10, Math.floor(C / 15)));
      tags.add('reasoning');
    }
    if (r.chance(0.03) && typeof a.content === 'string') {
      a.content = [{ type: 'text', text: a.content }];
      tags.add('assistant-array');
    }
    if (r.chance(0.03)) {
      a['name'] = 'agent';
      a['refusal'] = null;
      tags.add('extra-fields');
    }
    if (!ids.length && r.chance(0.03)) a.tool_calls = [];
    if (ids.length) {
      a.tool_calls = ids.map((id, k): ToolCall => ({ id, type: 'function', function: { name: names[k]!, arguments: toolArgs(r, names[k]!, C) } }));
      if (!http && r.chance(0.01)) {
        (a.tool_calls[0]!.function as { arguments: unknown }).arguments = { filePath: '/repo/obj.ts' };
        tags.add('object-args');
      }
      if (names.includes('todowrite')) tags.add('todo');
      if (ids.length > 1) tags.add('parallel');
    }
    if (a.tool_calls === undefined && r.chance(0.3)) {
      hist.push(a);
      hist.push({ role: 'assistant', content: prose(r, r.int(5, 80)) }); // consecutive assistants
      tags.add('consecutive');
    } else hist.push(a);

    // results
    const order = !strictPairs && r.chance(0.1) ? [...ids.keys()].reverse() : [...ids.keys()];
    let lastHuge = false;
    for (const k of order) {
      if (!strictPairs && r.chance(0.02)) {
        tags.add('missing-result');
        continue;
      }
      const force = s === hugeAt && k === order[0];
      const content = resultFor(r, names[k]!, C, tags, force, http);
      lastHuge = force || (typeof content === 'string' && content.length > C);
      const tm: ChatMessage = { role: 'tool', tool_call_id: ids[k]!, content };
      if (r.chance(0.03)) tm['name'] = names[k]!;
      hist.push(tm);
    }
    if (!strictPairs && r.chance(0.02)) {
      hist.push({ role: 'tool', tool_call_id: 'orphan_' + s, content: 'stray' });
      tags.add('orphan');
    }
    // user messages after the turn
    const u = r.next();
    if (lastHuge && r.chance(0.5)) {
      hist.push({ role: 'user', content: 'USER-AFTER-HUGE: ' + r.pick(CORRECTIONS) });
      tags.add('user-after-huge');
    } else if (u < 0.12) {
      hist.push({ role: 'user', content: r.pick(CORRECTIONS) });
      tags.add('correction');
    } else if (u < 0.15) hist.push({ role: 'user', content: CONTINUE });
    else if (u < 0.17 && !qwen) hist.push({ role: 'user', content: [{ type: 'text', text: 'see screenshot' }, { type: 'image_url', image_url: { url: 'https://img/x.png' } }] });
    else if (u < 0.19) hist.push({ role: 'user', content: prose(r, r.int(10, Math.floor(C / 8)), 0.05) });
    else if (u < 0.2 && qwen && !http && r.chance(0.25)) {
      // the Qwen template rejects a system message after the first: counting fails (DESIGN §5.8 I7 path)
      hist.push({ role: 'system', content: 'late system note' });
      tags.add('template-error');
    } else if (u < 0.2 && !qwen && !http) {
      hist.push({ role: r.pick(['system', 'developer', 'function', 'weird']), content: prose(r, 30) });
      tags.add('odd-role');
    }
    // the client sends at this boundary (the next assistant turn will start a new boundary)
    const last = s === steps - 1;
    send(last || mutatePending, mutatePending);
    mutatePending = false;
  }
  return { seed, cfg, template, mode, preset, requests, learned: learnedL, mutated, tags: [...tags].sort() };
}

/** The OpenCode (or Kilo) client-summary shape: user marker (+ Kilo environment part), assistant summary. */
function clientSummaryShape(r: Rng, h: ChatMessage[], seed: number, C: number, kilo: boolean): void {
  h.push(kilo
    ? { role: 'user', content: [{ type: 'text', text: 'What did we do so far?' }, { type: 'text', text: '<environment_details>\nCurrent time: now\n</environment_details>' }] }
    : { role: 'user', content: 'What did we do so far?' });
  h.push({ role: 'assistant', content: `## Objective\n- CS-ONLY-${seed} ${prose(r, r.int(50, Math.floor(C / 8)))}\n\n## Next Move\n1. go on` });
}
