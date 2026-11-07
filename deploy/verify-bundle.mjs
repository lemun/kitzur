#!/usr/bin/env node
// Verifies an extracted offline or Windows bundle on the target machine, with Node alone (no network, no shell):
//   node verify-bundle.mjs <extracted-dir> [--archive FILE --sums SHA256SUMS]
// Prints one PASS or FAIL line per check. Exits 0 if all pass, 1 if a check fails, 2 on a usage error.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

// The same list as scripts/check-pack.mjs, which runs on import and so cannot share it.
const FORBIDDEN = [
  [/^(dist\/)?test\//, 'test file'],
  [/^(dist\/)?bench\//, 'bench file'],
  [/^site\//, 'site file'],
  [/^\.github\//, 'CI file'],
  [/^docs\/assets\//, 'docs media'],
  [/(^|\/)\.env(\.[^/]*)?$/, 'env file'],
  [/\.(pem|key)$/, 'key material'],
];
const BIN = 'dist/src/cli.js';
const USAGE = 'usage: node verify-bundle.mjs <extracted-dir> [--archive FILE --sums SHA256SUMS]';

function usage(message) {
  console.error(`verify-bundle: ${message}\n${USAGE}`);
  process.exit(2);
}

const args = process.argv.slice(2);
let dir, archive, sums;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--archive' || a === '--sums') {
    const v = args[++i];
    if (!v) usage(`${a} needs a file`);
    if (a === '--archive') archive = v; else sums = v;
  } else if (a.startsWith('-')) usage(`unknown option ${a}`);
  else if (dir === undefined) dir = a;
  else usage(`unexpected argument ${a}`);
}
if (dir === undefined) usage('the extracted bundle folder is required');
if (Boolean(archive) !== Boolean(sums)) usage('--archive and --sums go together');
dir = resolve(dir);
if (!existsSync(dir) || !statSync(dir).isDirectory()) usage(`${dir} is not a folder`);

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const toPosix = (p) => p.split(sep).join('/');
function listFiles(root) {
  const out = [];
  for (const e of readdirSync(root, { withFileTypes: true, recursive: true }))
    if (e.isFile()) out.push(toPosix(relative(dir, join(e.parentPath ?? e.path, e.name))));
  return out.sort();
}

let failed = 0;
function check(name, fn) {
  let problems;
  try { problems = fn(); } catch (err) { problems = [err.message]; }
  if (problems.length) {
    failed++;
    console.log(`FAIL ${name}: ${problems.slice(0, 10).join('; ')}${problems.length > 10 ? `; and ${problems.length - 10} more` : ''}`);
  } else console.log(`PASS ${name}`);
}

const files = listFiles(dir);
const readPkg = () => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

check('node version', () => {
  const engine = readPkg().engines?.node ?? '';
  const want = Number(/^>=\s*(\d+)/.exec(engine)?.[1]);
  const have = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(want)) return [`package.json engines.node is "${engine}"`];
  return have >= want ? [] : [`Node ${process.versions.node} is older than engines.node ${engine}`];
});

if (archive) check('archive checksum', () => {
  const name = basename(archive);
  const line = readFileSync(sums, 'utf8').split(/\r?\n/)
    .map((l) => /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(l)).find((m) => m && basename(m[2]) === name);
  if (!line) return [`${name} is not listed in ${sums}`];
  return sha256(archive) === line[1].toLowerCase() ? [] : [`${name} does not match its SHA256SUMS line`];
});

check('bundle manifest', () => {
  const problems = [];
  const listed = new Set();
  for (const l of readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split(/\r?\n/)) {
    if (!l) continue;
    const m = /^([0-9a-fA-F]{64}) [ *]\.\/(.+)$/.exec(l);
    if (!m) { problems.push(`unreadable manifest line "${l}"`); continue; }
    listed.add(m[2]);
    const file = join(dir, ...m[2].split('/'));
    if (!existsSync(file)) problems.push(`missing ${m[2]}`);
    else if (sha256(file) !== m[1].toLowerCase()) problems.push(`changed ${m[2]}`);
  }
  for (const f of files) if (f !== 'SHA256SUMS' && !listed.has(f)) problems.push(`not in the manifest: ${f}`);
  return problems;
});

check('package and imports', () => {
  const problems = [];
  const deps = Object.keys(readPkg().dependencies ?? {});
  if (deps.length) problems.push(`package.json has dependencies: ${deps.join(', ')}`);
  if (!files.includes(BIN)) problems.push(`bin target ${BIN} is missing`);
  const present = new Set(files);
  for (const f of files.filter((f) => f.startsWith('dist/src/') && f.endsWith('.js'))) {
    const code = readFileSync(join(dir, f), 'utf8');
    for (const [, spec] of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = toPosix(relative(dir, resolve(join(dir, dirname(f)), spec)));
      if (!present.has(target)) problems.push(`${f} imports missing ${spec}`);
    }
  }
  return problems;
});

check('no forbidden files', () => files.flatMap((f) => {
  const hit = FORBIDDEN.find(([re]) => re.test(f));
  return hit ? [`${hit[1]}: ${f}`] : [];
}));

check('bundled CLI runs', () => {
  const keep = new Set(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.has(k.toUpperCase())));
  const problems = [];
  for (const cmd of [['version'], ['config', 'validate', '--preset', '32k', '--upstream', 'http://127.0.0.1:1']]) {
    const res = spawnSync(process.execPath, [join(dir, ...BIN.split('/')), ...cmd],
      { cwd: dir, env, encoding: 'utf8', shell: false, timeout: 30_000 });
    if (res.status !== 0)
      problems.push(`kitzur ${cmd.join(' ')} exited ${res.status ?? res.signal}: ${(res.stderr || res.error?.message || '').trim().split('\n')[0]}`);
  }
  return problems;
});

console.log(failed ? `verify-bundle: ${failed} check(s) failed` : 'verify-bundle: all checks passed');
process.exit(failed ? 1 : 0);
