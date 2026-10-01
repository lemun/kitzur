import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../../src/types.js';
import type { Config } from '../../src/config/schema.js';
import { SUMMARY_HEADER, type SummaryInput, type SummaryOptions } from '../../src/engine/contracts.js';
import { createSummarizer, createSummarizerExt, FACTS_LINE } from '../../src/engine/summary.js';
import { tools as referenceTools } from '../../bench/scenarios/reference.js';
import { assistant, call, cfg, CONTINUE_SHORT, mcpSnapshot, playwrightOutput, tool, user } from '../ledger/fixtures.js';
import { digests, estimateCounter, exactCounter, headEnd, lastAssistant, prng, randomHistory, referenceHistory, unitStarts } from './helpers.js';

const OPTS: SummaryOptions = { budgetTokens: 1_000_000, allowFloorEviction: false, userShortenStep: 0 };
const input = (messages: ChatMessage[], cut: number, compaction = 1, hEnd = headEnd(messages)): SummaryInput => ({ messages, digests: digests(messages), hEnd, cut, compaction });
const qwen = exactCounter('qwen3');
const counter = qwen ?? estimateCounter('qwen3');

/** A crafted OpenCode session touching every ledger channel. */
function session(): ChatMessage[] {
  const ls = call('bash', { command: 'ls -R tests/e2e | head -300', description: 'List tests' }, 'c_ls');
  const rc = call('read', { filePath: '/repo/playwright.config.ts' }, 'c_rc');
  const nav = call('playwright_browser_navigate', { url: 'https://staging-3.shop.example/checkout/cart' }, 'c_nav');
  const td1 = call('todowrite', { todos: [
    { content: 'Migrate cart page objects', status: 'in_progress' },
    { content: 'TODO-DROP-Z1H5K: remove the legacy banner helper', status: 'pending' },
    { content: 'TODO-P3-RETRY: add retry for promo banner in checkout_promo.spec.ts', status: 'pending' },
  ] }, 'c_td1');
  const t1 = call('bash', { command: 'npx playwright test tests/e2e/checkout/promo.spec.ts --reporter=line' }, 'c_t1');
  const ed = call('edit', { filePath: '/repo/src/pages/CartPage.ts', oldString: "page.locator('.cart-btn')", newString: "page.getByTestId('cart-continue')" }, 'c_ed');
  const td2 = call('todowrite', { todos: [
    { content: 'Migrate cart page objects', status: 'completed' },
    { content: 'TODO-P3-RETRY: add retry for promo banner in checkout_promo.spec.ts', status: 'in_progress' },
    { content: 'TODO-NEW-B8M2N: migrate the payment page', status: 'pending' },
  ] }, 'c_td2');
  const t2 = call('bash', { command: 'npx playwright test tests/e2e/checkout/cart.spec.ts --reporter=line' }, 'c_t2');
  const nav2 = call('playwright_browser_navigate', { url: 'https://staging-3.shop.example/checkout/payment' }, 'c_nav2');
  const rp = call('read', { filePath: '/repo/src/pages/PaymentPage.ts' }, 'c_rp');
  const config = "// playwright.config.ts\n// env overrides are loaded from config/envs/staging-3.override.yaml (see loadEnv)\nexport default {};";
  return [
    { role: 'system', content: 'You are a browser automation coding agent.' }, // 0
    user('Task GOAL-CHK-7F3A: migrate the checkout E2E suite to page objects and make every checkout spec pass on staging-3.'), // 1
    assistant('Exploring the test layout first.', [ls]), // 2
    tool(ls, Array.from({ length: 30 }, (_, i) => `tests/e2e/checkout/spec_${i}.spec.ts`).join('\n')), // 3
    assistant('', [rc]), // 4
    tool(rc, config), // 5
    assistant('DECISION-D42: we will use data-testid selectors only, never CSS classes.', [nav]), // 6
    tool(nav, mcpSnapshot({ url: 'https://staging-3.shop.example/checkout/cart', title: 'Cart - Shop', elements: 6 })), // 7
    assistant('', [td1]), // 8
    tool(td1, JSON.stringify([{ content: 'TODO-DROP-Z1H5K: remove the legacy banner helper' }], null, 2)), // 9
    user('USER-VIEW-R4: run every checkout spec at viewport 1280x720 (VP-OLD-K7Q2M).\n---\nKeep using staging-3 for every run.'), // 10
    assistant('Cart page objects are migrated. UNFINISHED-9K: checkout_promo.spec.ts is still flaky.', [t1]), // 11
    tool(t1, playwrightOutput(12, [{ spec: 'checkout/promo.spec.ts', line: 44 }])), // 12
    user(CONTINUE_SHORT), // 13
    assistant('', [ed]), // 14
    tool(ed, 'Edit applied successfully.'), // 15
    user('Correction for USER-VIEW-R4: use viewport 1920x1080 instead (VP-NEW-R3T8W).'), // 16
    assistant('NOTE: promo banner animates 2s (NOTE-ANIM-C4D9P)', [td2]), // 17
    tool(td2, '[]'), // 18
    assistant('', [t2]), // 19
    tool(t2, playwrightOutput(14, [])), // 20
    assistant('', [nav2]), // 21
    tool(nav2, mcpSnapshot({ url: 'https://staging-3.shop.example/checkout/payment', title: 'Payment - Shop', elements: 6 })), // 22
    assistant('Next I will read the payment page.', [rp]), // 23
    tool(rp, '// PaymentPage.ts\nexport class PaymentPage {}'), // 24
  ];
}

