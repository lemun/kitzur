import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/schema.js';
import { ConfigError, loadConfig, parseRawValue, parseSetArg, splitEnvSet } from '../../src/config/load.js';
import { parseJsonc, stripJsonc } from '../../src/config/jsonc.js';
import { listPresets } from '../../src/config/presets.js';
import { DEFAULT_LEAVES, LEAF_SPECS } from '../../src/config/spec.js';

function tmp(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-cfg-'));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('loadConfig: defaults only, provenance "default" for every leaf', () => {
  const r = loadConfig({ env: {} });
  assert.deepEqual(r.config, DEFAULT_CONFIG);
  assert.notEqual(r.config, DEFAULT_CONFIG, 'a copy, never the shared default object');
  assert.deepEqual(Object.keys(r.provenance).sort(), [...DEFAULT_LEAVES].sort());
  assert.ok(Object.values(r.provenance).every((s) => s === 'default'));
  assert.equal(r.preset, null);
  assert.deepEqual(r.layers, ['default']);
});

test('loadConfig: precedence default < preset < file < env < CLI, with provenance per leaf', () => {
  const t = tmp();
  try {
    const file = join(t.dir, 'kitzur.jsonc');
    writeFileSync(file, `// comment
{
  /* the file names a preset; --preset overrides it */
  "preset": "64k",
  "budget": { "window": 50000, "safetyMarginTokens": 600, },
  "listen": { "port": 9000 },
  "server": { "type": "vllm" },
  "tokenizer": { "path": "tok/tokenizer.json" },
}
`);
    const env = { KITZUR_PORT: '9100', KITZUR_SERVER_TYPE: 'sglang', KITZUR_SET: 'budget.safetyMarginTokens=700;logLevel=debug' };
    const r = loadConfig({ configPath: file, preset: '32k', env, sets: ['listen.port=0', 'server.type=tgi'], cwd: t.dir });
    const c = r.config;
    assert.equal(r.preset, '32k');
    assert.equal(c.budget.defaultMaxTokens, 8000);
    assert.equal(r.provenance['budget.defaultMaxTokens'], 'preset:32k');
    assert.equal(c.budget.window, 50_000);
    assert.equal(r.provenance['budget.window'], `file:${file}`);
    assert.equal(c.budget.safetyMarginTokens, 700);
    assert.equal(r.provenance['budget.safetyMarginTokens'], 'env:KITZUR_SET');
    assert.equal(c.logLevel, 'debug');
    assert.equal(c.listen.port, 0);
    assert.equal(r.provenance['listen.port'], 'cli:--set');
    assert.equal(c.server.type, 'tgi');
    assert.equal(c.tokenizer.path, join(t.dir, 'tok', 'tokenizer.json'), 'file paths are relative to the file');
    assert.equal(r.provenance['compaction.targetFraction'], 'default');
    assert.deepEqual(r.layers, ['default', 'preset:32k', `file:${file}`, 'env:KITZUR_PORT', 'env:KITZUR_SERVER_TYPE', 'env:KITZUR_SET', 'cli:--set']);
    // without --preset the file's preset applies; KITZUR_PRESET beats the file
    assert.equal(loadConfig({ configPath: file, env: {} }).config.budget.defaultMaxTokens, 16_000);
    assert.equal(loadConfig({ configPath: file, env: { KITZUR_PRESET: '128k' } }).preset, '128k');
    // KITZUR_CONFIG
    assert.equal(loadConfig({ env: { KITZUR_CONFIG: file } }).config.listen.port, 9000);
  } finally {
    t.done();
  }
});

test('loadConfig: arrays replace, objects merge, headers merge key by key', () => {
  const t = tmp();
  try {
    const file = join(t.dir, 'c.json');
    writeFileSync(file, JSON.stringify({
      rules: { toolNames: { snapshot: ['pw_browser_snapshot'] } },
      upstream: { headers: { 'X-A': '1' } },
      errors: { custom: [{ id: 'x', server: 's', match: 'boom', kind: 'overflow_unknown' }] },
    }));
    const r = loadConfig({ configPath: file, env: {}, sets: ['upstream.headers.X-B=2', 'ledger.stopWords=foo,bar'] });
    assert.deepEqual(r.config.rules.toolNames.snapshot, ['pw_browser_snapshot']);
    assert.deepEqual(r.config.rules.toolNames.read, DEFAULT_CONFIG.rules.toolNames.read, 'siblings kept');
    assert.deepEqual(r.config.upstream.headers, { 'X-A': '1', 'X-B': '2' });
    assert.equal(r.provenance['upstream.headers'], 'cli:--set');
    assert.equal(r.config.errors.custom.length, 1);
    assert.deepEqual(r.config.ledger.stopWords, ['foo', 'bar']);
  } finally {
    t.done();
  }
});

