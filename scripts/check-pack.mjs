#!/usr/bin/env node
// Checks what `npm publish` would ship: node scripts/check-pack.mjs [package-dir]
// Every `files` entry is packed, each bin target is packed and starts with a node shebang, nothing outside
// `files` (or npm's always-included names) and nothing private or dev-only ships, engines.node is >=22, and the
// unpacked size stays under the budget. Exits 1 with one line per violation. Run `npm run build` first.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Unpacked size was 1,842,742 bytes at 0.2.1; the budget leaves about 25% headroom.
const UNPACKED_SIZE_BUDGET = 2_300_000;
const MIN_NODE_MAJOR = 22;
// npm adds these whatever `files` says
const ALWAYS_INCLUDED = /^(package\.json|(.*\/)?(readme|licen[cs]e|notice|changelog)(\.[^/]*)?)$/i;
const FORBIDDEN = [
  [/^(dist\/)?test\//, 'test file'],
  [/^(dist\/)?bench\//, 'bench file'],
  [/^site\//, 'site file'],
  [/^\.github\//, 'CI file'],
  [/^docs\/assets\//, 'docs media'],
  [/(^|\/)\.env(\.[^/]*)?$/, 'env file'],
  [/\.(pem|key)$/, 'key material'],
];

const dir = resolve(process.argv[2] ?? '.');
const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const res = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { cwd: dir, encoding: 'utf8', shell: process.platform === 'win32' });
if (res.status !== 0) {
  console.error(`check-pack: npm pack failed (exit ${res.status})\n${res.stderr}`);
  process.exit(1);
}
const report = JSON.parse(res.stdout)[0];
const packed = report.files.map((f) => f.path.replaceAll('\\', '/'));

function globToRegExp(glob) {
  const body = glob.replace(/\/$/, '').split(/(\*\*\/|\*)/).map((part) =>
    part === '**/' ? '(?:.*/)?' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${body}(/.*)?$`); // a directory entry covers everything under it
}

const violations = [];
const declared = (pkg.files ?? []).map((f) => [f, globToRegExp(f)]);
if (!declared.length) violations.push('package.json has no "files" list');
for (const [entry, re] of declared)
  if (!packed.some((p) => re.test(p))) violations.push(`files entry "${entry}" matches nothing in the pack`);

const bins = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
for (const [name, target] of Object.entries(bins)) {
  const path = target.replace(/^\.\//, '');
  if (!packed.includes(path)) { violations.push(`bin "${name}" target ${path} is not in the pack`); continue; }
  if (!readFileSync(join(dir, path), 'utf8').startsWith('#!/usr/bin/env node'))
    violations.push(`bin "${name}" target ${path} does not start with "#!/usr/bin/env node"`);
}

for (const p of packed) {
  const hit = FORBIDDEN.find(([re]) => re.test(p));
  if (hit) violations.push(`${hit[1]} would ship: ${p}`);
  else if (!ALWAYS_INCLUDED.test(p) && !declared.some(([, re]) => re.test(p)))
    violations.push(`undeclared file would ship: ${p}`);
}

const engine = pkg.engines?.node ?? '';
const major = Number(/^>=\s*(\d+)/.exec(engine)?.[1]);
if (!(major >= MIN_NODE_MAJOR)) violations.push(`engines.node is "${engine}", expected >=${MIN_NODE_MAJOR}`);

if (report.unpackedSize > UNPACKED_SIZE_BUDGET)
  violations.push(`unpacked size ${report.unpackedSize} bytes is over the ${UNPACKED_SIZE_BUDGET} byte budget`);

if (violations.length) {
  console.error(`check-pack: ${violations.length} violation(s) in ${report.filename}:`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`check-pack: ok, ${packed.length} files, ${report.unpackedSize} bytes unpacked (budget ${UNPACKED_SIZE_BUDGET})`);
