import test from 'node:test';
import assert from 'node:assert/strict';
import { maskSnapshotString } from '../../src/diagnostics/snapshot.js';

const facts = { version: '0.2.1', node: 'v22', platform: 'win32', arch: 'x64', home: 'D:\\Profiles\\alice', upstreamHost: 'gpu.example', tokenizerConfigured: false, tokenizerLoads: false };

// Input, expected output, and the user name that must not survive masking.
const cases: Array<[string, string, string]> = [
  ['C:\\Users\\Alice Smith\\kitzur.json', '<home>\\kitzur.json', 'Alice'],
  ['D:\\Profiles\\alice\\x', '<home>\\x', 'alice'],
  ['D:/Profiles/alice/x', '<home>/x', 'alice'],
  ['d:\\profiles\\alice\\x', '<home>\\x', 'alice'],
  ['D:\\\\Profiles\\\\alice\\\\x', '<home>\\\\x', 'alice'],
  ['C:\\\\Users\\\\alice\\\\x', '<home>\\\\x', 'alice'],
  ['C:\\Documents and Settings\\alice\\x', '<home>\\x', 'alice'],
  ['C:/Users/You/kitzur.json', '<home>/kitzur.json', 'You'],
  ['C:/Users/Alice Smith/x', '<home>/x', 'Alice'],
  ['\\\\srv\\share\\Users\\alice\\x', '\\\\srv\\share<home>\\x', 'alice'],
  ['read C:\\Users\\you\\a.json then D:/Profiles/alice/b.json', 'read <home>\\a.json then <home>/b.json', 'alice'],
  ['/Users/you/x', '<home>/x', 'you'],
  ['/home/you/x', '<home>/x', 'you'],
  ['/mnt/c/Users/you/x', '/mnt/c<home>/x', 'you'],
];

test('Windows home paths in any spelling are masked in the doctor snapshot', () => {
  for (const [input, expected] of cases) assert.equal(maskSnapshotString(input, facts), expected, input);
  assert.equal(maskSnapshotString('no path here: Users and home stay', facts), 'no path here: Users and home stay');
});

test('no user name survives masking for any path form', () => {
  for (const [input, , name] of cases) assert.doesNotMatch(maskSnapshotString(input, facts), new RegExp(name, 'i'), input);
  assert.doesNotMatch(maskSnapshotString('read C:\\Users\\you\\a.json then D:/Profiles/alice/b.json', facts), /you/i);
});
