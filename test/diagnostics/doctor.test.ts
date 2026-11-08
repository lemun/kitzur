import test, { mock } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/config/load.js';
import { doctor, renderDoctor } from '../../src/diagnostics/doctor.js';
import { Upstream } from '../../src/proxy/upstream.js';
import { opensslAvailable, withLeafOnlyServer } from '../helpers/leaf-only.js';

test('doctor diagnoses the missing TLS link while Upstream keeps rejecting the leaf-only server', { skip: !opensslAvailable }, async () => {
  await withLeafOnlyServer(async (origin, caFile) => {
    const cfg = defaultConfig();
    cfg.upstream.origin = origin;
    cfg.upstream.caFile = caFile;
    cfg.listen.port = 0;
    const upstream = new Upstream(cfg.upstream);
    try {
      const before = await upstream.probe();
      assert.equal(before.ok, false);
      assert.match(before.tlsError ?? '', /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
      const result = await doctor(cfg, { upstreamCheck: true });
      const check = result.checks.find((c) => c.code === 'upstream.tls');
      assert.equal(result.exitCode, 1);
      assert.equal(check?.status, 'error');
      assert.match(check?.message ?? '', /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
      assert.match(check?.message ?? '', /leaf_only_missing_intermediate/);
      assert.match(check?.message ?? '', /FAILED: localhost <- Wiring Intermediate/);
      assert.match(check?.message ?? '', /SHA256/);
      assert.ok(!result.checks.some((c) => c.code === 'upstream.reachable'));
      assert.equal((await upstream.probe()).ok, false, 'inspection must not weaken Upstream verification');
    } finally { upstream.close(); }
  });
});

test('doctor reports missing and invalid tokenizer with sanitized messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-doctor-'));
  try {
    const cfg = defaultConfig();
    cfg.tokenizer.path = join(dir, 'TOKEN_SECRET_PATH.json');
    const missing = await doctor(cfg);
    assert.equal(missing.exitCode, 0, 'missing tokenizer falls back to estimator');
    assert.ok(missing.checks.some((c) => c.code === 'tokenizer.path' && c.status === 'warn'));
    assert.doesNotMatch(renderDoctor(missing), /TOKEN_SECRET_PATH/);
    writeFileSync(cfg.tokenizer.path, '{"not":"a tokenizer"}');
    const invalid = await doctor(cfg);
    assert.ok(invalid.checks.some((c) => c.code === 'tokenizer.load' && c.status === 'error'));
    assert.doesNotMatch(renderDoctor(invalid), /not a tokenizer|TOKEN_SECRET_PATH/);
    // each cause gets its own message, and none quotes the file
    const messages = new Set<string>();
    for (const body of ['', 'SECRET_BODY', '{"SECRET_BODY":1}', null]) {
      if (body === null) { rmSync(cfg.tokenizer.path); fs.mkdirSync(cfg.tokenizer.path); } else writeFileSync(cfg.tokenizer.path, body);
      const result = await doctor(cfg);
      assert.doesNotMatch(renderDoctor(result), /SECRET_BODY|TOKEN_SECRET_PATH/);
      messages.add(result.checks.find((c) => c.code === 'tokenizer.load')?.message ?? '');
    }
    assert.equal(messages.size, 4, [...messages].join('\n'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor flags unusable budget and an unreachable explicit upstream probe', async () => {
  const cfg = defaultConfig();
  cfg.budget.window = 100;
  cfg.budget.defaultMaxTokens = 90;
  cfg.budget.safetyMarginTokens = 50;
  cfg.upstream.origin = 'http://127.0.0.1:1';
  cfg.upstream.headers = { Authorization: 'Bearer TOKEN_SECRET_VALUE' };
  cfg.upstream.timeoutMs = 100;
  const result = await doctor(cfg, { upstreamCheck: true, timeoutMs: 150 });
  assert.equal(result.exitCode, 1);
  assert.ok(result.checks.some((c) => c.code === 'budget.compatible' && c.status === 'error'));
  assert.ok(result.checks.some((c) => c.code === 'upstream.reachable' && c.status === 'error'));
  assert.doesNotMatch(JSON.stringify(result), /ECONN|127\.0\.0\.1|TOKEN_SECRET_VALUE/);
});

test('doctor recognizes reachable auth and missing-route responses and bounds a stalled probe', async () => {
  const server = createServer((req, res) => {
    if (req.headers['x-diagnostic-route'] === '/auth') { res.writeHead(401); res.end(); }
    else if (req.headers['x-diagnostic-route'] === '/missing') { res.writeHead(404); res.end(); }
    // /stall deliberately leaves the response open until doctor times out.
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const [path, expectedStatus] of [['/auth', 'warn'], ['/missing', 'warn'], ['/stall', 'error']] as const) {
      const timeoutMs = path === '/stall' ? 80 : 5_000;
      const cfg = defaultConfig(); cfg.upstream.origin = origin; cfg.upstream.timeoutMs = timeoutMs;
      // Upstream's GET probe path is fixed; route by request header for independent status cases.
      cfg.upstream.headers = { 'x-diagnostic-route': path };
      const result = await doctor(cfg, { upstreamCheck: true, timeoutMs });
      const check = result.checks.find((c) => c.code === 'upstream.reachable');
      assert.equal(check?.status, expectedStatus, path);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('doctor detects a regular file blocking a state directory without modifying paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-doctor-path-'));
  try {
    const blocker = join(dir, 'regular-file'); writeFileSync(blocker, 'sentinel');
    const cfg = defaultConfig(); cfg.stateDir = join(blocker, 'state');
    cfg.stats.path = join(blocker, 'stats.jsonl');
    const before = (await import('node:fs')).readFileSync(blocker, 'utf8');
    const result = await doctor(cfg);
    assert.ok(result.checks.some((c) => c.code === 'state.directory' && c.status === 'error'));
    assert.ok(result.checks.some((c) => c.code === 'stats.path' && c.status === 'error'));
    assert.equal((await import('node:fs')).readFileSync(blocker, 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor checks the log file folder: default under the state dir, a missing folder, a blocked folder, a read-only folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-doctor-log-'));
  const logCheck = async (file: string | null) => {
    const cfg = defaultConfig(); cfg.stateDir = join(dir, 'state'); cfg.log.file = file;
    return (await doctor(cfg)).checks.find((c) => c.code === 'log.directory');
  };
  try {
    assert.equal((await logCheck(null))?.status, 'ok');
    assert.equal((await logCheck(join(dir, 'new', 'logs', 'x.log')))?.status, 'ok');
    const blocker = join(dir, 'regular-file'); writeFileSync(blocker, 'sentinel');
    const blocked = await logCheck(join(blocker, 'x.log'));
    assert.equal(blocked?.status, 'error');
    assert.match(blocked?.message ?? '', /^Log path is not a directory/);
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const ro = join(dir, 'ro'); fs.mkdirSync(ro, { mode: 0o555 });
      try { assert.equal((await logCheck(join(ro, 'x.log')))?.status, 'warn'); }
      finally { fs.chmodSync(ro, 0o755); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor treats refused probes and other HTTP services as warnings without restart advice', async () => {
  for (const [status, body] of [[403, 'Host mismatch'], [503, '{}'], [200, 'not json'], [200, '{"name":"other","stats":{"dropped":5,"write_failures":2}}'], [200, 'null']] as const) {
    const server = createServer((_req, res) => { res.writeHead(status); res.end(body); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const cfg = defaultConfig();
      cfg.listen.port = (server.address() as { port: number }).port;
      const result = await doctor(cfg);
      const check = result.checks.find((c) => c.code === 'instance.responsive');
      assert.equal(check?.status, 'warn', String(status));
      assert.match(check?.message ?? '', /another service .*answers on/i);
      assert.doesNotMatch(check?.fix ?? '', /Restart|Start-Process/);
      assert.equal(result.checks.some((c) => c.code === 'stats.writer'), false);
      assert.equal(result.exitCode, 0);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test('doctor reports the stats writer counters from a running Kitzur /status', async () => {
  for (const [stats, status] of [[{ dropped: 3, write_failures: 1 }, 'warn'], [{ dropped: 0, write_failures: 0 }, 'ok']] as const) {
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ name: 'kitzur', stats })); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const cfg = defaultConfig();
      cfg.listen.port = (server.address() as { port: number }).port;
      const check = (await doctor(cfg)).checks.find((c) => c.code === 'stats.writer');
      assert.equal(check?.status, status);
      assert.match(check?.message ?? '', new RegExp(`dropped ${stats.dropped} record\\(s\\) and seen ${stats.write_failures} write failure`));
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test('probe classifies HTTP answers and transport failures without requiring a listening socket', async () => {
  const { probeInstance } = await import('../../src/diagnostics/doctor.js');
  for (const [status, body, code, expected] of [
    [200, '{"name":"kitzur"}', null, 'responsive'],
    [403, 'Host mismatch', null, 'other'],
    [503, '{}', null, 'other'],
    [200, 'not json', null, 'other'],
    [200, '{"name":"other","stats":{"dropped":4}}', null, 'other'],
    [200, 'null', null, 'other'],
    [200, '', 'ECONNRESET', 'hung'],
    [200, '', 'ETIMEDOUT', 'hung'],
    [200, '', 'ECONNREFUSED', 'other'],
    [200, '', 'HPE_INVALID_CONSTANT', 'other'],
  ] as const) {
    const socket = Object.assign(new EventEmitter(), { destroy() {}, setTimeout() {} });
    const req = Object.assign(new EventEmitter(), {
      destroy() {},
      end() {
        process.nextTick(() => {
          if (code) req.emit('error', Object.assign(new Error(code), { code }));
          else {
            const res = Object.assign(new EventEmitter(), { statusCode: status });
            respond(res);
            res.emit('data', Buffer.from(body));
            res.emit('end');
          }
        });
      },
    });
    let respond: (res: EventEmitter) => void;
    mock.method(net, 'createConnection', () => { process.nextTick(() => socket.emit('connect')); return socket; });
    const authorizations: unknown[] = [];
    mock.method(http, 'request', (options: { headers: { authorization?: string } }, callback: typeof respond) => {
      authorizations.push(options.headers.authorization);
      respond = callback; return req;
    });
    syncBuiltinESMExports();
    try {
      assert.equal(await probeInstance('127.0.0.1', 1234), expected, String(body || code));
      if (expected === 'responsive') {
        const cfg = defaultConfig(); cfg.listen.port = 1234; cfg.listen.token = 'CLIENT_SECRET';
        const result = await doctor(cfg);
        assert.equal(result.checks.find((c) => c.code === 'instance.responsive')?.status, 'ok');
        assert.deepEqual(authorizations, [undefined, 'Bearer CLIENT_SECRET']);
      }
      if (expected === 'other') {
        const cfg = defaultConfig(); cfg.listen.port = 1234;
        const result = await doctor(cfg);
        const check = result.checks.find((c) => c.code === 'instance.responsive');
        assert.equal(check?.status, 'warn');
        assert.match(check?.message ?? '', /another service .*answers on 1234/i);
        assert.doesNotMatch(check?.fix ?? '', /Restart|Start-Process/);
        assert.equal(result.exitCode, 0);
      }
    }
    finally { mock.restoreAll(); syncBuiltinESMExports(); }
  }
});

test('doctor reads an OpenCode JSONC file and handles unreadable files safely', async () => {
  const cfg = defaultConfig();
  cfg.listen.port = 8787;
  const result = await doctor(cfg, { clientConfigPath: 'test/fixtures/client-config/npm.opencode.json' });
  assert.ok(result.checks.some((c) => c.code === 'client.npm'));
  const missing = await doctor(cfg, { clientConfigPath: 'SECRET_MISSING_FILE' });
  assert.equal(missing.exitCode, 1);
  assert.ok(missing.checks.some((c) => c.code === 'client.config'));
  assert.doesNotMatch(renderDoctor(missing), /SECRET_MISSING_FILE/);
  const notFound = missing.checks.find((c) => c.code === 'client.config');
  assert.equal(notFound?.status, 'error');
  assert.match(notFound?.message ?? '', /not found/);
  assert.match(notFound?.fix ?? '', /--client-config/);
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-client-config-'));
  try {
    const unreadable = await doctor(cfg, { clientConfigPath: dir });
    assert.equal(unreadable.exitCode, 1);
    const read = unreadable.checks.find((c) => c.code === 'client.config');
    assert.equal(read?.status, 'error');
    assert.match(read?.message ?? '', /could not be read \(EISDIR\)/);
    assert.ok(!renderDoctor(unreadable).includes(dir));
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{\n  "provider": {\n    "authorization": Bearer SK-FAKE-SECRET-123\n  }\n}\n');
    const invalid = await doctor(cfg, { clientConfigPath: broken });
    assert.equal(invalid.exitCode, 1);
    const syntax = invalid.checks.find((c) => c.code === 'client.config');
    assert.equal(syntax?.status, 'error');
    assert.match(syntax?.message ?? '', /not valid JSON\/JSONC \(line 3, column \d+\)/);
    assert.match(syntax?.fix ?? '', /editor/);
    assert.doesNotMatch(renderDoctor(invalid), /SK-FAKE-SECRET|Bearer|authorization|broken\.json/);
    for (const [code, shown] of [['UNKNOWN', 'UNKNOWN'], ['ERR_FS_FILE_TOO_LARGE', 'ERR_FS_FILE_TOO_LARGE'], ['bad code SK-FAKE', 'UNKNOWN'], [undefined, 'UNKNOWN']] as const) {
      mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error(`read failed SK-FAKE-SECRET ${broken}`), { code }); });
      syncBuiltinESMExports();
      try {
        const other = await doctor(cfg, { clientConfigPath: broken });
        assert.equal(other.exitCode, 1);
        const failed = other.checks.find((c) => c.code === 'client.config');
        assert.equal(failed?.status, 'error');
        assert.equal(failed?.message, `Client configuration file could not be read (${shown}).`);
        assert.doesNotMatch(renderDoctor(other), /SK-FAKE|broken\.json/);
      } finally { mock.restoreAll(); syncBuiltinESMExports(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor warns when upstream.headers is set without listen.token, without printing secrets', async () => {
  const cfg = defaultConfig();
  cfg.listen.port = 8787;
  cfg.upstream.headers = { authorization: 'Bearer UPSTREAM_SECRET' };
  const open = await doctor(cfg);
  assert.equal(open.checks.find((c) => c.code === 'listen.token')?.status, 'warn');
  assert.doesNotMatch(renderDoctor(open), /UPSTREAM_SECRET/);
  cfg.listen.token = 'CLIENT_SECRET';
  const closed = await doctor(cfg);
  assert.equal(closed.checks.find((c) => c.code === 'listen.token'), undefined);
  assert.doesNotMatch(renderDoctor(closed), /CLIENT_SECRET|UPSTREAM_SECRET/);
});

test('doctor still reports diagnostics when upstream.headers is not a record', async () => {
  const cfg = defaultConfig();
  (cfg.upstream as { headers: unknown }).headers = null;
  const result = await doctor(cfg);
  assert.equal(result.checks.find((c) => c.code === 'config.valid')?.status, 'error');
  assert.equal(result.checks.find((c) => c.code === 'listen.token'), undefined);
});

test('doctor reports resolved config, state and log paths', async () => {
  const cfg = defaultConfig(); cfg.stateDir = '/tmp/kitzur-paths'; cfg.log.file = '/tmp/kitzur.log';
  const result = await doctor(cfg, { configPath: '/tmp/kitzur.jsonc', timeoutMs: 1 });
  assert.equal(result.checks.find((c) => c.code === 'paths')?.message, 'Paths: config=/tmp/kitzur.jsonc; state_dir=/tmp/kitzur-paths; log_file=/tmp/kitzur.log');
});

test('upstream authentication diagnostics distinguish client keys, stored keys and probe tokens', async () => {
  let status = 200, expected = '';
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization ?? '', expected);
    res.writeHead(status); res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    for (status of [200, 401, 403, 404, 500]) for (const header of ['', 'Authorization', 'X-Api-Key', 'Proxy-Authorization', 'api-key', 'Cookie']) for (const token of ['', 'PROBE_SECRET']) {
      const cfg = defaultConfig(); cfg.upstream.origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
      cfg.upstream.headers = header ? { [header]: 'STORED_SECRET' } : {};
      expected = token ? 'Bearer ' + token : header === 'Authorization' ? 'STORED_SECRET' : '';
      const result = await doctor(cfg, { upstreamCheck: true, env: { KITZUR_PROBE_TOKEN: token } });
      const check = result.checks.find((c) => c.code === 'upstream.reachable');
      assert.equal(check?.status, status === 200 ? 'ok' : status === 500 ? 'error' : 'warn');
      if (token && [200, 401, 403].includes(status)) assert.match(check?.message ?? '', status === 200 ? /key accepted/i : /key was rejected/i);
      assert.doesNotMatch(renderDoctor(result) + JSON.stringify(result), /PROBE_SECRET|STORED_SECRET/);
    }
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('probe auth status and token forwarding at the request boundary', async () => {
  for (const status of [200, 401, 403, 404, 500]) for (const stored of [false, true]) for (const token of ['', 'PROBE_SECRET']) {
    const cfg = defaultConfig(); cfg.upstream.origin = 'http://localhost:1';
    cfg.upstream.headers = stored ? { AUTHORIZATION: 'STORED_SECRET' } : {};
    mock.method(Upstream.prototype, 'request', async (req: { headers: Record<string, unknown> }) => {
      assert.equal(req.headers.authorization, token ? 'Bearer ' + token : stored ? 'STORED_SECRET' : undefined);
      return { status, body: Readable.from([Buffer.from('{}')]) };
    });
    try {
      const result = await doctor(cfg, { upstreamCheck: true, env: { KITZUR_PROBE_TOKEN: token } });
      const check = result.checks.find((c) => c.code === 'upstream.reachable');
      assert.equal(check?.status, status === 200 ? 'ok' : status === 500 ? 'error' : 'warn');
      if (token && [200, 401, 403].includes(status)) assert.match(check?.message ?? '', status === 200 ? /key accepted/i : /key was rejected/i);
      assert.doesNotMatch(renderDoctor(result) + JSON.stringify(result), /PROBE_SECRET|STORED_SECRET/);
    } finally { mock.restoreAll(); }
  }
});
