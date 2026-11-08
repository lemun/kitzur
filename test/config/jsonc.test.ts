import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonErrorInfo, parseJsonc } from '../../src/config/jsonc.js';

const BOM = String.fromCharCode(0xfeff);

function errorOf(text: string): string {
  try {
    parseJsonc(text, 'f.jsonc');
  } catch (e) {
    return (e as Error).message;
  }
  assert.fail(`expected ${JSON.stringify(text)} to fail`);
}

test('jsonc: an unexpected token whose quoted context spans a line break keeps line:col and quotes no text (regression)', () => {
  const msg = errorOf('{"k": 5551234567,\n  "z": oops }');
  assert.equal(msg, 'f.jsonc:2:8: invalid JSON (unexpected character)');
  assert.ok(!/\d{2}|oops|"/.test(msg.replace(/^f\.jsonc:\d+:\d+/, '')), msg);
  // context V8 quotes that cannot be found in the text: no position, still no text
  assert.deepEqual(jsonErrorInfo('Unexpected token \'x\', ..."ab\ncd"... is not valid JSON', 'zzz'), { reason: 'unexpected character', pos: null });
  assert.deepEqual(jsonErrorInfo('Odd "SECRET\nmore" at position 3', 'abc'), { reason: 'Odd …', pos: null });
});

test('jsonc: CRLF files parse, and error lines count CRLF breaks', () => {
  assert.deepEqual(parseJsonc('{\r\n  "a": 1, // c\r\n  "b": [1,\r\n 2,\r\n ]\r\n}\r\n'), { a: 1, b: [1, 2] });
  assert.equal(errorOf('{\r\n  "a": 1,\r\n  "b": nope\r\n}'), 'f.jsonc:3:9: invalid JSON (unexpected character)');
});

test('jsonc: a trailing comma followed by a comment before ] or } is dropped', () => {
  assert.deepEqual(parseJsonc('{"a": [1, // x\n], "b": 2, // y\n}'), { a: [1], b: 2 });
  assert.deepEqual(parseJsonc('{"a": [1, /* x */ ], "b": 2, /* y\n */ }'), { a: [1], b: 2 });
});

test('jsonc: // and /* inside strings are kept', () => {
  assert.deepEqual(parseJsonc('{"u": "http://a//b", "c": "/* x */", "e": "\\\\"}'), { u: 'http://a//b', c: '/* x */', e: '\\' });
});

test('jsonc: unterminated strings, a trailing backslash and an unterminated block comment', () => {
  assert.equal(errorOf('{"a": "abc'), 'f.jsonc:1:11: invalid JSON (Unterminated string)');
  assert.equal(errorOf('{"a": "abc\\'), 'f.jsonc: invalid JSON (Unexpected end of JSON input)');
  assert.equal(errorOf('{"a": 1 /* never'), "f.jsonc:1:17: invalid JSON (Expected ',' or '}' after property value)");
});

test('jsonc: an empty file and a comment-only file are an unexpected end', () => {
  assert.equal(errorOf(''), 'f.jsonc: invalid JSON (Unexpected end of JSON input)');
  assert.equal(errorOf('// only\n/* c */\n'), 'f.jsonc: invalid JSON (Unexpected end of JSON input)');
});

test('jsonc: only one BOM is skipped', () => {
  assert.deepEqual(parseJsonc(BOM + '{"x": 1}'), { x: 1 });
  assert.equal(errorOf(BOM + BOM + '{"x": 1}'), 'f.jsonc:1:1: invalid JSON (unexpected character)');
});

test('jsonc: error lines match the original text after a multi-line block comment', () => {
  assert.equal(errorOf('/* a\nb\nc */\n{\n "a": 1,\n "b": oops\n}'), 'f.jsonc:6:7: invalid JSON (unexpected character)');
});
