import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExtractor } from '../../src/engine/ledger/extract.js';
import { createToolRulesExt } from '../../src/engine/rules/index.js';
import { isListingOutput, outputPaths, samePath } from '../../src/engine/ledger/paths.js';
import { capHeadTail } from '../../src/engine/ledger/text.js';
import { SUMMARY_HEADER } from '../../src/engine/contracts.js';
import type { ChatMessage } from '../../src/types.js';
import { assistant, call, cfg, CONTINUE_SHORT, mcpSnapshot, opencodeNotice, playwrightOutput, tool } from './fixtures.js';

const C = cfg();
const rules = createToolRulesExt(C);
const ex = createExtractor(C, rules);

test('user(): facts vs client boilerplate, compaction markers, prior summaries, Kilo environment details', () => {
  assert.deepEqual(ex.user({ role: 'user', content: 'Keep using staging-3.' }), { kind: 'user', fact: true, text: 'Keep using staging-3.' });
  assert.equal(ex.user({ role: 'user', content: CONTINUE_SHORT }).fact, false);
  assert.equal(ex.user({ role: 'user', content: C.client.boilerplateUserTexts[1]! }).fact, false);
  assert.equal(ex.user({ role: 'user', content: 'What did we do so far?' }).fact, false);
  assert.equal(ex.user({ role: 'user', content: `${SUMMARY_HEADER}\n\n- earlier` }).fact, false);
  assert.equal(ex.user({ role: 'user', content: [{ type: 'text', text: 'Attached media from tool result:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }).fact, false);
  assert.equal(ex.user({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }).fact, false);
  // Kilo: every user message is an array with an <environment_details> part
  const env = '\n\n<environment_details>\nMessage time: 2026-09-28T10:00:00Z\nWorking directory: /repo\n</environment_details>';
  const kilo = ex.user({ role: 'user', content: [{ type: 'text', text: 'Use viewport 1920x1080.' }, { type: 'text', text: env }] });
  assert.deepEqual(kilo, { kind: 'user', fact: true, text: 'Use viewport 1920x1080.' });
  assert.equal(ex.user({ role: 'user', content: [{ type: 'text', text: CONTINUE_SHORT }, { type: 'text', text: env }] }).fact, false);
});

test('assistant(): OpenCode tool calls per role (MCP prefix, todowrite, read/edit/write/apply_patch, bash test)', () => {
  const nav = call('playwright_browser_navigate', { url: 'https://staging-3.shop.example/checkout/cart' });
  const todo = call('todowrite', {
    todos: [
      { content: 'Migrate cart page objects', status: 'in_progress', priority: 'high', id: '1' },
      { content: 'TODO-P3-RETRY: add retry for promo banner', status: 'pending', priority: 'medium', id: '2' },
      { content: 'Read the config', status: 'completed', priority: 'low', id: '3' },
    ],
  });
  const read = call('read', { filePath: '/repo/src/pages/legacy/PromoBanner.ts' });
  const edit = call('edit', { filePath: '/repo/src/pages/CartPage.ts', oldString: "page.locator('.cart-btn')", newString: "page.getByTestId('cart-continue')" });
  const write = call('write', { filePath: '/repo/src/pages/NewPage.ts', content: 'export {}' });
  const patch = call('apply_patch', {
    patchText: '*** Begin Patch\n*** Add File: src/pages/Added.ts\n+export {}\n*** Update File: src/pages/Old.ts\n*** Move to: src/pages/Renamed.ts\n@@\n-a\n+b\n*** Delete File: src/pages/Gone.ts\n*** End Patch',
  });
  const bash = call('bash', { command: 'npx playwright test tests/e2e/checkout/promo.spec.ts --reporter=line', description: 'Run promo spec' });
  const snap = call('playwright_browser_snapshot', {});
  const f = ex.assistant(assistant('', [nav, todo, read, edit, write, patch, bash, snap]));
  const [n, t, r, e, w, p, b, s] = f.calls;
  assert.deepEqual(n!.roles, ['snapshot', 'browserNavigate']);
  assert.equal(n!.navigateUrl, 'https://staging-3.shop.example/checkout/cart');
  assert.equal(n!.keyArgs, 'https://staging-3.shop.example/checkout/cart');
  assert.deepEqual(t!.todos, [
    { content: 'Migrate cart page objects', status: 'in_progress' },
    { content: 'TODO-P3-RETRY: add retry for promo banner', status: 'pending' },
    { content: 'Read the config', status: 'completed' },
  ]);
  assert.equal(t!.keyArgs, '(3 items)');
  assert.deepEqual(r!.files, [{ path: '/repo/src/pages/legacy/PromoBanner.ts', action: 'read' }]);
  assert.equal(r!.keyArgs, '/repo/src/pages/legacy/PromoBanner.ts');
  assert.deepEqual(e!.files, [{ path: '/repo/src/pages/CartPage.ts', action: 'edit' }]);
  assert.deepEqual(w!.files, [{ path: '/repo/src/pages/NewPage.ts', action: 'write' }]);
  assert.deepEqual(p!.files, [
    { path: 'src/pages/Added.ts', action: 'write' },
    { path: 'src/pages/Old.ts', action: 'edit' },
    { path: 'src/pages/Gone.ts', action: 'delete' },
    { path: 'src/pages/Renamed.ts', action: 'edit' },
  ]);
  assert.equal(p!.keyArgs, 'src/pages/Added.ts, src/pages/Old.ts, src/pages/Gone.ts, src/pages/Renamed.ts');
  assert.equal(b!.command, 'npx playwright test tests/e2e/checkout/promo.spec.ts --reporter=line');
  assert.equal(b!.test, true);
  assert.equal(b!.keyArgs, '`npx playwright test tests/e2e/checkout/promo.spec.ts --reporter=line`');
  assert.equal(s!.keyArgs, '');
  assert.equal(f.narrative, '');
  // Kilo / Roo names and shapes
  const kilo = ex.assistant({
    role: 'assistant',
    content: null,
    tool_calls: [call('update_todo_list', { todos: '[x] Read config\n[-] Migrate cart\n[ ] TODO-P3-RETRY retry' }), call('read_file', { path: 'src/a.ts' }), call('execute_command', { command: 'pytest -q' })],
  });
  assert.deepEqual(kilo.calls[0]!.todos, [
    { content: 'Read config', status: 'completed' },
    { content: 'Migrate cart', status: 'in_progress' },
    { content: 'TODO-P3-RETRY retry', status: 'pending' },
  ]);
  assert.deepEqual(kilo.calls[1]!.files, [{ path: 'src/a.ts', action: 'read' }]);
  assert.equal(kilo.calls[2]!.test, true);
  // unknown tool: canonical JSON of the args, capped at 120
  const other = ex.assistant(assistant('', [call('playwright_browser_click', { ref: 'e12', element: 'Apply promo button' })]));
  assert.equal(other.calls[0]!.keyArgs, '{"element":"Apply promo button","ref":"e12"}');
  const big = ex.assistant(assistant('', [call('task', { prompt: 'x'.repeat(500) })]));
  assert.equal(big.calls[0]!.keyArgs.length, 121);
});

test('assistant(): tagged lines (decision/todo/blocked/note), tier-1 labels before any cap, tier-2 text, reasoning', () => {
  const text = [
    'DECISION-D42: we will use data-testid selectors only, never CSS classes, because the design system renames classes every release. Opening the checkout page now.',
    'Cart page objects are migrated. UNFINISHED-9K: checkout_promo.spec.ts is still flaky (the promo banner animates in late).',
    '- TODO: add a retry to the promo banner spec',
    '**BLOCKED:** staging-3 returns 502 for /api/cart',
    'NOTE: promo banner animates 2s (NOTE-ANIM-C4D9P)',
    'I looked at the page. Decision: keep the old helper for now.',
    'RISK: the payment iframe may need a frame locator.',
    'Next I will open the payment page.',
  ].join('\n');
  const f = ex.assistant({ role: 'assistant', content: text, reasoning_content: 'thinking about selectors' });
  assert.deepEqual(f.tagged, [
    { tag: 'decision', text: 'DECISION-D42: we will use data-testid selectors only, never CSS classes, because the design system renames classes every release. Opening the checkout page now.' },
    { tag: 'todo', text: 'TODO: add a retry to the promo banner spec' },
    { tag: 'blocked', text: 'BLOCKED: staging-3 returns 502 for /api/cart' },
    { tag: 'note', text: 'NOTE: promo banner animates 2s (NOTE-ANIM-C4D9P)' },
    { tag: 'decision', text: 'Decision: keep the old helper for now.' },
  ]);
  assert.deepEqual(f.labels, [
    { text: 'Cart page objects are migrated. UNFINISHED-9K: checkout_promo.spec.ts is still flaky (the promo banner animates in late).', priority: true },
    { text: 'RISK: the payment iframe may need a frame locator.', priority: false },
  ]);
  assert.equal(f.narrative, 'Next I will open the payment page.');
  assert.equal(f.reasoning, ''); // reasoning.summary 'drop' (default)
  const keep = cfg();
  keep.reasoning.summary = 'keep';
  assert.equal(createExtractor(keep, createToolRulesExt(keep)).assistant({ role: 'assistant', content: 'x', reasoning_content: 'thinking about\nselectors' }).reasoning, 'thinking about selectors');
  // a label deep inside a very long message is still found (tier 1 before any cap)
  const long = ex.assistant({ role: 'assistant', content: 'filler '.repeat(400) + '\nLATE-FACT-X9: remember me' });
  assert.deepEqual(long.labels, [{ text: 'LATE-FACT-X9: remember me', priority: true }]);
  // inline <think> is reasoning, not visible text
  const think = createExtractor(keep, createToolRulesExt(keep)).assistant({ role: 'assistant', content: '<think>\nplan it\n</think>\n\nVisible answer.' });
  assert.equal(think.reasoning, 'plan it');
  assert.equal(think.narrative, 'Visible answer.');
  // with the ledger disabled everything is narrative
  const off = cfg();
  off.ledger.enabled = false;
  const g = createExtractor(off, createToolRulesExt(off)).assistant({ role: 'assistant', content: text });
  assert.deepEqual(g.tagged, []);
  assert.deepEqual(g.labels, []);
  assert.equal(g.narrative, capHeadTail(text, 600).replace(/\s+/g, ' ').trim());
});

test('result(): Playwright MCP snapshot with page state, open tabs and OpenCode notice', () => {
  const nav = call('playwright_browser_navigate', { url: 'https://staging-3.shop.example/checkout/payment' });
  const text = mcpSnapshot({
    url: 'https://staging-3.shop.example/checkout/payment',
    title: 'Payment - Shop',
    tabs: [
      { url: 'https://staging-3.shop.example/checkout/cart', title: 'Checkout - Shop' },
      { url: 'https://staging-3.shop.example/checkout/payment', title: 'Payment - Shop', current: true },
    ],
    code: "await page.goto('https://staging-3.shop.example/checkout/payment');",
    elements: 30,
    truncatedTo: '/users/example/.local/share/opencode/tool-output/tool_0194c3f1a2b3Xy9Zq',
  });
  const r = ex.result(tool(nav, text), nav);
  assert.equal(r.resultKind, 'snapshot');
  assert.equal(r.pageUrl, 'https://staging-3.shop.example/checkout/payment');
  assert.equal(r.pageTitle, 'Payment - Shop');
  assert.equal(r.tabs.length, 2);
  assert.equal(r.snapshot!.savedPath, '/users/example/.local/share/opencode/tool-output/tool_0194c3f1a2b3Xy9Zq');
  assert.match(r.condensed, /^\[snapshot: https:\/\/staging-3\.shop\.example\/checkout\/payment — "Payment - Shop", \d+ refs\]$/);
  assert.deepEqual(r.paths, []);
});

test('result(): bash test output (✓/✘) gives a tally, failure lines and the failing spec path', () => {
  const bash = call('bash', { command: 'npx playwright test tests/e2e/checkout --reporter=line' });
  const text = playwrightOutput(12, [{ spec: 'checkout/promo.spec.ts', line: 44 }, { spec: 'checkout/payment.spec.ts', line: 9 }]);
  const r = ex.result(tool(bash, text), bash);
  assert.equal(r.resultKind, 'test');
  assert.equal(r.tally, '12 passed, 2 failed');
  assert.match(r.condensed, /^✘ 13 \[chromium\] › checkout\/promo\.spec\.ts:44:5/);
  // checkout/promo.spec.ts (runner line) and tests/e2e/checkout/promo.spec.ts (stack) are one file: longest form
  assert.deepEqual(r.paths, ['checkout/cart.spec.ts', 'tests/e2e/checkout/promo.spec.ts', 'tests/e2e/checkout/payment.spec.ts']);
  // OpenCode's bash keeps the tail: the tally survives its truncation
  const cut = `...output truncated...\n\nFull output saved to: /users/example/.local/share/opencode/tool-output/tool_9\n\n` + text.split('\n').slice(-6).join('\n');
  assert.equal(ex.result(tool(bash, cut), bash).tally, '12 passed, 2 failed');
});

test('output paths (§6.2, ): config-like first, listings excluded, own path and URLs skipped, caps', () => {
  const readCfg = call('read', { filePath: '/repo/playwright.config.ts' });
  const code = [
    '// playwright.config.ts',
    "import { defineConfig } from '@playwright/test';",
    '// fixtures in tests/fixtures/cart.fixture.ts and tests/fixtures/user.fixture.ts',
    '// env overrides are loaded from config/envs/staging-3.override.yaml (see loadEnv)',
    '// docs: https://playwright.dev/docs/test-configuration.html',
    "// this file: /repo/playwright.config.ts and ./playwright.config.ts",
    'export default defineConfig({});',
  ].join('\n');
  const r = ex.result(tool(readCfg, code), readCfg);
  assert.deepEqual(r.paths, ['config/envs/staging-3.override.yaml', 'tests/fixtures/cart.fixture.ts', 'tests/fixtures/user.fixture.ts']);
  // ls -R / glob / grep outputs: > 50% of the lines start with a path (glyphs allowed)
  const ls = Array.from({ length: 30 }, (_, i) => `tests/e2e/cart/spec_${i}.spec.ts`).join('\n');
  assert.equal(isListingOutput(ls), true);
  assert.deepEqual(outputPaths(ls, [], 3), []);
  const tree = ['.', '├── src/pages/CartPage.ts', '│   └── src/pages/legacy/PromoBanner.ts', '└── config/app.yaml'].join('\n');
  assert.equal(isListingOutput(tree), true);
  const grep = Array.from({ length: 10 }, (_, i) => `/repo/src/pages/P${i}Page.ts:${i}:  await page.locator('.x').click();`).join('\n');
  assert.deepEqual(outputPaths(grep, [], 3), []);
  // URLs and OpenCode's saved-output pointer are not file references
  assert.deepEqual(outputPaths('see https://cdn.example.com/assets/app.js and http://h/x/y.css', [], 3), []);
  assert.deepEqual(outputPaths(opencodeNotice(10, '/users/example/.local/share/opencode/tool-output/tool_1.txt'), [], 3), []);
  // absolute paths keep their root; trailing punctuation is not part of the path
  assert.deepEqual(outputPaths('Error in /repo/src/a.ts: bad. Also (src/b/c.tsx).', [], 3), ['/repo/src/a.ts', 'src/b/c.tsx']);
  // one file under two spellings; a bare name never matches by suffix
  assert.ok(samePath('checkout/a.spec.ts', 'tests/e2e/checkout/a.spec.ts'));
  assert.ok(samePath('./src/a.ts', 'src/a.ts'));
  assert.ok(!samePath('index.ts', 'src/index.ts'));
  assert.ok(!samePath('src/a.ts', 'src/b.ts'));
  // the per-result cap is disabled with 0
  assert.deepEqual(outputPaths('src/a/b.ts', [], 0), []);
});

test('extraction is a pure function of the message (and its call)', () => {
  const c1 = call('read', { filePath: '/repo/a.ts' }, 'call_x');
  const m: ChatMessage = tool(c1, 'import x from "lib/x.json";');
  const a = ex.result(m, c1);
  const b = createExtractor(cfg(), createToolRulesExt(cfg())).result(structuredClone(m), structuredClone(c1));
  assert.deepEqual(a, b);
});
