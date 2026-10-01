import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type Config } from '../../src/config/schema.js';
import { loadConfig } from '../../src/config/load.js';
import { checkErrorRule, globToRegExp, validateConfig } from '../../src/config/validate.js';
import { DEFAULT_LEAVES, getPath, LEAF_SPECS, leafPaths } from '../../src/config/spec.js';

const cfgWith = (f: (c: Config) => void): Config => {
  const c = structuredClone(DEFAULT_CONFIG);
  f(c);
  return c;
};
const errorsOf = (c: Config): string[] => validateConfig(c).errors;
const warningsOf = (c: Config): string[] => validateConfig(c).warnings;

test('spec: LEAF_SPECS covers exactly the leaves of DEFAULT_CONFIG', () => {
  assert.deepEqual(Object.keys(LEAF_SPECS).sort(), [...DEFAULT_LEAVES].sort());
  assert.deepEqual(leafPaths(DEFAULT_CONFIG as unknown as Record<string, unknown>), [...DEFAULT_LEAVES]);
});

test('validate: the defaults and every preset are valid', () => {
  const r = validateConfig(DEFAULT_CONFIG);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => /upstream\.origin is not set/.test(w)));
  assert.ok(r.warnings.some((w) => /tokenizer\.path is not set/.test(w)));
  for (const p of ['32k', '64k', '100k', '128k']) {
    const l = loadConfig({ preset: p, env: {}, sets: ['upstream.origin=http://127.0.0.1:8000'] });
    assert.deepEqual(validateConfig(l.config, { provenance: l.provenance }).errors, [], p);
  }
});

