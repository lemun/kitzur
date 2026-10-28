import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../helpers.js';

// Tracked text must not leak private machine details: home paths, internal hosts, private IPs, emails, ULID-shaped ids.
// Reserved example domains (RFC 2606) and GitHub noreply addresses pass. Exceptions live in test/docs/hygiene-allow.json as {path, pattern, reason}; pattern is a regex tested against the match.

interface Allow { path: string; pattern: string; reason: string }

const PLACEHOLDER = /^(<[^>]*>|\$\{?\w+\}?|%\w+%|USERNAME|you|example|user|me)$/i;
const RULES: { name: string; re: RegExp; ok?: (m: RegExpExecArray) => boolean }[] = [
  { name: 'home path', re: /(?:\/Users\/|\/home\/|\b[A-Za-z]:\\{1,2}Users\\{1,2})([^/\\\s'"`]+)[/\\]/g,
    ok: (m) => PLACEHOLDER.test(m[1]!) },
  { name: 'private hostname', re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|corp|lan|intranet)\b(?![.(])/gi },
  { name: 'private IPv4', re: /\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}\b/g },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    ok: (m) => /@(?:users\.noreply\.github\.com|(?:[\w-]+\.)*example(?:\.com|\.org)?)$/i.test(m[0]) },
  { name: 'ULID-shaped id', re: /\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/g,
    ok: (m) => !/\d/.test(m[0].slice(1)) || !/[A-Z]/.test(m[0]) },
];

test('tracked files carry no private paths, hosts, IPs, emails or ULID-shaped ids', (t) => {
  const git = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (git.error || git.status !== 0) {
    t.skip('git or a git checkout is unavailable; cannot list tracked files');
    return;
  }
  const allow = JSON.parse(readFileSync(join(ROOT, 'test/docs/hygiene-allow.json'), 'utf8')) as Allow[];
  const used = new Set<Allow>();
  const hits: string[] = [];
  for (const file of git.stdout.split('\0').filter(Boolean)) {
    let buf: Buffer;
    try {
      if (statSync(join(ROOT, file)).size > 1 << 20) continue;
      buf = readFileSync(join(ROOT, file));
    } catch { continue; } // deleted in the working tree
    if (buf.includes(0)) continue;
    buf.toString('utf8').split('\n').forEach((line, i) => {
      for (const { name, re, ok } of RULES) {
        for (const m of line.matchAll(re)) {
          if (ok?.(m as RegExpExecArray)) continue;
          const a = allow.find((e) => e.path === file && new RegExp(e.pattern).test(m[0]));
          if (a) used.add(a);
          else hits.push(`${file}:${i + 1}: ${name}: ${m[0]}`);
        }
      }
    });
  }
  assert.deepEqual(hits, [], `add a reasoned entry to test/docs/hygiene-allow.json only if the match is public`);
  assert.deepEqual(allow.filter((a) => !used.has(a)), [], 'stale hygiene-allow.json entries');
});
