// Shared helpers for the summary tests: counters over the dev tokenizer, reference-scenario histories
// (bench/scenarios/reference.ts, byte-exact port of scenario.py) and a seeded random history generator.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage } from '../../src/types.js';
import { createCounter, type Counter } from '../../src/tokenize/counter.js';
import { loadTokenizerCached, type LoadedTokenizer } from '../../src/tokenize/load.js';
import type { TemplateName } from '../../src/tokenize/template.js';
import { digestOf } from '../../src/tokenize/canonical.js';
import { testTokenizerPath } from '../helpers.js';
import { assistantMessage, initialHistory, toolOutput, USER_INJECT, type ScenarioOptions } from '../../bench/scenarios/reference.js';
import { assistant, call, mcpSnapshot, playwrightOutput, tool, user } from '../ledger/fixtures.js';

let tok: LoadedTokenizer | null | undefined;
/** The dev tokenizer (bench/.cache/Qwen3.6-27B-tokenizer.json), or null: tests that need it skip. */
export function devTokenizer(): LoadedTokenizer | null {
  if (tok !== undefined) return tok;
  const p = testTokenizerPath();
  tok = p ? loadTokenizerCached(p, null, { stateDir: join(tmpdir(), 'kitzur-test-tokenizer-cache') }) : null;
  return tok;
}

export function exactCounter(template: TemplateName): Counter | null {
  const t = devTokenizer();
  return t ? createCounter({ mode: 'exact', template, tokenizer: t, tokenizerId: t.sha256 }) : null;
}

export const estimateCounter = (template: TemplateName = 'qwen3'): Counter => createCounter({ mode: 'estimate', template });

export const digests = (msgs: ChatMessage[]): string[] => msgs.map((m) => digestOf(m));

/** Index of the start of the newest assistant unit (the start of the mandatory units with keepRecent 1). */
export function lastAssistant(msgs: ChatMessage[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]!.role === 'assistant') return i;
  return -1;
}

/**
 * The reference session as the bench client sends it at `step` (history after steps 0..step-1): assistant
 * message, one tool message per call, and USER_INJECT; `extra` adds user messages after a step (overlays).
 */
export function referenceHistory(step: number, o: ScenarioOptions, extra: ReadonlyMap<number, string[]> = new Map()): ChatMessage[] {
  const h = initialHistory();
  for (let s = 0; s < step; s++) {
    const a = assistantMessage(s, o);
    h.push(a);
    for (const c of a.tool_calls) h.push({ role: 'tool', tool_call_id: c.id, content: toolOutput(s, o) });
    const inj = USER_INJECT.get(s);
    if (inj !== undefined) h.push({ role: 'user', content: inj });
    for (const u of extra.get(s) ?? []) h.push({ role: 'user', content: u });
  }
  return h;
}

/**
 * The history once for `steps` steps, with the message count the client sends at each step (lenAt[k] = length of
 * the request at step k), so a test can slice every step's request out of one build.
 */
export function referenceSession(steps: number, o: ScenarioOptions, extra: ReadonlyMap<number, string[]> = new Map()): { msgs: ChatMessage[]; lenAt: number[] } {
  const msgs = initialHistory();
  const lenAt: number[] = [msgs.length];
  for (let s = 0; s < steps; s++) {
    const a = assistantMessage(s, o);
    msgs.push(a);
    for (const c of a.tool_calls) msgs.push({ role: 'tool', tool_call_id: c.id, content: toolOutput(s, o) });
    const inj = USER_INJECT.get(s);
    if (inj !== undefined) msgs.push({ role: 'user', content: inj });
    for (const u of extra.get(s) ?? []) msgs.push({ role: 'user', content: u });
    lenAt.push(msgs.length);
  }
  return { msgs, lenAt };
}