test('validate: type and range of every leaf', () => {
  // a wrong-typed value in every leaf yields one error naming that leaf
  for (const path of DEFAULT_LEAVES) {
    const c = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
    const keys = path.split('.');
    let cur = c;
    for (const k of keys.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
    // an object is invalid for every leaf type except a headers record
    cur[keys[keys.length - 1]!] = LEAF_SPECS[path]!.t === 'headers' ? 'x' : { bogus: getPath(DEFAULT_CONFIG, path) ?? 1 };
    const errs = errorsOf(c as unknown as Config);
    assert.ok(errs.length >= 1 && errs[0]!.startsWith(path), `${path}: ${JSON.stringify(errs)}`);
  }
  assert.match(errorsOf(cfgWith((c) => (c.listen.port = 70_000)))[0]!, /listen\.port: expected an integer in \[0, 65535\]/);
  assert.match(errorsOf(cfgWith((c) => (c.budget.window = 32_000.5)))[0]!, /budget\.window/);
  assert.match(errorsOf(cfgWith((c) => (c.compaction.keepRecent = 0)))[0]!, /compaction\.keepRecent/);
  assert.match(errorsOf(cfgWith((c) => ((c.digestHook as { enabled: boolean }).enabled = true)))[0]!, /not implemented in v1/);
  assert.match(errorsOf(cfgWith((c) => (c.upstream.origin = 'http://gw:8000/v1')))[0]!, /origin only.*client's baseURL/);
  assert.match(errorsOf(cfgWith((c) => (c.upstream.origin = 'ftp://gw')))[0]!, /scheme must be http or https/);
  assert.deepEqual(errorsOf(cfgWith((c) => (c.upstream.origin = 'https://gw.example:8443/'))), []);
  assert.match(errorsOf(cfgWith((c) => (c.upstream.headers = { 'bad name': 'x' })))[0]!, /invalid header name/);
  assert.match(errorsOf(cfgWith((c) => (c.tokenizer.endpoint.path = 'tokenize')))[0]!, /tokenizer\.endpoint\.path/);
  assert.match(errorsOf(cfgWith((c) => (c.rules.toolNames.read = ['read', ' '])))[0]!, /empty string/);
});

test('validate: regexes (cues, label pattern, test commands, error rules, exclusions)', () => {
  assert.match(errorsOf(cfgWith((c) => (c.ledger.correctionCues = '(unclosed')))[0]!, /ledger\.correctionCues: invalid regex/);
  assert.match(errorsOf(cfgWith((c) => (c.rules.test.commands = '[a-')))[0]!, /rules\.test\.commands: invalid regex/);
  const rule = { id: 'r1', server: 'x', match: 'limit is (?<window>\\d+)', kind: 'overflow_prompt' as const, status: [400, null], on: 'message' as const };
  assert.deepEqual(checkErrorRule(rule, 'r'), []);
  assert.match(checkErrorRule({ ...rule, match: '(?<win>\\d+)' }, 'r')[0]!, /unknown named group 'win'/);
  assert.match(checkErrorRule({ ...rule, kind: 'context_overflow' }, 'r')[0]!, /r\.kind/);
  assert.match(checkErrorRule({ ...rule, where: 'sse' }, 'r')[0]!, /unknown key 'where'/);
  assert.match(checkErrorRule({ ...rule, status: [200, 'x'] }, 'r')[0]!, /r\.status/);
  assert.match(checkErrorRule({ ...rule, match: '(' }, 'r')[0]!, /invalid regex/);
  assert.match(checkErrorRule({ ...rule, flags: 'q' }, 'r')[0]!, /flags/);
  const dup = cfgWith((c) => (c.errors.custom = [rule, rule]));
  assert.match(errorsOf(dup)[0]!, /duplicate id 'r1'/);
  assert.match(errorsOf(cfgWith((c) => (c.errors.exclusions = [{ id: 'x', match: '(' }])))[0]!, /exclusions\[0\]\.match: invalid regex/);
  assert.deepEqual(errorsOf(cfgWith((c) => (c.errors.exclusions = [{ id: 'rl', match: 'rate limit', flags: 'i' }]))), []);
});

test('validate:  fraction and trigger/target rules', () => {
  assert.match(errorsOf(cfgWith((c) => (c.compaction.triggerFraction = 1.01)))[0]!, /triggerFraction/);
  assert.match(errorsOf(cfgWith((c) => (c.compaction.targetFraction = 1)))[0]!, /targetFraction/);
  assert.match(errorsOf(cfgWith((c) => (c.compaction.targetFraction = 0)))[0]!, /targetFraction/);
  const tt = cfgWith((c) => {
    c.compaction.triggerTokens = 40_000;
    c.compaction.targetTokens = 40_000;
  });
  assert.match(errorsOf(tt)[0]!, /targetTokens \(40000\) must be below compaction\.triggerTokens \(40000\)/);
  const clampWarn = warningsOf(cfgWith((c) => (c.compaction.triggerTokens = 66_000)));
  assert.ok(clampWarn.some((w) => /triggerTokens 66000 is above hard 61000; it is clamped/.test(w)));
});

test('validate:  budget-mode conflict is an error', () => {
  const c = cfgWith((x) => {
    x.server.budgetMode = 'strict_total';
    x.budget.limitCountsMaxTokens = false;
  });
  assert.match(errorsOf(c).join('\n'), /server\.budgetMode 'strict_total' counts max_tokens, but budget\.limitCountsMaxTokens is false/);
  assert.deepEqual(errorsOf(cfgWith((x) => (x.budget.limitCountsMaxTokens = false))), []);
});

test('validate: an unusable budget is an error with a preset hint', () => {
  const l = loadConfig({ env: { KITZUR_WINDOW: '32000' } });
  const r = validateConfig(l.config, { provenance: l.provenance });
  assert.match(r.errors[0]!, /no room for the prompt: budget = window 32000 − T_plan 32000 − margin 512 = -512.*--preset 32k/);
  const hardErr = errorsOf(cfgWith((c) => (c.client.outputAllowanceTokens = 68_000)));
  assert.match(hardErr[0]!, /no room below the client's compaction point/);
});

test('validate: startup warnings ( clamp,  T_plan,  snapshot, preset mismatch)', () => {
  const clamp = warningsOf(cfgWith((c) => (c.budget.maxTokensClamp.enabled = true)));
  assert.ok(clamp.some((w) => /^clamp enabled but unreachable: range \(61000, 61000\) is empty/.test(w)), clamp.join('\n'));
  const reachable = warningsOf(cfgWith((c) => {
    c.budget.maxTokensClamp.enabled = true;
    c.client.compactionPointTokens = 100_000;
  }));
  assert.ok(!reachable.some((w) => /clamp enabled/.test(w)));
  const tplan = warningsOf(cfgWith((c) => {
    c.budget.planMaxTokens = 16_000;
    c.client.outputLimit = 32_000;
  }));
  assert.ok(tplan.some((w) => /T_plan 16000 .* is below the client's output limit 32000/.test(w)));
  const l32 = loadConfig({ preset: '32k', env: {}, sets: ['budget.observedFixedPromptTokens=9376'] });
  const snap = validateConfig(l32.config, { provenance: l32.provenance }).warnings;
  assert.ok(snap.some((w) => /at most one snapshot fits per compaction epoch: trigger 20000 − \(head 9376 \+ summary 939\) = 9685 < snapshot 17655 \(estimated/.test(w)), snap.join('\n'));
  const l100 = loadConfig({ preset: '100k', env: {}, sets: ['budget.observedFixedPromptTokens=9376', 'rules.snapshot.p90Tokens=17438'] });
  assert.ok(!validateConfig(l100.config, { provenance: l100.provenance }).warnings.some((w) => /one snapshot/.test(w)));
  // a later layer overriding the preset's window
  const over = loadConfig({ preset: '64k', env: { KITZUR_WINDOW: '65536' } });
  const ow = validateConfig(over.config, { provenance: over.provenance }).warnings;
  assert.ok(ow.some((w) => /preset 64k sets budget\.window=64000 but the effective value is 65536 \(env:KITZUR_WINDOW\)/.test(w)), ow.join('\n'));
  // a preset window with the built-in (100k) defaultMaxTokens
  const alone = loadConfig({ env: { KITZUR_WINDOW: '64000' } });
  const aw = validateConfig(alone.config, { provenance: alone.provenance }).warnings;
  assert.ok(aw.some((w) => /budget\.window=64000 \(env:KITZUR_WINDOW\) with the built-in budget\.defaultMaxTokens 32000; preset 64k uses 16000/.test(w)), aw.join('\n'));
});

test('validate: messages carry the value source', () => {
  const l = loadConfig({ env: {}, sets: ['compaction.userMaxChars=3'] });
  assert.match(validateConfig(l.config, { provenance: l.provenance }).errors[0]!, /compaction\.userMaxChars: .* \(cli:--set\)$/);
});

test('validate: checkFiles', () => {
  const c = cfgWith((x) => (x.tokenizer.path = '/nonexistent/tokenizer.json'));
  assert.deepEqual(validateConfig(c).errors, []);
  const r = validateConfig(c, { checkFiles: true });
  assert.deepEqual(r.errors, [], 'a missing tokenizer falls back to the estimate');
  assert.ok(r.warnings.some((w) => /tokenizer\.path: file not found: .*falls back to the estimate/.test(w)));
  const ca = cfgWith((x) => (x.upstream.caFile = '/nonexistent/ca.pem'));
  assert.match(validateConfig(ca, { checkFiles: true }).errors[0]!, /upstream\.caFile: file not found/);
});

test('globToRegExp: * is the only wildcard', () => {
  assert.ok(globToRegExp('*browser_*').test('playwright_browser_snapshot'));
  assert.ok(!globToRegExp('read').test('read_file'));
  assert.ok(globToRegExp('*read_file').test('read_file'));
  assert.ok(!globToRegExp('a.b').test('axb'));
  assert.ok(globToRegExp('a(b)?').test('a(b)?'));
});
