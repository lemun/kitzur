// Byte-exact port of reference-harness sim/scenario.py (content generation; render/count live in
// bench/lib/render.ts). Verified against reference implementation, all 8 env variants x 200 steps
// (test/bench/scenario.test.ts).
//
// The Python module reads SIM_CAP_BYTES / SIM_CHATTY / SIM_HUGE_AT / SIM_HUGE_CHARS from the
// environment at call time; here they are explicit options (`ScenarioOptions`), and
// `scenarioOptionsFromEnv()` reproduces Python's parsing quirks (SIM_CHATTY=0 is truthy, int() accepts
// " +51_200\n", SIM_CAP_BYTES="" raises).
//
// RNG draw order is part of the contract (reference implementation): generator arguments before the
// body (randint(1,4) before the words), `ok or random()` short-circuits, choice() before random() in
// test_output's arguments, the snapshot depth draw happens on every non-':' line.

import { PyRandom } from '../lib/pyrandom.js';
import { pyDumps } from '../lib/pyjson.js';
import type { ChatMessage, ToolCall } from '../../src/types.js';

export interface ScenarioOptions {
  /** SIM_CAP_BYTES: OpenCode Truncate.output imitation (UTF-8 bytes; 0 = off). Reference: 51200. */
  capBytes?: number;
  /** SIM_CHATTY: long assistant texts. */
  chatty?: boolean;
  /** SIM_HUGE_AT: step whose tool output is replaced by one huge snapshot (null = off). */
  hugeAt?: number | null;
  /** SIM_HUGE_CHARS (default 240000). */
  hugeChars?: number;
}

/** Python int(str): strips whitespace, optional sign, underscores between digits. */
export function pyInt(s: string): number {
  const t = s.trim();
  if (!/^[+-]?\d+(?:_\d+)*$/.test(t)) throw new Error(`invalid literal for int() with base 10: '${s}'`);
  return Number(t.replaceAll('_', ''));
}

/** The env knobs exactly as scenario.py reads them. */
export function scenarioOptionsFromEnv(env: Record<string, string | undefined> = process.env): Required<ScenarioOptions> {
  const huge = env['SIM_HUGE_AT'];
  return {
    capBytes: pyInt(env['SIM_CAP_BYTES'] ?? '0'),
    chatty: Boolean(env['SIM_CHATTY']), // Python truthiness of the raw string: "0" is ON
    hugeAt: huge ? pyInt(huge) : null,
    // huge_snapshot_step() parses SIM_HUGE_CHARS only when SIM_HUGE_AT is set, so an invalid value is
    // ignored otherwise (and raises only together with SIM_HUGE_AT).
    hugeChars: huge ? pyInt(env['SIM_HUGE_CHARS'] ?? '240000') : 240000,
  };
}

/** Inverse of scenarioOptionsFromEnv, for launching the Python harness with the same knobs. */
export function scenarioEnv(o: ScenarioOptions): Record<string, string> {
  const env: Record<string, string> = {};
  if (o.capBytes) env['SIM_CAP_BYTES'] = String(o.capBytes);
  if (o.chatty) env['SIM_CHATTY'] = '1';
  if (o.hugeAt !== undefined && o.hugeAt !== null) {
    env['SIM_HUGE_AT'] = String(o.hugeAt);
    if (o.hugeChars !== undefined) env['SIM_HUGE_CHARS'] = String(o.hugeChars);
  }
  return env;
}

export const SUMMARY_HEADER = 'The following is a summary of your previous actions (long observations omitted):';

/** FACTS in Python dict order: [marker, label, channel]. */
export const FACTS: ReadonlyArray<readonly [string, string, string]> = [
  ['GOAL-CHK-7F3A', 'task goal', 'first user message (head)'],
  ['DECISION-D42', 'decision', 'assistant visible text, step 2'],
  ['USER-RULE-Q7', 'user constraint', 'user message typed mid-session, after step 9'],
  ['UNFINISHED-9K', 'unfinished item', 'assistant visible text, step 14'],
  ['TODO-P3-RETRY', 'unfinished item (todo)', 'todowrite tool-call args + its tool result, step 3'],
  ['src/pages/legacy/PromoBanner.ts', 'file path', 'read tool-call argument only, step 5'],
  ['staging-3.override.yaml', 'file path', 'inside a long tool output only, step 1'],
];
export const FACT_KEYS: readonly string[] = FACTS.map((f) => f[0]);

