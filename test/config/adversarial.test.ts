// Adversarial regression tests for the component (loader, validation, import-eval, the import-eval CLI):
// each block pins a defect found by verification, and cross-checks the config against the modules that
// consume it (the engine's regex compiles, the proxy's ErrorClassifier), so the two cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ConfigError, loadConfig } from '../../src/config/load.js';
import { validateConfig } from '../../src/config/validate.js';
import { clampRange, computeBudget, requestMaxTokens } from '../../src/config/derived.js';
import { clampClause, requestedMaxTokens } from '../../src/engine/budget.js';
import { DEFAULT_CONFIG, type Config } from '../../src/config/schema.js';
import { getPath, LEAF_SPECS } from '../../src/config/spec.js';
import { errorText, mapEvalResults, messageRegex, readEvalInputs, sseErrorPayloads, type ImportResult } from '../../src/config/import-eval.js';
import { main, type CliIO } from '../../src/cli.js';
import { createToolRulesExt } from '../../src/engine/rules/index.js';
import { createExtractor } from '../../src/engine/ledger/extract.js';
import { supersedeRules } from '../../src/engine/ledger/supersede.js';
import { ErrorClassifier } from '../../src/proxy/errors.js';
import type { ErrorRule } from '../../src/types.js';
import { ROOT } from '../helpers.js';
import { mulberry32 } from './rng.js';

type J = Record<string, unknown>;

// ---------------------------------------------------------------- loader

test('loader: Object.prototype names are unknown keys, not leaves (file, object and --set)', () => {
  for (const k of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf']) {
    assert.equal(LEAF_SPECS[k], undefined, k);
    assert.throws(() => loadConfig({ env: {}, sets: [`${k}=1`] }), (e: unknown) => e instanceof ConfigError && /unknown config key/.test(e.message), `--set ${k}`);
    // JSON.parse makes "__proto__" an own key, like any other
    const layer = JSON.parse(`{"${k}": {"shadow": true}}`) as J;
    assert.throws(() => loadConfig({ env: {}, object: layer }), (e: unknown) => e instanceof ConfigError && /unknown config key/.test(e.message), `file ${k}`);
  }
  assert.throws(() => loadConfig({ env: { KITZUR_SET: 'constructor=1' } }), /unknown config key constructor/);
});

test('loader and validation never echo header values (credentials)', () => {
  const secret = 'Bearer sk-SECRET-123';
  try {
    loadConfig({ env: {}, sets: [`upstream.headers={"Authorization":"${secret}"`] });
    assert.fail('expected a ConfigError');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.ok(!e.message.includes('sk-SECRET'), e.message);
  }
  const l = loadConfig({ env: {}, object: { upstream: { headers: secret } } });
  const v = validateConfig(l.config);
  assert.equal(v.errors.length, 1);
  assert.ok(!v.errors[0]!.includes('sk-SECRET'), v.errors[0]);
});

// ---------------------------------------------------------------- validation vs the consumers

/** true when the engine accepts the pattern for this leaf (it compiles it when the factory is built). */
function engineAccepts(path: string, pattern: string): boolean {
  const cfg = structuredClone(DEFAULT_CONFIG);
  const set = (c: Config): void => {
    if (path === 'rules.test.commands') c.rules.test.commands = pattern;
    else if (path === 'ledger.labelPattern') c.ledger.labelPattern = pattern;
    else if (path === 'ledger.correctionCues') c.ledger.correctionCues = pattern;
    else c.ledger.additiveCues = pattern;
  };
  set(cfg);
  try {
    const rules = createToolRulesExt(cfg);
    createExtractor(cfg, rules);
    supersedeRules(cfg.ledger);
    return true;
  } catch {
    return false;
  }
}

test('validation accepts a regex leaf exactly when the engine compiles it (u-mode is stricter than non-u)', () => {
  const corpus = [
    'make\\-check|npm\\:test', 'NOTE\\:', 'x\\-y', 'foo{bar', '\\bjest\\b', '(?<n>a)\\k<n>', '[a-', '(', '\\p{L}+', 'a{2,1}',
    '(?<![\\p{L}])x', '\\u{1F600}', '[\\w-x]', '\\cA', '\\_', '(?i:x)', 'a**', '', 'ok|also',
  ];
  let differ = 0;
  for (const path of ['rules.test.commands', 'ledger.labelPattern', 'ledger.correctionCues', 'ledger.additiveCues']) {
    for (const p of corpus) {
      const l = loadConfig({ env: {}, sets: [{ path, raw: JSON.stringify(p), source: 'cli:--set' }] });
      const valid = !validateConfig(l.config).errors.some((e) => e.startsWith(path));
      assert.equal(valid, engineAccepts(path, p), `${path} = ${JSON.stringify(p)}: validation ${valid}`);
      if (/^rules|labelPattern/.test(path) && /\\[-:_]/.test(p)) differ++;
    }
  }
  assert.ok(differ > 0, 'the corpus has patterns that only non-u mode accepts');
});

