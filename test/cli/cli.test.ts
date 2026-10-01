import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { asRequest, collectRequests, main, parseArgs, setOpsOf, CONFIG_OPTS, UsageError, type CliIO } from '../../src/cli.js';
import type { AppModules } from '../../src/app.js';
import { loadConfig } from '../../src/config/load.js';
import { validateConfig } from '../../src/config/validate.js';
import { DEFAULT_LEAVES } from '../../src/config/spec.js';
import { packageInfo } from '../../src/config/paths.js';
import type { ChatRequest, Engine, EngineResult, LearnedEntry, PlanStore } from '../../src/types.js';
import { ROOT, testTokenizerPath } from '../helpers.js';

interface Run {
  code: number;
  out: string;
  err: string;
}

function io(over: Partial<CliIO> = {}): CliIO & { outBuf: string[]; errBuf: string[] } {
  const outBuf: string[] = [];
  const errBuf: string[] = [];
  return {
    outBuf, errBuf,
    stdout: (s) => void outBuf.push(s),
    stderr: (s) => void errBuf.push(s),
    env: {},
    cwd: process.cwd(),
    onSignal: () => undefined,
    ...over,
  };
}
async function run(argv: string[], over: Partial<CliIO> = {}): Promise<Run> {
  const x = io(over);
  const code = await main(argv, x);
  return { code, out: x.outBuf.join(''), err: x.errBuf.join('') };
}
function withTmp<T>(f: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-cli-'));
  return f(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ---------------------------------------------------------------- argument parsing

test('parseArgs: long, short, inline, boolean, repeated, --, errors', () => {
  const p = parseArgs(['serve-x', '--config', 'a.json', '-s', 'a.b=1', '--set=c.d=2', '--shadow', '--port=0', 'pos', '--', '--not-an-option'], CONFIG_OPTS);
  assert.deepEqual(p.positionals, ['serve-x', 'pos', '--not-an-option']);
  assert.equal(p.values['config'], 'a.json');
  assert.deepEqual(p.values['set'], ['a.b=1', 'c.d=2']);
  assert.equal(p.values['shadow'], true);
  assert.deepEqual(p.ordered.map((o) => o.name), ['config', 'set', 'set', 'shadow', 'port']);
  // config assignments in argv order, shortcuts as their leaf
  assert.deepEqual(setOpsOf(p), [
    { path: 'a.b', raw: '1', source: 'cli:--set' },
    { path: 'c.d', raw: '2', source: 'cli:--set' },
    { path: 'shadow', raw: 'true', source: 'cli:--shadow' },
    { path: 'listen.port', raw: '0', source: 'cli:--port' },
  ]);
  assert.throws(() => parseArgs(['--nope'], CONFIG_OPTS), UsageError);
  assert.throws(() => parseArgs(['-x'], CONFIG_OPTS), /unknown option -x/);
  assert.throws(() => parseArgs(['--config'], CONFIG_OPTS), /--config needs a value/);
  assert.throws(() => parseArgs(['--shadow=yes'], CONFIG_OPTS), /takes no value/);
});

test('main: help, version, unknown command, usage errors', async () => {
  const h = await run(['help']);
  assert.equal(h.code, 0);
  assert.match(h.out, /usage: kitzur <command>/);
  assert.equal((await run([])).code, 2);
  const v = await run(['version']);
  assert.equal(v.code, 0);
  assert.equal(v.out, `kitzur ${packageInfo().version} (node ${process.version})\n`);
  assert.equal(packageInfo().version, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  const u = await run(['frobnicate']);
  assert.equal(u.code, 2);
  assert.match(u.err, /unknown command 'frobnicate'/);
  assert.equal((await run(['config'])).code, 2);
  assert.equal((await run(['config', 'show', '--bogus'])).code, 2);
  const ce = await run(['config', 'show', '--set', 'budget.windw=1']);
  assert.equal(ce.code, 2);
  assert.match(ce.err, /config error: cli:--set: unknown config key budget\.windw \(did you mean budget\.window\?\)/);
});

// ---------------------------------------------------------------- config show / validate / init

test('config show: every leaf with its source, derived budget, masked headers', async () => {
  const r = await run(['config', 'show', '--preset', '32k', '--set', 'upstream.headers.Authorization=Bearer secret', '--port', '0'], { env: { KITZUR_WINDOW: '32000' } });
  assert.equal(r.code, 0);
  assert.match(r.out, /^# kitzur .* effective config: default < preset:32k < env:KITZUR_WINDOW < cli:--set < cli:--port\n/);
  assert.match(r.out, /\nbudget\.window +\= 32000 +\(env:KITZUR_WINDOW\)\n/);
  assert.match(r.out, /\nbudget\.defaultMaxTokens +\= 8000 +\(preset:32k\)\n/);
  assert.match(r.out, /\nlisten\.port +\= 0 +\(cli:--port\)\n/);
  assert.match(r.out, /\ncompaction\.targetFraction +\= 0\.35 +\(default\)\n/);
  assert.match(r.out, /\nupstream\.headers +\= \{"Authorization":"<set>"\} +\(cli:--set\)\n/);
  assert.ok(!r.out.includes('secret'), 'header values are never printed');
  for (const line of ['budget        23488', 'clientPoint   24000', 'allowance     4000', 'hard          20000', 'trigger       20000', 'target        7000']) {
    assert.ok(r.out.includes(`\n${line}\n`), line);
  }
  const lines = r.out.split('\n').filter((l) => / = .*\((default|preset|env|cli)/.test(l));
  assert.equal(lines.length, DEFAULT_LEAVES.length, 'one line per leaf');
  const changed = await run(['config', 'show', '--preset', '64k', '--changed']);
  assert.equal(changed.out.split('\n').filter((l) => /^[a-zA-Z].* = /.test(l)).length, 2);
  const j = await run(['config', 'show', '--json', '--set', 'upstream.headers.X-Key=abc']);
  const o = JSON.parse(j.out) as { config: { upstream: { headers: Record<string, string> } }; provenance: Record<string, string>; derived: { trigger: number } };
  assert.deepEqual(o.config.upstream.headers, { 'X-Key': '<set>' });
  assert.equal(o.derived.trigger, 61_000);
  assert.equal(o.provenance['upstream.headers'], 'cli:--set');
  // errors are printed and set the exit code
  const bad = await run(['config', 'show', '--set', 'compaction.triggerFraction=2']);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /# ERROR: compaction\.triggerFraction/);
});

test('config validate: exit codes, warnings, JSON', async () => {
  const ok = await run(['config', 'validate', '--preset', '100k', '--upstream', 'http://127.0.0.1:8000']);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /ok \(\d+ warning\(s\)\)\n$/);
  const bad = await run(['config', 'validate', '--set', 'server.budgetMode=prompt_only', '--set', 'budget.limitCountsMaxTokens=true', '--json']);
  assert.equal(bad.code, 2);
  const j = JSON.parse(bad.out) as { ok: boolean; errors: string[] };
  assert.equal(j.ok, false);
  assert.match(j.errors.join('\n'), /does not count max_tokens, but budget\.limitCountsMaxTokens is true/);
  const nocap = await run(['config', 'validate', '--set', 'upstream.caFile=/nonexistent/ca.pem']);
  assert.equal(nocap.code, 2);
});

test('config init: a commented config that loads, validates and refuses to overwrite', () =>
  withTmp(async (dir) => {
    for (const preset of ['32k', '64k', '100k', '128k']) {
      const r = await run(['config', 'init', '--preset', preset, '--out', `c-${preset}.jsonc`], { cwd: dir });
      assert.equal(r.code, 0, r.err);
      const file = join(dir, `c-${preset}.jsonc`);
      const text = readFileSync(file, 'utf8');
      assert.match(text, /^\/\/ kitzur configuration/);
      const l = loadConfig({ configPath: file, env: {} });
      assert.equal(l.preset, preset);
      const v = validateConfig(l.config, { provenance: l.provenance });
      assert.deepEqual(v.errors, []);
      assert.ok(v.warnings.some((w) => /upstream\.origin is not set/.test(w)));
      assert.equal(l.provenance['server.type'], 'default', 'left for import-eval to fill in');
    }
    const again = await run(['config', 'init', '--out', 'c-32k.jsonc'], { cwd: dir });
    assert.equal(again.code, 1);
    assert.match(again.err, /exists \(use --force/);
    assert.equal((await run(['config', 'init', '--out', 'c-32k.jsonc', '--force'], { cwd: dir })).code, 0);
    const toStdout = await run(['config', 'init', '-o', '-', '-p', '64k']);
    assert.match(toStdout.out, /"preset": "64k"/);
    assert.equal((await run(['config', 'init', '--preset', '48k', '-o', '-'])).code, 1);
  }));

// ---------------------------------------------------------------- import-eval

interface Bundle { sets: Record<string, Record<string, string>> }
const bundle = JSON.parse(gunzipSync(readFileSync(join(ROOT, 'test', 'fixtures', 'gateway-probes', 'fixtures.json.gz'))).toString('utf8')) as Bundle;
function extract(set: string, dir: string): string {
  const d = join(dir, set);
  mkdirSync(d, { recursive: true });
  for (const [f, txt] of Object.entries(bundle.sets[set]!)) writeFileSync(join(d, f), txt);
  return d;
}

test('config import-eval: exit codes, written config + sidecar, dry run, JSON report, merge', () =>
  withTmp(async (dir) => {
    const full = extract('mock-vllm', dir);
    const partial = extract('only-gateway502', dir);
    const r = await run(['config', 'import-eval', full, '--out', 'imp.json', '--port', '8484'], { cwd: dir });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /client baseURL = http:\/\/127\.0\.0\.1:8484\/v1/);
    const written = JSON.parse(readFileSync(join(dir, 'imp.json'), 'utf8')) as Record<string, unknown>;
    assert.equal((written['budget'] as Record<string, unknown>)['window'], 100_000);
    const side = JSON.parse(readFileSync(join(dir, 'imp.provenance.json'), 'utf8')) as { knobs: Record<string, { confidence: string }>; todos: string[]; info: Record<string, unknown> };
    assert.equal(side.knobs['budget.window']!.confidence, 'measured');
    assert.ok(side.info['tokenizer.calibration.tinyPromptTokens']);
    assert.match(side.todos[0]!, /upstream\.origin/);
    // the written file is a valid config layer
    const l = loadConfig({ configPath: join(dir, 'imp.json'), env: {}, sets: ['upstream.origin=http://gw:8000'] });
    assert.deepEqual(validateConfig(l.config).errors, []);
    // refuses to replace without --merge/--force
    const again = await run(['config', 'import-eval', partial, '--out', 'imp.json'], { cwd: dir });
    assert.equal(again.code, 1);
    assert.match(again.err, /exists: use --merge/);
    // partial pack: exit 10; dry run writes nothing; JSON report
    const dry = await run(['config', 'import-eval', partial, '--out', 'p.json', '--dry-run', '--json-report'], { cwd: dir });
    assert.equal(dry.code, 10);
    assert.equal(existsSync(join(dir, 'p.json')), false);
    const rep = JSON.parse(dry.out) as { exitCode: number; unsafe: string[]; config: { errors?: { custom: Array<{ kind: string }> } } };
    assert.equal(rep.exitCode, 10);
    assert.equal(rep.config.errors?.custom[0]!.kind, 'gateway_error');
    // merge into an init config: the imported knobs land, hand edits survive, re-import updates imported ones
    await run(['config', 'init', '--out', 'my.jsonc'], { cwd: dir });
    const m1 = await run(['config', 'import-eval', partial, '--merge', 'my.jsonc'], { cwd: dir });
    assert.equal(m1.code, 10);
    assert.ok(existsSync(join(dir, 'my.jsonc.bak')));
    assert.match(m1.out, /comments in .*my\.jsonc are not preserved/);
    const mine = JSON.parse(readFileSync(join(dir, 'my.jsonc'), 'utf8')) as { preset: string; budget: Record<string, unknown>; server?: Record<string, unknown> };
    assert.equal(mine.preset, '100k');
    mine.budget['defaultMaxTokens'] = 24_000; // hand edit of an imported knob
    writeFileSync(join(dir, 'my.jsonc'), JSON.stringify(mine));
    const m2 = await run(['config', 'import-eval', full, '--merge', 'my.jsonc'], { cwd: dir });
    assert.equal(m2.code, 0);
    assert.match(m2.out, /budget\.defaultMaxTokens: config has 24000 \(hand-set\), the pack says 32000 \[measured\]; kept/);
    const after = JSON.parse(readFileSync(join(dir, 'my.jsonc'), 'utf8')) as { budget: Record<string, unknown>; server: Record<string, unknown> };
    assert.equal(after.budget['defaultMaxTokens'], 24_000);
    assert.equal(after.server['type'], 'vllm', 'filled in: the init template leaves it unset');
    assert.equal(after.budget['observedFixedPromptTokens'], 9376);
    // invalid input
    const bad = await run(['config', 'import-eval', join(dir, 'missing')], { cwd: dir });
    assert.equal(bad.code, 1);
    assert.match(bad.err, /invalid input: input not found/);
    assert.equal((await run(['config', 'import-eval'], { cwd: dir })).code, 2);
    // a directory whose only result is a corrupted block
    const corrupt = join(dir, 'corrupt');
    mkdirSync(corrupt);
    writeFileSync(join(corrupt, 'probe.out'), bundle.sets['mock-vllm']!['probe.out']!.replace('"window": 100000', '"window": 1'));
    const c = await run(['config', 'import-eval', corrupt, '--dry-run'], { cwd: dir });
    assert.equal(c.code, 10, 'no results -> defaults only');
    assert.match(c.out, /checksum MISMATCH/);
  }));

test('config import-eval --tokenizer: the tiny-request template check', { skip: testTokenizerPath() ? false : 'no dev tokenizer.json' }, () =>
  withTmp(async (dir) => {
    const full = extract('mock-vllm', dir);
    const r = await run(['config', 'import-eval', full, '--dry-run', '--json-report', '--tokenizer', testTokenizerPath()!, '--template', 'sim'], { cwd: dir });
    const rep = JSON.parse(r.out) as { info: Record<string, { value: { server: number; ours: number } }> };
    const chk = rep.info['tokenizer.calibration.tinyPromptCheck']!.value;
    assert.equal(chk.server, 20);
    assert.equal(chk.ours, 20, 'the sim template counts the probe request as the mock does');
  }));

// ---------------------------------------------------------------- state, status, count

test('state show / reset on a state dir', () =>
  withTmp(async (dir) => {
    const entry = (w: number): LearnedEntry => ({
      configuredWindow: 100_000, counterId: 'c', window: w, maxPrompt: null, maxBodyBytes: null, tighten: 512,
      tightenLog: [{ rule: 'overflow_unknown', at: '2026-09-28T10:00:00Z', rejectedRaw: 70_000 }], correction: 1.02, samples: 9, meanRatio: 1.01,
      ratios: [], pendingTighten: [], includeUsageRejected: false, updatedAt: '2026-09-28T10:00:00Z',
    });
    writeFileSync(join(dir, 'learned.json'), JSON.stringify({ version: 2, entries: { 'http://gw:8000|qwen': entry(98_304), 'http://gw:8000|small': entry(60_000) } }));
    const s = await run(['state', 'show', '--state-dir', dir]);
    assert.equal(s.code, 0, s.err);
    assert.match(s.out, /2 entries/);
    assert.match(s.out, /http:\/\/gw:8000\|qwen\n  window 98304 \(configured 100000\).*tighten 512, correction 1\.02 \(9 samples\)/);
    assert.match(s.out, /tighten: 2026-09-28T10:00:00Z overflow_unknown rejected raw 70000/);
    const js = await run(['state', 'show', '--json', '--key', 'small'], { env: { KITZUR_STATE_DIR: dir } });
    assert.deepEqual(Object.keys((JSON.parse(js.out) as { entries: object }).entries), ['http://gw:8000|small']);
    mkdirSync(join(dir, 'plans'));
    const r = await run(['state', 'reset', '--key', 'qwen', '--plans', '--state-dir', dir]);
    assert.equal(r.code, 0);
    assert.match(r.out, /removed 1 entry: http:\/\/gw:8000\|qwen/);
    assert.equal(existsSync(join(dir, 'plans')), false);
    const left = JSON.parse(readFileSync(join(dir, 'learned.json'), 'utf8')) as { entries: object };
    assert.deepEqual(Object.keys(left.entries), ['http://gw:8000|small']);
    assert.equal((await run(['state', 'frob'])).code, 2);
  }));

test('status: GET /status of a running instance', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"name":"kitzur","uptime_s":3}');
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  try {
    const r = await run(['status', '--port', String(port)]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(r.out), { name: 'kitzur', uptime_s: 3 });
    const nf = await run(['status', '--url', `http://127.0.0.1:${port}/missing`]);
    assert.equal(nf.code, 1);
    assert.match(nf.err, /returned HTTP 404/);
  } finally {
    srv.close();
  }
  const down = await run(['status', '--url', 'http://127.0.0.1:9/status']);
  assert.equal(down.code, 1);
  assert.match(down.err, /cannot reach/);
});

test('count: exact per-message counts without content', { skip: testTokenizerPath() ? false : 'no dev tokenizer.json' }, () =>
  withTmp(async (dir) => {
    const req: ChatRequest = {
      model: 'm', max_tokens: 1000,
      messages: [{ role: 'system', content: 'SECRET-SYSTEM-TEXT' }, { role: 'user', content: 'SECRET-USER-TEXT and more' }],
    };
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ body: JSON.stringify(req) }));
    const r = await run(['count', 'r.json', '--tokenizer', testTokenizerPath()!, '--state-dir', dir, '--json'], { cwd: dir });
    assert.equal(r.code, 0, r.err);
    const o = JSON.parse(r.out) as { counter: string; total: number; perMessage: Array<{ role: string; tokens: number }>; tReq: number; serverFits: boolean };
    assert.equal(o.counter, 'exact');
    assert.equal(o.tReq, 1000);
    assert.deepEqual(o.perMessage.map((m) => m.role), ['system', 'user']);
    assert.equal(o.perMessage.reduce((a, m) => a + m.tokens, 0) + (o as unknown as { overhead: number }).overhead, o.total);
    assert.ok(!r.out.includes('SECRET'), 'no content');
    const text = await run(['count', 'r.json', '--tokenizer', testTokenizerPath()!, '--state-dir', dir], { cwd: dir });
    assert.ok(!text.out.includes('SECRET'));
    assert.match(text.out, /r\.json: \d+ tokens \(exact, template qwen3/);
    const est = await run(['count', 'r.json'], { cwd: dir });
    assert.equal(est.code, 2, 'no tokenizer: refuses unless --estimate');
    assert.match(est.err, /--estimate/);
    assert.equal((await run(['count', 'r.json', '--estimate', '--json'], { cwd: dir })).code, 0);
  }));