const sectionsOf = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('## '));

test('layout: header, facts line, fixed section order, first-appearance order, trailer last', () => {
  const S = createSummarizer(cfg(), counter);
  const h = session();
  const r = S.render(input(h, 23, 3), OPTS);
  const text = r.text!;
  const lines = text.split('\n');
  assert.equal(lines[0], SUMMARY_HEADER);
  assert.equal(lines[1], '');
  assert.equal(lines[2], FACTS_LINE);
  assert.equal(lines[3], '');
  assert.equal(lines[lines.length - 1], '[kitzur] Messages 2–22 were compacted (compaction 3).');
  assert.equal(lines[lines.length - 2], '');
  assert.deepEqual(sectionsOf(text), [
    '## User instructions',
    '## Decisions',
    '## Open todos (todowrite #17)',
    '## Files',
    '## Browser',
    '## Last test run',
    '## Referenced paths',
    '## Assistant notes',
    '## Tool log',
  ]);
  const section = (name: string): string[] => {
    const at = lines.findIndex((l) => l.startsWith(name));
    const out: string[] = [];
    for (let i = at + 1; i < lines.length && lines[i]!.startsWith('- ') || (i < lines.length && lines[i]!.startsWith('  ')); i++) out.push(lines[i]!);
    return out;
  };
  // user facts: partial supersession by the shared ID, `---` neutralized, boilerplate "Continue" excluded
  assert.deepEqual(section('## User instructions'), ['- #10: - - -', '  Keep using staging-3 for every run. (part superseded by #16)', '- #16: Correction for USER-VIEW-R4: use viewport 1920x1080 instead (VP-NEW-R3T8W).']);
  assert.deepEqual(section('## Decisions'), ['- #6: DECISION-D42: we will use data-testid selectors only, never CSS classes.']);
  // the latest todo list wins; completed items collapse to a count
  assert.deepEqual(section('## Open todos'), ['- [in_progress] TODO-P3-RETRY: add retry for promo banner in checkout_promo.spec.ts', '- [pending] TODO-NEW-B8M2N: migrate the payment page', '- (1 completed)']);
  // files: first-touch order; the config-like output path is a file; PaymentPage recurs in the tail
  assert.deepEqual(section('## Files'), ['- /repo/playwright.config.ts — read #4', '- config/envs/staging-3.override.yaml — referenced in read #4', '- /repo/src/pages/CartPage.ts — edit #14']);
  assert.deepEqual(section('## Browser'), ['- https://staging-3.shop.example/checkout/payment — "Payment - Shop" (#21)']);
  assert.deepEqual(section('## Last test run'), ['- #19 `npx playwright test tests/e2e/checkout/cart.spec.ts --reporter=line` → 14 passed']);
  // checkout/promo.spec.ts and tests/e2e/checkout/promo.spec.ts are one file: first appearance, longest form
  assert.deepEqual(section('## Referenced paths'), ['- checkout/cart.spec.ts (in bash #11)', '- tests/e2e/checkout/promo.spec.ts (in bash #11)']);
  // notes: NOTE lines first, then tier 1, then tier 2
  assert.deepEqual(section('## Assistant notes'), [
    '- #17: NOTE: promo banner animates 2s (NOTE-ANIM-C4D9P)',
    '- #11: Cart page objects are migrated. UNFINISHED-9K: checkout_promo.spec.ts is still flaky.',
    '- #2: Exploring the test layout first.',
  ]);
  const log = section('## Tool log');
  assert.equal(log.length, 9); // the calls at #2..#21; #23 is in the tail
  const lsOut = Array.from({ length: 30 }, (_, i) => `tests/e2e/checkout/spec_${i}.spec.ts`).join('\n');
  assert.ok(log[0]!.startsWith(`- #2 bash \`ls -R tests/e2e | head -300\` → ${lsOut.length - 400} chars omitted: "tests/e2e/checkout/spec_0.spec.ts tests/e2e`), log[0]);
  assert.ok(log[0]!.endsWith('tests/e2e/checkout/spec_29.spec.ts"'), log[0]);
  assert.equal(log[2], '- #6 playwright_browser_navigate https://staging-3.shop.example/checkout/cart → [snapshot: https://staging-3.shop.example/checkout/cart — "Cart - Shop", 32 refs]');
  assert.equal(log[3], '- #8 todowrite (3 items) → ok');
  // superseded and dropped facts never come back through any channel
  assert.ok(!text.includes('VP-OLD-K7Q2M'));
  assert.ok(!text.includes('TODO-DROP-Z1H5K'));
  assert.ok(!text.includes('Continue if you have next steps'));
  assert.equal(r.kept + r.dropped, Object.values(r.categories).reduce((a, c) => a + c.kept + c.dropped, 0));
  assert.equal(r.dropped, 0);
});

