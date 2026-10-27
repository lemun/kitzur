// Source comments and docs must explain themselves: no references to numbered specification sections,
// ADR numbers, invariant tags or DESIGN.md sections that no repository document defines, and no empty
// prose parentheses or stray punctuation left behind where such a reference was removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from '../helpers.js';

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** Section signs, ADR numbers and invariant tags (I1–I9): anywhere in a line, code included. */
const DANGLING = /§|\bADR-?\d+\b|\bI\d\b/;
/**
 * Leftovers of a removed reference in prose: `()` after a space, `(, x`, `x, )`, `a, , b`, `( x`, `(: x`,
 * `per :`, `word : x` and a doubled space after "the" / "per".
 */
const BROKEN_PROSE = /(^|[\s,;:])\(\s*\)|\(\s*[,;:]|[,;]\s+\)|,\s+,|\(\s+[A-Za-z]|[A-Za-z] [:;,](\s|$)|\b(the|per)  [A-Za-z]/;
/** `DESIGN.md "Section"`: the quoted name must be a heading of DESIGN.md. */
const DESIGN_SECTION = /DESIGN\.md "([^"]+)"/g;

/** The comment text of a TypeScript line (whole-line comments, or the part after ` // `), without `code` spans. */
function commentText(line: string): string {
  const t = line.trim();
  let c = '';
  if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) c = t;
  else if (line.includes(' // ')) c = line.slice(line.indexOf(' // '));
  return c.replace(/`[^`]*`/g, '``');
}

const HEADINGS = new Set(
  readFileSync(join(ROOT, 'DESIGN.md'), 'utf8').split('\n').filter((l) => l.startsWith('#')).map((l) => l.replace(/^#+\s*/, '').trim()),
);

function offends(line: string, prose: string): boolean {
  if (DANGLING.test(line) || BROKEN_PROSE.test(prose)) return true;
  return [...line.matchAll(DESIGN_SECTION)].some((m) => !HEADINGS.has(m[1]!));
}

/** `file:line: text` for every offending line. */
function scan(files: string[]): string[] {
  const bad: string[] = [];
  for (const f of files) {
    const ts = f.endsWith('.ts');
    let fence = false;
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (!ts && /^\s*```/.test(line)) fence = !fence;
      if (fence) return;
      const prose = ts ? commentText(line) : line.replace(/`[^`]*`/g, '``');
      if (offends(line, prose)) bad.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
    });
  }
  return bad;
}

test('src/, docs/ and DESIGN.md hold no dangling specification references or broken parentheses', () => {
  const files = [...walk(join(ROOT, 'src'), '.ts'), ...walk(join(ROOT, 'docs'), '.md'), join(ROOT, 'DESIGN.md')];
  const bad = scan(files);
  assert.deepEqual(bad, [], `rewrite these as standalone explanations:\n${bad.join('\n')}`);
});

test('the scanner flags what it should and keeps code calls, regexes and real references', () => {
  const cases: [string, boolean][] = [
    ['// the budget (§3)', true],
    ['/** see ADR-7 */', true],
    ['  // fall back (I7)', true],
    ['// Admission (DESIGN.md, ).', true],
    ['// clamp (, ADR-7)', true],
    ['// startup warnings ( clamp unreachable)', true],
    ['// falls back per : attempt 1', true],
    ['// Test fault injection :', true],
    ['// the  resend of the original', true],
    ['// state (DESIGN.md "State dir")', true],
    ['  const x = f();', false],
    ['// calls render() once', false],
    ['  // a literal `(?:(?!,)\\S)+,` stops at the comma', false],
    ['  // a loop, not /[.,;)]+$/ (quadratic)', false],
    ['  const [, , ...lines] = s;', false],
    ['// see DESIGN.md "Budgets and counting"', false],
  ];
  for (const [line, want] of cases) assert.equal(offends(line, commentText(line)), want, line);
});
