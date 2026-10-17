import test, { mock } from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/config/load.js';
import { doctor, renderDoctor } from '../../src/diagnostics/doctor.js';

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

test('doctor treats refused probes and other HTTP services as warnings without restart advice', async () => {
  for (const [status, body] of [[403, 'Host mismatch'], [503, '{}'], [200, 'not json'], [200, '{"name":"other"}'], [200, 'null']] as const) {
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
      assert.equal(result.exitCode, 0);
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
    [200, '{"name":"other"}', null, 'other'],
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
    mock.method(http, 'request', (_options: unknown, callback: typeof respond) => { respond = callback; return req; });
    syncBuiltinESMExports();
    try {
      assert.equal(await probeInstance('127.0.0.1', 1234), expected, String(body || code));
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
});
