// Damaged state files: the file persistence never throws out of load, starts empty, counts the damage in
// corruptLines(), warns through the log hook and leaves the damaged file byte-for-byte in place for inspection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plan } from '../../src/types.js';
import { MemoryPlanStore } from '../../src/engine/store.js';
import { createFilePersistence } from '../../src/engine/store-file.js';

const plan = (n: number): Plan => ({
  version: 2, engine: 'e', n, hEnd: 2, cut: 2, summary: null, headRewrites: {},
  rewrites: { 7: { kind: 'truncate', stage: 'admission', message: { role: 'tool', tool_call_id: 'c', content: 'x' } } },
  compactions: 0, fit: 'ok', key: 'k' + n,
});
const now = () => new Date('2026-09-28T12:00:00Z');
const NAME = 'plans-2026-09-28.jsonl';
const rec = (key: string, p: unknown) => JSON.stringify({ key, plan: p }) + '\n';

/** Writes `content` as today's state file, opens a fresh store over it and checks the shared invariants. */
async function damaged(content: Buffer | string, keys: string[], extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-faults-'));
  try {
    writeFileSync(join(dir, NAME), content);
    for (const [name, body] of Object.entries(extra)) writeFileSync(join(dir, name), body);
    const before = readdirSync(dir).sort();
    const warnings: string[] = [];
    const p = createFilePersistence({ dir, now, warn: (m) => warnings.push(m) });
    const store = new MemoryPlanStore({ maxPlans: 10, maxBytes: 1e9, persistence: p });
    const got = keys.map((k) => store.get(k));
    await p.flush();
    if (p.corruptLines() > 0) assert.deepEqual(warnings, [`plan store: skipped ${p.corruptLines()} damaged record(s) in ${NAME}; the file is left in place`]);
    else assert.deepEqual(warnings, [], 'an intact file warns nothing');
    assert.deepEqual(readdirSync(dir).sort(), before, 'no file is renamed, created or removed');
    assert.deepEqual(readFileSync(join(dir, NAME)), Buffer.from(content), 'the damaged file is left as it was');
    return { got, corrupt: p.corruptLines(), stats: store.stats() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a file truncated mid-record keeps the whole records before the cut and reports the torn one', async () => {
  const whole = rec('a', plan(1)) + rec('b', plan(2)) + rec('c', plan(3));
  const cut = whole.indexOf(rec('b', plan(2))) + 20;
  const r = await damaged(whole.slice(0, cut), ['b', 'c', 'a']);
  assert.deepEqual(r.got, [undefined, undefined, plan(1)]);
  assert.equal(r.corrupt, 1);
});

test('a file truncated inside a multi-byte character is reported, never decoded into a plan', async () => {
  const full = Buffer.from(rec('u', { ...plan(4), engine: 'é'.repeat(8) }));
  const r = await damaged(full.subarray(0, full.indexOf(0xc3) + 1), ['u']);
  assert.deepEqual(r.got, [undefined]);
  assert.equal(r.corrupt, 1);
});

test('a file of random bytes starts empty and every line is reported', async () => {
  let seed = 42;
  const bytes = Buffer.alloc(16 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
  const lines = bytes.toString('latin1').split('\n').filter((l) => l.length > 0).length;
  const r = await damaged(bytes, ['a', 'k1']);
  assert.deepEqual(r.got, [undefined, undefined]);
  assert.equal(r.stats.persistedHits, 0);
  assert.equal(r.corrupt, lines, 'each non-empty line counts once');
});

test('an empty file starts empty with nothing to report', async () => {
  const r = await damaged('', ['a']);
  assert.deepEqual(r.got, [undefined]);
  assert.equal(r.corrupt, 0);
});

test('a record with a newer plan version is reported and never reused', async () => {
  const r = await damaged(rec('a', plan(1)) + rec('a', { ...plan(9), version: 3 }) + rec('n', { ...plan(5), version: 3 }), ['n', 'a']);
  assert.deepEqual(r.got, [undefined, plan(1)], 'the newer record neither loads nor shadows the older valid one');
  assert.equal(r.corrupt, 2);
});

test('a leftover temp file from an interrupted write is ignored and left alone', async () => {
  const r = await damaged(rec('a', plan(1)), ['a', 't'], { [`${NAME}.tmp`]: rec('t', plan(7)).slice(0, 30) });
  assert.deepEqual(r.got, [plan(1), undefined]);
  assert.equal(r.corrupt, 0, 'files outside the plans-<day>.jsonl pattern are never read');
});

test('a read-only state directory still loads, drops appends without throwing and keeps the file', { skip: process.getuid?.() === 0 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-faults-'));
  const file = join(dir, NAME);
  try {
    writeFileSync(file, rec('a', plan(1)));
    chmodSync(file, 0o400);
    chmodSync(dir, 0o500);
    const warnings: string[] = [];
    const p = createFilePersistence({ dir, now, warn: (m) => warnings.push(m) });
    const store = new MemoryPlanStore({ maxPlans: 10, maxBytes: 1e9, persistence: p });
    assert.deepEqual(store.get('a'), plan(1));
    store.set('b', plan(2));
    store.set('c', plan(3));
    await p.flush();
    assert.deepEqual(warnings, [`plan store: cannot write ${NAME} (EACCES); plans stay in memory only`], 'a failed write warns once, not per plan');
    assert.deepEqual(readdirSync(dir), [NAME]);
    assert.equal(readFileSync(file, 'utf8'), rec('a', plan(1)), 'the failed append leaves the file unchanged');
    assert.deepEqual(store.get('b'), plan(2), 'the plan still lives in memory for this process');
    // an unreadable file is a miss, not an exception
    chmodSync(file, 0o000);
    const seen: string[] = [];
    const q = createFilePersistence({ dir, now, warn: (m) => seen.push(m) });
    assert.equal(q.load('a'), undefined);
    await q.flush();
    assert.equal(q.corruptLines(), 1);
    assert.deepEqual(seen, [`plan store: ${NAME} is unreadable (EACCES); left in place, starting without it`]);
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Runs as root too (permissions do not stop root): a directory where today's file should be can be neither read nor appended to.
test('an unreadable state file and failed appends start empty, warn and keep the plans in memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-faults-'));
  try {
    mkdirSync(join(dir, NAME));
    const warnings: string[] = [];
    const p = createFilePersistence({ dir, now, warn: (m) => warnings.push(m) });
    const store = new MemoryPlanStore({ maxPlans: 10, maxBytes: 1e9, persistence: p });
    assert.equal(store.get('a'), undefined);
    store.set('b', plan(2));
    await p.flush();
    assert.equal(p.corruptLines(), 1, 'the unreadable file is counted');
    assert.deepEqual(warnings, [
      `plan store: ${NAME} is unreadable (EISDIR); left in place, starting without it`,
      `plan store: cannot write ${NAME} (EISDIR); plans stay in memory only`,
    ]);
    assert.deepEqual(readdirSync(dir), [NAME]);
    assert.deepEqual(readdirSync(join(dir, NAME)), [], 'the damaged entry is left as it was');
    assert.deepEqual(store.get('b'), plan(2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
