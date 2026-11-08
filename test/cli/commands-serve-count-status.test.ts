import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliIO } from '../../src/cli.js';

async function run(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), env: {}, cwd, onSignal: () => undefined };
  const code = await main(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

async function withTmp(f: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-cmds-'));
  try { await f(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('serve, count and status keep their usage-error contract through main', () =>
  withTmp(async (dir) => {
    for (const argv of [['serve', '--frob'], ['serve', 'extra'], ['count'], ['count', 'a.json', 'b.json'], ['status', '--frob'],
      ['status', '--timeout-ms', 'abc'], ['status', '--timeout-ms', '-5'], ['status', '--timeout-ms', '10001'],
      ['status', '--url', 'not a url'], ['status', '--url', 'notaurl'], ['status', '--url', 'ftp://u:secret@h/status']]) {
      const r = await run(argv, dir);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err, /^kitzur: /, argv.join(' '));
      assert.equal(r.out, '');
    }
    assert.match((await run(['serve', '--frob'], dir)).err, /unknown option --frob/);
    assert.match((await run(['count'], dir)).err, /count needs one request file/);
    writeFileSync(join(dir, 'nope.json'), JSON.stringify({ prompt: 'p' }));
    const notChat = await run(['count', 'nope.json', '--state-dir', dir], dir);
    assert.equal(notChat.code, 2);
    assert.match(notChat.err, /nope\.json: not a chat request/);
    assert.match((await run(['status', '--timeout-ms', 'abc'], dir)).err, /--timeout-ms must be an integer from 1 to 10000\n/);
    const badUrl = await run(['status', '--url', 'ftp://u:secret@h/status'], dir);
    assert.match(badUrl.err, /--url must be an http\(s\) URL such as http:\/\/127\.0\.0\.1:8270\/status\n/);
    assert.doesNotMatch(badUrl.err, /secret|cannot reach|nothing answered/);
  }));

test('serve loads the runtime log from its new directory and exits 2 without an upstream origin', () =>
  withTmp(async (dir) => {
    const r = await run(['serve', '--state-dir', dir], dir);
    assert.equal(r.code, 2);
    assert.match(r.err, /kitzur: config error: upstream\.origin is required/);
  }));

test('count --estimate measures a tiny synthetic request offline', () =>
  withTmp(async (dir) => {
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hello there' }] }));
    const r = await run(['count', 'r.json', '--estimate', '--json', '--state-dir', dir], dir);
    assert.equal(r.code, 0, r.err);
    const o = JSON.parse(r.out) as { file: string; messages: number; tools: number; tReq: number; total: number; overhead: number; perMessage: Array<{ i: number; role: string; tokens: number }> };
    assert.equal(o.file, 'r.json');
    assert.equal(o.messages, 1);
    assert.equal(o.tools, 0);
    assert.equal(o.tReq, 100);
    assert.deepEqual(o.perMessage.map((m) => [m.i, m.role]), [[0, 'user']]);
    assert.equal(o.perMessage[0]!.tokens + o.overhead, o.total);
    assert.ok(!r.out.includes('hello'), 'no content');
  }));

test('count uses the model profile of the request, with a --model override', () =>
  withTmp(async (dir) => {
    writeFileSync(join(dir, 'kitzur.json'), JSON.stringify({ budget: { window: 100000 }, models: { 'org/small': { budget: { window: 50000 } } } }));
    const messages = [{ role: 'user', content: 'hello there' }];
    writeFileSync(join(dir, 'a.json'), JSON.stringify({ model: 'org/small', max_tokens: 100, messages }));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ max_tokens: 100, messages }));
    const count = async (...argv: string[]) => {
      const r = await run(['count', ...argv, '--config', 'kitzur.json', '--estimate', '--json', '--state-dir', dir], dir);
      assert.equal(r.code, 0, r.err);
      const o = JSON.parse(r.out) as { profile: string; budget: number };
      return [o.profile, o.budget] as const;
    };
    const small = await count('a.json');
    const root = await count('b.json');
    assert.equal(small[0], 'org/small');
    assert.equal(root[0], 'root');
    assert.ok(small[1] < root[1], `${small[1]} < ${root[1]}`);
    assert.deepEqual(await count('b.json', '--model', 'org/small'), small);
    const text = await run(['count', 'a.json', '--config', 'kitzur.json', '--estimate', '--state-dir', dir], dir);
    assert.match(text.out, /, profile org\/small\)/);
    const bad = await run(['count', 'a.json', '--config', 'kitzur.json', '--model', 'nope', '--state-dir', dir], dir);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--model nope: no configured profile for this model \(configured: org\/small\)/);
  }));

