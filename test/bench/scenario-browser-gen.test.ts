import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PyRandom } from '../../bench/lib/pyrandom.js';
import { pyDumps } from '../../bench/lib/pyjson.js';
import * as ref from '../../bench/scenarios/reference.js';
import { capOutput, makeSession, simulateSession } from '../../bench/scenarios/common.js';
import { BrowserGen, snapshotW } from '../../bench/scenarios/browser-gen.js';
import { referenceScript } from '../../bench/scenarios/browser.js';

const VARIANTS: Array<[string, ref.ScenarioOptions]> = [
  ['uncapped', {}],
  ['cap51200', { capBytes: 51_200 }],
  ['chatty_cap51200', { capBytes: 51_200, chatty: true }],
  ['huge180k_at20', { hugeAt: 20, hugeChars: 180_000 }],
];

test('BrowserGen with default options reproduces reference.ts byte for byte (assistant turns and tool outputs)', () => {
  for (const [name, o] of VARIANTS) {
    const g = new BrowserGen({ id: 'x', steps: 120, capBytes: o.capBytes ?? null, chatty: o.chatty ?? false, hugeAt: o.hugeAt ?? null, ...(o.hugeChars ? { hugeChars: o.hugeChars } : {}) });
    for (let s = 0; s < 120; s++) {
      assert.equal(pyDumps(g.assistant(s)), pyDumps(ref.assistantMessage(s, o)), `${name} step ${s} assistant`);
      assert.equal(g.output(s), ref.toolOutput(s, o), `${name} step ${s} output`);
    }
  }
});

test('capOutput is reference.toolOutput’s cap', () => {
  for (let s = 0; s < 60; s++) {
    assert.equal(capOutput(ref.toolOutputRaw(s), s, 51_200), ref.toolOutput(s, { capBytes: 51_200 }), `step ${s}`);
    assert.equal(capOutput(ref.toolOutputRaw(s), s, 50_000), ref.toolOutput(s, { capBytes: 50_000 }), `step ${s} (50000)`);
    assert.equal(capOutput(ref.toolOutputRaw(s), s, null), ref.toolOutputRaw(s));
  }
});

test('snapshotW with the reference vocabulary and title is reference.snapshot', () => {
  for (const seed of [1, 7, 5004, 5020]) {
    assert.equal(snapshotW(new PyRandom(seed), 20_000, 'https://x/y'), ref.snapshot(new PyRandom(seed), 20_000, 'https://x/y'));
  }
});

test('BrowserGen hooks: seed offset, URL and tally suffixes, fixed texts', () => {
  const base = new BrowserGen({ id: 'a', steps: 46 });
  const seeded = new BrowserGen({ id: 'b', steps: 46, seedOffset: 1_000_000 });
  let differs = 0;
  for (let s = 0; s < 46; s++) if (seeded.output(s) !== base.output(s)) differs++;
  assert.ok(differs > 30, `seeded content differs on most steps (${differs})`);
  const hooked = new BrowserGen({ id: 'c', steps: 46, urlSuffix: (s) => `?run=NAV-${s}`, tallySuffix: (s) => `(TLY-${s})` });
  const nav = hooked.stepPlan(11)[2]['url'] as string;
  assert.ok(nav.endsWith('?run=NAV-11'), nav);
  assert.ok(hooked.output(11).includes('?run=NAV-11'), 'the snapshot echoes the URL');
  assert.ok(hooked.output(10).endsWith('(TLY-10)'), 'the tally line carries the suffix');
  // the rest of the step is unchanged: same page choice, same text
  assert.equal(hooked.stepPlan(11)[0], base.stepPlan(11)[0]);
});

test('the byte-exact reference session is reference.ts itself', () => {
  const s = makeSession(referenceScript('default', 46, { capBytes: 51_200 }));
  const h = simulateSession(s);
  const hist = ref.initialHistory();
  for (let k = 0; k < 46; k++) {
    const a = ref.assistantMessage(k, { capBytes: 51_200 });
    hist.push(a, { role: 'tool', tool_call_id: a.tool_calls[0]!.id, content: ref.toolOutput(k, { capBytes: 51_200 }) });
    const u = ref.USER_INJECT.get(k);
    if (u) hist.push({ role: 'user', content: u });
  }
  assert.equal(pyDumps(h.map((m) => m.message)), pyDumps(hist));
  // tools, system, goal are the reference's
  assert.equal(pyDumps(s.tools()), pyDumps(ref.tools()));
  assert.equal(s.system(), ref.systemPrompt());
});