test("errors.custom / exclusions: 'g' and 'y' flags are rejected, because they make the proxy's classifier stateful", () => {
  const rule: ErrorRule = { id: 'x', server: 's', match: 'too long', flags: 'gi', kind: 'overflow_unknown', on: 'message' };
  // the failure the check prevents: one shared classifier, the same body again (on: 'message', as import-eval writes)
  const c = new ErrorClassifier({ useBuiltin: false, custom: [rule], exclusions: [] });
  const body = '{"error": {"message": "prompt too long"}}';
  const kinds = [1, 2, 3].map(() => c.classify({ status: 400, body, inStream: false }).kind);
  assert.deepEqual(kinds, ['overflow_unknown', 'unmatched', 'overflow_unknown'], 'lastIndex carries over between bodies');
  for (const flags of ['g', 'y', 'gi', 'iy']) {
    const l = loadConfig({ env: {}, object: { errors: { custom: [{ ...rule, flags }], exclusions: [{ id: 'e', match: 'quota', flags }] } } });
    const errs = validateConfig(l.config).errors;
    assert.ok(errs.some((e) => /^errors\.custom\[0\]\.flags: 'g' and 'y' are not allowed/.test(e)), `${flags}: ${errs.join('; ')}`);
    assert.ok(errs.some((e) => /^errors\.exclusions\[0\]\.flags: 'g' and 'y' are not allowed/.test(e)), `${flags}: ${errs.join('; ')}`);
  }
  for (const flags of ['', 'i', 'iu', 's', 'm', 'd']) {
    const l = loadConfig({ env: {}, object: { errors: { custom: [{ ...rule, flags }], exclusions: [{ id: 'e', match: 'quota', flags }] } } });
    assert.deepEqual(validateConfig(l.config).errors, [], flags);
  }
});

test('validation warnings: an empty allowedHosts, a budget under a quarter of the window', () => {
  let l = loadConfig({ env: {}, sets: ['listen.allowedHosts='] });
  assert.ok(validateConfig(l.config).warnings.some((w) => /allowedHosts is empty/.test(w)));
  // 32k server, the client's (OpenCode default) max_tokens 32000 as T_plan: budget 256
  l = loadConfig({ env: {}, sets: ['budget.window=32768', 'budget.defaultMaxTokens=32000', 'client.compactionPointTokens=16768', 'client.outputAllowanceTokens=2000'] });
  const v = validateConfig(l.config);
  assert.deepEqual(v.errors, []);
  assert.ok(v.warnings.some((w) => /^budget 256 is under a quarter of the window 32768/.test(w)), v.warnings.join('\n'));
  for (const p of ['32k', '64k', '100k', '128k']) {
    const pv = validateConfig(loadConfig({ env: {}, preset: p }).config);
    assert.ok(!pv.warnings.some((w) => /under a quarter/.test(w)), p);
  }
});

// ---------------------------------------------------------------- derived vs the engine

test('derived: T_req equals the engine\'s for any max_tokens / max_completion_tokens (fractions, 0, negatives, NaN)', () => {
  const vals = [undefined, null, 0, -1, 0.5, 1, 1.9, 1024, 4096.7, 32_000, Number.NaN, Number.POSITIVE_INFINITY] as const;
  for (const a of vals) {
    for (const b of vals) {
      const req = { messages: [], max_tokens: a, max_completion_tokens: b } as unknown as Parameters<typeof requestedMaxTokens>[0];
      assert.equal(requestMaxTokens(req, DEFAULT_CONFIG), requestedMaxTokens(req, DEFAULT_CONFIG), `${a} / ${b}`);
    }
  }
});

