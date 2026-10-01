// The BROWSER-session generator of scenario.py (bench/scenarios/reference.ts), generalised with seeds and hooks so the
// non-`-ref` families can reuse it: a seed offset (distinct interleaved sessions), a snapshot vocabulary and page
// title (Hebrew UI), per-step URL and tally suffixes (the "latest" facts), fixed texts, huge-output markers.
//
// With the default options it reproduces reference.assistantMessage / reference.toolOutput byte for byte (test/bench/
// scenario-browser-gen.test.ts checks 200 steps × the reference variants), including the RNG draw order documented in
// reference.ts. The `-ref` scenarios nevertheless use reference.ts itself (bench/scenarios/browser.ts), so nothing here can
// change a cross-checked number.

import type { ChatMessage } from '../../src/types.js';
import { PyRandom } from '../lib/pyrandom.js';
import { pyDumps } from '../lib/pyjson.js';
import {
  CHATTY, codeFile, GOAL_TEXT, kind, systemPrompt, testOutput, tools as referenceTools, USER_INJECT, WORDS, type StepArgs, type StepKind,
} from './reference.js';
import { assistantWithCalls, capOutput, userMsg, type SessionScript } from './common.js';

export const PAGES = ['cart', 'shipping', 'payment', 'review', 'confirmation', 'promo'] as const;
export const REF_TITLE = 'Checkout - Shop';

/** reference.ts TEXTS (not exported there). */
export const STEP_TEXTS: Readonly<Record<StepKind, string>> = {
  click: 'Clicking the next checkout control to see the resulting state.',
  read: 'Reading the page object to update its selectors.',
  edit: 'Replacing the class selector with a data-testid locator.',
  snapshot: 'Taking a fresh snapshot to confirm the change rendered.',
  test: 'Running the checkout specs.',
  navigate: 'Navigating to the next checkout page.',
  grep: 'Searching for remaining class-based selectors.',
  ls: 'Exploring the test layout first.',
  read_config: 'Reading the Playwright config.',
  todo: 'Recording the plan.',
  read_legacy: 'Checking the legacy promo banner helper.',
};

export const REF_FIXED_TEXTS: ReadonlyMap<number, string> = new Map([
  [
    2,
    'DECISION-D42: we will use data-testid selectors only, never CSS classes, because ' +
      'the design system renames classes every release. Opening the checkout page now.',
  ],
  [
    14,
    'Cart page objects are migrated. UNFINISHED-9K: checkout_promo.spec.ts is still flaky ' +
      '(the promo banner animates in late); I will come back to it after the payment page.',
  ],
]);

export const REF_TODOS: ReadonlyArray<{ content: string; status: string }> = [
  { content: 'Migrate cart page objects', status: 'in_progress' },
  { content: 'Migrate payment page objects', status: 'pending' },
  { content: 'TODO-P3-RETRY: add retry for promo banner in checkout_promo.spec.ts', status: 'pending' },
  { content: 'Run full checkout suite on staging-3', status: 'pending' },
];

const ROLES = [
  'generic', 'link', 'button', 'textbox', 'listitem', 'cell', 'row', 'heading', 'img',
  'combobox', 'option', 'checkbox', 'paragraph', 'list', 'region', 'navigation',
];
const OPENERS = new Set(['generic', 'list', 'row', 'region', 'navigation']);
const cap1 = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/**
 * reference.snapshot() with a vocabulary for the accessible names and textbox values (URLs stay ASCII, as gateway-probes
 * content.py does for its Hebrew snapshot) and a page title. words = WORDS, title = REF_TITLE reproduces it exactly.
 * Lengths are UTF-16 units: equal to Python len() for the BMP vocabularies used here (ASCII and Hebrew).
 */
