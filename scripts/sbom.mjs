#!/usr/bin/env node
// Prints a CycloneDX 1.5 SBOM for what `npm publish` would ship: node scripts/sbom.mjs [--out FILE]
// One `file` component per packed file with its SHA-256. The output is deterministic: components are sorted, paths
// are package-relative, the serial number is derived from the content, and metadata.timestamp is set only from
// SOURCE_DATE_EPOCH. There are no runtime dependencies, so `dependencies` is empty. Run `npm run build` first.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
if (outIdx >= 0 && !out) {
  console.error('sbom: --out needs a file name');
  process.exit(2);
}

const dir = resolve('.');
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const res = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' });
if (res.status !== 0) {
  console.error(`sbom: npm pack failed (exit ${res.status})\n${res.stderr}`);
  process.exit(1);
}
const packed = JSON.parse(res.stdout)[0].files.map((f) => f.path.replaceAll('\\', '/')).sort();
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const purl = `pkg:npm/${encodeURIComponent(pkg.name)}@${pkg.version}`;
const metadata = {
  ...(process.env.SOURCE_DATE_EPOCH
    ? { timestamp: new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString().replace(/\.000Z$/, 'Z') }
    : {}),
  component: {
    type: 'application', 'bom-ref': purl, name: pkg.name, version: pkg.version,
    licenses: [{ license: { id: pkg.license } }], purl,
  },
};
const components = packed.map((path) => ({
  type: 'file', 'bom-ref': `file:${path}`, name: path,
  hashes: [{ alg: 'SHA-256', content: sha256(readFileSync(join(dir, path))) }],
}));
const body = { metadata, components, dependencies: [] };

// RFC 4122 layout over the content hash, so the same content always gets the same serial number
const h = sha256(JSON.stringify(body));
const serial = `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-` +
  `${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
const text = `${JSON.stringify({
  bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: serial, version: 1, ...body,
}, null, 2)}\n`;

if (out) writeFileSync(out, text);
else process.stdout.write(text);