test('scope: items whose key recurs in [cut, b) are left to the verbatim tail; corrections in the tail still supersede', () => {
  const S = createSummarizer(cfg(), counter);
  const h = session();
  const text = S.render(input(h, 11), OPTS).text!;
  // #10 is summarized, its correction #16 is in the tail
  assert.ok(text.includes('- #10: - - -\n  Keep using staging-3 for every run. (part superseded by #16)'));
  assert.ok(!text.includes('VP-OLD-K7Q2M'));
  // todowrite (#17), test (#19) and navigate (#21) recur in the tail: no todo state, no test, no tab
  assert.ok(!text.includes('## Open todos'));
  assert.ok(!text.includes('## Last test run'));
  assert.ok(!text.includes('## Browser'));
  // the tool log still lists the summarized calls
  assert.ok(text.includes('- #8 todowrite (3 items) → ok'));
  // a path touched again in the tail is not a file item
  const h2 = [...h, assistant('', [call('read', { filePath: '/repo/playwright.config.ts' }, 'c_again')]), tool(call('read', { filePath: '/repo/playwright.config.ts' }, 'c_again'), 'x')];
  const t2 = S.render(input(h2, 23), OPTS).text!;
  assert.ok(!t2.includes('- /repo/playwright.config.ts — read #4'));
  assert.ok(t2.includes('- config/envs/staging-3.override.yaml — referenced in read #4'));
  // nothing summarized: null
  const none = S.render(input(h, 2), OPTS);
  assert.equal(none.text, null);
  assert.equal(none.tokens, 0);
  // one summarized message: singular trailer
  assert.ok(S.render(input(h, 3), OPTS).text!.endsWith('[kitzur] Message 2 was compacted (compaction 1).'));
});

