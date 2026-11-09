import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../helpers.js';

const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
const pkgVersion = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;

interface Section { heading: string; label: string; date?: string }

function sections(text: string): Section[] {
  return [...text.matchAll(/^## (.*)$/gm)].map(([, heading = '']) => {
    const m = /^\[([^\]]+)\](?: [—-] (\S+))?$/.exec(heading);
    assert.ok(m, `heading is not "[label]" or "[label] — date": ## ${heading}`);
    return { heading, label: m[1]!, date: m[2] };
  });
}

function links(text: string): Map<string, string> {
  return new Map([...text.matchAll(/^\[([^\]]+)\]: (\S+)$/gm)].map(([, label = '', url = '']) => [label, url]));
}

function semver(v: string, where: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  assert.ok(m, `not a x.y.z version: ${where}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isRealDate(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);
}

const all = sections(changelog);
const released = all.filter((s) => s.label !== 'Unreleased');

test('Unreleased is the first section of the changelog', () => {
  assert.equal(all[0]?.label, 'Unreleased', `first section is ## ${all[0]?.heading}`);
  assert.equal(all.filter((s) => s.label === 'Unreleased').length, 1);
});

test('released sections carry real dates, with versions descending and dates never increasing', () => {
  assert.ok(released.length > 0);
  released.forEach((s, i) => {
    assert.ok(s.date && isRealDate(s.date), `missing or invalid date: ## ${s.heading}`);
    const prev = released[i - 1];
    if (!prev) return;
    const [a, b] = [semver(prev.label, prev.heading), semver(s.label, s.heading)];
    const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    assert.ok(cmp > 0, `## ${s.heading} is not older than ## ${prev.heading}`);
    assert.ok(s.date! <= prev.date!, `## ${s.heading} is dated after ## ${prev.heading}`);
  });
});

test('the newest released section is the package.json version and release-notes prints it', () => {
  assert.equal(released[0]?.label, pkgVersion, `## ${released[0]?.heading} does not match package.json ${pkgVersion}`);
  const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'release-notes.mjs'), `v${pkgVersion}`, join(ROOT, 'CHANGELOG.md')], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.trim().length > 0, `release notes for v${pkgVersion} are empty`);
});

test('every section has a compare link naming the previous tag', () => {
  const refs = links(changelog);
  const base = 'https://github.com/lemun/kitzur/';
  assert.equal(refs.get('Unreleased'), `${base}compare/v${released[0]?.label}...HEAD`, 'link for [Unreleased]');
  released.forEach((s, i) => {
    const prev = released[i + 1];
    const want = prev ? `${base}compare/v${prev.label}...v${s.label}` : `${base}releases/tag/v${s.label}`;
    assert.ok(refs.has(s.label), `no reference link for [${s.label}]`);
    assert.equal(refs.get(s.label), want, `link for [${s.label}]`);
  });
});
