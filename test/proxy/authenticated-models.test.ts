import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeUpstream, jsonRes, request, startProxy } from './harness.js';
import { FakeEngine, result } from './fake-engine.js';

const engine = (): FakeEngine => new FakeEngine((req) => result(req, req, false));

test('lazy models probe prefers configured headers and reuses the existing limits parser', async () => {
  const up = await fakeUpstream((hit, res) => {
    if (hit.url === '/v1/models') jsonRes(res, 200, { data: [{ id: 'm1', max_model_len: 32768 }] });
    else jsonRes(res, 200, {});
  });
  const f = await startProxy(up, engine(), { config: { upstream: { headers: { Authorization: 'Bearer configured' } } } });
  try {
    await request(f.port, { path: '/other', headers: { authorization: 'Bearer client' } });
    const probe = up.hits.find((hit) => hit.url === '/v1/models')!;
    assert.equal(probe.headers.authorization, 'Bearer configured');
    assert.deepEqual(f.proxy.snapshot()['discovered_window'], { m1: 32768 });
  } finally { await f.close(); await up.close(); }
});

test('simultaneous first requests share one authenticated probe', async () => {
  let probeCount = 0;
  const up = await fakeUpstream(async (hit, res) => {
    if (hit.url === '/v1/models') { probeCount++; await new Promise((resolve) => setTimeout(resolve, 35)); jsonRes(res, 200, { data: [] }); }
    else jsonRes(res, 200, {});
  });
  const f = await startProxy(up, engine());
  try {
    await Promise.all([1, 2, 3].map((i) => request(f.port, { path: `/other${i}`, headers: { authorization: 'Bearer client-secret' } })));
    assert.equal(probeCount, 1);
    assert.equal(up.hits.filter((hit) => hit.url === '/v1/models')[0]!.headers.authorization, 'Bearer client-secret');
  } finally { await f.close(); await up.close(); }
});

test('lazy probe timeout is bounded and does not retry', async () => {
  let probes = 0;
  const up = await fakeUpstream((hit, res) => {
    if (hit.url === '/v1/models') { probes++; return; }
    jsonRes(res, 200, {});
  });
  const f = await startProxy(up, engine(), { config: { upstream: { timeoutMs: 60 } } });
  try {
    const response = await request(f.port, { path: '/other' });
    assert.equal(response.status, 200);
    assert.equal(probes, 1);
    assert.match((f.proxy.snapshot()['upstream'] as { probe: { error?: string } }).probe.error ?? '', /timeout/i);
  } finally { await f.close(); await up.close(); }
});

test('redirect response is rejected without following its location', async () => {
  const up = await fakeUpstream((hit, res) => {
    if (hit.url === '/v1/models') { res.writeHead(302, { location: '/redirect-target' }); res.end(); }
    else jsonRes(res, 200, {});
  });
  const f = await startProxy(up, engine());
  try {
    await request(f.port, { path: '/other' });
    assert.equal(up.hits.filter((hit) => hit.url === '/v1/models').length, 1);
    assert.equal(up.hits.some((hit) => hit.url === '/redirect-target'), false);
    assert.equal((f.proxy.snapshot()['probe'] as { status?: number }).status, 302);
  } finally { await f.close(); await up.close(); }
});

test('client Authorization is absent from logs, status and stats', async () => {
  const secret = 'Bearer never-log-this-value';
  const logs: string[] = [];
  const up = await fakeUpstream((hit, res) => jsonRes(res, 200, hit.url === '/v1/models' ? { data: [] } : {}));
  const f = await startProxy(up, engine(), { log: (_level, message) => logs.push(message) });
  try {
    await request(f.port, { path: '/other', headers: { authorization: secret } });
    const status = await request(f.port, { method: 'GET', path: '/status' });
    const recorded = f.records().map((record) => JSON.stringify(record)).join('\n');
    assert.equal(logs.join('\n').includes(secret), false);
    assert.equal(status.text().includes(secret), false);
    assert.equal(recorded.includes(secret), false);
  } finally { await f.close(); await up.close(); }
});