test('user facts: full supersession, amends the task, head goal never removed', () => {
  const S = createSummarizer(cfg(), counter);
  const nav = call('bash', { command: 'echo 1' }, 'c1');
  const h: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    user('Migrate the checkout E2E suite and make every checkout spec pass against the staging-3 environment.'),
    assistant('', [nav]),
    tool(nav, 'ok'),
    user('Run the payment specs against staging-3.'),
    user('Change of plan: use staging-4 for payment, staging-3 is down.'),
    user('Actually, target the staging-4 environment for every checkout spec.'),
    assistant('Done.'),
  ];
  const text = S.render(input(h, 7), OPTS).text!;
  assert.ok(text.includes('- #4: (superseded by #5)\n'), text);
  assert.ok(!text.includes('Run the payment specs against staging-3.'));
  assert.ok(text.includes('- #5: Change of plan: use staging-4 for payment, staging-3 is down.\n'));
  assert.ok(text.includes('- #6: Actually, target the staging-4 environment for every checkout spec. (amends the task)'));
});

test('user facts: shortened head+tail at userMaxChars / 2^step (R7), never evicted', () => {
  const c = cfg();
  c.compaction.userMaxChars = 400;
  const S = createSummarizerExt(c, counter);
  const b = call('bash', { command: 'echo 1' }, 'c1');
  const long = 'RULE-START ' + 'keep the staging-3 environment stable and never touch tests/legacy. '.repeat(30) + ' RULE-END';
  const h: ChatMessage[] = [{ role: 'system', content: 's' }, user('goal'), assistant('', [b]), tool(b, 'ok'), user(long), assistant('x')];
  const lens: number[] = [];
  for (const step of [0, 1, 2, 3] as const) {
    const d = S.renderDetailed(input(h, 5), { budgetTokens: 0, allowFloorEviction: true, userShortenStep: step });
    const line = d.render.text!.split('\n').find((l) => l.startsWith('- #4: '))!;
    assert.ok(line.includes('RULE-START') && line.includes('RULE-END'), line);
    lens.push(line.length);
    assert.ok(d.items.filter((i) => i.category === 'user').every((i) => i.kept));
  }
  assert.ok(lens[0]! > lens[1]! && lens[1]! > lens[2]! && lens[2]! > lens[3]!, String(lens));
  assert.ok(lens[0]! <= '- #4: '.length + 400 + 5);
});

test('browser: last URL + title per tab from navigate args, page state and ### Open tabs', () => {
  const S = createSummarizer(cfg(), counter);
  const n1 = call('playwright_browser_navigate', { url: 'https://shop/cart' }, 'n1');
  const t1 = call('playwright_browser_tabs', { action: 'new' }, 't1');
  const n2 = call('playwright_browser_navigate', { url: 'https://shop/pay' }, 'n2');
  const c1 = call('playwright_browser_click', { element: 'Continue', ref: 'e9' }, 'c1');
  const h: ChatMessage[] = [
    { role: 'system', content: 's' }, user('goal'),
    assistant('', [n1]), tool(n1, mcpSnapshot({ url: 'https://shop/cart', title: 'Cart' })),
    assistant('', [t1]), tool(t1, '### Open tabs\n- 0: [Cart] (https://shop/cart)\n- 1: (current) [] (about:blank)\n'),
    assistant('', [n2]), tool(n2, mcpSnapshot({ url: 'https://shop/pay', title: 'Pay', tabs: [{ url: 'https://shop/cart', title: 'Cart' }, { url: 'https://shop/pay', title: 'Pay', current: true }] })),
    assistant('', [c1]), tool(c1, mcpSnapshot({ url: 'https://shop/pay/confirm', title: 'Confirm', tabs: [{ url: 'https://shop/cart', title: 'Cart' }, { url: 'https://shop/pay/confirm', title: 'Confirm', current: true }] })),
    assistant('done'),
  ];
  const text = S.render(input(h, 10), OPTS).text!;
  const browser = text.split('\n').filter((l) => l.startsWith('- tab '));
  assert.deepEqual(browser, ['- tab 0: https://shop/cart — "Cart" (#8)', '- tab 1: https://shop/pay/confirm — "Confirm" (#8)']);
});