export function snapshotW(rng: PyRandom, chars: number, url: string, words: readonly string[] = WORDS, title = REF_TITLE): string {
  const lines = [`### Page state\n- Page URL: ${url}\n- Page Title: ${title}\n- Page Snapshot:\n\`\`\`yaml`];
  let ref = 1;
  let depth = 0;
  let size = lines[0]!.length;
  while (size < chars) {
    const role = rng.choice(ROLES);
    const nw = rng.randint(1, 4);
    const parts: string[] = [];
    for (let i = 0; i < nw; i++) parts.push(i === 0 ? cap1(rng.choice(words)) : rng.choice(words));
    let name = parts.join(' ');
    let extra = '';
    if (role === 'link' || role === 'button') extra = ' [cursor=pointer]';
    if (role === 'cell') {
      const a = rng.randint(1, 999);
      const b = rng.randint(10, 99);
      name = `$${a}.${b}`;
    }
    let line = '  '.repeat(depth) + `- ${role} "${name}" [ref=e${ref}]${extra}` + (OPENERS.has(role) ? ':' : '');
    if (role === 'link') {
      const w = rng.choice(WORDS);
      const n = rng.randint(100, 9999);
      line += '\n' + '  '.repeat(depth + 1) + `- /url: /${w}/${n}`;
    }
    if (role === 'textbox') line += '\n' + '  '.repeat(depth + 1) + `- text: "${rng.choice(words)}"`;
    lines.push(line);
    size += line.length + 1;
    ref += 1;
    if (line.endsWith(':')) depth = Math.min(depth + 1, 9);
    else if (rng.random() < 0.25 && depth > 0) depth -= rng.randint(1, depth);
  }
  lines.push('```');
  return lines.join('\n');
}

/** Insert `line` before the closing ``` of a snapshot (last 200 chars) or in the middle of any text. */
export function insertLine(text: string, line: string, where: 'before-last' | 'middle'): string {
  const lines = text.split('\n');
  const at = where === 'before-last' ? lines.length - 1 : Math.floor(lines.length / 2);
  lines.splice(at, 0, line);
  return lines.join('\n');
}

export interface BrowserGenOptions {
  id: string;
  steps: number;
  /** 0 = the reference RNG streams Random(1000+step) / Random(5000+step); otherwise added to both seeds */
  seedOffset?: number;
  capBytes?: number | null;
  chatty?: boolean;
  hugeAt?: number | null;
  hugeChars?: number;
  /** the huge output's content (reference: a snapshot; `test`: a non-snapshot test log, F4 huge180k-test) */
  hugeKind?: 'snapshot' | 'test';
  /** markers planted in the huge output: in its first 200 chars, its middle, its last 200 chars */
  hugeMarkers?: { head?: string; mid?: string; tail?: string };
  /** snapshot vocabulary (default WORDS) and page title (default REF_TITLE) */
  words?: readonly string[];
  pageTitle?: string;
  /** appended to the navigate URL of a step (e.g. "?run=NAV-S11-K3M9Q"); also echoed by its snapshot */
  urlSuffix?: (step: number) => string | null;
  /** appended to the last (tally) line of a step's test output */
  tallySuffix?: (step: number) => string | null;
  /** assistant texts that replace the drawn text at fixed steps (default: the reference DECISION/UNFINISHED) */
  fixedTexts?: ReadonlyMap<number, string>;
  goalText?: string;
  /** user messages after a step (default: the reference USER_INJECT) */
  userInject?: ReadonlyMap<number, string>;
  todos?: ReadonlyArray<{ content: string; status: string }>;
  /**
   * When set, raw outputs are memoized process-wide under this key (scenarios that share content — every qa46-based
   * variant — then generate it once). The key must identify every option, hooks included.
   */
  cacheKey?: string;
}

const OUTPUT_MEMO = new Map<string, string>();

/** The BROWSER generator: step plans and raw outputs, as reference.ts computes them, with the hooks above. */
export class BrowserGen {
  readonly o: BrowserGenOptions;
  constructor(o: BrowserGenOptions) {
    this.o = o;
  }

  private get off(): number {
    return this.o.seedOffset ?? 0;
  }

  private fixed(): ReadonlyMap<number, string> {
    return this.o.fixedTexts ?? REF_FIXED_TEXTS;
  }

  private text(step: number, k: StepKind, rng: PyRandom): string {
    const f = this.fixed().get(step);
    let t: string;
    if (f !== undefined) t = f;
    else if (rng.random() < 0.25) t = '';
    else t = STEP_TEXTS[k] + ` (step ${step})`;
    if (this.o.chatty && f === undefined) return (t || 'Continuing.') + CHATTY;
    return t;
  }

