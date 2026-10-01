import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { renderPrompt, simProfile } from '../../src/tokenize/template.js';
import { createCounter } from '../../src/tokenize/counter.js';
import { pyLen } from '../../src/tokenize/pyjson.js';
import type { ChatRequest } from '../../src/types.js';
import { ROOT } from '../helpers.js';
import { loadSimHistory, simRequest, type SimEnv } from './sim-session.js';
import { testTokenizer } from './tok-helper.js';

// sim-render-golden.json: render() sha256/len per step from the sim-port reference study (render_golden.json).
// sim-counts.json: Python scenario.count_tokens() (the mock's prompt_tokens) for session requests and edge bodies.
const load = (f: string): any => JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', f), 'utf8'));
const RG = load('sim-render-golden.json');
const SC = load('sim-counts.json');
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const envOf = (e: Record<string, string>): SimEnv => ({ cap: e['SIM_CAP_BYTES'] ? Number(e['SIM_CAP_BYTES']) : null, chatty: !!e['SIM_CHATTY'] });

test('sim profile renders byte-exactly what scenario.py render() does (46 steps x 3 variants)', () => {
  const h = loadSimHistory();
  const prof = simProfile();
  let checked = 0;
  for (const [name, v] of Object.entries<any>(RG.variants)) {
    const env = envOf(v.env);
    for (const [step, want, pylen] of v.steps as [number, string, number][]) {
      const r = renderPrompt(prof, simRequest(h, step, env));
      assert.equal(sha(r), want, `${name} step ${step}`);
      assert.equal(pyLen(r), pylen);
      checked++;
    }
  }
  assert.equal(checked, 138);
});

test('sim profile renders the edge bodies (list content, images, Hebrew/emoji tool, reasoning, developer, 2nd system)', () => {
  const prof = simProfile();
  assert.ok(SC.edge.length >= 3);
  for (const e of SC.edge) assert.equal(renderPrompt(prof, e.body as ChatRequest), e.render);
});

const tok = testTokenizer();

test('sim counter equals the Python mock count_tokens() exactly (session requests incl. 46 steps, cap 51200, chatty)', { skip: tok ? false : 'no dev tokenizer.json' }, () => {
  const h = loadSimHistory();
  const counter = createCounter({ mode: 'exact', template: 'sim', tokenizer: tok });
  let n = 0;
  for (const [name, v] of Object.entries<any>(SC.variants)) {
    const env: SimEnv = { cap: v.cap, chatty: v.chatty };
    for (const row of v.rows) {
      const req = simRequest(h, row.steps, env);
      assert.equal(req.messages.length, row.messages);
      const m = counter.measure(req);
      assert.equal(m.total, row.tokens, `${name} steps=${row.steps}`);
      assert.equal(m.perMessage.reduce((a, b) => a + b, 0) + m.overhead, m.total);
      n++;
    }
  }
  for (const e of SC.edge) {
    assert.equal(counter.countRequest(e.body as ChatRequest), e.tokens);
    assert.equal(tok!.count(e.render), e.tokens);
    n++;
  }
  assert.ok(n >= 60, `${n} requests`);
  // the reference headline numbers (reference implementation, server-quirks.md §6.3)
  assert.equal(counter.countRequest(simRequest(h, 46, { cap: 51200 })), 316_614);
  assert.equal(counter.countRequest(simRequest(h, 46)), 356_361);
});
