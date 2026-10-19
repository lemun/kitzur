import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const opensslAvailable = spawnSync('openssl', ['version']).status === 0;

/** A trusted root with an omitted intermediate: verification must still fail. */
export async function withLeafOnlyServer(fn: (origin: string, caFile: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-leaf-only-'));
  const run = (...args: string[]) => {
    const result = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'root.key', '-out', 'root.pem', '-subj', '/CN=Wiring Root', '-days', '2', '-addext', 'basicConstraints=critical,CA:TRUE');
    for (const [id, cn, issuer, ca] of [['inter', 'Wiring Intermediate', 'root', true], ['leaf', 'localhost', 'inter', false]] as const) {
      run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${id}.key`, '-out', `${id}.csr`, '-subj', `/CN=${cn}`);
      writeFileSync(join(dir, 'ext'), `basicConstraints=critical,CA:${ca ? 'TRUE' : 'FALSE'}\n${ca ? 'keyUsage=critical,keyCertSign,cRLSign' : 'subjectAltName=DNS:localhost,IP:127.0.0.1'}`);
      run('x509', '-req', '-in', `${id}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`, '-CAcreateserial', '-out', `${id}.pem`, '-days', '1', '-extfile', 'ext');
    }
    const server = https.createServer({ cert: readFileSync(join(dir, 'leaf.pem')), key: readFileSync(join(dir, 'leaf.key')) }, (_req, res) => {
      res.end('{"data":[]}');
    });
    server.on('tlsClientError', () => {});
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      await fn(`https://127.0.0.1:${address.port}`, join(dir, 'root.pem'));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