  navigateUrl(step: number, page: string): string {
    const suffix = this.o.urlSuffix?.(step) ?? '';
    return `https://staging-3.shop.example/checkout/${page}${suffix}`;
  }

  /**
   * The page a snapshot / click result reports (`- Page URL:`): the URL of the latest navigate at or before the step,
   * as a real browser (Playwright MCP) would. scenario.py's generic `.../checkout/current` made every snapshot after a
   * navigate contradict it, so a proxy that keeps the latest page state (DESIGN.md "rest": last URL per tab)
   * could not keep the planted "latest navigate URL" facts (benchmark contract ). The byte-exact `-ref` variants use
   * reference.ts and are unaffected.
   */
  currentUrl(step: number): string {
    for (let s = step; s >= 0; s--) {
      if (kind(s) !== 'navigate') continue;
      const url = this.stepPlan(s)[2]['url'];
      if (typeof url === 'string') return url;
    }
    return 'https://staging-3.shop.example/checkout/current';
  }

  /** (assistant_text, tool_name, args), like reference.stepPlan. */
  stepPlan(step: number): [string, string, StepArgs] {
    const rng = new PyRandom(this.off + 1000 + step);
    const k = kind(step);
    const t = this.text(step, k, rng);
    const page = rng.choice(PAGES);
    let call: [string, StepArgs];
    switch (k) {
      case 'ls': call = ['bash', { command: 'ls -R tests/e2e | head -300' }]; break;
      case 'read_config': call = ['read', { filePath: '/repo/playwright.config.ts' }]; break;
      case 'navigate': call = ['browser_navigate', { url: this.navigateUrl(step, page) }]; break;
      case 'todo': call = ['todowrite', { todos: (this.o.todos ?? REF_TODOS).map((x) => ({ ...x })) }]; break;
      case 'snapshot': call = ['browser_snapshot', {}]; break;
      case 'read_legacy': call = ['read', { filePath: '/repo/src/pages/legacy/PromoBanner.ts' }]; break;
      case 'click': call = ['browser_click', { element: `${page} continue button`, ref: `e${rng.randint(10, 900)}` }]; break;
      case 'read': call = ['read', { filePath: `/repo/src/pages/${cap1(page)}Page.ts` }]; break;
      case 'edit':
        call = ['edit', {
          filePath: `/repo/src/pages/${cap1(page)}Page.ts`,
          oldString: `page.locator('.${page}-btn')`,
          newString: `page.getByTestId('${page}-continue')`,
        }];
        break;
      case 'test': call = ['bash', { command: `npx playwright test tests/e2e/checkout/${page}.spec.ts --reporter=line` }]; break;
      case 'grep': call = ['grep', { pattern: "locator\\('\\.", path: '/repo/src/pages' }]; break;
    }
    return [t, call[0], call[1]];
  }

  assistant(step: number): ChatMessage {
    const [t, name, args] = this.stepPlan(step);
    return assistantWithCalls(step, t, [[name, args]]);
  }

  private huge(rng: PyRandom): string {
    const chars = this.o.hugeChars ?? 240_000;
    const m = this.o.hugeMarkers ?? {};
    if ((this.o.hugeKind ?? 'snapshot') === 'test') {
      let out = testOutput(rng, chars, false);
      if (m.head) out = out.replace(/^Running 14 tests using 4 workers/, `Running 14 tests using 4 workers [shard ${m.head}]`);
      if (m.mid) out = insertLine(out, `  ✘  0 [chromium] › checkout/orders-export.spec.ts:1:1 › export ${m.mid}`, 'middle');
      if (m.tail) out += ` [shard summary ${m.tail}]`;
      return out;
    }
    const title = m.head ? `Orders admin ${m.head}` : REF_TITLE;
    let out = snapshotW(rng, chars, 'https://staging-3.shop.example/checkout/admin-orders', this.o.words ?? WORDS, title);
    if (m.mid) out = insertLine(out, `- paragraph "Orders export page 2 ${m.mid}" [ref=e900001]`, 'middle');
    if (m.tail) out = insertLine(out, `- paragraph "End of orders export ${m.tail}" [ref=e900002]`, 'before-last');
    return out;
  }

