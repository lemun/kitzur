import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELP_COMMANDS, NO_CONFIG_COMMANDS, USAGE, usageOf, wantsHelp } from '../../src/cli/usage.js';
import { display, fmtHost, maskUserinfo, parseNoEcho } from '../../src/cli/format.js';

test('usageOf: every help command gets its own header and lines, and only its own', () => {
  for (const cmd of HELP_COMMANDS) {
    const u = usageOf(cmd);
    assert.ok(u.startsWith(`usage: kitzur ${cmd} [options]\n\n`), cmd);
    const own = u.split('\n').slice(2).filter((l) => /^ {2}\S/.test(l) && !/^ {2}-/.test(l));
    assert.ok(own.length > 0, `${cmd} has no usage lines`);
    for (const l of own) assert.ok(l.startsWith(`  ${cmd} `) || l === `  ${cmd}`, `${cmd}: ${l}`);
  }
});

test('usageOf: config options appear unless the command reads no config', () => {
  for (const cmd of HELP_COMMANDS) {
    const hasOpts = usageOf(cmd).includes('config options (');
    assert.equal(hasOpts, !NO_CONFIG_COMMANDS.has(cmd), cmd);
  }
  assert.ok(usageOf('serve').endsWith(USAGE.slice(USAGE.indexOf('config options'))));
});

test('usageOf: replay and count document --model', () => {
  for (const cmd of ['replay', 'count']) assert.match(usageOf(cmd), /\[--model ID\]/, cmd);
});

test('usageOf: every flag a command parses is listed', () => {
  const flags: Record<string, RegExp[]> = {
    config: [/config init .*\[--model ID\[=WINDOW\]\]\.\.\. .*\[--dry-run\]/, /config show \[--model ID\] \[--changed\] \[--full\] \[--json\]/, /config validate \[--model ID\] \[--json\]/],
    count: [/count <request\.json> \[--model ID\] \[--estimate\] \[--json\]/],
    replay: [/\[--json\]/, /\[--no-fresh\]/],
    serve: [/serve \[--drain-ms N\]/],
    status: [/ {2}status \[--url URL\] \[--json\] \[--timeout-ms N\] {2}show a running instance's status\n/],
  };
  for (const [cmd, res] of Object.entries(flags)) for (const re of res) assert.match(usageOf(cmd), re, cmd);
  assert.match(USAGE, /^[\x00-\x7f]*$/, 'USAGE is plain ASCII');
});

test('usageOf: every flag a config subcommand lists is one it parses', () => {
  const accepts: Record<string, string[]> = {
    init: ['preset', 'out', 'force', 'upstream', 'tokenizer', 'model', 'dry-run'],
    show: ['model', 'changed', 'full', 'json'],
    validate: ['model', 'json'],
    'import-eval': ['out', 'merge', 'provenance', 'dry-run', 'force-keys', 'allow-pack-version', 'json-report', 'port', 'tokenizer', 'template', 'force'],
    'export-opencode': ['model', 'small-model', 'provider', 'key-env'],
  };
  const own: Record<string, string> = {};
  let sub = '';
  for (const l of usageOf('config').split('\n')) {
    if (l.startsWith('config options')) break;
    const m = /^ {2}config (\S+)/.exec(l);
    if (m) sub = m[1]!;
    if (sub) own[sub] = (own[sub] ?? '') + l + '\n';
  }
  assert.deepEqual(Object.keys(own).sort(), Object.keys(accepts).sort());
  for (const [s, text] of Object.entries(own)) {
    for (const [, f] of text.matchAll(/--([a-z][a-z-]*)/g)) assert.ok(accepts[s]!.includes(f!), `config ${s} lists --${f}`);
  }
  assert.doesNotMatch(own['export-opencode']!, /--force-keys/);
  assert.match(own['import-eval']!, /--force-keys a\.b,c/);
});

test('wantsHelp: --help or -h before `--` only', () => {
  assert.equal(wantsHelp(['--help']), true);
  assert.equal(wantsHelp(['x', '-h']), true);
  assert.equal(wantsHelp(['--', '--help']), false);
  assert.equal(wantsHelp(['--json']), false);
});

test('maskUserinfo hides URL credentials and leaves everything else alone', () => {
  assert.equal(maskUserinfo('https://user:secret@gw.example/v1'), 'https://<credentials>@gw.example/v1');
  assert.equal(maskUserinfo('http://token@gw.example'), 'http://<credentials>@gw.example');
  assert.equal(maskUserinfo('https://gw.example/a@b'), 'https://gw.example/a@b');
  assert.equal(maskUserinfo(null), null);
  assert.equal(display('upstream.origin', 'https://u:p@gw.example'), '"https://<credentials>@gw.example"');
});

test('fmtHost brackets bare IPv6 addresses only', () => {
  assert.equal(fmtHost('::1'), '[::1]');
  assert.equal(fmtHost('[::1]'), '[::1]');
  assert.equal(fmtHost('127.0.0.1'), '127.0.0.1');
  assert.equal(fmtHost('localhost'), 'localhost');
});

test('parseNoEcho parses valid JSON and never quotes the offending input', () => {
  assert.deepEqual(parseNoEcho('{"a":1}'), { a: 1 });
  const secrets = ['{"prompt": "SECRET_PROMPT_TEXT" oops}', '{"prompt":"SECRET_PROMPT_TEXT"', 'SECRET_PROMPT_TEXT', '{"k":\n  SECRET_PROMPT_TEXT}'];
  for (const text of secrets) {
    assert.throws(() => parseNoEcho(text), (e: Error) => {
      assert.ok(!e.message.includes('SECRET'), e.message);
      assert.ok(!e.message.includes('prompt'), e.message);
      return true;
    });
  }
  assert.throws(() => parseNoEcho('{"x": SECRET}', 7), (e: Error) => /at line 7\b/.test(e.message) && !e.message.includes('SECRET'));
});
