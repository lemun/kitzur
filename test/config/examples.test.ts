import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';
import { loadConfig } from '../../src/config/load.js';
import { validateConfig } from '../../src/config/validate.js';

const dir = join(ROOT, 'examples/config');
const files = readdirSync(dir).filter((f) => f.endsWith('.jsonc')).sort();

test('examples/config has at least one example', () => assert.ok(files.length > 0));

for (const f of files) {
  test(`examples/config/${f} loads and validates with an empty env`, () => {
    const l = loadConfig({ configPath: join(dir, f), env: {} });
    assert.deepEqual(validateConfig(l.config, { provenance: l.provenance }).errors, [], f);
    const origin = l.config.upstream.origin;
    assert.ok(origin, `${f}: upstream.origin is set`);
    assert.match(new URL(origin).hostname, /(^|\.)example\.com$/, `${f}: ${origin}`);
  });

  test(`examples/config/${f} carries no secrets or machine paths`, () => {
    const text = readFileSync(join(dir, f), 'utf8');
    assert.doesNotMatch(text, /"Authorization"\s*:/i, f);
    assert.doesNotMatch(text, /\b(?:Bearer\s+[\w.-]{8,}|sk-[\w-]{8,}|gh[pousr]_\w{8,}|[A-Za-z0-9+/_-]{32,})/, f);
    assert.doesNotMatch(text, /"token"\s*:\s*"(?!<)[^"]+"/, f);
    for (const [, p] of text.matchAll(/"((?:\/|[A-Za-z]:\\)[^"]*)"/g)) {
      assert.match(p!, /<[^>]+>|%\w+%|\$\{?\w+\}?/, `${f}: absolute path without a placeholder: ${p}`);
    }
  });
}

test('examples/config/README.md lists exactly the example files', () => {
  const listed = [...readFileSync(join(dir, 'README.md'), 'utf8').matchAll(/\]\(([^)\s]+\.jsonc)\)/g)].map(([, t]) => t!).sort();
  assert.deepEqual(listed, files);
});

test('docs index links the config examples on GitHub', () => {
  assert.ok(readFileSync(join(ROOT, 'docs/README.md'), 'utf8').includes('(https://github.com/lemun/kitzur/tree/main/examples/config)'));
});
