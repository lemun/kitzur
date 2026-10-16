import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, type Socket } from 'node:net';
import { RuntimeLog, LoopWatchdog } from '../../src/diagnostics/runtime.js';
import { doctor, probeInstance } from '../../src/diagnostics/doctor.js';
import { buildApp } from '../../src/app.js';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';

test('startup logging ignores paused stderr and flushes a file on close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kitzur-startup-log-'));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.stateDir = dir;
  cfg.upstream.origin = 'http://127.0.0.1:1';
  const original = process.stderr.write;
  let calls = 0;
  process.stderr.write = (() => { calls++; return false; }) as typeof original;
  try {
    const app = await buildApp(cfg);
    try { assert.equal(calls, 0, 'startup logging must not touch stderr'); }
    finally { await app.close(0); }
    assert.match(await readFile(join(dir, 'logs', `kitzur-${new Date().toISOString().slice(0, 10)}.log`), 'utf8'), /counting with the per-class estimate/);
  } finally { process.stderr.write = original; await rm(dir, { recursive: true, force: true }); }
});

test('serving never calls a blocked stderr writer and writes logs to a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kitzur-log-'));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.listen.port = 0;
  cfg.stateDir = dir;
  cfg.upstream.origin = 'http://127.0.0.1:1';
  const original = process.stderr.write;
  let calls = 0;
  // A paused stream never calls its completion callback. Serving must not touch it.
  process.stderr.write = (() => { calls++; return false; }) as typeof original;
  try {
    const app = await buildApp(cfg);
    try {
      assert.equal(calls, 0, 'startup logging must not touch stderr');
      const addr = await app.listen();
      const res = await fetch(`http://127.0.0.1:${addr.port}/status`, { signal: AbortSignal.timeout(2000) });
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(typeof body['loop_lag_ms'], 'number');
      assert.equal(body['stalls_total'], 0);
      assert.equal(calls, 0);
    } finally { await app.close(0); }
    const file = join(dir, 'logs', `kitzur-${new Date().toISOString().slice(0, 10)}.log`);
    assert.match(await readFile(file, 'utf8'), /counting with the per-class estimate/);
  } finally { process.stderr.write = original; await rm(dir, { recursive: true, force: true }); }
});

test('watchdog records synchronous stalls independently and counts recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kitzur-watch-'));
  const log = new RuntimeLog({ dir, level: 'info' });
  const watchdog = new LoopWatchdog(log, { thresholdMs: 100, heartbeatMs: 25 });
  try {
    log.info('before stall');
    watchdog.phase('request-7', 'planning');
    const startup = setTimeout(() => assert.fail('watchdog startup timed out'), 2000);
    try { await watchdog.ready; } finally { clearTimeout(startup); }
    await delay(50); // allow a heartbeat before the deliberate stall
    const until = Date.now() + 450;
    while (Date.now() < until) { /* deliberate synchronous event-loop stall */ }
    await delay(100);
    const lines = (await readFile(log.path, 'utf8')).split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(lines.length >= 2, 'continues reporting until recovery');
    assert.equal(lines[0]?.['event'], 'event_loop_stall');
    assert.equal(lines[0]?.['request_id'], 'request-7');
    assert.equal(lines[0]?.['phase'], 'planning');
    assert.match(String(lines[0]?.['last_log_line']), /before stall/);
    assert.equal(watchdog.snapshot()['stalls_total'], 1);
  } finally { watchdog.close(); await log.close(); await rm(dir, { recursive: true, force: true }); }
});

test('doctor identifies a listening socket that never answers HTTP', async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    assert.equal(await probeInstance('127.0.0.1', port, 60), 'hung');
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.listen.port = port;
    const result = await doctor(cfg, { timeoutMs: 60 });
    const check = result.checks.find((c) => c.code === 'instance.responsive');
    assert.equal(check?.status, 'error');
    assert.match(check?.message ?? '', /a Kitzur process is listening but not responding/);
    assert.match(check?.fix ?? '', /Start-Process.*-WindowStyle Hidden.*-RedirectStandardOutput.*-RedirectStandardError/);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('file logging rotates at the cap and drops excess queued lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kitzur-rotate-'));
  const log = new RuntimeLog({ dir, level: 'info', maxBytes: 200 });
  try {
    for (let i = 0; i < 300; i++) log.info(`line ${i}`);
    await log.close();
    assert.equal(log.dropped, 44);
    assert.ok((await readFile(log.path)).length <= 200);
    assert.ok((await readFile(`${log.path}.1`)).length <= 200);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('logging prunes dated files and preserves unrelated files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kitzur-retention-'));
  const log = new RuntimeLog({ dir, level: 'info' });
  try {
    await writeFile(join(dir, 'kitzur-2000-01-01.log'), 'old');
    await writeFile(join(dir, 'kitzur-2000-01-01.log.1'), 'old backup');
    await writeFile(join(dir, 'unrelated.log'), 'keep');
    log.info('today');
    await log.close();
    const names = await readdir(dir);
    assert.ok(!names.some((name) => name.includes('2000-01-01')));
    assert.ok(names.includes('unrelated.log'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('log filesystem errors are reported without rejecting shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kitzur-log-error-'));
  const blocked = join(dir, 'blocked');
  await writeFile(blocked, 'file blocks directory');
  const log = new RuntimeLog({ dir: blocked, level: 'info' });
  try {
    log.info('cannot write');
    await log.close();
    assert.match(log.errorMessage ?? '', /EEXIST|ENOTDIR/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('file rotation during watchdog reporting leaves both logs readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kitzur-watch-rotate-'));
  const log = new RuntimeLog({ dir, level: 'info', maxBytes: 200 });
  const watchdog = new LoopWatchdog(log, { thresholdMs: 50, heartbeatMs: 10 });
  try {
    log.info('before rotation');
    const startup = setTimeout(() => assert.fail('watchdog startup timed out'), 2000);
    try { await watchdog.ready; } finally { clearTimeout(startup); }
    await delay(50);
    const until = Date.now() + 250;
    while (Date.now() < until) { /* let the worker append while the main loop is stalled */ }
    // Queue enough output to rotate the main stream while worker appends may still be in flight.
    log.info('after rotation ' + 'x'.repeat(150));
    await log.close();
    watchdog.close();
    const current = await readFile(log.path, 'utf8');
    const previous = await readFile(`${log.path}.1`, 'utf8');
    assert.match(current, /after rotation/);
    assert.match(previous, /before rotation/);
    assert.match(current + previous, /event_loop_stall/);
    for (const line of (current + previous).split('\n').filter(Boolean)) {
      if (line.startsWith('{')) assert.equal(JSON.parse(line).event, 'event_loop_stall');
      else assert.match(line, /^\d{4}-\d{2}-\d{2}T.* kitzur: info: /);
    }
    assert.equal(log.errorMessage, null);
  } finally { watchdog.close(); await log.close(); await rm(dir, { recursive: true, force: true }); }
});
