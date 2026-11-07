import { main } from '../../src/cli.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig, parseSetArg, splitEnvSet } from '../../src/config/load.js';

const load = (sets: string[], env: Record<string, string> = {}, models?: unknown) =>
  loadConfig({ object: models === undefined ? {} : { models }, env, sets });

const issues = (f: () => unknown): string[] => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof ConfigError, String(e));
    return e.issues;
  }
  assert.fail('expected a ConfigError');
};

test('bracket IDs with dots, a slash, a quote and a semicolon set that exact model', () => {
  const l = load(
    ['models["org/qwen.v1"].budget.window=64000', 'models["say \\"hi\\""].budget.window=72000'],
    { KITZUR_SET: 'models["a;b:c"].budget.window=48000;budget.window=90000' },
  );
  assert.equal(l.models['org/qwen.v1']!.budget.window, 64000);
  assert.equal(l.models['say "hi"']!.budget.window, 72000);
  assert.equal(l.models['a;b:c']!.budget.window, 48000);
  assert.equal(l.config.budget.window, 90000);
  assert.equal(l.provenance['models["org/qwen.v1"].budget.window'], 'cli:--set');
  assert.equal(l.provenance['models["a;b:c"].budget.window'], 'env:KITZUR_SET');
  assert.deepEqual(splitEnvSet('models["x;y"].budget.window=1;logLevel=debug'), ['models["x;y"].budget.window=1', 'logLevel=debug']);
  assert.deepEqual(parseSetArg('models["k=v"].budget.window=5'), { path: 'models["k=v"].budget.window', raw: '5', source: 'cli:--set' });
});

test('a set creates an absent profile or overrides one leaf of a file profile, over the final root', () => {
  const file = { 'org/m': { budget: { window: 100000 }, client: { compactionPointTokens: 80000 } } };
  const l = load(['models["org/m"].budget.window=120000', 'models["new"].client.inputLimit=50000', 'budget.window=70000'], {}, file);
  assert.equal(l.models['org/m']!.budget.window, 120000);
  assert.equal(l.models['org/m']!.client.compactionPointTokens, 80000);
  assert.equal(l.models['new']!.client.inputLimit, 50000);
  assert.equal(l.models['new']!.budget.window, 70000);
});

test('precedence: file < KITZUR_SET < --set', () => {
  const file = { m: { budget: { window: 100000 } } };
  const env = { KITZUR_SET: 'models["m"].budget.window=110000' };
  assert.equal(load([], {}, file).models['m']!.budget.window, 100000);
  assert.equal(load([], env, file).models['m']!.budget.window, 110000);
  const l = load(['models["m"].budget.window=120000'], env, file);
  assert.equal(l.models['m']!.budget.window, 120000);
  assert.equal(l.provenance['models["m"].budget.window'], 'cli:--set');
});

test('malformed brackets, unknown, global and invalid leaves are errors that never echo the value', () => {
  const secret = 'sk-example-secret';
  const cases: Array<[string, RegExp]> = [
    [`models["unterminated].budget.window=${secret}`, /malformed model ID/],
    [`models[m].budget.window=${secret}`, /malformed model ID/],
    [`models["m"]budget.window=${secret}`, /malformed model path/],
    [`models["m"].budget.widnow=${secret}`, /unknown config key models\.m\.budget\.widnow \(did you mean budget\.window\?\)/],
    [`models["m"].upstream.headers.Authorization=${secret}`, /upstream\.headers\.Authorization is global; .*budget, client, and tokenizer/],
    [`models["m"].listen.port=${secret}`, /listen\.port is global/],
    [`models["m"].budget.window=${secret}`, /models\["m"\]\.budget\.window: invalid value \(value not shown\)/],
    [`models["m"].budget.window=-5`, /budget\.window: invalid value/],
    [`models[""].budget.window=${secret}`, /invalid model ID/],
    [`models["m"].budget.window:${secret}`, /not shown/],
  ];
  for (const [arg, re] of cases) {
    for (const msgs of [issues(() => load([arg])), issues(() => load([], { KITZUR_SET: arg.replace(/;/g, '\\;') }))]) {
      assert.equal(msgs.length, 1, arg);
      assert.match(msgs[0]!, re, arg);
      assert.ok(!msgs[0]!.includes(secret), msgs[0]);
    }
  }
});

test('configs without brackets behave as before', () => {
  const l = load(['budget.window=64000'], { KITZUR_SET: 'logLevel=debug;upstream.headers.X-Note=a\\;b' });
  assert.equal(l.config.budget.window, 64000);
  assert.equal(l.config.upstream.headers['X-Note'], 'a;b');
  assert.deepEqual(Object.keys(l.models), []);
  assert.ok(!Object.keys(l.provenance).some((k) => k.startsWith('models')));
  assert.match(issues(() => load(['budget.widnow=1']))[0]!, /unknown config key budget\.widnow/);
});

test('config show --json --model reports the provenance of bracket leaves', async () => {
  let out = '';
  const code = await main(['config', 'show', '--json', '--model', 'org/m.v1', '--set', 'models["org/m.v1"].budget.window=64000'], {
    stdout: (s) => { out += s; }, stderr: () => {}, env: { KITZUR_SET: 'models["org/m.v1"].client.inputLimit=60000' }, cwd: process.cwd(), onSignal: () => {},
  });
  assert.equal(code, 0, out);
  const prov = JSON.parse(out).provenance as Record<string, string>;
  assert.equal(prov['models["org/m.v1"].budget.window'], 'cli:--set');
  assert.equal(prov['models["org/m.v1"].client.inputLimit'], 'env:KITZUR_SET');
});