test('reasoning policy (drop / cap / keep) and the ledger switch', () => {
  const b = call('bash', { command: 'echo 1' }, 'c1');
  const h: ChatMessage[] = [
    { role: 'system', content: 's' }, user('goal'),
    { role: 'assistant', content: 'DECISION: use chromium.', reasoning_content: 'R'.repeat(1000), tool_calls: [b] }, tool(b, 'ok'),
    assistant('x'),
  ];
  const run = (f: (c: Config) => void): string => {
    const c = cfg();
    f(c);
    return createSummarizer(c, counter).render(input(h, 4), OPTS).text!;
  };
  assert.ok(!run(() => {}).includes('(reasoning)'));
  const capped = run((c) => {
    c.reasoning.summary = 'cap';
    c.reasoning.summaryCapChars = 100;
  });
  assert.ok(capped.includes('- #2 (reasoning): ' + 'R'.repeat(67) + ' […] ' + 'R'.repeat(33)));
  assert.ok(run((c) => (c.reasoning.summary = 'keep')).includes('- #2 (reasoning): ' + 'R'.repeat(1000)));
  const off = run((c) => (c.ledger.enabled = false));
  assert.deepEqual(sectionsOf(off), ['## Assistant notes', '## Tool log']);
  assert.ok(off.includes('- #2: DECISION: use chromium.'));
});

test('output paths: config-like first, then first appearance, capped by maxTotal', () => {
  const c = cfg();
  c.ledger.outputPaths.maxTotal = 2;
  const S = createSummarizer(c, counter);
  const b1 = call('bash', { command: 'make build' }, 'b1');
  const b2 = call('bash', { command: 'make lint' }, 'b2');
  const h: ChatMessage[] = [
    { role: 'system', content: 's' }, user('goal'),
    assistant('', [b1]), tool(b1, 'error in src/a/one.ts\nerror in src/a/two.ts'),
    assistant('', [b2]), tool(b2, 'loaded settings from config/app.toml'),
    assistant('x'),
  ];
  const text = S.render(input(h, 6), OPTS).text!;
  assert.ok(text.includes('- config/app.toml — referenced in bash #4'));
  assert.ok(text.includes('- src/a/one.ts (in bash #2)'));
  assert.ok(!text.includes('src/a/two.ts (in'));
});

// ---------------------------------------------------------------- exact token accounting

