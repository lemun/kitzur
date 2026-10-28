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