// ---------------------------------------------------------------- replay and serve with injected modules

/** A fake engine: drops every other message after the first two; `flaky` makes a fresh engine differ. */
function fakeModules(opts: { flaky?: boolean; onClose?: (ms: number) => void; probe?: () => Promise<{ ok: boolean; tlsError?: string }> } = {}): AppModules & { built: number } {
  let built = 0;
  const mods = {
    get built() {
      return built;
    },
    createEngine: (): Engine => {
      const n = ++built;
      const store = new Map<string, unknown>();
      return {
        process(req: ChatRequest): EngineResult {
          const live = store.size > 0;
          store.set(String(req.messages.length), true);
          const msgs = req.messages.length > 2 ? req.messages.filter((_, i) => i < 2 || i % 2 === 0) : req.messages;
          const out = { ...req, messages: opts.flaky && n > 1 ? msgs.slice(0, 1) : msgs };
          return {
            action: live ? 'reuse' : 'passthrough', request: out, changed: msgs.length !== req.messages.length, maxTokens: null, plan: null, sessionKey: 's',
            stats: {
              messagesIn: req.messages.length, messagesOut: out.messages.length, tokensIn: req.messages.length * 10, tokensOut: out.messages.length * 10,
              budget: { budget: 67_000, trigger: 61_000 } as EngineResult['stats']['budget'], compactions: 0, summaryTokens: 0, ledgerTokens: 0, rewrites: 0,
              boundariesReplayed: 0, cacheHits: 0, engineMs: 0.1,
            },
          };
        },
        learned: () => ({}) as LearnedEntry,
        setLearned: () => undefined,
      };
    },
    createSummarizer: () => ({ render: () => ({ text: null, tokens: 0, floorTokens: 0, kept: 0, dropped: 0, categories: {} }) }),
    createToolRules: () => ({}) as ReturnType<AppModules['createToolRules']>,
    createStore: () => ({ get: () => undefined, set: () => undefined, size: () => 0 }) as PlanStore,
    createState: () => ({ entries: () => ({}), discarded: [], lastError: null, flush: () => undefined }) as unknown as ReturnType<AppModules['createState']>,
    createStats: () => ({ close: async () => undefined }) as unknown as ReturnType<AppModules['createStats']>,
    createProxyServer: () =>
      ({
        listen: async () => ({ host: '127.0.0.1', port: 45678 }),
        close: async (ms?: number) => opts.onClose?.(ms ?? -1),
        upstream: { probe: opts.probe ?? (async () => ({ ok: true })) },
        status: { warn: () => undefined },
      }) as unknown as ReturnType<AppModules['createProxyServer']>,
  };
  return mods as unknown as AppModules & { built: number };
}

