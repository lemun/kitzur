import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { passthroughEngine } from './fake-engine.js';
import { chatBody, fakeUpstream, okCompletion, jsonRes, request, startProxy, waitRecords } from './harness.js';

test('startProxy removes the temp state dir it created when its test ends', async (t) => {
  let stateDir = '';
  await t.test('uses a proxy', async (st) => {
    const up = await fakeUpstream((_h, res) => jsonRes(res, 200, okCompletion()));
    const f = await startProxy(st, up, passthroughEngine());
    stateDir = f.stateDir;
    try {
      assert.equal((await request(f.port, { body: chatBody() })).status, 200);
      await waitRecords(f, 1);
    } finally { await f.close(); await up.close(); }
    assert.ok(existsSync(stateDir));
  });
  assert.equal(existsSync(stateDir), false, `${stateDir} leaked`);
});

test('startProxy leaves a caller-supplied state dir alone', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-harness-own-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, okCompletion()));
  const f = await startProxy(t, up, passthroughEngine(), { stateDir: dir });
  await f.close(); await up.close();
  assert.ok(existsSync(dir));
});
