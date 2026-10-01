import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOpenCodeSim, CONTINUE_AFTER_OVERFLOW, CONTINUE_SHORT } from '../../bench/opencode-sim.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { pyLen } from '../../bench/lib/pyjson.js';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import { testTokenizerPath } from '../helpers.js';
import { benchFixture } from './fixtures.js';

const tokPath = testTokenizerPath();

test('OpenCode-mechanics sim prints exactly what baseline.py printed', { skip: tokPath ? false : 'no dev tokenizer.json' }, () => {
  const counter = new PromptCounter(loadTokenizer(tokPath!));
  const G = benchFixture<Record<string, string>>('baseline.json.gz');
  const capped = runOpenCodeSim({ counter, scenario: { capBytes: 51200 } });
  assert.equal(capped.stdout, G['cap51200']);
  assert.equal(capped.totals.total_prompt_tokens, 2_492_849);
  assert.equal(capped.totals.rejected, 462_177);
  assert.equal(capped.totals.compactions, 6);
  assert.equal(runOpenCodeSim({ counter, scenario: {} }).stdout, G['uncapped']);
  // real OpenCode's post-overflow Continue text (reference implementation): 429 chars, 81 Qwen tokens
  assert.equal(pyLen(CONTINUE_AFTER_OVERFLOW), 429);
  assert.equal(pyLen(CONTINUE_SHORT), 100);
  assert.equal(counter.countText(CONTINUE_AFTER_OVERFLOW), 81);
  assert.equal(counter.countText(CONTINUE_SHORT), 21);
  const long = runOpenCodeSim({ counter, scenario: { capBytes: 51200 }, continueText: 'long' });
  assert.equal(long.totals.compactions, 6);
  assert.ok(long.totals.total_prompt_tokens > capped.totals.total_prompt_tokens);
});