test('derived: the  "clamp unreachable" check agrees with the engine\'s clamp clause on random configs', () => {
  const rnd = mulberry32(0xc13);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  let reachable = 0;
  let checked = 0;
  for (let i = 0; i < 5000; i++) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.budget.window = pick([8000, 32_000, 64_000, 100_000, 128_000]);
    cfg.budget.defaultMaxTokens = pick([1000, 8000, 16_000, 32_000]);
    cfg.budget.maxTokensClamp = { enabled: true, floorTokens: pick([1, 1024, 8192, 20_000]) };
    cfg.client.compactionPointTokens = rnd() < 0.5 ? null : 1 + Math.floor(rnd() * cfg.budget.window * 1.2);
    cfg.client.outputAllowanceTokens = rnd() < 0.5 ? null : Math.floor(rnd() * 10_000);
    cfg.compaction.triggerFraction = pick([1, 0.9, 0.5]);
    cfg.server.type = pick(['vllm', 'llamacpp', 'tgi'] as const);
    const learned = rnd() < 0.3 ? { window: Math.floor(cfg.budget.window * (0.5 + rnd() / 2)), maxPrompt: null, maxBodyBytes: null, tighten: Math.floor(rnd() * 3000) } : null;
    const b = computeBudget(cfg, { learned });
    if (b.budget <= 0 || b.hard <= 1) continue;
    checked++;
    const r = clampRange(cfg, b);
    // the clause is monotone in c: it can fire iff it holds just above min(trigger, budget)
    const fires = clampClause(cfg, b, Math.min(b.trigger, b.budget) + 1, false);
    assert.equal(r.reachable, fires, JSON.stringify({ i, r, mode: b.mode }));
    if (fires) reachable++;
  }
  assert.ok(checked > 1000 && reachable > 50 && reachable < checked, `${reachable}/${checked}`);
});

// ---------------------------------------------------------------- import-eval

interface Bundle { sets: Record<string, Record<string, string>> }
const bundle = JSON.parse(gunzipSync(readFileSync(join(ROOT, 'test', 'fixtures', 'gateway-probes', 'fixtures.json.gz'))).toString('utf8')) as Bundle;
function withTmp<T>(f: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-adv-'));
  try {
    return f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function extract(set: string, dir: string): string {
  const d = join(dir, set);
  mkdirSync(d, { recursive: true });
  for (const [f, txt] of Object.entries(bundle.sets[set]!)) writeFileSync(join(d, f), txt);
  return d;
}
const mock = withTmp((dir) => readEvalInputs([extract('mock-vllm', dir)]));
const results = (): Record<string, J> => structuredClone(mock.results);
const capErrors = (R: Record<string, J>, errors: J[]): void => void ((R['summarize_capture'] as J)['errors'] = errors);
const customOf = (res: ImportResult): ErrorRule[] => (getPath(res.config, 'errors.custom') ?? []) as ErrorRule[];
const effOf = (res: ImportResult): Config => loadConfig({ env: {}, object: res.config }).config;

/** Classifies a body with the generated rules only (the proxy's classifier). */
const classifyWith = (rules: ErrorRule[], status: number, body: string, inStream = false): string =>
  new ErrorClassifier({ useBuiltin: false, custom: rules, exclusions: [] }).classify({ status, body, inStream }).kind;

test('import-eval: auth and rate-limit errors never become overflow rules (401 "invalid token", 429 "tokens per minute")', () => {
  const R = results();
  capErrors(R, [
    { status: 401, body: '{"error": {"message": "Invalid or expired API token", "type": "auth_error"}}' },
    { status: 403, body: '{"error": {"message": "token lacks the model scope"}}' },
    { status: 429, body: '{"error": {"message": "Rate limit reached on tokens per min"}}' },
    { status: 400, body: '{"error": {"message": "Prompt of 99000 tokens exceeds limit"}}' },
  ]);
  const res = mapEvalResults(R);
  assert.deepEqual(customOf(res).map((r) => [r.status, r.match]), [[[400], 'Prompt of \\d+ tokens exceeds limit']]);
  // a probe case rejected for credentials: a warning, no rule
  const R2 = results();
  const A = ((R2['probe_gateway']!['tests'] as J)['overflow'] as J)['prompt_alone_over_window'] as J;
  A['rejection'] = { status: 401, body: '{"error": {"message": "Unauthorized"}}' };
  const r2 = mapEvalResults(R2);
  assert.ok(r2.warnings.some((w) => /prompt_alone_over_window was rejected with HTTP 401/.test(w)), r2.warnings.join('\n'));
  assert.ok(!customOf(r2).some((r) => r.status?.includes(401)));
});

test('import-eval: a captured in-stream error yields a rule from its error event only (never from content deltas)', () => {
  const content = 'SECRET-PLAN: migrate the billing DB on Friday';
  const tail = (err: string): string =>
    `lta": {"content": "x"}}]}\n\ndata: {"id": "chatcmpl-9", "choices": [{"delta": {"content": "${content}"}}]}\n\n` +
    `data: {"id": "chatcmpl-9", "choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 3}}\n\n${err}data: [DONE]\n\n`;
  const ev = '{"error": {"message": "Context of 101234 tokens is over the 100000 limit", "code": 400}}';
  assert.deepEqual(sseErrorPayloads(tail(`data: ${ev}\n\n`)), [ev]);
  // an overflow event: one in-stream rule, classified by the proxy on that event
  let R = results();
  capErrors(R, [{ status: 200, body: tail(`data: ${ev}\n\n`), opencode_kilo_would_detect_overflow: true }]);
  let res = mapEvalResults(R);
  const rules = customOf(res);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0]!.status, [null]);
  assert.equal(rules[0]!.match, 'Context of \\d+ tokens is over the (?<window>\\d+) limit');
  assert.ok(!JSON.stringify(res).includes('SECRET-PLAN'), 'no model output in the config or the provenance');
  assert.equal(classifyWith(rules, 400, ev, true), 'overflow_prompt');
  assert.equal(classifyWith(rules, 400, ev, false), 'unmatched', 'in-stream only');
  // a non-overflow in-stream error (the usage chunk says "tokens"): no rule
  R = results();
  capErrors(R, [{ status: 200, body: tail('data: {"error": {"message": "worker died", "code": 500}}\n\n') }]);
  res = mapEvalResults(R);
  assert.deepEqual(customOf(res), []);
  // the error event fell outside the captured tail: skipped with a warning
  R = results();
  capErrors(R, [{ status: 200, body: tail('') }]);
  res = mapEvalResults(R);
  assert.deepEqual(customOf(res), []);
  assert.ok(res.warnings.some((w) => /in-stream error whose error event is not in the captured tail/.test(w)));
});

