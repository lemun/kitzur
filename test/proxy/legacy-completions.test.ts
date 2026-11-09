import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { passthroughEngine } from './fake-engine.js';
import { chatBody, fakeUpstream, jsonRes, okCompletion, request, startProxy } from './harness.js';

const prompt = 'def fibonacci(n): secret-prompt-text';
const legacy = (logs: string[]): string[] => logs.filter((l) => l.includes('legacy completions'));

test('legacy completions are forwarded unchanged and warned about once per process', async (t) => {
  const logs: string[] = [];
  const up = await fakeUpstream((_hit, res) => jsonRes(res, 200, okCompletion()));
  t.after(() => up.close());
  const f = await startProxy(t, up, passthroughEngine(), { log: (level, msg) => logs.push(`${level} ${msg}`) });
  t.after(() => f.close());
  const body = Buffer.from(JSON.stringify({ model: 'm', prompt, max_tokens: 16 }), 'utf8');
  for (let i = 0; i < 2; i++) {
    const r = await request(f.port, { method: 'POST', path: '/v1/completions', headers: { authorization: 'Bearer client-key' }, body });
    assert.equal(r.status, 200);
  }
  const hits = up.hits.filter((h) => h.url === '/v1/completions');
  assert.equal(hits.length, 2);
  for (const h of hits) assert.deepEqual(h.body, body, 'forwarded byte for byte');
  const lines = legacy(logs);
  assert.equal(lines.length, 1, 'one warn line per process');
  const line = lines[0] ?? '';
  assert.match(line, /^warn /);
  assert.equal(line.includes('secret-prompt-text'), false);
  assert.equal(line.includes('client-key'), false);
  assert.equal(line.includes('Bearer'), false);
});

test('chat and models requests do not warn about legacy completions', async (t) => {
  const logs: string[] = [];
  const up = await fakeUpstream((hit, res) => (hit.url === '/v1/models' ? jsonRes(res, 200, { data: [] }) : jsonRes(res, 200, okCompletion())));
  t.after(() => up.close());
  const f = await startProxy(t, up, passthroughEngine(), { log: (level, msg) => logs.push(`${level} ${msg}`) });
  t.after(() => f.close());
  await request(f.port, { method: 'POST', path: '/v1/chat/completions', body: chatBody() });
  await request(f.port, { method: 'GET', path: '/v1/models' });
  assert.deepEqual(legacy(logs), []);
});

for (const path of ['/v1/completions/', '/openai/v1/completions']) {
  test(`POST ${path} warns as a legacy completions request`, async (t) => {
    const logs: string[] = [];
    const up = await fakeUpstream((_hit, res) => jsonRes(res, 200, okCompletion()));
    t.after(() => up.close());
    const f = await startProxy(t, up, passthroughEngine(), { log: (level, msg) => logs.push(`${level} ${msg}`) });
    t.after(() => f.close());
    await request(f.port, { method: 'POST', path, body: { model: 'm', prompt } });
    assert.equal(legacy(logs).length, 1);
  });
}

const counters = async (port: number): Promise<{ legacy_completions: number; legacy_over_budget: number; passthrough_requests: number }> =>
  (await request(port, { method: 'GET', path: '/status' })).json().counters;
// 4 characters per token with the test counter: far above the default budget, and far below it
const big = 'x'.repeat(400_000);
const small = 'def f(): pass';

for (const count of [true, false]) {
  test(`legacy completions reach the upstream byte for byte with legacyCompletions.count=${count}`, async (t) => {
    const up = await fakeUpstream((_hit, res) => jsonRes(res, 200, okCompletion()));
    t.after(() => up.close());
    const f = await startProxy(t, up, passthroughEngine(), { config: { legacyCompletions: { count } } });
    t.after(() => f.close());
    // odd spacing and key order: any re-serialization would show
    const body = Buffer.from(`{ "prompt" : ${JSON.stringify(big)},"model":"m" ,"max_tokens":16}`, 'utf8');
    const r = await request(f.port, { method: 'POST', path: '/v1/completions', body });
    assert.equal(r.status, 200);
    assert.deepEqual(up.hits.find((h) => h.url === '/v1/completions')?.body, body);
    assert.equal(r.headers['x-kitzur-action'], count ? 'passthrough' : undefined);
    if (count) assert.match(String(r.headers['x-kitzur-tokens']), /^100000\/100000\/\d+$/);
    else assert.equal(r.headers['x-kitzur-tokens'], undefined);
    const c = await counters(f.port);
    assert.deepEqual([c.legacy_completions, c.legacy_over_budget, c.passthrough_requests], count ? [1, 1, 1] : [0, 0, 1]);
  });
}

