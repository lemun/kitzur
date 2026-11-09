import { test } from 'node:test';
import assert from 'node:assert/strict';
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
