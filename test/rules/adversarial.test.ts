// Adversarial checks of the tool rules (regressions): real-world output shapes the happy-path fixtures do not
// produce, and slimming as a property over many room sizes on the reference scenario's snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolRules } from '../../src/engine/rules/index.js';
import { snapshotInfo } from '../../src/engine/rules/snapshot.js';
import { tallyLine } from '../../src/engine/rules/testrun.js';
import { call, cfg } from '../ledger/fixtures.js';
import { exactCounter, referenceSession } from '../summary/helpers.js';

const rules = createToolRules(cfg());
const approx = (s: string): number => 5 + Math.ceil(s.length / 4);
const pwTest = call('bash', { command: 'npx playwright test tests/e2e/checkout --reporter=list' }, 'c_pw');

/** Playwright's list reporter: the tally is a block of count lines with the affected tests listed under each. */
const PLAYWRIGHT_LIST = [
  'Running 14 tests using 4 workers',
  '',
  '  ✘  1 [chromium] › checkout/promo.spec.ts:44:5 › promo banner (30.0s)',
  '  ✓  2 [chromium] › checkout/cart.spec.ts:10:5 › cart (812ms)',
  '',
  '  1) [chromium] › checkout/promo.spec.ts:44:5 › promo banner ─────────────',
  '',
  '    Test timeout of 30000ms exceeded.',
  '',
  '  2 failed',
  '    [chromium] › checkout/promo.spec.ts:44:5 › promo banner ──────────────',
  '    [chromium] › checkout/pay.spec.ts:12:5 › pay ─────────────────────────',
  '  1 flaky',
  '    [chromium] › checkout/ship.spec.ts:9:5 › ship ────────────────────────',
  '  11 passed (45.2s)',
  '',
  '  To open last HTML report run:',
  '',
  '    npx playwright show-report',
].join('\n');

test('test rule: Playwright\'s multi-line tally keeps the failed and flaky counts (regression)', () => {
  assert.equal(tallyLine(PLAYWRIGHT_LIST), '2 failed, 1 flaky, 11 passed (45.2s)');
  assert.equal(rules.classify(PLAYWRIGHT_LIST, pwTest), 'test');
  const c = rules.condense(PLAYWRIGHT_LIST, pwTest);
  assert.ok(c.startsWith('✘ 1 [chromium] › checkout/promo.spec.ts:44:5 › promo banner (30.0s)'), c);
  assert.ok(c.endsWith('; 2 failed, 1 flaky, 11 passed (45.2s)'), c);
  // all-passed runs and single-line tallies are unchanged
  assert.equal(tallyLine('Running 3 tests using 1 worker\n\n  ✓ 1 a\n\n  3 passed (2.1s)'), '3 passed (2.1s)');
  assert.equal(tallyLine('  12 passed, 2 failed'), '12 passed, 2 failed');
  assert.equal(tallyLine('Test Suites: 1 failed, 3 passed, 4 total\nTests:       2 failed, 12 passed, 14 total\nSnapshots:   0 total\nTime:        3.2 s'), 'Tests: 2 failed, 12 passed, 14 total');
  assert.equal(tallyLine('==== 2 failed, 12 passed in 3.21s ===='), '==== 2 failed, 12 passed in 3.21s ====');
  // a count line at another indent, or separated by a blank line, is not part of the block
  assert.equal(tallyLine('2 failed\n\n  11 passed (4s)'), '11 passed (4s)');
});

test('slimSnapshot(): elements whose yaml key Playwright single-quotes are still interactive (regression)', () => {
  // Playwright's yaml writer quotes a key containing ": " (and other specials): `- 'link "Step 1: Shipping" [ref=e5]':`
  const snap = [
    '### Page state', '- Page URL: https://shop/checkout', '- Page Title: Checkout', '- Page Snapshot:', '```yaml',
    '- generic [ref=e1]:',
    ...Array.from({ length: 6 }, (_, i) => `  - 'link "Step ${i}: Shipping" [ref=e${i + 10}] [cursor=pointer]':\n    - /url: /s${i}`),
    `  - 'heading "Total: $12.00" [level=2] [ref=e30]'`,
    `  - 'button "Pay now #1" [ref=e31]'`,
    ...Array.from({ length: 6 }, (_, i) => `  - paragraph [ref=e${i + 100}]: A long paragraph ${i} that is not interactive`),
    '```',
  ].join('\n');
  const out = rules.slimSnapshot(snap, 1e9, approx)!;
  for (let i = 0; i < 6; i++) {
    assert.ok(out.includes(`  - 'link "Step ${i}: Shipping" [ref=e${i + 10}] [cursor=pointer]':`), `link ${i}`);
    assert.ok(out.includes(`    - /url: /s${i}`), `url ${i}`);
  }
  assert.ok(out.includes(`'heading "Total: $12.00" [level=2] [ref=e30]'`));
  assert.ok(out.includes(`'button "Pay now #1" [ref=e31]'`));
  assert.ok(!out.includes('paragraph'));
  assert.ok(out.endsWith('kept 8 of 15 elements (interactive and headings); text of other elements omitted. Re-requesting the snapshot will not show more. Use browser_evaluate for specific text.]'), out.slice(-200));
});

