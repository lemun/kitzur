import { X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { test } from 'node:test';
import { inspectTlsChain } from '../../src/diagnostics/tls-chain.js';
import { main } from '../../src/cli.js';

const openssl = spawnSync('openssl', ['version']).status === 0;
for (const mode of ['offline', 'socket']) test(`TLS chain diagnoses missing intermediate, trust, hostname, expiry and CLI (${mode})`, { skip: !openssl }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-chain-'));
  const run = (...args: string[]) => {
    const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const pem = (file: string) => readFileSync(join(dir, file), 'utf8');
  try {
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-subj', '/CN=Test Root', '-days', '2', '-addext', 'basicConstraints=critical,CA:TRUE');
    for (const [id, cn, issuer, ca] of [['inter', 'Test Intermediate', 'root', true], ['leaf', 'localhost', 'inter', false]] as const) {
      run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${id}.key`, '-out', `${id}.csr`, '-subj', `/CN=${cn}`);
      writeFileSync(join(dir, 'ext'), `basicConstraints=critical,CA:${ca ? 'TRUE' : 'FALSE'}\n${ca ? 'keyUsage=critical,keyCertSign,cRLSign' : 'subjectAltName=DNS:localhost\nauthorityInfoAccess=caIssuers;URI:http://issuer.test/inter.pem'}`);
      run('x509', '-req', '-in', `${id}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`, '-CAcreateserial', '-out', `${id}.pem`, '-days', '1', '-extfile', 'ext');
    }
    const serve = async (cert: string, key: string, fn: (origin: string) => Promise<void>) => {
      if (mode === 'offline') {
        const chain = (cert.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [])
          .map((pem) => ({ raw: new X509Certificate(pem).raw, issuerCertificate: undefined as unknown }));
        chain.forEach((c, i) => { c.issuerCertificate = chain[i + 1]; });
        const mocked = t.mock.method(tls, 'connect', () => {
          const socket = Object.assign(new EventEmitter(), {
            authorized: false, authorizationError: 'TEST_UNVERIFIED', getPeerCertificate: () => chain[0],
            end: () => {}, destroy: () => { socket.emit('close'); },
          });
          queueMicrotask(() => socket.emit('secureConnect'));
          return socket;
        });
        try { await fn('https://127.0.0.1:443'); }
        finally { mocked.mock.restore(); }
        return;
      }
      let bytes = 0;
      const server = tls.createServer({ cert, key }, (socket) => socket.on('data', (data) => { bytes += data.length; }));
      server.on('tlsClientError', () => {});
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      try { await fn(`https://127.0.0.1:${address.port}`); }
      finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
      assert.equal(bytes, 0, 'diagnostic must never send application data');
    };
    const caFile = join(dir, 'root.pem');
    await serve(pem('leaf.pem'), pem('leaf.key'), async (origin) => {
      const result = await inspectTlsChain({ origin, servername: 'localhost', caFile });
      assert.equal(result.diagnosis, 'leaf_only_missing_intermediate');
      assert.match(result.hint, /Test Intermediate/);
      assert.equal(result.certificates[0]?.aiaIssuerUrl, 'http://issuer.test/inter.pem');
    });
    await serve(pem('leaf.pem') + pem('inter.pem'), pem('leaf.key'), async (origin) => {
      const result = await inspectTlsChain({ origin, servername: 'localhost', caFile });
      assert.equal(result.diagnosis, 'ok');
      assert.equal(result.certificates.length, 3);
      assert.equal(result.certificates[2]?.source, 'local_store');
      assert.equal(result.links.length, 2);
      assert.equal((await inspectTlsChain({ origin, servername: 'localhost' })).diagnosis, 'unknown_root');
      assert.equal((await inspectTlsChain({ origin, caFile })).diagnosis, 'hostname_mismatch');
      let output = '';
      const code = await main(['tls-probe', origin, '--ca-file', caFile, '--json'], {
        cwd: dir, env: {}, stdout: (s) => { output += s; }, stderr: () => {}, onSignal: () => {},
      });
      assert.equal(code, 1);
      assert.equal(JSON.parse(output).diagnosis, 'hostname_mismatch');
      if (mode === 'offline') {
        output = '';
        assert.equal(await main(['tls-probe', origin.replace('127.0.0.1', 'localhost'), '--ca-file', caFile, '--json'], {
          cwd: dir, env: {}, stdout: (s) => { output += s; }, stderr: () => {}, onSignal: () => {},
        }), 0);
        assert.equal(JSON.parse(output).diagnosis, 'ok');
      }
    });
    await serve(pem('root.pem'), pem('root.key'), async (origin) => {
      assert.equal((await inspectTlsChain({ origin, servername: 'Test Root' })).diagnosis, 'self_signed');
    });
    await serve(pem('leaf.pem') + pem('inter.pem'), pem('leaf.key'), async (origin) => {
      const clock = t.mock.method(Date, 'now', () => Date.parse(new X509Certificate(pem('leaf.pem')).validTo) + 1000);
      try { assert.equal((await inspectTlsChain({ origin, servername: 'localhost', caFile })).diagnosis, 'expired'); }
      finally { clock.mock.restore(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('verification bypass is confined to the handshake diagnostic', () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
  const files = walk('src').filter((file) => /rejectUnauthorized\s*:\s*false/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(files, [join('src', 'diagnostics', 'tls-chain.ts')]);
});

test('tls-probe validates arguments and exposes help without connecting', async () => {
  let output = '';
  const io = { cwd: process.cwd(), env: {}, stdout: (s: string) => { output += s; }, stderr: (s: string) => { output += s; }, onSignal: () => {} };
  assert.equal(await main(['tls-probe', '--help'], io), 0);
  assert.match(output, /--ca-file/);
  for (const args of [['http://example.test'], ['https://example.test', '--timeout-ms', '0'], ['https://a', 'https://b']]) {
    assert.equal(await main(['tls-probe', ...args], io), 2);
  }
});
