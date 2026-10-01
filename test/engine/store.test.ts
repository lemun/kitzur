import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../src/types.js';
import { MemoryPlanStore } from '../../src/engine/store.js';
import { createFilePersistence } from '../../src/engine/store-file.js';

const plan = (n: number, summary: string | null = null): Plan => ({
  version: 2, engine: 'e', n, hEnd: 2, cut: summary ? 5 : 2, summary, headRewrites: {},
  rewrites: { 7: { kind: 'truncate', stage: 'admission', message: { role: 'tool', tool_call_id: 'c', content: 'x' } } },
  compactions: summary ? 1 : 0, fit: 'ok', key: 'k' + n,
});

test('memory store: LRU order, entry cap, byte cap, never empty', () => {
  const s = new MemoryPlanStore({ maxPlans: 3, maxBytes: 1e9 });
  for (let i = 0; i < 5; i++) s.set('k' + i, plan(i));
  assert.equal(s.size(), 3);
  assert.equal(s.get('k0'), undefined);
  assert.ok(s.get('k2'));
  s.set('k5', plan(5));
  assert.equal(s.get('k3'), undefined, 'k2 was touched, so k3 is the least recent');
  assert.ok(s.get('k2'));
  const tiny = new MemoryPlanStore({ maxPlans: 100, maxBytes: 10 });
  tiny.set('a', plan(1, 'x'.repeat(100)));
  assert.equal(tiny.size(), 1, 'an oversized newest entry stays');
  tiny.set('b', plan(2, 'y'.repeat(100)));
  assert.equal(tiny.size(), 1);
  assert.equal(tiny.get('a'), undefined);
  assert.ok(tiny.get('b'));
});

test('file persistence: JSONL per day, lazy load, later lines win, corrupt lines ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-plans-'));
  try {
    const now = () => new Date(Date.UTC(2026, 8, 28, 12));
    const p1 = createFilePersistence({ dir: join(dir, 'plans'), now });
    const s1 = new MemoryPlanStore({ maxPlans: 10, maxBytes: 1e9, persistence: p1 });
    s1.set('a', plan(1));
    s1.set('b', plan(2, 'S'));
    s1.set('b', plan(3, 'S2'));
    const files = readdirSync(join(dir, 'plans'));
    assert.deepEqual(files, ['plans-2026-09-28.jsonl']);
    const lines = readFileSync(join(dir, 'plans', files[0]!), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    appendFileSync(join(dir, 'plans', files[0]!), '{"key":"torn","plan":{"vers');
    // a restarted process: empty memory, lazy load from disk
    const p2 = createFilePersistence({ dir: join(dir, 'plans'), now });
    const s2 = new MemoryPlanStore({ maxPlans: 10, maxBytes: 1e9, persistence: p2 });
    assert.equal(s2.size(), 0);
    assert.deepEqual(s2.get('b'), plan(3, 'S2'));
    assert.deepEqual(s2.get('a'), plan(1));
    assert.equal(s2.get('torn'), undefined);
    assert.equal(p2.corruptLines(), 1);
    assert.equal(s2.stats().persistedHits, 2);
    // a missing directory behaves as empty and never throws
    const p3 = createFilePersistence({ dir: join(dir, 'nope', 'deeper') });
    assert.equal(p3.load('x'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
