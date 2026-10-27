import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as cli from '../../src/cli.js';
import { asRequest, collectRequests } from '../../src/cli/requests.js';
import { httpGet, importState } from '../../src/cli/http.js';
import * as state from '../../src/proxy/state.js';

const chat = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

test('asRequest rejects non-chat shapes and accepts a minimal chat request', () => {
  for (const x of [null, 1, 'x', [], {}, { messages: 'no' }, { body: '{oops' }, { request: { prompt: 'p' } }]) assert.equal(asRequest(x), null);
  assert.deepEqual(asRequest(chat), chat);
  assert.deepEqual(asRequest({ body: JSON.stringify(chat) }), chat);
  assert.deepEqual(asRequest({ request: chat }), chat);
});

test('collectRequests reads a single file, a directory and a .jsonl file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-req-'));
  try {
    const d = join(dir, 'caps');
    mkdirSync(d);
    writeFileSync(join(d, '10.json'), JSON.stringify(chat));
    writeFileSync(join(d, '2.json'), JSON.stringify({ body: chat }));
    writeFileSync(join(d, 'skip.txt'), 'x');
    writeFileSync(join(dir, 'one.json'), JSON.stringify({ nope: 1 }));
    writeFileSync(join(dir, 'many.jsonl'), JSON.stringify(chat) + '\n\n' + JSON.stringify({ x: 1 }) + '\n');
    const single = collectRequests(['one.json'], dir);
    assert.deepEqual(single, [{ label: 'one.json', req: null }]);
    assert.deepEqual(collectRequests(['caps'], dir).map((r) => [r.label, r.req !== null]), [['2.json', true], ['10.json', true]]);
    assert.deepEqual(collectRequests([join(dir, 'many.jsonl')], '/').map((r) => [r.label, r.req !== null]), [['many.jsonl:1', true], ['many.jsonl:2', false]]);
    assert.throws(() => collectRequests(['missing.json'], dir), cli.UsageError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(cli.asRequest, asRequest);
  assert.equal(cli.collectRequests, collectRequests);
});

test('httpGet returns status and body, sends the Bearer header and times out', async () => {
  const seen: Array<string | undefined> = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.url === '/slow') return void setTimeout(() => res.end('late'), 500);
    res.writeHead(418).end('teapot');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await httpGet(base + '/x', 2000), { status: 418, body: 'teapot' });
    await httpGet(base + '/x', 2000, 'tok');
    assert.deepEqual(seen, [undefined, 'Bearer tok']);
    await assert.rejects(httpGet(base + '/slow', 50), /timed out after 50 ms/);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('importState resolves showState and resetState from the built proxy/state.js', async () => {
  const st = await importState();
  assert.equal(st.showState, state.showState);
  assert.equal(st.resetState, state.resetState);
});
