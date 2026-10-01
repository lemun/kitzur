import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolRules } from '../../src/engine/rules/index.js';
import { globToRegExp } from '../../src/engine/rules/glob.js';
import { isSnapshotText, parseOpenTabs, slimMarker } from '../../src/engine/rules/snapshot.js';
import { call, cfg, mcpSnapshot, opencodeNotice, playwrightOutput } from '../ledger/fixtures.js';

const rules = createToolRules(cfg());
/** a stand-in counter: ~4 chars per token plus a message overhead, like a real template */
const approx = (s: string): number => 5 + Math.ceil(s.length / 4);

test('globs: * is the only wildcard, anchored, case-insensitive', () => {
  assert.ok(globToRegExp('*browser_*').test('playwright_browser_snapshot'));
  assert.ok(globToRegExp('*browser_*').test('browser_click'));
  assert.ok(!globToRegExp('read').test('read_file'));
  assert.ok(globToRegExp('*read_file').test('read_file'));
  assert.ok(globToRegExp('a.b').test('A.B'));
  assert.ok(!globToRegExp('a.b').test('axb'));
});

test('role(): OpenCode MCP prefix and bare names, per role (DESIGN §7 defaults)', () => {
  assert.deepEqual(rules.role('playwright_browser_snapshot'), ['snapshot']);
  assert.deepEqual(rules.role('browser_snapshot'), ['snapshot']);
  assert.deepEqual(rules.role('playwright_browser_navigate'), ['snapshot', 'browserNavigate']);
  assert.deepEqual(rules.role('browser_navigate_back'), ['snapshot', 'browserNavigate']);
  assert.deepEqual(rules.role('playwright_browser_tabs'), ['snapshot', 'browserNavigate']);
  assert.deepEqual(rules.role('todowrite'), ['todo']);
  assert.deepEqual(rules.role('todo_write'), ['todo']);
  assert.deepEqual(rules.role('update_todo_list'), ['todo']);
  assert.deepEqual(rules.role('read'), ['read']);
  assert.deepEqual(rules.role('read_file'), ['read']);
  assert.deepEqual(rules.role('edit'), ['edit']);
  assert.deepEqual(rules.role('apply_patch'), ['edit']);
  assert.deepEqual(rules.role('write'), ['write']);
  assert.deepEqual(rules.role('write_to_file'), ['write']);
  assert.deepEqual(rules.role('bash'), ['shell']);
  assert.deepEqual(rules.role('execute_command'), ['shell']);
  assert.deepEqual(rules.role('grep'), []);
  assert.deepEqual(rules.role('Read'), ['read']);
  const custom = cfg();
  custom.rules.toolNames.todo = ['my_todos'];
  assert.deepEqual(createToolRules(custom).role('my_todos'), ['todo']);
  assert.deepEqual(createToolRules(custom).role('todowrite'), []);
});

test('classify(): snapshot content beats names and the test rule ()', () => {
  const snap = mcpSnapshot({ url: 'https://staging-3.shop.example/checkout/cart', title: 'Checkout - Shop' });
  assert.equal(rules.classify(snap, call('playwright_browser_snapshot', {})), 'snapshot');
  assert.equal(rules.classify(snap, call('bash', { command: 'npx playwright test tests/e2e/checkout/cart.spec.ts' })), 'snapshot');
  assert.equal(rules.classify(snap, null), 'snapshot');
  // ten [ref= markers without the page-state header still make a snapshot
  const refs = Array.from({ length: 10 }, (_, i) => `- button "B${i}" [ref=e${i}]`).join('\n');
  assert.equal(rules.classify(refs, call('bash', { command: 'cat dump.txt' })), 'snapshot');
  assert.equal(rules.classify(refs.split('\n').slice(0, 9).join('\n'), null), 'other');
  // test by command, and by content
  const out = playwrightOutput(12, [{ spec: 'checkout/promo.spec.ts', line: 44 }]);
  assert.equal(rules.classify(out, call('bash', { command: 'npx playwright test tests/e2e/checkout --reporter=line' })), 'test');
  assert.equal(rules.classify('ok', call('bash', { command: 'pnpm test' })), 'test');
  assert.equal(rules.classify('Tests:       2 failed, 12 passed, 14 total', call('bash', { command: 'make ci' })), 'test');
  assert.equal(rules.classify('Edit applied successfully.', call('edit', { filePath: '/repo/a.ts' })), 'other');
  // browser tool without a snapshot in the result
  assert.equal(rules.classify('Took the screenshot', call('playwright_browser_take_screenshot', {})), 'other');
});