/** analyze.py / baseline.py SHORT names. */
export const FACT_SHORT: ReadonlyMap<string, string> = new Map([
  ['GOAL-CHK-7F3A', 'goal'],
  ['DECISION-D42', 'decision'],
  ['USER-RULE-Q7', 'user-rule'],
  ['UNFINISHED-9K', 'unfinished(text)'],
  ['TODO-P3-RETRY', 'unfinished(todo)'],
  ['src/pages/legacy/PromoBanner.ts', 'path(call arg)'],
  ['staging-3.override.yaml', 'path(tool output)'],
]);

export const GOAL_TEXT =
  'Task GOAL-CHK-7F3A: migrate the checkout E2E suite (tests/e2e/checkout/*.spec.ts) ' +
  'to the new page-object pattern under src/pages/, then make every checkout spec pass ' +
  'against the staging-3 environment using the Playwright MCP browser to inspect pages. ' +
  'Do not change application code.';

/** step -> user message appended after that step's tool results (Python USER_INJECT). */
export const USER_INJECT: ReadonlyMap<number, string> = new Map([
  [
    9,
    'Important, USER-RULE-Q7: do NOT modify anything under tests/legacy/ - the compatibility suite covers ' +
      'those files. Also keep using the staging-3 environment only.',
  ],
]);

/** Python f"{n:04d}" (the sign counts toward the width: -1 -> "-001"). */
export const pad4 = (n: number): string => (n < 0 ? '-' + String(-n).padStart(3, '0') : String(n).padStart(4, '0'));
/** Python str.capitalize() for the ASCII words used here (first upper, rest lower). */
const cap1 = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
/** Python % (floor modulo). */
const pyMod = (a: number, n: number): number => ((a % n) + n) % n;
const utf8Len = (s: string): number => Buffer.byteLength(s, 'utf8');

// ---------------------------------------------------------------- fixed fields

let systemPromptMemo: string | null = null;

export function systemPrompt(): string {
  if (systemPromptMemo !== null) return systemPromptMemo;
  const rng = new PyRandom(1);
  const rules = [
    'Prefer editing existing files over creating new ones.',
    'Run the relevant spec after every change and read the failure output carefully.',
    'Use the Playwright MCP browser tools to inspect the live page before writing selectors.',
    'Never commit, push, or change git configuration.',
    'Keep responses short; the user reads them in a terminal.',
    'When a tool call fails, explain why before retrying.',
    'Use todowrite to track multi-step work and keep it current.',
    'Quote exact file paths and line numbers when referring to code.',
  ];
  const paras: string[] = [];
  for (let i = 0; i < 46; i++) {
    const r = rng.sample(rules, 4);
    paras.push(
      `## Guideline ${i}\n` + r.join(' ') + ' ' + 'This project uses TypeScript, Playwright test runner, and page objects. '.repeat(2),
    );
  }
  systemPromptMemo = "You are a browser automation coding agent working in the user's repository.\n\n" + paras.join('\n\n');
  return systemPromptMemo;
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
  };
}