test('import-eval: a JSON body the pack truncated still gives a rule that matches the full body at runtime', () => {
  const full = JSON.stringify({ error: { message: 'Your request is too long for this deployment: 108000 tokens', detail: 'y'.repeat(5000) } });
  const cut = full.slice(0, 3000);
  assert.deepEqual(errorText(cut), { text: 'Your request is too long for this deployment: 108000 tokens', on: 'message' });
  const R = results();
  const ov = (R['probe_gateway']!['tests'] as J)['overflow'] as J;
  (ov['prompt_alone_over_window'] as J)['rejection'] = { status: 400, body: cut, body_truncated: true };
  let rules = customOf(mapEvalResults(R));
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!.on, 'message');
  assert.equal(classifyWith(rules, 400, full), 'overflow_unknown');
  // no complete "message" string in the kept part: the rule runs on the raw body, whose start it matches
  const full2 = JSON.stringify({ error: { detail: 'z'.repeat(400), message: 'late message 108000' } });
  const cut2 = full2.slice(0, 350);
  assert.equal(errorText(cut2).on, 'body');
  (ov['prompt_alone_over_window'] as J)['rejection'] = { status: 400, body: cut2, body_truncated: true };
  rules = customOf(mapEvalResults(R));
  assert.equal(rules[0]!.on, 'body');
  assert.notEqual(classifyWith(rules, 400, full2), 'unmatched');
  // plain text stays a message rule (the proxy's message of a non-JSON body is the body)
  assert.deepEqual(errorText('upstream said: context too big'), { text: 'upstream said: context too big', on: 'message' });
});

test('import-eval: an unusable result is a conflict (32k server + max_tokens 32000; windows from echoed input)', () => {
  // OpenCode without limit.output sends 32000 to a 32k model ( (b)): T_plan 32000 leaves a 256-token budget
  const R = JSON.parse(JSON.stringify(results()).replace(/100000/g, '32768')) as Record<string, J>;
  const res = mapEvalResults(R, { capture: mock.capture });
  assert.equal(res.provenance['budget.window']?.value, 32768);
  assert.equal(computeBudget(effOf(res)).budget, 256);
  assert.equal(res.exitCode, 11);
  assert.ok(res.conflicts.some((c) => /leave a prompt budget of only 256: set budget.planMaxTokens/.test(c)), res.conflicts.join('\n'));
  // with a planMaxTokens set by hand the same measurements are fine
  const fixed = effOf(res);
  fixed.budget.planMaxTokens = 8000;
  assert.deepEqual(validateConfig(fixed).errors, []);
});