test('snapshotInfo(): URL, title, refs and the saved-output path; open tabs', () => {
  const snap = mcpSnapshot({
    url: 'https://staging-3.shop.example/checkout/payment',
    title: 'Payment - Shop',
    tabs: [
      { url: 'https://staging-3.shop.example/checkout/cart', title: 'Checkout - Shop' },
      { url: 'https://staging-3.shop.example/checkout/payment', title: 'Payment - Shop', current: true },
    ],
    elements: 20,
    truncatedTo: '/users/example/.local/share/opencode/tool-output/tool_0194c3f1a2b3Xy9Zq',
  });
  const info = rules.snapshotInfo(snap)!;
  assert.equal(info.url, 'https://staging-3.shop.example/checkout/payment');
  assert.equal(info.title, 'Payment - Shop');
  assert.equal(info.savedPath, '/users/example/.local/share/opencode/tool-output/tool_0194c3f1a2b3Xy9Zq');
  assert.equal(info.refs, (snap.match(/\[ref=/g) ?? []).length);
  assert.deepEqual(parseOpenTabs(snap), [
    { index: 0, current: false, title: 'Checkout - Shop', url: 'https://staging-3.shop.example/checkout/cart' },
    { index: 1, current: true, title: 'Payment - Shop', url: 'https://staging-3.shop.example/checkout/payment' },
  ]);
  assert.equal(rules.snapshotInfo('Edit applied successfully.'), null);
  // no page-state lines: the current tab of the open-tabs block
  const tabsOnly =
    '### Open tabs\n- 0: [Cart] (https://shop/cart)\n- 1: (current) [Pay] (https://shop/pay)\n\n' +
    Array.from({ length: 12 }, (_, i) => `- link "L${i}" [ref=e${i}]`).join('\n');
  const t = rules.snapshotInfo(tabsOnly)!;
  assert.equal(t.url, 'https://shop/pay');
  assert.equal(t.title, 'Pay');
  assert.equal(t.savedPath, null);
});

test('stubText(): the exact §7 stub', () => {
  assert.equal(
    rules.stubText({ url: 'https://staging-3.shop.example/checkout/cart', title: 'Checkout - Shop', refs: 412, savedPath: null }),
    '[superseded snapshot: https://staging-3.shop.example/checkout/cart — "Checkout - Shop", 412 refs; take a new browser_snapshot for current refs]',
  );
});

test('slimSnapshot(): exact  marker, never invites a re-snapshot', () => {
  assert.equal(
    slimMarker(7, 30, '/users/example/.local/share/opencode/tool-output/tool_1'),
    "[kitzur: snapshot slimmed to fit this model's context: kept 7 of 30 elements (interactive and headings); text of other elements omitted. Re-requesting the snapshot will not show more. Full output: /users/example/.local/share/opencode/tool-output/tool_1; use grep/Read on it or browser_evaluate for specific text.]",
  );
  assert.equal(
    slimMarker(7, 30, null),
    "[kitzur: snapshot slimmed to fit this model's context: kept 7 of 30 elements (interactive and headings); text of other elements omitted. Re-requesting the snapshot will not show more. Use browser_evaluate for specific text.]",
  );
  assert.ok(!/call browser_snapshot|take a new/i.test(slimMarker(1, 2, null)));
});

test('slimSnapshot(): keeps header, saved-output line, interactive elements with indentation; children while room allows', () => {
  const saved = '/users/example/.local/share/opencode/tool-output/tool_0194c3f1a2b3Xy9Zq';
  const snap = mcpSnapshot({ url: 'https://shop/checkout/cart', title: 'Cart', elements: 40, truncatedTo: saved });
  const full = rules.slimSnapshot(snap, 1e9, approx)!;
  assert.ok(full);
  const lines = full.split('\n');
  // header lines kept verbatim
  for (const h of ['### Page state', '- Page URL: https://shop/checkout/cart', '- Page Title: Cart', '- Page Snapshot:', '```yaml']) assert.ok(lines.includes(h), h);
  // OpenCode's pointer survives slimming ()
  assert.ok(lines.some((l) => l.includes(`Full output saved to: ${saved}`)));
  // interactive elements and headings are kept with their indentation; others are dropped
  assert.ok(lines.includes('    - link "Shop home" [ref=e3] [cursor=pointer]:'));
  assert.ok(lines.includes('    - heading "Checkout" [level=1] [ref=e8]'));
  assert.ok(lines.includes('    - button "Apply 0" [ref=e11] [cursor=pointer]'));
  assert.ok(!lines.some((l) => l.includes('paragraph') || l.includes('- cell') || l.includes('- generic') || l.includes('- img')));
  // with unlimited room every direct text / url child of a kept element is kept
  assert.ok(lines.includes('      - /url: /'));
  assert.ok(lines.includes('      - text: SAVE0'));
  // marker last, with counts
  const total = (snap.match(/\[ref=/g) ?? []).length;
  const kept = lines.filter((l) => l.includes('[ref=')).length;
  assert.equal(lines[lines.length - 1], slimMarker(kept, total, saved));
  assert.equal(lines[lines.length - 2], '');

  // tight room: the result fits, children are dropped first, and more room never keeps fewer lines
  const base = rules.slimSnapshot(snap, approx(full) - 1, approx)!;
  assert.ok(approx(base) <= approx(full) - 1);
  let prev = 0;
  for (let room = approx(full) - 60; room <= approx(full); room += 7) {
    const s = rules.slimSnapshot(snap, room, approx);
    if (s === null) continue;
    assert.ok(approx(s) <= room);
    const n = s.split('\n').length;
    assert.ok(n >= prev);
    prev = n;
  }
  // too little room even for header + elements + marker
  assert.equal(rules.slimSnapshot(snap, 20, approx), null);
  // not a snapshot: nothing to slim
  assert.equal(rules.slimSnapshot('plain output', 1e9, approx), null);
});

test('slimSnapshot(): children of nested kept elements are added in document order', () => {
  const snap = [
    '- Page URL: https://x/y',
    '- Page Snapshot:',
    '```yaml',
    '- link "A" [ref=e1]:',
    '  - /url: /a',
    '  - button "B" [ref=e2]:',
    '    - text: b',
    '  - text: a2',
    ...Array.from({ length: 10 }, (_, i) => `- paragraph [ref=e${i + 3}]: p${i}`),
    '```',
  ].join('\n');
  const full = rules.slimSnapshot(snap, 1e9, approx)!;
  assert.deepEqual(full.split('\n').slice(0, 8), ['- Page URL: https://x/y', '- Page Snapshot:', '```yaml', '- link "A" [ref=e1]:', '  - /url: /a', '  - button "B" [ref=e2]:', '    - text: b', '  - text: a2']);
});

test('slimSnapshot(): drops executed code, console messages and the rest of the notice; keeps open tabs', () => {
  const saved = '/users/example/.local/share/opencode/tool-output/tool_7';
  const snap =
    mcpSnapshot({
      url: 'https://shop/pay',
      title: 'Pay',
      code: "await page.getByRole('button', { name: 'Apply' }).click();",
      tabs: [{ url: 'https://shop/cart', title: 'Cart' }, { url: 'https://shop/pay', title: 'Pay', current: true }],
      elements: 12,
    }) +
    '\n\n### New console messages\n- [ERROR] Failed to load resource: 404 @ https://shop/api/x:0\n- [LOG] banner mounted @ https://shop/app.js:1' +
    opencodeNotice(999, saved);
  const lines = rules.slimSnapshot(snap, 1e9, approx)!.split('\n');
  assert.deepEqual(lines.slice(0, 9), [
    '### Open tabs',
    '- 0: [Cart] (https://shop/cart)',
    '- 1: (current) [Pay] (https://shop/pay)',
    '### Page state',
    '- Page URL: https://shop/pay',
    '- Page Title: Pay',
    '- Page Snapshot:',
    '```yaml',
    '    - link "Shop home" [ref=e3] [cursor=pointer]:',
  ]);
  const text = lines.join('\n');
  assert.ok(!text.includes('Ran Playwright code') && !text.includes('getByRole'));
  assert.ok(!text.includes('console') && !text.includes('[ERROR]'));
  assert.ok(!text.includes('bytes truncated') && !text.includes('Use Grep'));
  assert.ok(text.includes(`Full output saved to: ${saved}`));
  assert.ok(lines.includes('```'), 'closing fence kept');
});

test('condense(): snapshot, test failures + tally, short verbatim, long excerpt, todo', () => {
  const snap = mcpSnapshot({ url: 'https://staging-3.shop.example/checkout/cart', title: 'Checkout - Shop', elements: 5 });
  assert.equal(rules.condense(snap, call('playwright_browser_snapshot', {})), `[snapshot: https://staging-3.shop.example/checkout/cart — "Checkout - Shop", ${(snap.match(/\[ref=/g) ?? []).length} refs]`);

  const out = playwrightOutput(12, [{ spec: 'checkout/promo.spec.ts', line: 44 }, { spec: 'checkout/cart.spec.ts', line: 71 }]);
  const c = rules.condense(out, call('bash', { command: 'npx playwright test tests/e2e/checkout --reporter=line' }));
  assert.equal(
    c,
    '✘ 13 [chromium] › checkout/promo.spec.ts:44:5 › promo banner (5021ms); Error: Timed out 5000ms waiting for expect(locator).toBeVisible(); ' +
      '✘ 14 [chromium] › checkout/cart.spec.ts:71:5 › promo banner (5021ms); Error: Timed out 5000ms waiting for expect(locator).toBeVisible(); 12 passed, 2 failed',
  );
  const few = cfg();
  few.rules.test.maxFailureLines = 1;
  assert.equal(createToolRules(few).condense(out, call('bash', { command: 'npx playwright test' })), '✘ 13 [chromium] › checkout/promo.spec.ts:44:5 › promo banner (5021ms); 12 passed, 2 failed');
  // passing run: tally only
  assert.equal(rules.condense(playwrightOutput(14, []), call('bash', { command: 'npx playwright test' })), '14 passed');

  assert.equal(rules.condense('Edit applied successfully.', call('edit', { filePath: '/repo/a.ts' })), 'Edit applied successfully.');
  assert.equal(rules.condense('  \n', call('bash', { command: 'true' })), '(empty)');
  const code = Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`).join('\n');
  const long = rules.condense(code, call('read', { filePath: '/repo/src/v.ts' }));
  const omitted = code.length - 240 - 160;
  assert.ok(long.startsWith(`${omitted.toLocaleString('en-US')} chars omitted: "export const v0 = 0;`), long);
  assert.ok(long.endsWith('export const v199 = 199;"'), long);
  const noExcerpt = cfg();
  noExcerpt.rules.excerpt = { headChars: 0, tailChars: 0, shortVerbatimChars: 300 };
  assert.equal(createToolRules(noExcerpt).condense(code, null), `${code.length.toLocaleString('en-US')} chars omitted`);

  // the todo echo never revives item texts (§6.3)
  const todos = JSON.stringify([{ content: 'TODO-DROP-Z1H5K: remove me', status: 'pending' }], null, 2);
  assert.equal(rules.condense(todos, call('todowrite', { todos: [] })), 'ok');
  assert.equal(rules.condense(todos, call('playwright_update_todo_list', { todos: '' })), 'ok');
});

test('isSnapshotText agrees with the saved-output-only notice', () => {
  const notice = opencodeNotice(10, '/tmp/x');
  assert.equal(isSnapshotText(notice), false);
});