  /** reference.toolOutputRaw with the hooks (memoized under `cacheKey`). */
  outputRaw(step: number): string {
    if (this.o.cacheKey === undefined) return this.generate(step);
    const k = `${this.o.cacheKey}\u0000${step}`;
    let v = OUTPUT_MEMO.get(k);
    if (v === undefined) {
      if (OUTPUT_MEMO.size > 5000) OUTPUT_MEMO.clear();
      OUTPUT_MEMO.set(k, (v = this.generate(step)));
    }
    return v;
  }

  private generate(step: number): string {
    const rng = new PyRandom(this.off + 5000 + step);
    const k = kind(step);
    const [, , args] = this.stepPlan(step); // its own RNG: the 5000-stream is untouched
    if (this.o.hugeAt !== undefined && this.o.hugeAt !== null && step === this.o.hugeAt) return this.huge(rng);
    const words = this.o.words ?? WORDS;
    const title = this.o.pageTitle ?? REF_TITLE;
    switch (k) {
      case 'ls': {
        const out: string[] = [];
        for (let i = 0; i < 90; i++) {
          const a = rng.choice(WORDS);
          const b = rng.choice(WORDS);
          out.push(`tests/e2e/${a}/${b}_${i}.spec.ts`);
        }
        return out.join('\n');
      }
      case 'read_config':
        return codeFile(rng, 6000, 'playwright.config.ts', '// env overrides are loaded from config/envs/staging-3.override.yaml (see loadEnv)\n');
      case 'todo':
        return pyDumps(args['todos'], { indent: 2 });
      case 'navigate':
      case 'click':
      case 'snapshot': {
        const chars = k !== 'click' ? rng.choice([30000, 40000, 50000, 60000, 80000]) : rng.choice([20000, 30000, 45000]);
        // with urlSuffix (the O1 "latest URL" series) the page reports the latest navigated URL; without it, the
        // reference's generic URL (BrowserGen's defaults stay byte-identical to reference.ts)
        const here = this.o.urlSuffix ? this.currentUrl(step) : 'https://staging-3.shop.example/checkout/current';
        return snapshotW(rng, chars, (args['url'] as string | undefined) ?? here, words, title);
      }
      case 'read_legacy':
        return codeFile(rng, 5000, 'PromoBanner.ts');
      case 'read': {
        const chars = rng.choice([4000, 7000, 10000]);
        return codeFile(rng, chars, (args['filePath'] as string).split('/').pop()!);
      }
      case 'edit':
        return 'Edit applied successfully.';
      case 'test': {
        const chars = rng.choice([2500, 4000, 6000]);
        const ok = rng.random() < 0.4;
        const out = testOutput(rng, chars, ok);
        const sfx = this.o.tallySuffix?.(step);
        return sfx ? `${out} ${sfx}` : out;
      }
      case 'grep': {
        const out: string[] = [];
        for (let i = 0; i < 40; i++) {
          const a = cap1(rng.choice(WORDS));
          const n = rng.randint(1, 300);
          const b = rng.choice(WORDS);
          out.push(`/repo/src/pages/${a}Page.ts:${n}:  await page.locator('.${b}-btn').click();`);
        }
        return out.join('\n');
      }
    }
  }

  output(step: number): string {
    return capOutput(this.outputRaw(step), step, this.o.capBytes);
  }

  /** The SessionScript (reference system prompt, tools, goal, USER_INJECT unless overridden). */
  script(): SessionScript {
    const o = this.o;
    const inject = o.userInject ?? USER_INJECT;
    return {
      id: o.id,
      seed: o.seedOffset ?? 0,
      steps: o.steps,
      system: () => systemPrompt(),
      tools: () => referenceTools(),
      goal: () => userMsg(o.goalText ?? GOAL_TEXT),
      assistant: (step) => this.assistant(step),
      results: (step) => [this.output(step)],
      users: (step) => {
        const t = inject.get(step);
        return t === undefined ? [] : [userMsg(t)];
      },
    };
  }
}

/** Steps of a kind within [0, steps). */
export function stepsOfKind(k: StepKind, steps: number): number[] {
  const out: number[] = [];
  for (let s = 0; s < steps; s++) if (kind(s) === k) out.push(s);
  return out;
}