test('import-eval: values the spec would reject are never written (compaction point 0, huge latency, tiny snapshots)', () => {
  const R = results();
  const first = (((R['collect_config'] as J)['files'] as J[])[0]!['config']) as J;
  const models = ((first['provider'] as J)['gw'] as J)['models'] as J;
  (models['local-model'] as J)['limit'] = { context: 16000 }; // below the client's max output: usable() = 0
  (R['summarize_capture'] as J)['latency_secs'] = { n: 3, min: 1, p50: 2, p90: 3, max: 40_000 };
  (R['summarize_capture'] as J)['tool_result_chars_by_tool'] = { browser_snapshot: { n: 1, min: 1, p50: 1, p90: 1, max: 1 } };
  const res = mapEvalResults(R, { capture: mock.capture });
  assert.equal(getPath(res.config, 'client.compactionPointTokens'), undefined);
  assert.equal(res.provenance['client.compactionPointTokens']?.confidence, 'inconclusive');
  assert.ok(res.warnings.some((w) => /the client compacts after every step/.test(w)));
  assert.equal(getPath(res.config, 'upstream.timeoutMs'), 24 * 3600 * 1000);
  assert.equal(getPath(res.config, 'rules.snapshot.p90Tokens'), 1);
  assert.deepEqual(validateConfig(effOf(res)).errors.filter((e) => !/^no room/.test(e)), []);
});

test('property: random gateway-probes results -> deterministic; loads; validates unless exit 11; rules compile in the proxy', () => {
  const rnd = mulberry32(0x1eac7);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const bodies = [
    '{"error": {"message": "Request of 108000 tokens exceeds the 100000 context", "code": 400}}',
    '{"object": "error", "message": "This model\'s maximum context length is 100000 tokens. However, you requested 108947 tokens (107947 in the messages, 1000 in the completion). Please reduce the length of the messages or completion.", "code": 400}',
    '{"error": {"type": "upstream_error", "message": "Upstream model server returned an error"}}',
    '<html><body>502 Bad Gateway (nginx/1.25.3)</body></html>',
    '{"detail": "input is (too) long [see https://x.y/z] ^$ .* 12 <url>"}',
    '{"error": {"message": "Invalid API token"}}',
    JSON.stringify({ error: { message: 'm '.repeat(2000) } }).slice(0, 3000),
  ];
  let n11 = 0;
  for (let i = 0; i < 300; i++) {
    const R = results();
    const t = R['probe_gateway']!['tests'] as J;
    const ov = t['overflow'] as J;
    const cap = R['summarize_capture'] as J;
    if (rnd() < 0.5) t['models'] = { status: 200, ids: [(R['probe_gateway']!['config'] as J)['model']], max_model_len: [pick([8192, 32768, 65536, 100000, 131072])], owned_by: ['vllm'], error: null };
    for (const name of Object.keys(ov)) {
      const row = ov[name];
      if (typeof row !== 'object' || row === null) continue;
      const r = rnd();
      if (r < 0.25) delete ov[name];
      else if (r < 0.6) ov[name] = { ...(row as J), accepted: false, rejection: { status: pick([400, 401, 413, 422, 429, 500, 502]), body: pick(bodies) } };
      else if (r < 0.75) ov[name] = { ...(row as J), accepted: false, http_status: 200, in_stream_errors: [pick(bodies)] };
    }
    cap['max_tokens_values'] = rnd() < 0.3 ? { None: 3 } : { [String(pick([1024, 8000, 16000, 32000, 64000]))]: 5 };
    cap['latency_secs'] = rnd() < 0.2 ? null : { n: 2, min: 0.1, p50: 1, p90: 2, max: pick([0.5, 30, 900, 50_000]) };
    cap['errors'] = [0, 1, 2].slice(0, Math.floor(rnd() * 3)).map(() => ({ status: pick([200, 400, 401, 500, 503]), body: pick(bodies) }));
    cap['reported_completion_tokens'] = rnd() < 0.2 ? null : { n: 9, min: 1, p50: 50, p90: 500, max: pick([10, 3000, 40_000]) };
    const files = (R['collect_config'] as J)['files'] as J[];
    const cc = files[0]!['config'] as J;
    const lim = ((((cc['provider'] as J)['gw'] as J)['models'] as J)['local-model'] as J);
    lim['limit'] = pick([null, { context: pick([16000, 32768, 100000]) }, { context: 100000, output: pick([4000, 32000]) }, { context: 100000, input: 90000 }]);
    cc['compaction'] = pick([null, { auto: false }, { auto: true, threshold_percent: pick([0, 50, 95]) }, { reserved: 50_000 }]);

    const res = mapEvalResults(R, { capture: rnd() < 0.5 ? mock.capture : null });
    assert.deepEqual(mapEvalResults(structuredClone(R), { capture: res.provenance['client.outputAllowanceTokens']?.source.startsWith('capture.jsonl') ? mock.capture : null }).config, res.config, `${i}: deterministic`);
    assert.ok([0, 10, 11].includes(res.exitCode));
    for (const k of ['compaction.triggerTokens', 'compaction.targetTokens', 'server.budgetMode']) assert.equal(getPath(res.config, k), undefined, `${i}: ${k}`);
    const eff = effOf(res); // throws on an unknown key
    const rules = customOf(res);
    assert.doesNotThrow(() => new ErrorClassifier({ useBuiltin: true, custom: rules, exclusions: [] }), `${i}: rules compile`);
    assert.ok(!rules.some((r) => r.status?.some((s) => s === 401 || s === 429)), `${i}: no auth/rate-limit rules`);
    if (res.exitCode === 11) n11++;
    else assert.deepEqual(validateConfig(eff).errors, [], `${i}: exit ${res.exitCode} but the config does not validate`);
  }
  assert.ok(n11 > 0 && n11 < 300, `both outcomes exercised (${n11} conflicts)`);
});

