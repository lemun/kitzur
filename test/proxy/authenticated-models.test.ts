import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passthroughEngine } from './fake-engine.js';
import { fakeUpstream, jsonRes, request, startProxy } from './harness.js';

test('a request without client authorization does not consume the lazy authenticated probe', async (t) => {
  const up = await fakeUpstream((hit, res) => {
    if (hit.url === '/v1/models' && hit.headers.authorization === 'Bearer client-key') jsonRes(res, 200, { data: [{ id: 'model', max_model_len: 32768 }] });
    else jsonRes(res, 401, {});
  });
  t.after(() => up.close());
  const f = await startProxy(t, up, passthroughEngine());
  t.after(() => f.close());
  await f.proxy.probe();
  assert.equal(up.hits[0]?.headers.authorization, undefined);

  await request(f.port, { method: 'GET', path: '/v1/models' });
  await request(f.port, { method: 'GET', path: '/v1/models', headers: { authorization: 'Bearer client-key' } });
  await new Promise((resolve) => setTimeout(resolve, 25));

  const probes = up.hits.filter((hit) => hit.url === '/v1/models');
  assert.equal(probes.length, 4, 'startup probe, two forwarded requests, and one lazy probe');
  assert.equal(probes[3]?.headers.authorization, 'Bearer client-key');
});
