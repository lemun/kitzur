import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const pkg = JSON.parse(read('package.json')) as { license: string; files: string[] };
const notices = read('THIRD_PARTY_NOTICES.md');

test('LICENSE, package.json and README agree on the MIT license', () => {
  const license = read('LICENSE');
  assert.ok(license.startsWith('MIT License'), 'LICENSE must start with "MIT License"');
  assert.match(license, /^Copyright \(c\) \d{4} \S/m);
  assert.equal(pkg.license, 'MIT');
  const section = /^## License\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(read('README.md'))?.[1];
  assert.ok(section, 'README must have a ## License section');
  assert.ok(section.includes('[MIT](LICENSE)'), 'README ## License must link [MIT](LICENSE)');
});

test('every LICENSES file is non-empty and referenced by THIRD_PARTY_NOTICES.md', () => {
  const names = readdirSync(join(ROOT, 'LICENSES'));
  assert.ok(names.length > 0, 'LICENSES/ must not be empty');
  for (const name of names) {
    assert.ok(statSync(join(ROOT, 'LICENSES', name)).size > 0, `LICENSES/${name} is empty`);
    assert.ok(notices.includes(name), `THIRD_PARTY_NOTICES.md must reference LICENSES/${name}`);
  }
});

test('every (LICENSES/<name>) link in THIRD_PARTY_NOTICES.md points to an existing file', () => {
  const links = [...notices.matchAll(/\(LICENSES\/([^)\s]+)\)/g)].map((m) => m[1]!);
  assert.ok(links.length > 0, 'THIRD_PARTY_NOTICES.md must link license texts');
  for (const name of links) {
    assert.ok(existsSync(join(ROOT, 'LICENSES', name)), `THIRD_PARTY_NOTICES.md: LICENSES/${name}`);
  }
});

test('npm package and offline bundle ship LICENSE, LICENSES and THIRD_PARTY_NOTICES.md', () => {
  for (const entry of ['LICENSE', 'LICENSES', 'THIRD_PARTY_NOTICES.md']) {
    assert.ok(pkg.files.includes(entry), `package.json files must include ${entry}`);
  }
  const script = read('scripts/pack-offline.sh');
  assert.match(script, /^cp -R\b[^\n]*\bLICENSES\b[^\n]*"\$stage\/"/m, 'pack-offline.sh must copy LICENSES');
  const copied = /^for f in ([^;\n]*); do\n[^\n]*cp "\$f" "\$stage\/"/m.exec(script)?.[1]?.split(/\s+/);
  assert.ok(copied, 'pack-offline.sh must copy top-level docs into the bundle');
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    assert.ok(copied.includes(name), `pack-offline.sh must copy ${name}`);
  }
});