for (const template of ['sim', 'qwen3'] as const) {
  const exact = exactCounter(template);
  test(`tokens = the exact count of the summary message inside the prompt (${template})`, { skip: exact ? false : 'no dev tokenizer.json' }, () => {
    const S = createSummarizerExt(cfg(), exact!);
    const cases: Array<[ChatMessage[], number]> = [];
    const h = session();
    cases.push([h, 11], [h, 23]);
    for (const step of [10, 22, 43]) {
      const r = referenceHistory(step, { capBytes: 51200 });
      cases.push([r, lastAssistant(r)]);
    }
    const chatty = referenceHistory(30, { capBytes: 51200, chatty: true });
    cases.push([chatty, lastAssistant(chatty)], [chatty, 20]);
    let checked = 0;
    for (const [msgs, cut] of cases) {
      const hEnd = headEnd(msgs);
      for (const budget of [0, 300, 939, 2680, 100_000]) {
        for (const allow of [false, true]) {
          const d = S.renderDetailed(input(msgs, cut, 2, hEnd), { budgetTokens: budget, allowFloorEviction: allow, userShortenStep: 0 });
          const r = d.render;
          const prompt = { messages: [...msgs.slice(0, hEnd), { role: 'user', content: r.text }, ...msgs.slice(cut)], tools: referenceTools() };
          const m = exact!.measure(prompt);
          assert.equal(m.perMessage[hEnd], r.tokens, `${template} cut=${cut} budget=${budget}`);
          assert.equal(S.messageTokens(r.text!), r.tokens);
          // floorTokens: the floor alone at shortening step 0
          assert.equal(r.floorTokens, d.prefixTokens(d.floorCount));
          if (!allow) assert.equal(r.floorTokens, S.renderDetailed(input(msgs, cut, 2, hEnd), { budgetTokens: 0, allowFloorEviction: false, userShortenStep: 0 }).render.tokens);
          if (budget >= r.floorTokens || allow) assert.ok(r.tokens <= Math.max(budget, d.prefixTokens(0)), `over budget: ${r.tokens} > ${budget}`);
          checked++;
        }
      }
    }
    assert.equal(checked, cases.length * 10);
  });
}

test('estimate counter: tokens equal the per-message estimate inside the prompt', () => {
  const est = estimateCounter('qwen3');
  const S = createSummarizer(cfg(), est);
  const h = session();
  const r = S.render(input(h, 23), { budgetTokens: 500, allowFloorEviction: false, userShortenStep: 0 });
  const m = est.measure({ messages: [...h.slice(0, 2), { role: 'user', content: r.text }, ...h.slice(23)] });
  assert.equal(m.perMessage[2], r.tokens);
});

// ---------------------------------------------------------------- determinism

test('byte determinism: identical text for identical input, independent of cache state, digests and object identity', () => {
  const inputs: SummaryInput[] = [];
  for (let seed = 1; seed <= 12; seed++) {
    const h = randomHistory(seed, 30);
    const starts = unitStarts(h, headEnd(h) + 1);
    inputs.push(input(h, starts[Math.floor(starts.length / 2)]!, seed));
  }
  const ref = session();
  inputs.push(input(ref, 23), input(ref, 11));
  const budgets = [0, 250, 900, 5000];
  const fresh = (x: SummaryInput, b: number): string => createSummarizer(cfg(), counter).render(x, { ...OPTS, budgetTokens: b }).text!;
  const expected = inputs.map((x) => budgets.map((b) => fresh(x, b)));
  // one warm summarizer, inputs visited in a shuffled order, several times
  const warm = createSummarizer(cfg(), counter);
  const r = prng(99);
  for (let round = 0; round < 3; round++) {
    const order = inputs.map((_, i) => i).sort(() => r() - 0.5);
    for (const i of order) {
      for (const [j, b] of budgets.entries()) {
        const x = inputs[i]!;
        assert.equal(warm.render(x, { ...OPTS, budgetTokens: b }).text, expected[i]![j]);
        // a structurally equal copy with no digests renders the same bytes
        const copy = { ...x, messages: structuredClone(x.messages), digests: [] };
        assert.equal(warm.render(copy, { ...OPTS, budgetTokens: b }).text, expected[i]![j]);
      }
    }
  }
});

// ---------------------------------------------------------------- eviction properties (§6.4, )

