import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  extractBlocks, isCanonicalPackText, mapEvalResults, mergeImport, messageOf, messageRegex, packDigest, packPercentile, parseGenerated,
  pyRound, readEvalInputs, renderImportReport, sidecarPath, type ImportResult,
} from '../../src/config/import-eval.js';
import { loadConfig } from '../../src/config/load.js';
import { validateConfig } from '../../src/config/validate.js';
import { computeBudget } from '../../src/config/derived.js';
import { getPath } from '../../src/config/spec.js';
import { ROOT } from '../helpers.js';

type J = Record<string, unknown>;
interface Bundle {
  sets: Record<string, Record<string, string>>;
  prototype: Record<string, { config: J; provenance: Record<string, { confidence: string; source: string }>; warnings: string[] }>;
  captureP99: number;
  captureN: number;
}
const bundle = JSON.parse(gunzipSync(readFileSync(join(ROOT, 'test', 'fixtures', 'gateway-probes', 'fixtures.json.gz'))).toString('utf8')) as Bundle;

function extract(set: string, dir: string): string {
  const d = join(dir, set);
  mkdirSync(d, { recursive: true });
  for (const [f, txt] of Object.entries(bundle.sets[set]!)) writeFileSync(join(d, f), txt);
  return d;
}
function withTmp<T>(f: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-ie-'));
  try {
    return f(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const importSet = (set: string): { res: ImportResult; inputs: ReturnType<typeof readEvalInputs> } =>
  withTmp((dir) => {
    const inputs = readEvalInputs([extract(set, dir)]);
    return { res: mapEvalResults(inputs.results, { capture: inputs.capture }), inputs };
  });

// Imported error-kind mapping.
const KIND: Record<string, string[]> = {
  ambiguous_overflow: ['gateway_error'], output_overflow: ['max_tokens_too_large'], context_overflow: ['overflow_prompt', 'overflow_unknown'],
};

test('import-eval: every fixture set agrees with the reference prototype (adapted per //)', () => {
  const exits: Record<string, number> = {};
  for (const set of Object.keys(bundle.sets)) {
    const { res, inputs } = importSet(set);
    const P = bundle.prototype[set]!;
    const pc = P.config;
    const pv = (k: string) => P.provenance[k]?.confidence;
    const ours = (k: string) => res.provenance[k];
    assert.deepEqual(inputs.invalid, [], set);
    exits[set] = res.exitCode;
    // same value and confidence
    for (const k of ['budget.window', 'budget.defaultMaxTokens', 'server.type', 'stream.injectIncludeUsage', 'reasoning.serverEmits']) {
      assert.deepEqual(ours(k)?.value, getPath(pc, k), `${set} ${k}`);
      assert.equal(ours(k)?.confidence, pv(k), `${set} ${k} confidence`);
    }
    for (const k of ['calibration.usageAvailable', 'reasoning.sentBackByClient', 'compaction.summaryRole', 'rules.snapshot.p90Tokens',
      'budget.observedFixedPromptTokens', 'upstream.timeoutMs', 'client.toolOutputMaxBytes', 'rules.mcpServers', 'tokenizer.template.enableThinking']) {
      if (pv(k) === undefined || pv(k) === 'default') continue;
      assert.deepEqual(ours(k)?.value, getPath(pc, k), `${set} ${k}`);
    }
    // limitCountsMaxTokens: written when measured/derived; null (server.type decides) when inconclusive/default
    const lc = ours('budget.limitCountsMaxTokens')!;
    assert.equal(lc.confidence, pv('budget.limitCountsMaxTokens'), `${set} limitCountsMaxTokens confidence`);
    assert.equal(lc.value, lc.confidence === 'measured' || lc.confidence === 'derived' ? getPath(pc, 'budget.limitCountsMaxTokens') : null, set);
    // chars/token per class: the prototype's measured object, one leaf each
    if (pv('tokenizer.fallback.charsPerToken') === 'measured') {
      for (const [cls, v] of Object.entries(getPath(pc, 'tokenizer.fallback.charsPerToken') as J)) {
        assert.equal(getPath(res.config, `tokenizer.fallback.charsPerToken.${cls}`), v, `${set} cpt ${cls}`);
      }
    }
    // informational now ()
    assert.equal(res.info['tokenizer.calibration.tinyPromptTokens']?.value, getPath(pc, 'tokenizer.calibration.tinyPromptTokens'), set);
    if (getPath(pc, 'rules.snapshot.maxTokens') !== undefined) assert.equal(res.info['rules.snapshot.maxTokens']?.value, getPath(pc, 'rules.snapshot.maxTokens'));
    assert.equal(res.info['upstream.basePath']?.value, getPath(pc, 'upstream.basePath'));
    assert.equal(res.clientBaseUrl, `http://127.0.0.1:8270${getPath(pc, 'upstream.basePath')}`);
    // /: never written
    for (const k of ['compaction.triggerTokens', 'compaction.targetTokens', 'budget.safetyMarginTokens', 'server.budgetMode', 'upstream.basePath',
      'errors.inStreamSeen', 'tokenizer.calibration', 'rules.toolNames.browserAction', 'rules.snapshot.maxTokens']) {
      assert.equal(getPath(res.config, k), undefined, `${set} must not write ${k}`);
    }
    // client point: client-config values equal; the prototype's default equals our derived clientPoint
    const eff = loadWritten(res);
    if (pv('client.compactionPointTokens') === 'client-config') assert.equal(ours('client.compactionPointTokens')?.value, getPath(pc, 'client.compactionPointTokens'));
    else assert.equal(computeBudget(eff).clientPoint, getPath(pc, 'client.compactionPointTokens'), `${set} derived clientPoint`);
    // error entries: same count, mapped kinds, and our JS regex matches what the prototype's matched
    const pcustom = (getPath(pc, 'errors.custom') ?? []) as Array<{ kind: string; match: string; status: number[]; where: string }>;
    const ocustom = eff.errors.custom;
    assert.equal(ocustom.length, pcustom.length, `${set} custom entries`);
    pcustom.forEach((pe, i) => {
      const oe = ocustom[i]!;
      assert.ok(KIND[pe.kind]!.includes(oe.kind), `${set} kind ${pe.kind} -> ${oe.kind}`);
      assert.deepEqual(oe.status, pe.where === 'sse' ? [null] : pe.status);
      assert.equal(oe.on, 'message');
      const sample = 'Upstream model server returned an error';
      assert.equal(new RegExp(oe.match).test(sample), new RegExp(pe.match).test(sample));
    });
    // tool names: the prototype's exact names (browserAction merged into snapshot) are recorded as observed
    const ptools = (getPath(pc, 'rules.toolNames') ?? {}) as Record<string, string[]>;
    for (const [role, names] of Object.entries(ptools)) {
      if (P.provenance[`rules.toolNames.${role}`]?.confidence !== 'measured') continue;
      const target = role === 'browserAction' ? 'snapshot' : role;
      const observed = (res.info[`rules.toolNames.${target}.observed`]?.value ?? []) as string[];
      for (const n of names) assert.ok(observed.includes(n), `${set} ${role} ${n}`);
    }
    // every prototype warning is also ours (same leading text)
    for (const w of P.warnings) {
      const head = w.slice(0, 40);
      assert.ok(res.warnings.some((x) => x.startsWith(head)), `${set}: missing warning ${JSON.stringify(w)} in ${JSON.stringify(res.warnings)}`);
    }
    // the written config loads through the normal loader and validates (schema names only)
    const v = validateConfig(eff);
    assert.deepEqual(v.errors, [], `${set}: ${v.errors.join('; ')}`);
  }
  assert.deepEqual(exits, { 'mock-vllm': 0, 'only-gateway502': 10, 'only-llamacpp': 10, 'only-tgi422': 10, 'only-vllm-onlyoverflow': 10 });
});

/** Writes res.config to a file and loads it with loadConfig (as a user would). */
function loadWritten(res: ImportResult) {
  return withTmp((dir) => {
    const f = join(dir, 'imported.json');
    writeFileSync(f, JSON.stringify(res.config));
    return loadConfig({ configPath: f, env: {} }).config;
  });
}

test('import-eval: mock-vllm specifics ( allowance from the capture p99, derived budget, report)', () => {
  const { res, inputs } = importSet('mock-vllm');
  assert.equal(inputs.capture?.length, 57, 'one record per captured request (one had no usage)');
  assert.equal(bundle.captureN, 56);
  assert.equal(inputs.sources['probe_gateway'], 'probe.out#probe_gateway', 'identical file and verified block: the block is preferred');
  assert.deepEqual(inputs.warnings, []);
  // min(T_plan 32000, max(2000, p99 137)) = 2000
  assert.equal(bundle.captureP99, 137);
  assert.deepEqual(res.provenance['client.outputAllowanceTokens'], {
    value: 2000, source: 'capture.jsonl (p99)', rule: 'min(T_plan, max(2000, p99 completion_tokens)) ()', confidence: 'measured',
  });
  // without the raw capture: dist.max is the p99 upper bound
  const noCap = mapEvalResults(inputs.results);
  assert.match(noCap.provenance['client.outputAllowanceTokens']!.source, /reported_completion_tokens\/max/);
  assert.equal(res.provenance['client.outputLimit']?.value, 32_000);
  assert.equal(res.provenance['client.outputTokenMax']?.value, 16_000);
  assert.deepEqual(res.conflicts, []);
  assert.deepEqual(res.unsafe, []);
  const report = renderImportReport(res, { inputs: inputs.sources });
  assert.match(report, /client baseURL = http:\/\/127\.0\.0\.1:8270\/v1/);
  assert.match(report, /derived \(DESIGN §3\): mode strict_total, W 100000, T_plan 32000, margin 1000, budget 67000, clientPoint 84000, allowance 2000, hard 67000/);
  assert.match(report, /proposed: 46\/46 steps, 7 compactions, peak prompt 60984, sum 1734118/);
  assert.match(report, /exit code 0/);
  // deterministic: same input, same output
  assert.deepEqual(mapEvalResults(inputs.results, { capture: inputs.capture }), res);
});

// ---------------------------------------------------------------- hand-crafted variants (notes §7.7 "still to hand-craft")

function mockResults(): Record<string, J> {
  return withTmp((dir) => structuredClone(readEvalInputs([extract('mock-vllm', dir)]).results));
}
const probeTests = (R: Record<string, J>): J => (R['probe_gateway']!['tests'] as J);
const overflow = (R: Record<string, J>): J => probeTests(R)['overflow'] as J;

test('variant: in-stream SSE overflow on the streaming case (status [null] entry, errors.inStream)', () => {
  const R = mockResults();
  overflow(R)['prompt_alone_over_window_streaming'] = {
    accepted: false, http_status: 200, max_tokens: 1000, stream: true, target_prompt_tokens: 108000, usage: null,
    in_stream_errors: ['{"error": {"message": "Request of 107947 tokens is over the 100000 token context of <host>", "code": 400}}'],
    in_stream_error_gobstopper_text_match: false, in_stream_error_opencode_match: false,
  };
  const res = mapEvalResults(R);
  const custom = getPath(res.config, 'errors.custom') as J[];
  assert.equal(custom.length, 1);
  assert.deepEqual(custom[0]!['status'], [null]);
  assert.equal(custom[0]!['kind'], 'overflow_prompt');
  // a trailing mask is one character (the rule is searched unanchored: the same bodies match, without O(n²) runs)
  assert.equal(custom[0]!['match'], 'Request of \\d+ tokens is over the (?<window>\\d+) token context of \\S');
  assert.ok(new RegExp(custom[0]!['match'] as string).test('Request of 5 tokens is over the 100000 token context of gw.example'));
  assert.equal(getPath(res.config, 'errors.inStream'), true);
  assert.equal(res.info['errors.inStreamSeen']?.value, true);
  // a fingerprinted in-stream body needs no entry (built-ins match any status)
  (overflow(R)['prompt_alone_over_window_streaming'] as J)['in_stream_errors'] = ['{"error": "Input validation error: `inputs` tokens + `max_new_tokens` must be <= 100000. Given: 107947 `inputs` tokens and 1000 `max_new_tokens`"}'];
  assert.equal(getPath(mapEvalResults(R).config, 'errors.custom'), undefined);
});

test('variant: stream usage rules (stream_options rejected, always sent, only when asked)', () => {
  const R = mockResults();
  const st = probeTests(R)['stream'] as J;
  st['with_include_usage'] = { error: { status: 400, body: 'unknown field stream_options' } };
  let res = mapEvalResults(R);
  assert.deepEqual([res.provenance['stream.injectIncludeUsage']?.value, res.provenance['stream.injectIncludeUsage']?.rule], [false, 'server rejects stream_options']);
  st['with_include_usage'] = { usage_present: true };
  st['without_stream_options'] = { usage_present: true };
  res = mapEvalResults(R);
  assert.equal(res.provenance['stream.injectIncludeUsage']?.rule, 'server always sends usage');
  st['without_stream_options'] = { usage_present: false };
  (R['summarize_capture'] as J)['include_usage_fraction'] = 0.5;
  res = mapEvalResults(R);
  assert.equal(res.provenance['stream.injectIncludeUsage']?.value, true);
  assert.equal(getPath(res.config, 'stream.injectIncludeUsage'), true);
});

test('variant: reasoning emitted and sent back', () => {
  const R = mockResults();
  const basic = probeTests(R)['basic'] as J;
  basic['message'] = { content_chars: 2, keys: ['content', 'reasoning_content', 'role'], reasoning_chars: null, reasoning_content_chars: 812 };
  (R['summarize_capture'] as J)['requests_with_reasoning_sent_back'] = 12;
  const res = mapEvalResults(R);
  assert.equal(getPath(res.config, 'reasoning.serverEmits'), true);
  assert.equal(getPath(res.config, 'reasoning.field'), 'reasoning_content');
  assert.equal(getPath(res.config, 'reasoning.sentBackByClient'), true);
});

test('variant: client compaction points (Kilo threshold_percent, limit.input + reserved, auto false)', () => {
  const R = mockResults();
  const files = (R['collect_config'] as J)['files'] as J[];
  const first = files[0]!['config'] as J;
  const cc = R['collect_config'] as J;
  (cc['env'] as J) = {};
  first['compaction'] = { auto: true, threshold_percent: 60 };
  let res = mapEvalResults(R);
  assert.equal(res.provenance['client.compactionPointTokens']?.value, 60_000, 'min(usable 68000, 100000·60%)');
  assert.match(res.provenance['client.compactionPointTokens']!.rule, /Kilo threshold_percent/);
  const model = ((first['provider'] as J)['gw'] as J)['models'] as J;
  (model['local-model'] as J)['limit'] = { context: 100000, input: 90000, output: 32000 };
  first['compaction'] = { auto: true, reserved: 12000 };
  assert.equal(mapEvalResults(R).provenance['client.compactionPointTokens']?.value, 78_000, 'input − reserved');
  first['compaction'] = { auto: true };
  assert.equal(mapEvalResults(R).provenance['client.compactionPointTokens']?.value, 70_000, 'input − min(20000, maxOut)');
  first['compaction'] = { auto: false };
  res = mapEvalResults(R);
  assert.equal(res.provenance['client.compactionPointTokens']?.value, 100_000, 'auto=false: the client never compacts');
  assert.equal(computeBudget(loadWritten(res)).hard, 67_000 - 0, 'hard = budget when the client never compacts');
});

test('variant: prompt-only limit -> limitCountsMaxTokens false, planMaxTokens from the reserve ()', () => {
  const R = mockResults();
  overflow(R)['prompt_plus_max_tokens_over_window'] = {
    accepted: true, finish_reason: 'stop', gob_estimate: 98332, max_tokens: 32000, secs: 4.2, stream: false, target_prompt_tokens: 72000,
    usage: { completion_tokens: 3, prompt_tokens: 72013, total_tokens: 72016 },
  };
  const res = mapEvalResults(R);
  assert.deepEqual([res.provenance['budget.limitCountsMaxTokens']?.value, res.provenance['budget.limitCountsMaxTokens']?.confidence], [false, 'measured']);
  // min(defaultMaxTokens 32000, max(8192, ceil(1.5 · 137)))
  assert.equal(getPath(res.config, 'budget.planMaxTokens'), 8192);
  assert.equal(getPath(res.config, 'client.outputAllowanceTokens'), 2000);
  const eff = loadWritten(res);
  assert.equal(computeBudget(eff).mode, 'prompt_only', 'vllm type + limitCountsMaxTokens false');
  assert.equal(getPath(res.config, 'server.budgetMode'), undefined, 'never server.budgetMode ()');
  assert.deepEqual(validateConfig(eff).errors, []);
});

test('variant: a distinct max_tokens body for case C (vLLM wording is built in; an unknown one maps to max_tokens_too_large)', () => {
  const R = mockResults();
  const C = overflow(R)['prompt_plus_max_tokens_over_window'] as J;
  const rej = C['rejection'] as J;
  rej['body'] = JSON.stringify({ object: 'error', message: "'max_tokens' or 'max_completion_tokens' is too large: 32000. This model's maximum context length is 100000 tokens and your request has 72013 input tokens (32000 > 100000 - 72013).", code: 400 });
  let res = mapEvalResults(R);
  assert.equal(res.provenance['budget.limitCountsMaxTokens']?.confidence, 'measured');
  assert.equal(getPath(res.config, 'errors.custom'), undefined);
  rej['body'] = JSON.stringify({ error: { message: 'requested completion of 32000 tokens exceeds remaining room of 27987', type: 'invalid_request_error' } });
  rej['gobstopper_text_match'] = false;
  rej['opencode_kilo_would_detect_overflow'] = false;
  res = mapEvalResults(R);
  const custom = getPath(res.config, 'errors.custom') as J[];
  assert.equal(custom.length, 1);
  assert.equal(custom[0]!['kind'], 'max_tokens_too_large');
  assert.equal(custom[0]!['match'], 'requested completion of (?<completion>\\d+) tokens exceeds remaining room of \\d+');
  assert.equal(res.provenance['budget.limitCountsMaxTokens']?.confidence, 'inconclusive', 'unrecognized, different from A');
  assert.equal(res.exitCode, 10);
});

test('variant: prefixed MCP tool names, "None" max_tokens, a name the default globs miss', () => {
  const R = mockResults();
  const cap = R['summarize_capture'] as J;
  cap['tool_sets'] = [{ count: 5, names: ['bash', 'read', 'search_and_replace', 'playwright_browser_snapshot', 'playwright_browser_click'] }];
  cap['tool_result_chars_by_tool'] = { playwright_browser_snapshot: { max: 50000, min: 1000, n: 3, p50: 40000, p90: 49000 } };
  cap['max_tokens_values'] = { None: 30, '16000': 5, '8000': 5 };
  const res = mapEvalResults(R);
  assert.deepEqual(res.info['rules.toolNames.snapshot.observed']?.value, ['playwright_browser_click', 'playwright_browser_snapshot']);
  assert.equal(getPath(res.config, 'rules.toolNames.snapshot'), undefined, "'*browser_*' already matches them");
  assert.deepEqual(getPath(res.config, 'rules.toolNames.edit'), ['edit', 'multiedit', 'apply_patch', '*apply_diff', 'search_and_replace']);
  // Python mode(): highest count, ties to the larger value string ('8000' > '16000')
  assert.equal(res.provenance['budget.defaultMaxTokens']?.value, 8000);
  assert.equal(getPath(res.config, 'rules.snapshot.p90Tokens'), pyRound(49000 / 2.949));
});

test('variant: conflicting measured windows (exit 11), rejected control D, capture error entries, owned_by', () => {
  const R = mockResults();
  const t = probeTests(R);
  t['models'] = { status: 200, ids: ['qwen-test'], max_model_len: [98304], owned_by: ['vllm'], error: null };
  (t['overflow'] as J)['both_under_window'] = { accepted: false, max_tokens: 32000, rejection: { status: 400, body: '{"error": {"message": "bad request"}}' } };
  (R['summarize_capture'] as J)['errors'] = [
    { status: 400, body: '{"error": {"message": "Prompt of 99000 tokens exceeds limit"}}', opencode_kilo_would_detect_overflow: false, gobstopper_would_retry: false, request_gob_estimate: 1 },
    { status: 429, body: '{"error": {"message": "slow down"}}', opencode_kilo_would_detect_overflow: false, gobstopper_would_retry: false, request_gob_estimate: 1 },
  ];
  const res = mapEvalResults(R);
  assert.equal(res.exitCode, 11);
  assert.match(res.conflicts[0]!, /measured windows differ: 98304 vs 100000|measured windows differ: 100000 vs 98304/);
  assert.equal(res.provenance['budget.window']?.value, 98_304, 'the smallest measured window');
  assert.ok(res.warnings.some((w) => /control case D .* REJECTED/.test(w)));
  const custom = getPath(res.config, 'errors.custom') as J[];
  // the rejected control's generic body (as the prototype does), and the capture's overflow body; the 429 has no overflow words
  assert.deepEqual(custom.map((e) => [e['match'], e['kind'], e['status']]), [
    ['bad request', 'gateway_error', [400]],
    ['Prompt of \\d+ tokens exceeds limit', 'overflow_unknown', [400]],
  ]);
  // owned_by names the server when no body fingerprints
  const R2 = withTmp((dir) => readEvalInputs([extract('only-gateway502', dir)]).results);
  (R2['probe_gateway']!['tests'] as J)['models'] = { status: 200, ids: ['qwen-test'], max_model_len: [null], owned_by: ['vllm'], error: null };
  const r2 = mapEvalResults(R2);
  assert.deepEqual([r2.provenance['server.type']?.value, r2.provenance['server.type']?.confidence], ['vllm', 'derived']);
});

test('variant: no results at all -> defaults only, exit 10', () => {
  const res = mapEvalResults({});
  assert.deepEqual(res.config, {});
  assert.equal(res.exitCode, 10);
  assert.equal(res.clientBaseUrl, null);
  assert.equal(res.unsafe.length, 4);
});

// ---------------------------------------------------------------- loading

test('readEvalInputs: block checksums, hand edits, versions, duplicates, unknown files', () => {
  withTmp((dir) => {
    const d = extract('mock-vllm', dir);
    // a block altered while copying
    const out = readFileSync(join(d, 'probe.out'), 'utf8');
    writeFileSync(join(d, 'probe.out'), out.replace('"window": 100000', '"window": 100001'));
    // a hand-edited result file (same 'generated' as the block)
    const probe = JSON.parse(readFileSync(join(d, 'probe_gateway.json'), 'utf8')) as J;
    writeFileSync(join(d, 'probe_gateway.json'), JSON.stringify(probe));
    writeFileSync(join(d, 'notes.json'), '{"hello": 1}');
    writeFileSync(join(d, 'x.bin'), 'zz');
    let r = readEvalInputs([d]);
    assert.ok(r.warnings.includes('probe.out: block probe_gateway checksum MISMATCH (altered while copying), ignored'), r.warnings.join('\n'));
    assert.ok(r.warnings.includes("probe_gateway.json: not in the pack's canonical form (edited by hand?)"));
    assert.equal(r.sources['probe_gateway'], 'probe_gateway.json');
    assert.deepEqual(r.ignored.sort(), ['notes.json', 'x.bin']);
    // restore the block: same 'generated', different content -> the verified block wins
    writeFileSync(join(d, 'probe.out'), out);
    r = readEvalInputs([d]);
    assert.equal(r.sources['probe_gateway'], 'probe.out#probe_gateway');
    assert.ok(r.warnings.some((w) => /the file differs from the verified block/.test(w)));
    // a newer version wins
    const newer = { ...(JSON.parse(extractBlocks(out)[0]!.body) as J), generated: '2026-10-05T09:00:00+0300' };
    writeFileSync(join(d, 'probe_gateway.json'), JSON.stringify(newer));
    r = readEvalInputs([d]);
    assert.equal(r.sources['probe_gateway'], 'probe_gateway.json');
    assert.ok(r.warnings.some((w) => /different versions found; using the newest 'generated' \(probe_gateway\.json\)/.test(w)));
    // unsupported pack version
    writeFileSync(join(d, 'check_host.json'), JSON.stringify({ script: 'check_host', pack_version: '2', generated: 'x' }));
    r = readEvalInputs([d]);
    assert.match(r.invalid.join('\n'), /check_host\.json: unsupported pack_version "2"/);
    assert.deepEqual(readEvalInputs([d], { allowPackVersions: ['2'] }).invalid, []);
    assert.match(readEvalInputs([join(dir, 'missing')]).invalid[0]!, /input not found/);
  });
});

test('pack helpers: canonical form, blocks, digests, generated, percentiles, messages', () => {
  const txt = bundle.sets['mock-vllm']!['summarize_capture.json']!;
  assert.equal(isCanonicalPackText(txt), true);
  assert.equal(isCanonicalPackText(txt.replace(/\n$/, '')), false);
  assert.equal(isCanonicalPackText(JSON.stringify(JSON.parse(txt), null, 2) + '\n'), false, 'indent 2 is not the pack form');
  assert.equal(isCanonicalPackText(JSON.stringify({ b: 1, a: 2 }, null, 1) + '\n'), false, 'unsorted keys');
  assert.equal(isCanonicalPackText('{\n "a": 2,\n "b": 1.0\n}\n'), true, 'Python float repr kept');
  const blocks = extractBlocks(bundle.sets['mock-vllm']!['probe.out']!.replace(/\n/g, '\r\n'));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.name, 'probe_gateway');
  assert.equal(blocks[0]!.ok, false, 'CRLF inside the body changes the checksum');
  const b2 = extractBlocks(bundle.sets['mock-vllm']!['probe.out']!);
  assert.equal(b2[0]!.ok, true);
  assert.equal(packDigest(bundle.sets['mock-vllm']!['probe_gateway.json']!.replace(/\n$/, '')), b2[0]!.digest);
  assert.equal(parseGenerated('2026-09-28T14:57:03+0300'), Date.parse('2026-09-28T11:57:03Z'));
  assert.ok(Number.isNaN(parseGenerated('yesterday')));
  assert.equal(packPercentile([5, 1, 3], 50), 3);
  assert.equal(packPercentile([], 99), null);
  assert.equal(pyRound(2.5), 2);
  assert.equal(pyRound(3.5), 4);
  assert.equal(pyRound(17438.45), 17438);
  assert.equal(messageOf('{"error": {"message": "m"}}'), 'm');
  assert.equal(messageOf('{"detail": "d"}'), 'd');
  assert.equal(messageOf('plain'), 'plain');
  assert.equal(messageRegex('a.b (x) 12 <url> 100000', { window: 100000 }), 'a\\.b \\(x\\) \\d+ \\S+ (?<window>\\d+)');
});

// ---------------------------------------------------------------- merge

test('mergeImport: absent, hand-set, previously imported, forced, defaults', () => {
  const { res } = importSet('mock-vllm');
  const existing: J = {
    $comment: 'mine', preset: '100k',
    budget: { window: 98_304 },                 // hand-set, differs
    server: { type: 'vllm' },                   // hand-set, equal
    upstream: { origin: 'http://gw:8000', timeoutMs: 900_000 }, // timeoutMs imported before, untouched
    client: { toolOutputMaxBytes: 40_000 },     // imported before, then hand-edited
  };
  const prev = {
    'upstream.timeoutMs': { value: 900_000, source: 's', rule: 'r', confidence: 'derived' as const },
    'client.toolOutputMaxBytes': { value: 51_200, source: 's', rule: 'r', confidence: 'client-config' as const },
  };
  const m = mergeImport(existing, prev, res);
  assert.equal(getPath(m.config, 'budget.window'), 98_304);
  assert.equal(getPath(m.config, 'upstream.timeoutMs'), 600_000, 'previously imported and untouched: updated');
  assert.equal(getPath(m.config, 'client.toolOutputMaxBytes'), 40_000, 'hand-edited since the import: kept');
  assert.equal(getPath(m.config, 'upstream.origin'), 'http://gw:8000');
  assert.equal(getPath(m.config, '$comment'), 'mine');
  assert.equal(getPath(m.config, 'budget.defaultMaxTokens'), 32_000, 'absent: written');
  assert.ok(m.kept.includes('budget.window') && m.kept.includes('server.type') && m.kept.includes('client.toolOutputMaxBytes'));
  assert.ok(m.written.includes('upstream.timeoutMs') && m.written.includes('budget.defaultMaxTokens'));
  assert.ok(m.warnings.some((w) => /^budget\.window: config has 98304 \(hand-set\), the pack says 100000 \[measured\]; kept \(use --force-keys budget\.window\)$/.test(w)));
  assert.ok(!m.warnings.some((w) => w.startsWith('server.type')), 'equal values: no warning');
  assert.equal(m.sidecarKnobs['client.toolOutputMaxBytes'], undefined, 'no longer an imported knob');
  assert.ok(m.sidecarKnobs['upstream.timeoutMs'] && m.sidecarKnobs['budget.defaultMaxTokens']);
  // --force-keys (a key or a section)
  const f = mergeImport(existing, prev, res, ['budget']);
  assert.equal(getPath(f.config, 'budget.window'), 100_000);
  // default knobs (not written by the import) never overwrite
  assert.equal(getPath(m.config, 'client.compactionPointTokens'), 84_000);
  const g = mergeImport({ compaction: { summaryRole: 'merge-into-first-user' }, cache: { prefixCaching: 'off' } }, null, res);
  assert.equal(getPath(g.config, 'cache.prefixCaching'), 'off', 'prefixCaching was unknown (default): untouched');
  assert.equal(getPath(g.config, 'compaction.summaryRole'), 'merge-into-first-user', 'hand-set survives a measured value');
  assert.equal(sidecarPath('/a/kitzur.config.json'), '/a/kitzur.config.provenance.json');
  assert.equal(sidecarPath('x.jsonc'), 'x.provenance.json');
});