/** A fresh array each call (callers may mutate). */
export function tools(): ToolDef[] {
  const fn = (name: string, desc: string, props: Array<[string, [string, string]]>): ToolDef => {
    const properties: Record<string, { type: string; description: string }> = {};
    for (const [k, [t, d]] of props) properties[k] = { type: t, description: d };
    return {
      type: 'function',
      function: { name, description: desc, parameters: { type: 'object', properties, required: props.slice(0, 1).map(([k]) => k) } },
    };
  };
  const long = (
    'Detailed usage notes: call this tool only when needed, prefer precise arguments, ' +
    'and read the returned output fully before acting. '
  ).repeat(6);
  const agent = [
    fn('bash', 'Run a shell command. ' + long, [['command', ['string', 'command to run']], ['timeout', ['number', 'ms']]]),
    fn('read', 'Read a file. ' + long, [['filePath', ['string', 'absolute path']], ['offset', ['number', 'line']], ['limit', ['number', 'lines']]]),
    fn('edit', 'Edit a file by exact string replacement. ' + long, [
      ['filePath', ['string', 'path']],
      ['oldString', ['string', 'old']],
      ['newString', ['string', 'new']],
    ]),
    fn('write', 'Write a file. ' + long, [['filePath', ['string', 'path']], ['content', ['string', 'content']]]),
    fn('glob', 'Find files by pattern. ' + long, [['pattern', ['string', 'glob']]]),
    fn('grep', 'Search file contents. ' + long, [['pattern', ['string', 'regex']], ['path', ['string', 'dir']]]),
    fn('todowrite', 'Update the todo list. ' + long, [['todos', ['array', 'todo items']]]),
    fn('task', 'Launch a subagent. ' + long, [['prompt', ['string', 'task']], ['description', ['string', 'short']]]),
    fn('webfetch', 'Fetch a URL. ' + long, [['url', ['string', 'url']]]),
  ];
  const pw = [
    'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form',
    'browser_select_option', 'browser_hover', 'browser_press_key', 'browser_wait_for',
    'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests',
    'browser_evaluate', 'browser_tabs', 'browser_close', 'browser_resize', 'browser_drag',
    'browser_file_upload', 'browser_handle_dialog', 'browser_navigate_back', 'browser_install',
  ];
  // replaceAll: Python str.replace replaces every occurrence.
  const pwTools = pw.map((n) =>
    fn(n, `Playwright MCP: ${n.replaceAll('_', ' ')}. ` + long.slice(0, 300), [
      ['element', ['string', 'Human-readable element description']],
      ['ref', ['string', 'Exact target element reference from the page snapshot']],
      ['url', ['string', 'URL']],
    ]),
  );
  return agent.concat(pwTools);
}

// ---------------------------------------------------------------- tool outputs

export const WORDS: readonly string[] = (
  'cart promo coupon shipping billing address payment card total subtotal tax order ' +
  'summary checkout continue apply remove quantity item product delivery express ' +
  'standard gift wrap newsletter account login guest email phone country city zip'
).split(' ');

const ROLES = [
  'generic', 'link', 'button', 'textbox', 'listitem', 'cell', 'row', 'heading', 'img',
  'combobox', 'option', 'checkbox', 'paragraph', 'list', 'region', 'navigation',
];
const OPENERS = new Set(['generic', 'list', 'row', 'region', 'navigation']);

/** Playwright MCP style ARIA snapshot of roughly `chars` characters (all ASCII: JS length == Python len). */
export function snapshot(rng: PyRandom, chars: number, url: string): string {
  const lines = [`### Page state\n- Page URL: ${url}\n- Page Title: Checkout - Shop\n- Page Snapshot:\n\`\`\`yaml`];
  let ref = 1;
  let depth = 0;
  let size = lines[0]!.length;
  while (size < chars) {
    const role = rng.choice(ROLES);
    const nw = rng.randint(1, 4); // range() argument is evaluated before the generator body
    const parts: string[] = [];
    for (let i = 0; i < nw; i++) parts.push(i === 0 ? cap1(rng.choice(WORDS)) : rng.choice(WORDS));
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
    if (role === 'textbox') line += '\n' + '  '.repeat(depth + 1) + `- text: "${rng.choice(WORDS)}"`;
    lines.push(line);
    size += line.length + 1;
    ref += 1;
    if (line.endsWith(':')) depth = Math.min(depth + 1, 9);
    else if (rng.random() < 0.25 && depth > 0) depth -= rng.randint(1, depth); // random() drawn on every non-':' line
  }
  lines.push('```');
  return lines.join('\n');
}