// ---------------------------------------------------------------- import-eval CLI

test('config import-eval: a merged config that does not validate exits 11, never 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-adv-cli-'));
  try {
    const res = extract('mock-vllm', dir);
    const cfg = join(dir, 'kitzur.jsonc');
    // a hand-set T_plan that leaves no room at the imported window: kept by the merge, so the result is unusable
    writeFileSync(cfg, '{ "budget": { "planMaxTokens": 99500 } }\n');
    const out: string[] = [];
    const io: CliIO = { stdout: (s) => void out.push(s), stderr: () => undefined, env: {}, cwd: dir, onSignal: () => undefined };
    const code = await main(['config', 'import-eval', res, '--merge', cfg], io);
    assert.equal(code, 11, out.join(''));
    assert.match(out.join(''), /the written config does not validate: no room for the prompt/);
    assert.match(out.join(''), /exit code 11/);
    // the same import into a fresh file is fine (exit 0)
    const code0 = await main(['config', 'import-eval', res, '--out', join(dir, 'fresh.json')], { ...io, stdout: () => undefined });
    assert.equal(code0, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- adversary round 2

test('import-eval: generated error rules never backtrack catastrophically on hostile bodies (ReDoS) (regression)', () => {
  const hostile: Array<[string, string]> = [
    // adjacent masks used to give \S+\S+…\S+ (12 of them: ~10 s on 28 characters)
    ['<host>'.repeat(12) + ' context length exceeded', 'a'.repeat(20_000)],
    // digit runs between masks: \d+\S+\d+\S+…
    ['1<ip>'.repeat(10) + ' too long', '1'.repeat(20_000)],
    // a body listing backends: \S+,\S+,…,\S+
    ['<host>,'.repeat(15) + '<host> overflow', 'a,'.repeat(10_000)],
    ['<url>.<url>.<url>.<url>.<url>.<url>.<url>.<url> is over the limit', 'x.'.repeat(10_000)],
  ];
  for (const [msg, body] of hostile) {
    const src = messageRegex(msg, { window: 32768 });
    const re = new RegExp(src, 'i');
    const t0 = process.hrtime.bigint();
    assert.equal(re.test(body), false);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 2000, `${src.slice(0, 60)}…: ${ms.toFixed(0)} ms`);
  }
  // the bodies the rules come from still match, numbers keep their names where nothing masks them
  const real: Array<[string, string, number | null]> = [
    ['Request to <url>. Max context is 32768 tokens', 'Request to http://gw.example/a.b. Max context is 32768 tokens', 32768],
    ['upstream <host>:8000 rejected: 40000 > 32768', 'upstream gw.example:8000 rejected: 40000 > 32768', 32768],
    ['hosts <host>,<host> overloaded', 'hosts a.example,b.example overloaded', null],
    ['a.b (x) 12 <url> 32768', 'a.b (x) 12 https://x/y 32768', 32768],
  ];
  for (const [msg, body, w] of real) {
    const m = new RegExp(messageRegex(msg, { window: 32768 }), 'iu').exec(body);
    assert.ok(m, `${msg} -> ${messageRegex(msg, { window: 32768 })}`);
    assert.equal(m.groups?.['window'] !== undefined ? Number(m.groups['window']) : null, w);
  }
});

test('config and request files: JSON syntax errors never quote the text (a mistyped header value, a captured prompt) (regression)', () =>
  withTmpDir(async (dir) => {
    // V8 quotes up to 21 characters around an unexpected token: `..."rization":Bearer SK-"... is not valid JSON`
    const cfgFile = join(dir, 'c.jsonc');
    writeFileSync(cfgFile, '{"upstream":{"headers":{"Authorization":Bearer SK-LIVE-789}}}');
    try {
      loadConfig({ configPath: cfgFile, env: {} });
      assert.fail('expected a ConfigError');
    } catch (e) {
      assert.ok(e instanceof ConfigError, String(e));
      assert.ok(!/SK-|Bearer|rization/.test(e.message), e.message);
      assert.match(e.message, /c\.jsonc:1:41: invalid JSON/);
    }
    const reqFile = join(dir, 'r.json');
    writeFileSync(reqFile, '{"messages":[{"role":"user","content":"PASSWORD-hunter2"}], "x": undefinedSECRET}');
    const short = join(dir, 's.json');
    writeFileSync(short, 'SECRET');
    const jsonl = join(dir, 'r.jsonl');
    writeFileSync(jsonl, '{"messages":[]}\n{"messages": [x SECRET-LINE]}\n');
    for (const cmd of [['count', reqFile], ['replay', reqFile], ['count', short], ['replay', jsonl]]) {
      const r = await runCli(cmd);
      assert.equal(r.code, 2, r.err);
      assert.ok(!/hunter2|SECRET|PASSWORD|undefined/.test(r.out + r.err), r.err);
      assert.match(r.err, /not JSON \(unexpected character at line \d+ column \d+\)/);
    }
  }));

test('credentials: --set typos and origins with user:password@ are never echoed (regression)', async () => {
  try {
    loadConfig({ env: {}, sets: ['upstream.headers.Authorization:Bearer SK-TYPO'] });
    assert.fail('expected a ConfigError');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.ok(!e.message.includes('SK-TYPO'), e.message);
  }
  // a header value cut at an unescaped ';' in KITZUR_SET: the tail is not an assignment and is never echoed
  try {
    loadConfig({ env: { KITZUR_SET: 'upstream.headers.Authorization=Bearer sk-abc;SECRETTAIL-123' } });
    assert.fail('expected a ConfigError');
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.ok(!/SECRETTAIL|sk-abc/.test(e.message), e.message);
    assert.match(e.message, /assignment 2 has no path=value form/);
  }
  assert.equal(loadConfig({ env: { KITZUR_SET: 'upstream.headers.Authorization=Bearer sk-abc\\;tail' } }).config.upstream.headers['Authorization'], 'Bearer sk-abc;tail');
  const origin = 'https://user:PASSW0RD@gw.example';
  const v = validateConfig(loadConfig({ env: {}, object: { upstream: { origin } } }).config);
  assert.equal(v.errors.length, 1);
  assert.match(v.errors[0]!, /credentials in the URL/);
  assert.ok(!v.errors[0]!.includes('PASSW0RD'));
  for (const args of [['config', 'show', '--upstream', origin], ['config', 'show', '--json', '--upstream', origin], ['config', 'validate', '--upstream', origin]]) {
    const r = await runCli(args);
    assert.equal(r.code, 2);
    assert.ok(!(r.out + r.err).includes('PASSW0RD'), args.join(' '));
  }
});

async function withTmpDir<T>(f: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-adv2-'));
  try {
    return await f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), env: {}, cwd: process.cwd(), onSignal: () => undefined };
  const code = await main(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}