test('over-budget string and string-array prompts get the headers and bump both counters', async (t) => {
  // the upstream's own x-kitzur-* headers never replace Kitzur's
  const up = await fakeUpstream((_hit, res) => jsonRes(res, 200, okCompletion(), { 'x-kitzur-action': 'compact', 'x-kitzur-over-budget': '1' }));
  t.after(() => up.close());
  const f = await startProxy(t, up, passthroughEngine());
  t.after(() => f.close());
  const one = await request(f.port, { method: 'POST', path: '/v1/completions', body: { model: 'm', prompt: big } });
  const budget = Number(one.headers['x-kitzur-over-budget']);
  assert.ok(budget > 0 && budget < 100_000, `budget ${budget}`);
  assert.equal(one.headers['x-kitzur-action'], 'passthrough');
  assert.match(String(one.headers['x-kitzur-tokens']), /^100000\/100000\/\d+$/);
  const many = await request(f.port, { method: 'POST', path: '/v1/completions', body: { model: 'm', prompt: [small, big] } });
  assert.equal(many.headers['x-kitzur-action'], 'passthrough');
  assert.equal(many.headers['x-kitzur-over-budget'], String(budget));
  assert.match(String(many.headers['x-kitzur-tokens']), /^100004\/100004\/\d+$/);
  const c = await counters(f.port);
  assert.deepEqual([c.legacy_completions, c.legacy_over_budget], [2, 2]);
});

test('an under-budget prompt gets the headers and bumps only legacy_completions', async (t) => {
  const up = await fakeUpstream((_hit, res) => jsonRes(res, 200, okCompletion()));
  t.after(() => up.close());
  const f = await startProxy(t, up, passthroughEngine());
  t.after(() => f.close());
  const r = await request(f.port, { method: 'POST', path: '/v1/completions', body: { model: 'm', prompt: [small, small] } });
  assert.equal(r.headers['x-kitzur-action'], 'passthrough');
  assert.match(String(r.headers['x-kitzur-tokens']), /^8\/8\/\d+$/);
  assert.equal(r.headers['x-kitzur-over-budget'], undefined);
  const c = await counters(f.port);
  assert.deepEqual([c.legacy_completions, c.legacy_over_budget], [1, 0]);
});

test('a BOM-prefixed legacy body is counted and forwarded byte for byte', async (t) => {
  const up = await fakeUpstream((_hit, res) => jsonRes(res, 200, okCompletion()));
  t.after(() => up.close());
  const f = await startProxy(t, up, passthroughEngine());
  t.after(() => f.close());
  const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ model: 'm', prompt: small }))]);
  const r = await request(f.port, { method: 'POST', path: '/v1/completions', body });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-kitzur-action'], 'passthrough');
  assert.match(String(r.headers['x-kitzur-tokens']), /^4\/4\/\d+$/);
  assert.deepEqual(up.hits.find((h) => h.url === '/v1/completions')?.body, body);
});

test('an unreadable legacy body is forwarded unchanged and counted nowhere', async (t) => {
  const up = await fakeUpstream((_hit, res) => jsonRes(res, 400, { error: { message: 'bad' } }));
  t.after(() => up.close());
  const f = await startProxy(t, up, passthroughEngine());
  t.after(() => f.close());
  const bodies = [Buffer.from(`{"prompt": ${JSON.stringify(big)}`), Buffer.from(JSON.stringify({ prompt: [1, 2, 3] })), Buffer.from(JSON.stringify({ model: 'm' }))];
  for (const body of bodies) {
    const r = await request(f.port, { method: 'POST', path: '/v1/completions', body });
    assert.equal(r.status, 400);
    assert.equal(r.headers['x-kitzur-action'], undefined);
    assert.equal(r.headers['x-kitzur-tokens'], undefined);
  }
  assert.deepEqual(up.hits.filter((h) => h.url === '/v1/completions').map((h) => h.body), bodies);
  const c = await counters(f.port);
  assert.deepEqual([c.legacy_completions, c.legacy_over_budget, c.passthrough_requests], [0, 0, 3]);
});

test('legacyCompletions.warn=false silences the log line and still counts', async (t) => {
  const logs: string[] = [];
  const up = await fakeUpstream((_hit, res) => jsonRes(res, 200, okCompletion()));
  t.after(() => up.close());
  const f = await startProxy(t, up, passthroughEngine(), { config: { legacyCompletions: { warn: false } }, log: (level, msg) => logs.push(`${level} ${msg}`) });
  t.after(() => f.close());
  const r = await request(f.port, { method: 'POST', path: '/v1/completions', body: { model: 'm', prompt } });
  assert.equal(r.headers['x-kitzur-action'], 'passthrough');
  assert.deepEqual(legacy(logs), []);
});

test('CONFIG.md names the locally served status endpoints next to the passthrough note', () => {
  const config = readFileSync(new URL('../../../CONFIG.md', import.meta.url), 'utf8');
  const note = config.slice(config.indexOf('Only chat requests are compacted')).slice(0, 400);
  assert.match(note, /passthrough endpoint[\s\S]*`GET \/status` and `\/kitzur\/status`\s+are served locally/);
});
