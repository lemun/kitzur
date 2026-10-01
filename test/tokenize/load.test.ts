import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
    const e = loadTokenizerCached(path!, '/proc/kitzur-no-such-dir/tok.lctk');
    assert.equal(e.cacheStatus, 'unwritable');
    assert.equal(e.count('<|im_start|>user\nhi<|im_end|>'), 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
