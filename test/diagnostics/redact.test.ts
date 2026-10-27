import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliIO } from '../../src/cli.js';
import { placeholder, redactArguments, redactRequest } from '../../src/diagnostics/redact.js';
import type { ChatMessage, ChatRequest } from '../../src/types.js';

const PROTECTED = new Set(['model', 'role', 'name', 'id', 'tool_call_id', 'type', 'required', 'tool_choice', 'format']);

/** Synthetic session: a system prompt, a tool, then `rounds` tool-call/tool-result pairs. */
function session(rounds: number): ChatRequest {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a careful coding assistant.\nFollow the house style and explain each change.' },
    { role: 'user', content: [{ type: 'text', text: 'Refactor the settings module so that nested options merge correctly. 🚀' }] },
  ];
  for (let i = 0; i < rounds; i++) {
    messages.push({ role: 'assistant', content: i % 2 ? null : `Step ${i}: looking at the next file.`, tool_calls: [
      { id: `call_${i}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `src/settings/part${i}.ts`, offset: i * 40, note: 'line one\nline "two" é \\ end' }) } },
    ] });
    const body = Array.from({ length: 60 }, (_, l) => `export const option${i}x${l} = merge(defaults.option${l}, overrides["option${l}"]);`).join('\n');
    messages.push({ role: 'tool', tool_call_id: `call_${i}`, content: body });
  }
  messages.push({ role: 'user', content: 'Now write the tests for those merges.' });
  return {
    model: 'synthetic-model', temperature: 0.2, max_tokens: 2000, messages,
    tools: [{ type: 'function', function: { name: 'read_file', description: 'Returns the text of one file.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative file path.' } }, required: ['path'] } } }],
  } as ChatRequest;
}

/** Every free-text string (key, value), with tool-call arguments expanded to their JSON values. */
function texts(x: unknown, key: string | null = null): Array<[string | null, string]> {
  if (typeof x === 'string') {
    if (key !== null && PROTECTED.has(key)) return [];
    return key === 'arguments' ? texts(JSON.parse(x)) : [[key, x]];
  }
  if (Array.isArray(x)) return x.flatMap((v) => texts(v, key === 'required' ? key : null));
  if (x && typeof x === 'object') return Object.entries(x).flatMap(([k, v]) => texts(v, k));
  return [];
}

test('redact keeps the shape: roles, order, tool-call pairing, names, model and numbers', () => {
  const req = session(3);
  const copy = structuredClone(req);
  const r = redactRequest(req);
  assert.deepEqual(req, copy, 'input untouched');
  assert.deepEqual(r.messages.map((m) => m.role), req.messages.map((m) => m.role));
  assert.deepEqual(r.messages.map((m) => m.tool_call_id ?? m.tool_calls?.map((c) => [c.id, c.function.name])),
    req.messages.map((m) => m.tool_call_id ?? m.tool_calls?.map((c) => [c.id, c.function.name])));
  assert.deepEqual([r.model, r.temperature, r.max_tokens], ['synthetic-model', 0.2, 2000]);
  assert.deepEqual(r.tools, [{ type: 'function', function: { name: 'read_file', description: placeholder('Returns the text of one file.'), parameters: { type: 'object', properties: { path: { type: 'string', description: placeholder('Relative file path.') } }, required: ['path'] } } }]);
  const args = JSON.parse(r.messages[2]!.tool_calls![0]!.function.arguments) as Record<string, unknown>;
  assert.deepEqual(Object.keys(args), ['path', 'offset', 'note']);
  assert.equal(args['offset'], 0);
  assert.equal(redactArguments('not json "x"'), placeholder('not json "x"'));
  const escaped = '{"a": "\\u00e9\\"x\\n"}';
  assert.equal(redactArguments(escaped).length, escaped.length);
  assert.match((JSON.parse(redactArguments(escaped)) as { a: string }).a, /^[^\n"]{3}\n$/);
});

test('redact keeps every string length and line count, and no 4-character run of the text survives', () => {
  const req = session(4);
  const r = redactRequest(req);
  const a = texts(req);
  const b = texts(r);
  assert.equal(b.length, a.length);
  const lines = (s: string): number => s.split('\n').length;
  a.forEach(([k, s], i) => {
    assert.equal(b[i]![0], k);
    assert.equal(b[i]![1].length, s.length, `string ${i}`);
    assert.equal(lines(b[i]![1]), lines(s), `string ${i}`);
  });
  const calls = (x: ChatRequest): string[] => x.messages.flatMap((m) => m.tool_calls?.map((c) => c.function.arguments) ?? []);
  assert.deepEqual(calls(r).map((s) => s.length), calls(req).map((s) => s.length));
  const grams = new Set(a.flatMap(([, s]) => Array.from({ length: Math.max(0, s.length - 3) }, (_, i) => s.slice(i, i + 4))));
  for (const [, s] of b) for (let i = 0; i + 4 <= s.length; i++) assert.ok(!grams.has(s.slice(i, i + 4)), 'no run of the original text');
});

async function run(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), env: {}, cwd, onSignal: () => undefined };
  const code = await main(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

test('kitzur redact writes .redacted.json files, never prints content, and replays to the same decisions (32k)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-redact-'));
  try {
    mkdirSync(join(dir, 'cap'));
    writeFileSync(join(dir, 'cap', 'a-long.json'), JSON.stringify(session(40)));
    writeFileSync(join(dir, 'cap', 'b-short.json'), JSON.stringify(session(1)));
    const r = await run(['redact', 'cap'], dir);
    assert.equal(r.code, 0, r.err);
    assert.ok(existsSync(join(dir, 'cap', 'a-long.redacted.json')) && existsSync(join(dir, 'cap', 'b-short.redacted.json')));
    assert.ok(!/merge|Refactor|assistant/.test(r.out + r.err), 'no content');
    const again = await run(['redact', 'cap', '--out', 'shared'], dir);
    assert.equal(again.code, 0, again.err);
    assert.equal(readFileSync(join(dir, 'shared', 'a-long.json'), 'utf8'), readFileSync(join(dir, 'cap', 'a-long.redacted.json'), 'utf8'), 'deterministic; inputs only');
    const decide = async (files: string[]): Promise<unknown[]> => {
      const j = await run(['replay', ...files, '--json', '--no-fresh', '--preset', '32k', '--state-dir', mkdtempSync(join(dir, 'state-'))], dir);
      assert.equal(j.code, 0, j.err);
      return (JSON.parse(j.out) as { requests: Array<Record<string, unknown>> }).requests.map((x) => x['action']);
    };
    const original = await decide(['cap/a-long.json', 'cap/b-short.json']);
    assert.notEqual(original[0], 'passthrough', 'the long session compacts');
    assert.equal(original[1], 'passthrough');
    assert.deepEqual(await decide(['cap/a-long.redacted.json', 'cap/b-short.redacted.json']), original);
    const stdout = await run(['redact', 'cap/b-short.json', '--out', '-'], dir);
    assert.equal(stdout.code, 0, stdout.err);
    assert.deepEqual(JSON.parse(stdout.out), redactRequest(session(1)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kitzur redact rejects headers files and non-requests before writing anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-redact-'));
  try {
    writeFileSync(join(dir, 'body.json'), JSON.stringify(session(1)));
    writeFileSync(join(dir, 'headers.json'), JSON.stringify({ 'content-type': 'application/json', Authorization: 'Bearer synthetic-token' }));
    const r = await run(['redact', 'body.json', 'headers.json'], dir);
    assert.equal(r.code, 2);
    assert.match(r.err, /headers\.json: looks like captured headers, which can hold credentials/);
    assert.ok(!r.err.includes('synthetic-token'));
    assert.ok(!existsSync(join(dir, 'body.redacted.json')), 'nothing written');
    writeFileSync(join(dir, 'other.json'), '{"x":1}');
    assert.match((await run(['redact', 'other.json'], dir)).err, /other\.json: not a chat request body/);
    assert.match((await run(['redact', 'body.json', '--out', '.'], dir)).err, /would overwrite the input/);
    assert.match((await run(['redact'], dir)).err, /redact needs a request file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
