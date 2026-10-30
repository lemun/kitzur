import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { passthroughEngine } from './fake-engine.js';
import { chatBody, fakeUpstream, okCompletion, jsonRes, request, startProxy, waitRecords } from './harness.js';

test('startProxy removes the temp state dir it created on close', async () => {
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, okCompletion()));
  const f = await startProxy(up, passthroughEngine());
  try {
    assert.equal((await request(f.port, { body: chatBody() })).status, 200);
    await waitRecords(f, 1);
    assert.ok(existsSync(f.stateDir));
  } finally { await f.close(); await up.close(); }
  assert.equal(existsSync(f.stateDir), false, `${f.stateDir} leaked`);
});

test('startProxy leaves a caller-supplied state dir alone', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-harness-own-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const up = await fakeUpstream((_h, res) => jsonRes(res, 200, okCompletion()));
  const f = await startProxy(up, passthroughEngine(), { stateDir: dir });
  await f.close(); await up.close();
  assert.ok(existsSync(dir));
});