test('loadConfig: unknown keys, bad values and missing files are ConfigErrors with hints', () => {
  const t = tmp();
  try {
    const file = join(t.dir, 'c.json');
    writeFileSync(file, JSON.stringify({ budget: { windw: 1 }, upstream: { basePath: '/v1' }, compaction: 5, $comment: 'ignored' }));
    const e = assert.throws(() => loadConfig({ configPath: file, env: {} }), ConfigError) as unknown;
    void e;
    try {
      loadConfig({ configPath: file, env: {} });
    } catch (err) {
      const issues = (err as ConfigError).issues;
      assert.equal(issues.length, 3);
      assert.match(issues[0]!, /unknown config key budget\.windw \(did you mean budget\.window\?\)/);
      assert.match(issues[1]!, /unknown config key upstream\.basePath/);
      assert.match(issues[2]!, /compaction must be an object/);
    }
    assert.throws(() => loadConfig({ env: {}, sets: ['budget.window'] }), /expected path=value/);
    assert.throws(() => loadConfig({ env: {}, sets: ['budget.window=big'] }), /budget\.window: expected an integer/);
    assert.throws(() => loadConfig({ env: {}, sets: ['budget=1'] }), /is a section/);
    assert.throws(() => loadConfig({ env: {}, sets: ['shadow=maybe'] }), /shadow: expected true or false/);
    assert.throws(() => loadConfig({ env: { KITZUR_WINDOW: 'x' } }), /env:KITZUR_WINDOW: budget\.window/);
    assert.throws(() => loadConfig({ configPath: join(t.dir, 'nope.json'), env: {} }), /config file not found/);
    assert.throws(() => loadConfig({ preset: '48k', env: {} }), /unknown preset '48k' \(available: 32k, 64k, 100k, 128k\)/);
    writeFileSync(file, '{ "budget": { "window": 1000 } oops }');
    assert.throws(() => loadConfig({ configPath: file, env: {} }), /c\.json:1:\d+: invalid JSON/);
  } finally {
    t.done();
  }
});

test('loadConfig: env mapping, empty values ignored, unknown KITZUR_* warned', () => {
  const env = {
    KITZUR_UPSTREAM_ORIGIN: 'http://gw:8000', KITZUR_WINDOW: '32_000', KITZUR_MAX_TOKENS: '8000', KITZUR_TOKENIZER_PATH: '~/tok.json',
    KITZUR_STATE_DIR: '/tmp/st', KITZUR_SHADOW: 'yes', KITZUR_HOST: '', KITZUR_TYPO: '1', KITZUR_TEST_FAULTS: 'x', KITZUR_BENCH_REAL_BASE: 'y',
  };
  const r = loadConfig({ env });
  assert.equal(r.config.upstream.origin, 'http://gw:8000');
  assert.equal(r.config.budget.window, 32_000);
  assert.equal(r.config.budget.defaultMaxTokens, 8000);
  assert.equal(r.config.tokenizer.path, join(homedir(), 'tok.json'));
  assert.equal(r.config.stateDir, '/tmp/st');
  assert.equal(r.config.shadow, true);
  assert.equal(r.config.listen.host, '127.0.0.1');
  assert.equal(r.provenance['budget.window'], 'env:KITZUR_WINDOW');
  assert.deepEqual(r.warnings, ['unknown environment variable KITZUR_TYPO ignored (see CONFIG.md "Environment")']);
});

test('parseRawValue / parseSetArg / splitEnvSet', () => {
  assert.equal(parseRawValue(LEAF_SPECS['budget.planMaxTokens']!, 'null'), null);
  assert.equal(parseRawValue(LEAF_SPECS['budget.planMaxTokens']!, '12_000'), 12_000);
  assert.equal(parseRawValue(LEAF_SPECS['tokenizer.path']!, 'null'), null);
  assert.equal(parseRawValue(LEAF_SPECS['listen.host']!, '"null"'), 'null');
  assert.equal(parseRawValue(LEAF_SPECS['budget.limitCountsMaxTokens']!, 'off'), false);
  assert.deepEqual(parseRawValue(LEAF_SPECS['client.boilerplateUserTexts']!, '["a, b", "c"]'), ['a, b', 'c']);
  assert.deepEqual(parseRawValue(LEAF_SPECS['rules.mcpServers']!, ''), []);
  assert.deepEqual(parseRawValue(LEAF_SPECS['errors.custom']!, '[]'), []);
  assert.throws(() => parseRawValue(LEAF_SPECS['errors.custom']!, '[oops'), /as JSON/);
  assert.deepEqual(parseSetArg('a.b=x=y'), { path: 'a.b', raw: 'x=y', source: 'cli:--set' });
  assert.deepEqual(splitEnvSet('a=1; b=2\\;3 ;;c=4'), ['a=1', 'b=2;3', 'c=4']);
});

test('jsonc: comments and trailing commas outside strings only', () => {
  const txt = '{\n "a": "http://x//y", // c\n "b": "/* no */", /* block\n */ "c": [1, 2, ], }\n';
  assert.deepEqual(parseJsonc(txt), { a: 'http://x//y', b: '/* no */', c: [1, 2] });
  assert.equal(stripJsonc('"a\\"//b"').trim(), '"a\\"//b"');
  assert.equal(stripJsonc('/*\n\n*/1').split('\n').length, 3, 'line breaks kept');
  assert.deepEqual(parseJsonc('﻿{"x": 1}'), { x: 1 });
});

test('presets: the shipped names', () => {
  assert.deepEqual(listPresets(), ['32k', '64k', '100k', '128k']);
});
