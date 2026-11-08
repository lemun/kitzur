import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { passthroughEngine } from './fake-engine.js';
import { chatBody, chunk, fakeUpstream, jsonRes, request, sseRes, startProxy, waitRecords } from './harness.js';

// Every upstream error path must keep these out of proxy-generated output: logs, stats records, /status
// and, for 502s, the proxy's own error body. Bodies the upstream itself echoes back are relayed verbatim and not checked.
const SECRETS = ['tok-SECRET', 'cfg-SECRET', 'key-SECRET', 'cookie-SECRET', 'PRIVATE-PROMPT'];
const CLIENT = { authorization: 'Bearer tok-SECRET', 'x-api-key': 'key-SECRET', cookie: 'a=cookie-SECRET' };

const cases: { name: string; stream?: boolean; timeoutMs?: number; proxyBody?: boolean; respond: (res: ServerResponse) => void }[] = [
  { name: 'upstream 500 with a JSON error body', respond: (res) => jsonRes(res, 500, { error: { message: 'boom' } }) },
  { name: 'upstream 401', respond: (res) => jsonRes(res, 401, { error: { message: 'unauthorized' } }) },
  { name: 'socket destroyed (502)', proxyBody: true, respond: (res) => res.socket?.destroy() },
  { name: 'upstream silent past timeoutMs (502)', timeoutMs: 300, proxyBody: true, respond: () => {} },
  {
    name: 'stream cut after the first chunk',
    stream: true,
    respond: (res) => void sseRes(res, [chunk('partial')], { end: false }).then(() => setTimeout(() => res.destroy(), 20)),
  },
];

for (const c of cases) {
  test(`secrets stay out of logs, stats and /status: ${c.name}`, async (t) => {
    const logs: string[] = [];
    const up = await fakeUpstream((hit, res) => (hit.url === '/v1/models' ? jsonRes(res, 404, {}) : c.respond(res)));
    t.after(() => up.close());
    const config = { listen: { token: 'tok-SECRET' }, upstream: { headers: { Authorization: 'Bearer cfg-SECRET' }, ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}) } };
    const f = await startProxy(t, up, passthroughEngine(), { config, log: (_level, msg) => logs.push(msg) });
    t.after(() => f.close());
    const body = chatBody('PRIVATE-PROMPT hello', c.stream ? { stream: true } : {});
    // a cut stream may end the client response abruptly; only the proxy's own 502 body is inspected
    const r = await request(f.port, { method: 'POST', path: '/v1/chat/completions', headers: CLIENT, body }).catch(() => null);
    if (c.proxyBody) assert.equal(r?.status, 502);
    assert.equal((await waitRecords(f, 1)).length, 1);
    const status = (await request(f.port, { method: 'GET', path: '/status', headers: { authorization: 'Bearer tok-SECRET' } })).text();
    assert.equal(JSON.parse(status).name, 'kitzur');
    assert.notEqual(logs.length, 0, 'the log must have a line so the check is not vacuous');
    const visible = [logs.join('\n'), JSON.stringify(f.records()), status, c.proxyBody ? (r?.text() ?? '') : ''].join('\n');
    for (const s of SECRETS) assert.equal(visible.includes(s), false, `${s} leaked`);
  });
}
