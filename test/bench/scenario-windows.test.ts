import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  errorRealLimit, errorSkew, forwardingCeiling, gobTunedThreshold, openCodeUsable, presetQuantities, WINDOWS, windowLabel,
} from '../../bench/scenarios/windows.js';

test('preset quantities reproduce the DESIGN.md preset table', () => {
  const want = {
    '32k': { budget: 23_488, clientPoint: 24_000, allowance: 4_000, hard: 20_000, trigger: 20_000, target: 7_000 },
    '64k': { budget: 47_360, clientPoint: 48_000, allowance: 7_000, hard: 41_000, trigger: 41_000, target: 14_350 },
    '100k': { budget: 67_000, clientPoint: 68_000, allowance: 7_000, hard: 61_000, trigger: 61_000, target: 21_350 },
    '128k': { budget: 94_720, clientPoint: 96_000, allowance: 7_000, hard: 89_000, trigger: 89_000, target: 31_150 },
  } as const;
  for (const [id, w] of Object.entries(want)) {
    const q = presetQuantities(WINDOWS[id as keyof typeof want]);
    assert.deepEqual(
      { budget: q.budget, clientPoint: q.clientPoint, allowance: q.allowance, hard: q.hard, trigger: q.trigger, target: q.target },
      w,
      id,
    );
  }
});

test('gobstopper tuned thresholds (benchmark contract ): 20,500 / 41,000 / 58,000 / 82,000', () => {
  assert.deepEqual(['32k', '64k', '100k', '128k'].map((w) => gobTunedThreshold(WINDOWS[w as '32k'])), [20_500, 41_000, 58_000, 82_000]);
});

test('error-style server limit skew (benchmark contract table)', () => {
  assert.equal(forwardingCeiling(WINDOWS['100k'], 'strict_total'), 93_000);
  assert.equal(errorRealLimit(WINDOWS['100k'], 'strict_total'), 89_000);
  assert.equal(errorSkew(WINDOWS['100k'], 'strict_total'), 11_000);
  assert.equal(errorRealLimit(WINDOWS['100k'], 'prompt_only'), 57_000);
  assert.equal(errorSkew(WINDOWS['100k'], 'prompt_only'), 43_000);
  assert.equal(errorRealLimit(WINDOWS['64k'], 'strict_total'), 54_440);
  assert.equal(errorSkew(WINDOWS['64k'], 'strict_total'), 9_560);
  assert.equal(errorRealLimit(WINDOWS['32k'], 'strict_total'), 26_720);
  assert.equal(errorSkew(WINDOWS['32k'], 'strict_total'), 5_280);
  // tgi: hard + min(O, 1024); silent_truncate like prompt_only
  assert.equal(forwardingCeiling(WINDOWS['100k'], 'tgi'), 62_024);
  assert.equal(forwardingCeiling(WINDOWS['100k'], 'silent_truncate'), 61_000);
  // every real window stays >= 0.5·W (a validated learned window is accepted, DESIGN.md)
  for (const w of Object.values(WINDOWS)) for (const m of ['strict_total', 'tgi', 'prompt_only'] as const) assert.ok(errorRealLimit(w, m) >= 0.5 * w.W, `${w.id} ${m}`);
});

test('OpenCode usable and labels', () => {
  assert.deepEqual(['32k', '64k', '100k', '128k'].map((w) => openCodeUsable(WINDOWS[w as '32k'])), [24_000, 48_000, 68_000, 96_000]);
  assert.equal(windowLabel(WINDOWS['100k']), '100k/32k');
});