test('replay: sizes only, live vs fresh determinism, exit codes', () =>
  withTmp(async (dir) => {
    const reqs = join(dir, 'reqs');
    mkdirSync(reqs);
    for (let i = 0; i < 12; i++) {
      const messages = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'GOAL-SECRET' }];
      for (let k = 0; k < i; k++) messages.push({ role: 'assistant', content: `A${k}` }, { role: 'user', content: `U${k}` });
      writeFileSync(join(reqs, `${String(i + 1)}_step${i}.json`), JSON.stringify({ model: 'm', messages }));
    }
    writeFileSync(join(reqs, 'notes.txt'), 'ignored');
    const mods = fakeModules();
    const r = await run(['replay', 'reqs'], { cwd: dir, modules: mods });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /determinism \(live == fresh\): 12\/12 ok/);
    assert.ok(!r.out.includes('SECRET'), 'never content');
    const rows = r.out.split('\n').filter((l) => /^ +\d+ /.test(l));
    assert.deepEqual(rows.map((l) => l.trim().split(/\s+/)[1]), Array.from({ length: 12 }, (_, i) => `${i + 1}_step${i}.json`), 'numeric order');
    assert.equal(mods.built, 13, 'one live engine and one fresh engine per request');
    const flaky = await run(['replay', 'reqs', '--json'], { cwd: dir, modules: fakeModules({ flaky: true }) });
    assert.equal(flaky.code, 1);
    const j = JSON.parse(flaky.out) as { mismatches: number; requests: Array<{ deterministic: boolean; messagesIn: number }> };
    assert.equal(j.mismatches, 12);
    assert.equal(j.requests[3]!.messagesIn, 8);
    const skip = await run(['replay', join(reqs, '3_step2.json'), '--no-fresh'], { cwd: dir, modules: fakeModules() });
    assert.equal(skip.code, 0);
    assert.ok(!skip.out.includes('determinism'));
    assert.equal((await run(['replay'], { cwd: dir })).code, 2);
  }));