test('eviction: one strict total order; longest prefix under budget; monotone in budget; users and floor protected', { skip: qwen ? false : 'no dev tokenizer.json' }, () => {
  const S = createSummarizerExt(cfg(), qwen!);
  const budgets = [0, 120, 250, 400, 600, 900, 1400, 2200, 3500, 1e9];
  let histories = 0;
  let evictions = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const h = randomHistory(seed * 7919, 10 + (seed % 5) * 8);
    const hEnd = headEnd(h);
    const starts = unitStarts(h, hEnd + 1);
    const cut = starts[Math.floor(prng(seed)() * starts.length)]!;
    const x = input(h, cut, 1, hEnd);
    histories++;
    for (const allow of [false, true]) {
      for (const step of [0, 2] as const) {
        let prevKept = new Set<string>();
        let prevK = -1;
        for (const budget of budgets) {
          const d = S.renderDetailed(x, { budgetTokens: budget, allowFloorEviction: allow, userShortenStep: step });
          const r = d.render;
          const users = d.items.filter((i) => i.category === 'user');
          const others = d.items.filter((i) => i.category !== 'user');
          // user facts are never evicted
          assert.ok(users.every((u) => u.kept));
          // the kept set is a prefix of the order
          const k = others.findIndex((i) => !i.kept);
          const kk = k < 0 ? others.length : k;
          assert.ok(others.slice(kk).every((i) => !i.kept), 'kept set is not a prefix');
          // without R6 the floor is always rendered
          if (!allow) assert.ok(others.filter((i) => i.floor).every((i) => i.kept));
          // longest prefix: fits, and one more item would not
          const minK = allow ? 0 : d.floorCount;
          if (kk > minK) assert.ok(r.tokens <= budget);
          if (kk < others.length && d.prefixTokens(kk) <= budget) assert.ok(d.prefixTokens(kk + 1) > budget, `seed ${seed}: item ${kk} fits`);
          // raising the budget never removes an item
          const kept = new Set(d.items.filter((i) => i.kept).map((i) => i.id));
          for (const id of prevKept) assert.ok(kept.has(id), `seed ${seed}: ${id} evicted when the budget grew to ${budget}`);
          assert.ok(kk >= prevK);
          if (kk < others.length) evictions++;
          prevKept = kept;
          prevK = kk;
          assert.equal(r.tokens, S.messageTokens(r.text!));
        }
      }
    }
  }
  assert.equal(histories, 30);
  assert.ok(evictions > 50, `the budgets exercised eviction only ${evictions} times`);
});

test('eviction order: categories by priority, the floor first, then tier 2 and the tool log newest first', () => {
  const S = createSummarizerExt(cfg(), counter);
  const h = session();
  const d = S.renderDetailed(input(h, 23), OPTS);
  const cats = d.items.filter((i) => i.category !== 'user').map((i) => i.category);
  const rank = ['decision', 'todo', 'file', 'rest', 'narrative1', 'narrative2', 'toolLog'];
  for (let i = 1; i < cats.length; i++) assert.ok(rank.indexOf(cats[i - 1]!) <= rank.indexOf(cats[i]!), cats.join(','));
  const ids = d.items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  // within rest: tabs and test-last first (newest first), then NOTE lines, then output paths by first appearance
  const rest = d.items.filter((i) => i.category === 'rest').map((i) => i.id);
  assert.deepEqual(rest, ['b:0', 'test-last', 'n:17:0', 'p:checkout/cart.spec.ts', 'p:tests/e2e/checkout/promo.spec.ts']);
  // within file: config-like output paths first, then tool-arg paths newest last action first
  assert.deepEqual(d.items.filter((i) => i.category === 'file').map((i) => i.id), ['f:config/envs/staging-3.override.yaml', 'f:/repo/src/pages/CartPage.ts', 'f:/repo/playwright.config.ts']);
  // the tool log is evicted oldest first (it is ordered newest first)
  const log = d.items.filter((i) => i.category === 'toolLog').map((i) => Number(i.id.split(':')[1]));
  assert.deepEqual(log, [...log].sort((a, b) => b - a));
  assert.equal(d.floorCount, d.items.filter((i) => i.category !== 'user' && i.floor).length);
});