export function codeFile(rng: PyRandom, chars: number, name: string, inject: string | null = null): string {
  const out = [`// ${name}`, "import { test, expect, Page } from '@playwright/test';", ''];
  let size = 0;
  let i = 0;
  while (size < chars) {
    const w = rng.choice(WORDS);
    // f-string order: toContainText word, TODO owner, then the two "verify" words.
    const c1 = rng.choice(WORDS);
    const c2 = rng.choice(WORDS);
    const c3 = rng.choice(WORDS);
    const c4 = rng.choice(WORDS);
    const block =
      `export async function ${w}Step${i}(page: Page) {\n` +
      `  await page.getByTestId('${w}-${i}').click();\n` +
      `  await expect(page.getByTestId('${w}-summary')).toContainText('${c1}');\n` +
      `  // TODO(${c2}): verify ${c3} ${c4} flow\n}\n`;
    out.push(block);
    size += block.length;
    i += 1;
    if (inject && i === 7) out.push(inject);
  }
  return out.join('\n');
}

export function testOutput(rng: PyRandom, chars: number, ok: boolean): string {
  const lines = ['Running 14 tests using 4 workers', ''];
  let size = 0;
  let n = 0;
  while (size < chars) {
    n += 1;
    const w = rng.choice(WORDS);
    const mark = ok || rng.random() < 0.8 ? '✓' : '✘'; // short-circuit: no random() when ok
    const a = rng.randint(5, 200);
    const b = rng.randint(3, 9);
    const w2 = rng.choice(WORDS);
    const ms = rng.randint(300, 9000);
    let line = `  ${mark}  ${n} [chromium] › checkout/${w}.spec.ts:${a}:${b} › ${w} ${w2} (${ms}ms)`;
    if (mark === '✘') {
      line +=
        `\n    Error: Timed out 5000ms waiting for expect(locator).toBeVisible()\n` +
        `    Locator: getByTestId('${w}-${n}')\n    at tests/e2e/checkout/${w}.spec.ts:${rng.randint(5, 200)}`;
    }
    lines.push(line);
    size += line.length; // ✓ ✘ › are BMP: code points == UTF-16 units
  }
  lines.push(ok ? `\n  ${n} passed` : `\n  ${n - 2} passed, 2 failed`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- step script

export type StepKind =
  | 'ls' | 'read_config' | 'navigate' | 'todo' | 'snapshot' | 'read_legacy'
  | 'click' | 'read' | 'edit' | 'test' | 'grep';

const FIXED_KINDS: ReadonlyMap<number, StepKind> = new Map([
  [0, 'ls'], [1, 'read_config'], [2, 'navigate'], [3, 'todo'], [4, 'snapshot'], [5, 'read_legacy'],
] as Array<[number, StepKind]>);
const CYCLE: readonly StepKind[] = ['click', 'read', 'edit', 'snapshot', 'test', 'navigate', 'grep', 'edit', 'snapshot', 'test'];

export function kind(step: number): StepKind {
  return FIXED_KINDS.get(step) ?? CYCLE[pyMod(step - 6, CYCLE.length)]!;
}

export const CHATTY = (
  ' My reasoning so far: the checkout flow has several page objects that still rely on ' +
  'class selectors; I compared the snapshot with the spec, noted which elements expose ' +
  'data-testid attributes, and planned the next edit so the spec stays readable. '
).repeat(4);

const TEXTS: Record<StepKind, string> = {
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

function textBase(step: number, k: StepKind, rng: PyRandom): string {
  if (step === 2)
    return (
      'DECISION-D42: we will use data-testid selectors only, never CSS classes, because ' +
      'the design system renames classes every release. Opening the checkout page now.'
    );
  if (step === 14)
    return (
      'Cart page objects are migrated. UNFINISHED-9K: checkout_promo.spec.ts is still flaky ' +
      '(the promo banner animates in late); I will come back to it after the payment page.'
    );
  if (rng.random() < 0.25) return ''; // models often emit a bare tool call
  return TEXTS[k] + ` (step ${step})`;
}

function text(step: number, k: StepKind, rng: PyRandom, o: ScenarioOptions): string {
  const t = textBase(step, k, rng);
  if (o.chatty && step !== 2 && step !== 14) return (t || 'Continuing.') + CHATTY;
  return t;
}

/** Tool-call arguments (plain objects: keys are never integer-like, so insertion order is kept). */
export type StepArgs = Record<string, unknown>;

/** (assistant_text, tool_name, args) for `step` (Python step_plan). */
export function stepPlan(step: number, o: ScenarioOptions = {}): [string, string, StepArgs] {
  const rng = new PyRandom(1000 + step);
  const k = kind(step);
  const t = text(step, k, rng, o);
  const page = rng.choice(['cart', 'shipping', 'payment', 'review', 'confirmation', 'promo']);
  let call: [string, StepArgs];
  switch (k) {
    case 'ls': call = ['bash', { command: 'ls -R tests/e2e | head -300' }]; break;
    case 'read_config': call = ['read', { filePath: '/repo/playwright.config.ts' }]; break;
    case 'navigate': call = ['browser_navigate', { url: `https://staging-3.shop.example/checkout/${page}` }]; break;
    case 'todo':
      call = ['todowrite', { todos: [
        { content: 'Migrate cart page objects', status: 'in_progress' },
        { content: 'Migrate payment page objects', status: 'pending' },
        { content: 'TODO-P3-RETRY: add retry for promo banner in checkout_promo.spec.ts', status: 'pending' },
        { content: 'Run full checkout suite on staging-3', status: 'pending' },
      ] }];
      break;
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

export interface ScenarioAssistant extends ChatMessage {
  role: 'assistant';
  content: string | null;
  tool_calls: ToolCall[];
}

/** Python assistant_message(step): arguments = json.dumps(args) with default ensure_ascii and spaced separators. */
export function assistantMessage(step: number, o: ScenarioOptions = {}): ScenarioAssistant {
  const [t, name, args] = stepPlan(step, o);
  return {
    role: 'assistant',
    content: t || null,
    tool_calls: [{ id: `call_${pad4(step)}_0`, type: 'function', function: { name, arguments: pyDumps(args) } }],
  };
}

export function toolOutputRaw(step: number, o: ScenarioOptions = {}): string {
  const rng = new PyRandom(5000 + step);
  const k = kind(step);
  const [, , args] = stepPlan(step, o); // its own fresh Random(1000+step): the 5000-stream is untouched
  if (o.hugeAt !== undefined && o.hugeAt !== null && step === o.hugeAt)
    return snapshot(rng, o.hugeChars ?? 240000, 'https://staging-3.shop.example/checkout/admin-orders');
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
      // Playwright MCP returns the page snapshot after navigate/click too.
      const chars = k !== 'click' ? rng.choice([30000, 40000, 50000, 60000, 80000]) : rng.choice([20000, 30000, 45000]);
      return snapshot(rng, chars, (args['url'] as string | undefined) ?? 'https://staging-3.shop.example/checkout/current');
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
      const chars = rng.choice([2500, 4000, 6000]); // choice before random(): argument order
      const ok = rng.random() < 0.4;
      return testOutput(rng, chars, ok);
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

/**
 * Python tool_output(step): OpenCode Truncate.output imitation in head mode — the first <= 2000 lines
 * within capBytes UTF-8 bytes, plus the notice. The notice makes a truncated output LARGER than a raw
 * output just over the cap (50,068 -> 50,218 bytes at cap 50000). Unlike OpenCode it always reports
 * bytes, never "N lines truncated" (no capped scenario output reaches 2000 lines).
 */
export function toolOutput(step: number, o: ScenarioOptions = {}): string {
  let out = toolOutputRaw(step, o);
  const cap = o.capBytes ?? 0;
  if (cap) {
    const lines = out.split('\n');
    const kept: string[] = [];
    let size = 0;
    const lim = Math.min(lines.length, 2000);
    for (let i = 0; i < lim; i++) {
      const b = utf8Len(lines[i]!) + (i ? 1 : 0);
      if (size + b > cap) break;
      kept.push(lines[i]!);
      size += b;
    }
    if (kept.length < lines.length) {
      const removed = utf8Len(out) - size;
      out =
        kept.join('\n') +
        `\n\n...${removed} bytes truncated...\n\nThe tool call succeeded but the ` +
        `output was truncated. Full output saved to: /users/example/.local/share/opencode/tool-output/` +
        `tool_${pad4(step)}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`;
    }
  }
  return out;
}

/** agent_client.py's initial history: [system(system_prompt()), user(GOAL_TEXT)]. */
export function initialHistory(): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: GOAL_TEXT },
  ];
}