test('serve: prints the bound address, drains on SIGTERM, refuses a config without an origin', async () => {
  let handler: ((sig: string) => void) | null = null;
  let closedWith: number | null = null;
  const x = io({ onSignal: (h) => void (handler = h), modules: fakeModules({ onClose: (ms) => (closedWith = ms) }) });
  const done = main(['serve', '--upstream', 'http://127.0.0.1:9', '--port', '0', '--drain-ms', '1234'], x);
  for (let i = 0; i < 100 && !x.outBuf.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(x.outBuf, ['listening on http://127.0.0.1:45678\n']);
  assert.ok(handler, 'signal handler registered');
  handler!('SIGTERM');
  assert.equal(await done, 0);
  assert.equal(closedWith, 1234);
  assert.match(x.errBuf.join(''), /SIGTERM: stopping; draining in-flight requests \(up to 1234 ms\)/);
  // no origin
  const r = await run(['serve'], { modules: fakeModules() });
  assert.equal(r.code, 2);
  assert.match(r.err, /upstream\.origin is required/);
  // a TLS verification failure at the startup probe exits non-zero (§9)
  const tls = await run(['serve', '--upstream', 'https://gw.example', '--port', '0'], { modules: fakeModules({ probe: async () => ({ ok: false, tlsError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) }) });
  assert.equal(tls.code, 1);
  assert.match(tls.err, /TLS verification of https:\/\/gw\.example failed: UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  assert.equal(tls.out, '', 'never announces a listener it is about to close');
});

test('collectRequests / asRequest: bodies, wrapped bodies, JSONL, arrays', () =>
  withTmp(async (dir) => {
    const body = { messages: [{ role: 'user', content: 'x' }] };
    writeFileSync(join(dir, 'a.jsonl'), [JSON.stringify(body), JSON.stringify({ request: body }), JSON.stringify({ body: JSON.stringify(body) }), '{"x":1}'].join('\n'));
    writeFileSync(join(dir, 'b.json'), JSON.stringify([body, body]));
    const got = collectRequests(['a.jsonl', 'b.json'], dir);
    assert.deepEqual(got.map((g) => [g.label, g.req !== null]), [['a.jsonl:1', true], ['a.jsonl:2', true], ['a.jsonl:3', true], ['a.jsonl:4', false], ['b.json:1', true], ['b.json:2', true]]);
    assert.equal(asRequest({ body: 'not json' }), null);
    assert.throws(() => collectRequests(['nope.json'], dir), /not found/);
  }));

test('the built bin runs as a program (shebang, entry-point detection, exit code)', () => {
  const cli = join(ROOT, 'dist', 'src', 'cli.js');
  assert.match(readFileSync(cli, 'utf8'), /^#!\/usr\/bin\/env node\n/);
  const v = spawnSync(process.execPath, [cli, 'version'], { encoding: 'utf8' });
  assert.equal(v.status, 0);
  assert.match(v.stdout, /^kitzur \d+\.\d+\.\d+/);
  const bad = spawnSync(process.execPath, [cli, 'config', 'validate', '--set', 'compaction.targetFraction=1'], { encoding: 'utf8', env: { PATH: process.env['PATH'] } });
  assert.equal(bad.status, 2);
  // a closed pipe ends quietly
  const sh = spawnSync('sh', ['-c', `"${process.execPath}" "${cli}" config show | head -1`], { encoding: 'utf8' });
  assert.equal(sh.stderr, '');
  assert.match(sh.stdout, /^# kitzur/);
});
