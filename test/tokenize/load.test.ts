import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { defaultTokenizerCachePath, loadTokenizerCached } from '../../src/tokenize/load.js';
import { ROOT, testTokenizerPath } from '../helpers.js';

const path = testTokenizerPath();

test('loadTokenizerCached: writes the compiled cache, loads from it, rebuilds a corrupt one', { skip: path ? false : 'no dev tokenizer.json' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-load-'));
  try {
    const cache = join(dir, 'sub', 'tok.lctk');
    const a = loadTokenizerCached(path!, cache);
    assert.equal(a.cacheStatus, 'written');
    assert.equal(a.fromCache, false);
    assert.equal(a.sha256, createHash('sha256').update(readFileSync(path!)).digest('hex'));
    assert.ok(existsSync(cache));
    const b = loadTokenizerCached(path!, cache);
    assert.equal(b.cacheStatus, 'fresh');
    assert.equal(b.fromCache, true);
    assert.ok(b.loadMs < a.loadMs, `cache load ${b.loadMs.toFixed(0)} ms vs json ${a.loadMs.toFixed(0)} ms`);
    const lines = gunzipSync(readFileSync(join(ROOT, 'test', 'fixtures', 'tokenizer-fixture.jsonl.gz'))).toString('utf8').trimEnd().split('\n');
    for (const line of lines.slice(0, 300)) {
      const { text, ids } = JSON.parse(line) as { text: string; ids: number[] };
      assert.deepEqual(b.encode(text), ids);
    }
    writeFileSync(cache, Buffer.from('LCTK garbage'));
    const c = loadTokenizerCached(path!, cache);
    assert.equal(c.cacheStatus, 'written');
    assert.equal(loadTokenizerCached(path!, cache).cacheStatus, 'fresh');
    // default location under the state dir, keyed by the sha
    const d = loadTokenizerCached(path!, null, { stateDir: join(dir, 'state') });
    assert.ok(existsSync(defaultTokenizerCachePath(join(dir, 'state'), d.sha256)));
    // an unwritable location only loses the cache (a regular file as the parent directory; also
    // /proc, where Node's recursive mkdirSync would never return)
    writeFileSync(join(dir, 'file'), 'x');
    assert.equal(loadTokenizerCached(path!, join(dir, 'file', 'sub', 'tok.lctk')).cacheStatus, 'unwritable');
    if (process.platform === 'linux') {
      const e = loadTokenizerCached(path!, '/proc/kitzur-no-such-dir/tok.lctk');
      assert.equal(e.cacheStatus, 'unwritable');
      assert.equal(e.count('<|im_start|>user\nhi<|im_end|>'), 5);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadTokenizerCached: a bad tokenizer file names its cause without quoting the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-load-bad-'));
  const failure = (p: string): Error => {
    try { loadTokenizerCached(p, join(dir, 'c.lctk')); } catch (e) { return e as Error; }
    assert.fail('expected a load failure');
  };
  const write = (name: string, body: string): string => { const p = join(dir, name); writeFileSync(p, body); return p; };
  try {
    assert.match(failure(join(dir, 'missing.json')).message, /^file not found/);
    assert.match(failure(dir).message, /^is a folder, not a file/);
    assert.match(failure(write('empty.json', '')).message, /^is empty/);
    const bad = failure(write('bad.json', '{"SECRET_CONTENT": oops}'));
    assert.ok(bad instanceof SyntaxError, 'keeps the error class');
    assert.match(bad.message, /^is not valid JSON \(line 1, column 20\)/);
    assert.doesNotMatch(bad.message, /SECRET_CONTENT|oops/);
    const cfg = failure(write('tokenizer_config.json', '{"SECRET_CONTENT":"x","model":{"type":"WordPiece"}}'));
    assert.equal(cfg.name, 'TokenizerUnsupportedError');
    assert.match(cfg.message, /^is valid JSON but not a supported tokenizer\.json \(model must be BPE\): .*model\.type BPE/);
    assert.doesNotMatch(cfg.message, /SECRET_CONTENT|WordPiece/);
    const norm = failure(write('norm.json', '{"model":{"type":"BPE"},"normalizer":{"SECRET_CONTENT":1}}'));
    assert.match(norm.message, /^is valid JSON but not a supported tokenizer\.json \(normalizer\): /);
    assert.doesNotMatch(norm.message, /SECRET_CONTENT/);
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const locked = write('locked.json', '{}');
      chmodSync(locked, 0o000);
      assert.match(failure(locked).message, /^cannot be read \(permission denied\)/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