test('count without model profiles reports root in JSON and text', () =>
  withTmp(async (dir) => {
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ model: 'm', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }));
    const j = await run(['count', 'r.json', '--estimate', '--json', '--state-dir', dir], dir);
    assert.equal((JSON.parse(j.out) as { profile: string }).profile, 'root');
    const t = await run(['count', 'r.json', '--estimate', '--state-dir', dir], dir);
    assert.match(t.out, /^r\.json: \d+ tokens \(estimate, template [^,)]+, profile root\)\n/);
  }));

test('count rejects a request with an empty messages array as a usage error', () =>
  withTmp(async (dir) => {
    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ messages: [] }));
    const r = await run(['count', 'empty.json', '--estimate', '--state-dir', dir], dir);
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
    assert.match(r.err, /^kitzur: .*empty\.json: the request has no messages; pass a captured Chat Completions body with at least one message\n/);
  }));

test('count names the message the chat template rejects, as a usage error', () =>
  withTmp(async (dir) => {
    const cases: [unknown[], number, RegExp][] = [
      [[{ role: 'user', content: 'hi' }, { role: 'bogus', content: 'x' }], 1, /Unexpected message role\. The model's chat template rejects this request/],
      [[{ role: 'user', content: 12 }], 0, /Unexpected content type\. The model's chat template rejects this request/],
      [[null, 'str'], 0, /is not a message object \(expected \{role, content\}\); fix or remove it/],
    ];
    for (const [messages, i, msg] of cases) {
      writeFileSync(join(dir, 'bad.json'), JSON.stringify({ messages }));
      const r = await run(['count', 'bad.json', '--estimate', '--state-dir', dir], dir);
      assert.equal(r.code, 2, r.err);
      assert.equal(r.out, '');
      assert.match(r.err, new RegExp(`^kitzur: .*bad\\.json: messages\\[${i}\\]`));
      assert.match(r.err, msg);
      assert.doesNotMatch(r.err, /Cannot read properties/);
    }
  }));

test('count warns when the config would be refused by serve but keeps its result', () =>
  withTmp(async (dir) => {
    writeFileSync(join(dir, 'kitzur.json'), JSON.stringify({ budget: { window: 300 } }));
    writeFileSync(join(dir, 'r.json'), JSON.stringify({ max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }));
    const j = await run(['count', 'r.json', '--config', 'kitzur.json', '--estimate', '--json', '--state-dir', dir], dir);
    assert.equal(j.code, 0, j.err);
    assert.ok((JSON.parse(j.out) as { budget: number }).budget < 0);
    assert.match(j.err, /kitzur: warn: config would be refused by serve: no room for the prompt: budget = window 300/);
    const ok = await run(['count', 'r.json', '--estimate', '--state-dir', dir], dir);
    assert.doesNotMatch(ok.err, /would be refused/);
    writeFileSync(join(dir, 'ca.json'), JSON.stringify({ upstream: { caFile: 'missing-ca.pem' } }));
    const ca = await run(['count', 'r.json', '--config', 'ca.json', '--estimate', '--state-dir', dir], dir);
    assert.equal(ca.code, 0, ca.err);
    assert.match(ca.err, /kitzur: warn: config would be refused by serve: upstream\.caFile: file not found: /);
  }));