/** mulberry32: a small seeded PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USER_TEXTS = [
  'Keep using the staging-3 environment only.',
  'Run the payment specs against staging-3.',
  'Change of plan: use staging-4 for payment, staging-3 is down.',
  'USER-VIEW-R4: run every checkout spec at viewport 1280x720 (VP-OLD-K7Q2M).',
  'Correction for USER-VIEW-R4: use viewport 1920x1080 instead (VP-NEW-R3T8W).',
  'Also add a data-testid to the cart badge rather than relying on its text.',
  'Important: do NOT modify anything under tests/legacy/.\n---\nTeam B owns those files.',
  'Actually, the checkout page has a new banner now.',
  'Please keep the reports short.',
];
const TEXTS = [
  '',
  '',
  'Reading the page object to update its selectors.',
  'DECISION: use getByRole for buttons because the test ids are unstable.',
  'TODO: re-run the promo spec after the fix.\nBLOCKED: the payment sandbox is down.',
  'NOTE: the banner animates for 2s.',
  'RISK-R2: the iframe may need a frame locator. Checking it next.',
  'My reasoning so far: the checkout flow has several page objects that still rely on class selectors; I compared the snapshot with the spec. '.repeat(3),
];
const PAGES = ['cart', 'shipping', 'payment', 'review', 'promo'];

/** A random OpenCode-shaped session: [system, goal, units...]. */
export function randomHistory(seed: number, units: number): ChatMessage[] {
  const r = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const h: ChatMessage[] = [
    { role: 'system', content: 'You are a browser automation coding agent.' },
    user('Task GOAL-CHK-7F3A: migrate the checkout E2E suite to page objects and make every checkout spec pass on staging-3.'),
  ];
  let n = 0;
  for (let u = 0; u < units; u++) {
    if (u > 0 && r() < 0.12) {
      h.push(user(pick(USER_TEXTS)));
      continue;
    }
    const page = pick(PAGES);
    const P = page[0]!.toUpperCase() + page.slice(1);
    const calls = [];
    const k = r() < 0.15 ? 0 : r() < 0.8 ? 1 : 2;
    for (let j = 0; j < k; j++) {
      const id = `call_${seed}_${n++}`;
      const x = r();
      if (x < 0.15) calls.push([call('read', { filePath: `/repo/src/pages/${P}Page.ts` }, id), `// ${P}Page.ts\nimport cfg from 'config/envs/${page}.override.yaml';\n` + 'export const x = 1;\n'.repeat(Math.floor(r() * 80))] as const);
      else if (x < 0.25) calls.push([call('edit', { filePath: `/repo/src/pages/${P}Page.ts`, oldString: 'a', newString: 'b' }, id), 'Edit applied successfully.'] as const);
      else if (x < 0.4) calls.push([call('bash', { command: `npx playwright test tests/e2e/checkout/${page}.spec.ts --reporter=line` }, id), playwrightOutput(3 + Math.floor(r() * 9), r() < 0.5 ? [{ spec: `checkout/${page}.spec.ts`, line: 10 + Math.floor(r() * 90) }] : [])] as const);
      else if (x < 0.55) calls.push([call('playwright_browser_navigate', { url: `https://staging-3.shop.example/checkout/${page}` }, id), mcpSnapshot({ url: `https://staging-3.shop.example/checkout/${page}`, title: `${P} - Shop`, elements: 4 + Math.floor(r() * 20) })] as const);
      else if (x < 0.7) calls.push([call('playwright_browser_snapshot', {}, id), mcpSnapshot({ url: `https://staging-3.shop.example/checkout/${page}`, title: `${P} - Shop`, elements: 4 + Math.floor(r() * 20) })] as const);
      else if (x < 0.8) calls.push([call('todowrite', { todos: [{ content: `Migrate ${page} page objects`, status: pick(['pending', 'in_progress', 'completed']) }, { content: 'TODO-P3-RETRY: add retry for promo banner', status: 'pending' }] }, id), '[]'] as const);
      else if (x < 0.9) calls.push([call('bash', { command: 'ls -R tests/e2e | head -300' }, id), Array.from({ length: 20 }, (_, i) => `tests/e2e/${page}/s_${i}.spec.ts`).join('\n')] as const);
      else calls.push([call('write', { filePath: `/repo/src/pages/${P}Helper.ts`, content: 'export {}' }, id), 'Wrote file successfully.'] as const);
    }
    const text = pick(TEXTS);
    const extra: Partial<ChatMessage> = r() < 0.3 ? { reasoning_content: 'I should check the selectors first.' } : {};
    h.push(assistant(text, calls.map(([c]) => c), extra));
    for (const [c, out] of calls) h.push(tool(c, out));
  }
  return h;
}

/** Unit starts in [from, b]: assistant/user/system/developer messages, plus b itself. */
export function unitStarts(msgs: ChatMessage[], from: number): number[] {
  const out: number[] = [];
  for (let i = from; i < msgs.length; i++) if (['assistant', 'user', 'system', 'developer'].includes(msgs[i]!.role)) out.push(i);
  out.push(msgs.length);
  return out;
}

/** hEnd: the first assistant (no client summaries in these histories). */
export function headEnd(msgs: ChatMessage[]): number {
  const i = msgs.findIndex((m) => m.role === 'assistant');
  return i < 0 ? msgs.length : i;
}