test('slimSnapshot() property on the reference snapshots: never over maxTokens, strictly smaller, marker and saved path kept', { skip: exactCounter('qwen3') ? false : 'no dev tokenizer.json' }, () => {
  const ex = exactCounter('qwen3')!;
  const count = (s: string): number => ex.countText(s);
  const { msgs } = referenceSession(46, { capBytes: 51200 });
  const snaps = msgs.filter((m) => m.role === 'tool' && typeof m.content === 'string' && rules.classify(m.content, null) === 'snapshot').map((m) => m.content as string);
  assert.ok(snaps.length >= 10, `${snaps.length} snapshots`);
  let slimmed = 0;
  for (const s of snaps.slice(0, 8)) {
    const full = count(s);
    const info = snapshotInfo(s)!;
    let prevLines = -1;
    for (const f of [0.1, 0.3, 0.45, 0.5, 0.6, 0.8, 1.0, 2.0]) {
      const max = Math.floor(full * f);
      const out = rules.slimSnapshot(s, max, count);
      if (out === null) continue;
      slimmed++;
      const c = count(out);
      assert.ok(c <= max, `${c} > ${max}`);
      assert.ok(c < full);
      assert.ok(out.includes('Re-requesting the snapshot will not show more.'));
      assert.ok(!/call browser_snapshot/i.test(out));
      if (info.savedPath) assert.ok(out.includes(`Full output: ${info.savedPath}; use grep/Read on it`));
      for (const h of ['- Page URL:', '- Page Title:', '- Page Snapshot:']) assert.ok(out.includes(h), h);
      // more room never keeps fewer lines
      const n = out.split('\n').length;
      assert.ok(n >= prevLines);
      prevLines = n;
    }
  }
  assert.ok(slimmed >= 20, `only ${slimmed} slims succeeded`);
});

test('classify(): the 10-ref threshold, and a test command with no tally still condenses', () => {
  const refs = (n: number): string => Array.from({ length: n }, (_, i) => `- button "b${i}" [ref=e${i}]`).join('\n');
  assert.equal(rules.classify(refs(9), null), 'other');
  assert.equal(rules.classify(refs(10), null), 'snapshot');
  assert.equal(rules.condense(refs(10), call('bash', { command: 'npx playwright test' }, 'c')), '[snapshot: 10 refs]');
  assert.equal(rules.condense('Error: no tests found', call('bash', { command: 'npm test' }, 'c')), 'Error: no tests found');
  // head/tail excerpts never split a surrogate pair
  const c = rules.condense('😀'.repeat(500), call('bash', { command: 'echo' }, 'c'));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(c), c);
  assert.ok(c.startsWith('300 chars omitted: "'), c);
});

test('classify(): a read of source code that mentions the snapshot markers is file content, a saved snapshot read back is a snapshot (regression)', () => {
  const read = call('read', { filePath: '/repo/src/engine/rules/snapshot.ts' }, 'c_read');
  const source = [
    "const SNAPSHOT_MARK = '- Page Snapshot:';",
    '// A Playwright MCP result looks like:',
    '//   - Page Snapshot:',
    ...Array.from({ length: 12 }, (_, k) => `  '- link "Cart${k}" [ref=e${k}] [cursor=pointer]',`),
  ].join('\n');
  const gutter = (t: string): string => t.split('\n').map((l, i) => `${String(i + 1).padStart(5, '0')}| ${l}`).join('\n');
  assert.equal(rules.classify(source, read), 'other');
  assert.equal(rules.classify(`<file>\n${gutter(source)}\n</file>`, read), 'other');
  assert.match(rules.condense(source, read), /chars omitted|SNAPSHOT_MARK/);
  // the same text from a shell or an MCP tool keeps 's content detection
  assert.equal(rules.classify(source, call('bash', { command: 'cat snapshot.ts' })), 'snapshot');
  // a real snapshot read back from OpenCode's saved output (gutter), Kilo's `1 | ` gutter, or raw
  const snap = ['### Page state', '- Page URL: https://shop/cart', '- Page Snapshot:', '```yaml', ...Array.from({ length: 12 }, (_, k) => `  - button "b${k}" [ref=e${k}]`), '```'].join('\n');
  assert.equal(rules.classify(snap, read), 'snapshot');
  assert.equal(rules.classify(gutter(snap), read), 'snapshot');
  assert.equal(rules.classify(snap.split('\n').map((l, i) => `${i + 1} | ${l}`).join('\n'), read), 'snapshot');
  const yamlOnly = Array.from({ length: 12 }, (_, k) => `- button "b${k}" [ref=e${k}]`).join('\n');
  assert.equal(rules.classify(gutter(yamlOnly), read), 'snapshot');
});
