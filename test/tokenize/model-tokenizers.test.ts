import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eagerTokenizer } from '../../src/app.js';
import { loadConfig } from '../../src/config/load.js';
import { doctor } from '../../src/diagnostics/doctor.js';
import { ModelRuntimeMap } from '../../src/proxy/model-runtime.js';

function fixture(): string {
  const bytes = Array.from({ length: 256 }, (_, i) => i);
  const visible = bytes.filter(b => (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || b >= 174);
  let extra = 256;
  const vocab = Object.fromEntries(bytes.map(b => [String.fromCharCode(visible.includes(b) ? b : extra++), b]));
  return JSON.stringify({ model: { type: 'BPE', vocab, merges: [] }, pre_tokenizer: { type: 'Sequence', pretokenizers: [
    { type: 'Split', pattern: { Regex: '\\s+' }, behavior: 'Isolated', invert: false },
    { type: 'ByteLevel', use_regex: false, add_prefix_space: false },
  ] }, added_tokens: [] });
}

test('model tokenizer paths are allowed and same SHA is loaded once and shared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-model-tokenizer-'));
  try {
    const path = join(dir, 'tokenizer.json');
    writeFileSync(path, fixture());
    const loaded = loadConfig({ env: {}, object: { tokenizer: { path, cachePath: join(dir, 'root.lctk') }, models: { a: { tokenizer: { path } }, b: { tokenizer: { path } } } } });
    const shared = new Map();
    const root = eagerTokenizer(loaded.config, loaded.config, shared);
    const a = eagerTokenizer(loaded.models.a!, loaded.config, shared);
    const b = eagerTokenizer(loaded.models.b!, loaded.config, shared);
    assert.equal(root.tokenizer, a.tokenizer);
    assert.equal(a.tokenizer, b.tokenizer);
    assert.equal(a.sourceBytes, Buffer.byteLength(fixture()));
    assert.equal(a.reason, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tokenizer source larger than 64 MiB falls back before JSON parsing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-tokenizer-limit-'));
  try {
    const path = join(dir, 'large.json');
    writeFileSync(path, '');
    truncateSync(path, 64 * 1024 * 1024 + 1);
    const loaded = loadConfig({ env: {}, object: { tokenizer: { path } } });
    const result = eagerTokenizer(loaded.config, loaded.config, new Map());
    assert.equal(result.tokenizer, null);
    assert.match(result.reason ?? '', /limit is 67108864 bytes/);
    assert.equal(result.sourceBytes, 64 * 1024 * 1024 + 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('doctor reports each configured model tokenizer mode and source identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-model-doctor-'));
  try {
    const path = join(dir, 'tokenizer.json');
    writeFileSync(path, fixture());
    const loaded = loadConfig({ env: {}, object: { models: { exact: { tokenizer: { path } }, estimated: { tokenizer: { mode: 'estimate' } } } } });
    const report = await doctor(loaded.config, { models: loaded.models });
    const exact = report.checks.find(check => check.code === 'model.exact.tokenizer');
    const estimate = report.checks.find(check => check.code === 'model.estimated.tokenizer');
    assert.match(exact?.message ?? '', /counter=exact; sha256=[0-9a-f]{64}; sourceBytes=\d+; loadMs=\d+/);
    assert.match(estimate?.message ?? '', /counter=estimate; reason=tokenizer.mode is 'estimate'/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('model runtime status includes per-model counter mode and tokenizer identity', () => {
  const root = { counter: { mode: 'estimate' }, estimateReason: 'root missing' } as any;
  const exact = { counter: { mode: 'exact' }, tokenizer: { sha256: 'abc', sourceBytes: 12, loadMs: 4 } } as any;
  const runtimes = new ModelRuntimeMap(root, { exact: {} } as any, new Map([['exact', exact]]));
  assert.deepEqual(runtimes.tokenizerStatus(), {
    root: { mode: 'estimate', sha256: null, sourceBytes: 0, loadMs: 0, reason: 'root missing' },
    exact: { mode: 'exact', sha256: 'abc', sourceBytes: 12, loadMs: 4, reason: null },
  });
});
