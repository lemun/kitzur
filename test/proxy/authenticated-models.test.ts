import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passthroughEngine } from './fake-engine.js';
import { fakeUpstream, jsonRes, request, startProxy, sleep } from './harness.js';

test('unauthenticated request does not consume lazy probe; authenticated lazy result is applied', async (t) => {
  const up = await fakeUpstream((hit, res) => {
    if (hit.url === '/v1/models' && hit.headers.authorization === 'Bearer client-key') jsonRes(res, 200, { data: [{ id: 'model', max_model_len: 32768 }] });
    else jsonRes(res, 401, {});
  });
  t.after(() => up.close());
  const f = await startProxy(t, up, passthroughEngine());
  t.after(() => f.close());
  await f.proxy.probe();
  await request(f.port, { method: 'GET', path: '/v1/models' });
  await request(f.port, { method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer client-key' } });
  await sleep(25);
  const status = (await request(f.port, { method: 'GET', path: '/status' })).json();
  const models = up.hits.filter((hit) => hit.url === '/v1/models');
  assert.equal(models.length, 4, 'startup probe, two forwarded requests, and one lazy probe');
  assert.equal(models.filter((hit) => hit.headers.authorization === 'Bearer client-key').length, 2, 'one forwarded request and the lazy probe');
  // only an authenticated lazy probe can discover the window: the forwarded request does not set it
  assert.deepEqual(status.discovered_window, { model: 32768 }, 'lazy probe result must be applied');
});

test('startup success skips lazy probe and configured authorization wins', async (t) => {
  const up = await fakeUpstream((hit, res) => jsonRes(res, 200, { data: [{ id: 'startup', max_model_len: 8192 }] }));
  t.after(() => up.close());
  const f = await startProxy(t, up, passthroughEngine(), { config: { upstream: { headers: { Authorization: 'Bearer configured-key' } } } });
  t.after(() => f.close());
  await f.proxy.probe();
  await request(f.port, { method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer client-key' } });
  assert.equal(up.hits.filter((h) => h.url === '/v1/models').length, 2);
  assert.equal(up.hits[0]?.headers.authorization, 'Bearer configured-key');
  assert.equal(up.hits[1]?.headers.authorization, 'Bearer configured-key');
});

test('listener token is not forwarded and secrets stay out of status, logs, and stats', async (t) => {
  const logs: string[] = [];
  const up = await fakeUpstream((hit, res) => jsonRes(res, 401, {}));
  t.after(() => up.close());
  const f = await startProxy(t, up, passthroughEngine(), { config: { listen: { token: 'listener-secret' } }, log: (_level, msg) => logs.push(msg) });
  t.after(() => f.close());
  await f.proxy.probe();
  await request(f.port, { method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer listener-secret' } });
  await sleep(25);
  const status = (await request(f.port, { method: 'GET', path: '/status', headers: { authorization: 'Bearer listener-secret' } })).text();
  assert.equal(JSON.parse(status).name, 'kitzur');
  const stats = JSON.stringify(f.records());
  assert.equal(up.hits.every((h) => h.headers.authorization === undefined), true);
  for (const visible of [status, logs.join('\n'), stats]) {
    assert.equal(visible.includes('listener-secret'), false);
    assert.equal(visible.includes('Bearer'), false);
  }
});

test('lazy redirects are not followed', async (t) => {
  const logs: string[] = [];
  const up = await fakeUpstream((hit, res) => {
    if (hit.url === '/v1/models' && hit.headers.authorization === 'Bearer client-key') jsonRes(res, 302, {}, { location: '/elsewhere' });
    else if (hit.url === '/v1/models') jsonRes(res, 401, {});
    else jsonRes(res, 200, {});
  });
  t.after(() => up.close());
  const f = await startProxy(t, up, passthroughEngine(), { log: (_level, msg) => logs.push(msg) });
  t.after(() => f.close());
  await f.proxy.probe();
  await request(f.port, { method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer client-key' } });
  await sleep(25);
  await request(f.port, { method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer client-key' } });
  assert.equal(up.hits.filter((h) => h.url === '/v1/models').length, 4, 'startup, lazy probe, and two forwarded requests');
  assert.equal(up.hits.filter((h) => h.url === '/elsewhere').length, 0);
});

test('lazy 401 warns once without looping', async (t) => {
  const logs: string[] = [];
  const up = await fakeUpstream((_hit, res) => jsonRes(res, 401, {}));
  t.after(() => up.close());
  const f = await startProxy(t, up, passthroughEngine(), { log: (_level, msg) => logs.push(msg) });
  t.after(() => f.close());
  await f.proxy.probe();
  await request(f.port, { method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer client-key' } });
  await sleep(25);
  await request(f.port, { method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer client-key' } });
  const status = (await request(f.port, { method: 'GET', path: '/status' })).json();
  assert.equal(up.hits.filter((h) => h.url === '/v1/models').length, 4);
  // one warning from the startup probe, one from the single lazy probe
  assert.equal(status.warnings.find((w: { key: string }) => w.key === 'upstream_probe')?.count, 2);
});

test('concurrent authenticated requests share one lazy probe', async (t) => {
  let probes = 0;
  const up = await fakeUpstream(async (hit, res) => {
    if (hit.url === '/v1/models' && hit.headers.authorization === 'Bearer client-key') {
      probes++;
      await sleep(30);
      jsonRes(res, 200, { data: [{ id: 'shared', max_model_len: 16384 }] });
    } else jsonRes(res, 401, {});
  });
  t.after(() => up.close());
  const f = await startProxy(t, up, passthroughEngine());
  t.after(() => f.close());
  await f.proxy.probe();
  await Promise.all(Array.from({ length: 5 }, () => request(f.port, { method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer client-key' } })));
  await sleep(25);
  assert.equal(probes, 6, 'five forwarded requests and one shared lazy probe');
  assert.deepEqual(f.proxy.snapshot().discovered_window, { shared: 16384 });
});
