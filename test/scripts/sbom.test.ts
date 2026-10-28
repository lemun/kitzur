import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

// a throwaway npm cache keeps the run independent of the user's cache
const env: NodeJS.ProcessEnv = { ...process.env, npm_config_cache: mkdtempSync(join(tmpdir(), 'kitzur-npm-cache-')) };
delete env.SOURCE_DATE_EPOCH;
const sbom = (extra: NodeJS.ProcessEnv = {}, args: string[] = []) => {
  const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sbom.mjs'), ...args],
    { cwd: ROOT, encoding: 'utf8', env: { ...env, ...extra } });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
};

interface Component { type: string; 'bom-ref': string; name: string; hashes: { alg: string; content: string }[] }

test('sbom.mjs emits a deterministic CycloneDX 1.5 document for the packed files', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const first = sbom();
  assert.equal(sbom(), first, 'two runs must be byte-identical');
  const doc = JSON.parse(first);
  assert.equal(doc.bomFormat, 'CycloneDX');
  assert.equal(doc.specVersion, '1.5');
  assert.equal(doc.version, 1);
  assert.match(doc.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(doc.metadata.timestamp, undefined);
  const purl = `pkg:npm/${pkg.name}@${pkg.version}`;
  assert.deepEqual(doc.metadata.component, {
    type: 'application', 'bom-ref': purl, name: 'kitzur', version: pkg.version,
    licenses: [{ license: { id: 'MIT' } }], purl,
  });

  const runtimeDeps = Object.keys(pkg.dependencies ?? {}).length;
  const components = doc.components as Component[];
  assert.equal(components.filter((c) => c.type === 'library').length, runtimeDeps);
  assert.deepEqual(doc.dependencies, []);

  const names = components.map((c) => c.name);
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes('package.json') && names.includes(pkg.bin.kitzur), names.join(', '));
  for (const c of components) {
    assert.equal(c.type, 'file');
    assert.equal(c['bom-ref'], `file:${c.name}`);
    assert.doesNotMatch(c.name, /^([/\\]|[A-Za-z]:)|\.\./, c.name);
    const digest = createHash('sha256').update(readFileSync(join(ROOT, c.name))).digest('hex');
    assert.deepEqual(c.hashes, [{ alg: 'SHA-256', content: digest }], c.name);
  }
  assert.ok(!first.includes(ROOT) && !first.includes(homedir()), 'no absolute or home paths');
});

test('sbom.mjs takes the timestamp from SOURCE_DATE_EPOCH and writes --out', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'kitzur-sbom-')), 'sbom.json');
  assert.equal(sbom({ SOURCE_DATE_EPOCH: '1700000000' }, ['--out', out]), '');
  const doc = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(doc.metadata.timestamp, '2023-11-14T22:13:20Z');
  assert.notEqual(doc.serialNumber, JSON.parse(sbom()).serialNumber);
});
