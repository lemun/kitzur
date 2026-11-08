import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const licenses = readdirSync(join(ROOT, 'LICENSES'));
const pkg = JSON.parse(read('package.json')) as { license: string; files: string[] };

test('LICENSE, package.json and the README agree on MIT', () => {
  const license = read('LICENSE');
  assert.match(license, /^MIT License/);
  assert.match(license, /^Copyright \(c\) \d{4} \S.*$/m);
  assert.equal(pkg.license, 'MIT');
  const section = read('README.md').split(/^## License$/m)[1] ?? '';
  assert.match(section, /\[MIT\]\(LICENSE\)/);
});

test('THIRD_PARTY_NOTICES.md names every LICENSES file and links only to files that exist', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  for (const f of licenses) assert.ok(notices.includes(`LICENSES/${f}`), `${f} is not referenced`);
  const links = [...notices.matchAll(/\]\((LICENSES\/[^)]*)\)/g)].map((m) => m[1] ?? '');
  assert.ok(links.length >= licenses.length, links.join(', '));
  for (const l of links) assert.ok(existsSync(join(ROOT, l)), `${l} does not exist`);
});

test('each LICENSES file holds its license text', () => {
  const marker = (f: string): RegExp => {
    if (f === 'Apache-2.0.txt') return /Apache License/;
    if (f === 'onig_sys-MIT.md') return /MIT/;
    if (f === 'Unicode-3.0.txt') return /UNICODE LICENSE V3/;
    if (f.startsWith('Oniguruma-')) return /Redistribution and use/;
    if (f.endsWith('-COPYRIGHT.txt')) return /Apache License[\s\S]*MIT/;
    if (/-MIT\./.test(f)) return /Permission is hereby granted/;
    throw new Error(`no marker for LICENSES/${f}`);
  };
  for (const f of licenses) {
    const text = read(`LICENSES/${f}`);
    assert.ok(text.trim().length > 0, `${f} is empty`);
    assert.match(text, marker(f), f);
  }
});

test('package.json files and the offline bundle script ship the license files', () => {
  for (const f of ['LICENSE', 'LICENSES', 'THIRD_PARTY_NOTICES.md']) assert.ok(pkg.files.includes(f), f);
  const script = read('scripts/pack-offline.sh');
  assert.match(script, /^cp -R .*\bLICENSES\b/m);
  assert.match(script, /^for f in .*\bLICENSE\b/m);
  assert.match(script, /^for f in .*\bTHIRD_PARTY_NOTICES\.md\b/m);
});
