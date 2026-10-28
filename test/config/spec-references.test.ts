// Comments, strings and docs must stand alone: no citations of numbered specification sections,
// ADR numbers or invariant tags that no repository document defines, no punctuation left behind
// where such a citation was removed, and every DESIGN.md "Heading" reference names a real heading.
// There is deliberately no allowlist: a finding is fixed in the source, never exempted here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from '../helpers.js';

interface Piece { kind: 'comment' | 'string'; text: string; line: number }

/** Comment and string-literal text of a TypeScript source, with the line each piece starts on. */
export function pieces(src: string): Piece[] {
  const out: Piece[] = [];
  let i = 0;
  let line = 1;
  // `prev` is the last significant code character; it decides whether `/` starts a regex literal.
  let prev = '';
  let prevWord = '';
  const braces: number[] = []; // per open template `${`: brace depth inside it
  const take = (kind: Piece['kind'], start: number, end: number, at: number): void => {
    out.push({ kind, text: src.slice(start, end), line: at });
  };
  const template = (): void => {
    // at the character after a backtick or after the `}` closing a `${`
    const at = line;
    let start = i;
    while (i < src.length) {
      const c = src[i]!;
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') line++;
      if (c === '`') { take('string', start, i, at); i++; prev = '`'; return; }
      if (c === '$' && src[i + 1] === '{') { take('string', start, i, at); i += 2; braces.push(0); prev = '{'; return; }
      i++;
    }
    take('string', start, i, at);
  };
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i);
      take('comment', i + 2, end < 0 ? src.length : end, line);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end;
      take('comment', i + 2, stop, line);
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      i = stop + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const at = line;
      let k = i + 1;
      while (k < src.length && src[k] !== c && src[k] !== '\n') k += src[k] === '\\' ? 2 : 1;
      take('string', i + 1, k, at);
      i = k + 1;
      prev = c;
      prevWord = '';
      continue;
    }
    if (c === '`') { i++; template(); prevWord = ''; continue; }
    if (c === '}' && braces.length && braces[braces.length - 1] === 0) { braces.pop(); i++; template(); continue; }
    if (c === '{' && braces.length) braces[braces.length - 1]!++;
    if (c === '}' && braces.length) braces[braces.length - 1]!--;
    if (c === '/' && (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /^(return|typeof|case|in|of|void|delete|throw|new|yield|await)$/.test(prevWord))) {
      // regex literal: skip it, classes included, then its flags
      let k = i + 1;
      let cls = false;
      while (k < src.length && src[k] !== '\n') {
        const r = src[k]!;
        if (r === '\\') { k += 2; continue; }
        if (r === '[') cls = true;
        else if (r === ']') cls = false;
        else if (r === '/' && !cls) break;
        k++;
      }
      i = k + 1;
      while (i < src.length && /[a-z]/.test(src[i]!)) i++;
      prev = '/';
      prevWord = '';
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let k = i;
      while (k < src.length && /[A-Za-z0-9_$]/.test(src[k]!)) k++;
      prevWord = src.slice(i, k);
      prev = 'a';
      i = k;
      continue;
    }
    prev = c;
    prevWord = '';
    i++;
  }
  return out;
}

/** Citations that no repository document defines. Checked on every scanned line, code included. */
const CITATION: [string, RegExp][] = [
  ['section sign', /§/],
  ['ADR number', /\bADR-?[0-9]+\b/],
  ['invariant tag', /\bI[1-9]\b/],
];

/** Residue of a removed citation in comments and prose. */
const PROSE_RESIDUE: [string, RegExp][] = [
  ['empty parentheses', /(^|\s)\(\s*\)(?!\s*=>)/],
  ['punctuation-led parentheses', /\(\s*[,;:]/],
  ['punctuation before a closing parenthesis', /[,;]\s*\)/],
  ['doubled comma', /,\s*,/],
  ['space after an opening parenthesis', /\( +\S/],
  ['dangling word before a closing parenthesis', /\b(to|of|or|and|the|per|see|in|by|with|from|as) +\)/],
  // a complete ternary `a ? b : c` quoted in prose is code, not residue
  ['space before a colon', /(?<!\s\?\s\w*)\w :(\s|$)|\s\?\s\w+ :\s*$/],
  ['doubled space after "the" or "per"', /\b(the|per)  +\S/i],
];

/** Residue of a removed citation inside string literals. */
const STRING_RESIDUE: [string, RegExp][] = [
  ['empty parentheses', /(^|\s)\(\s*\)(?!\s*=>)/],
  ['punctuation-led parentheses', /\(\s*[,;:]/],
];

const DESIGN_HEADINGS = new Set(
  readFileSync(join(ROOT, 'DESIGN.md'), 'utf8').split('\n').filter((l) => /^#+ /.test(l)).map((l) => l.replace(/^#+ /, '').trim()),
);

/** Quoted names cited as DESIGN.md sections: `DESIGN.md "A" (x), "B" and "C"`. */
export function designSections(text: string): string[] {
  const names: string[] = [];
  const flat = text.replace(/\n\s*\*?\s*/g, ' ');
  for (const m of flat.matchAll(/DESIGN(?:\.md)?[ ,:]*"([^"]+)"/g)) {
    names.push(m[1]!);
    let rest = flat.slice(m.index! + m[0].length);
    for (;;) {
      const more = /^\s*(?:\([^)]*\))?\s*(?:,|and|,\s*and)\s*"([^"]+)"/.exec(rest);
      if (!more) break;
      names.push(more[1]!);
      rest = rest.slice(more[0].length);
    }
  }
  return names;
}

interface Finding { line: number; rule: string; text: string }

function lineScan(text: string, firstLine: number, rules: [string, RegExp][], out: Finding[]): void {
  text.split('\n').forEach((l, k) => {
    for (const [rule, re] of rules) if (re.test(l)) out.push({ line: firstLine + k, rule, text: l.trim() });
  });
}

function designScan(text: string, line: number, out: Finding[]): void {
  for (const name of designSections(text)) {
    if (!DESIGN_HEADINGS.has(name)) out.push({ line, rule: `DESIGN.md has no heading "${name}"`, text: name });
  }
}

/** Findings in one TypeScript source. */
export function scanTs(src: string): Finding[] {
  const out: Finding[] = [];
  lineScan(src, 1, CITATION, out);
  for (const p of pieces(src)) {
    if (p.kind === 'comment') {
      // a block comment's leading ` * ` is layout, and code spans and regex literals quoted in prose are code
      const prose = p.text.replace(/^[ \t]*\*(?=\s|$)/gm, '').replace(/`[^`\n]*`/g, 'code').replace(/(^|\s)\/(?:\\.|[^/\s])+\/[a-z]*/g, '$1regex');
      lineScan(prose, p.line, PROSE_RESIDUE, out);
    } else lineScan(p.text, p.line, STRING_RESIDUE, out);
    designScan(p.text, p.line, out);
  }
  return out;
}

/** Findings in one markdown document, outside code fences; inline code spans are code, not prose. */
export function scanMd(src: string): Finding[] {
  const out: Finding[] = [];
  // an open fence closes only on a run of its own character at least as long as the opening run
  let fence = '';
  src.split('\n').forEach((l, k) => {
    const run = /^\s*(`{3,}|~{3,})/.exec(l)?.[1];
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(l)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = '';
      return;
    }
    if (run) { fence = run; return; }
    lineScan(l, k + 1, CITATION, out);
    lineScan(l.replace(/`[^`]*`/g, 'code'), k + 1, PROSE_RESIDUE, out);
    designScan(l, k + 1, out);
  });
  return out;
}

function files(dir: string, ext: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) found.push(...files(p, ext));
    else if (name.endsWith(ext)) found.push(p);
  }
  return found;
}

test('scanner flags dangling citations and their residue', () => {
  const bad: [string, string][] = [
    ['ts', '// the fold §3.2 decides'],
    ['ts', '// recorded in ADR-7'],
    ['ts', '// keeps I3 true'],
    ['ts', '// the step ( see above) runs'],
    ['ts', '// the step () runs'],
    ['ts', '// the step (, and the guard) runs'],
    ['ts', '// the step (x, ) runs'],
    ['ts', '// a, , b'],
    ['ts', '// the map (adapted to ) holds'],
    ['ts', '// the rule holds :'],
    ['ts', '// per  the design'],
    ['ts', '// Why? value : detail'],
    ['ts', '// a ? b, residue :'],
    ['ts', '// a ? b :'],
    ['ts', '/**\n * as in the  plan\n */'],
    ['ts', "const m = 'budget exceeded ()';"],
    ['ts', 'const m = "cap (; see notes)";'],
    ['ts', 'const m = `cap ${n} ()`;'],
    ['ts', '// see DESIGN.md "No such heading"'],
    ['md', 'The cap §4 applies.'],
    ['md', 'The cap (ADR-3) applies.'],
    ['md', 'The cap () applies.'],
    ['md', 'See DESIGN.md "Nowhere".'],
    ['md', '````\n```\n````\nThe cap §4 applies.'],
    ['md', '~~~\n```\n~~~\nThe cap §4 applies.'],
  ];
  for (const [kind, src] of bad) {
    const found = kind === 'ts' ? scanTs(src) : scanMd(src);
    assert.ok(found.length > 0, `not flagged: ${src}`);
  }
});

test('scanner keeps ordinary code and real references', () => {
  const good: [string, string][] = [
    ['ts', 'render();\nconst f = () => x;\nfor (;;) break;'],
    ['ts', 'const [, , ...rest] = xs;'],
    ['ts', 'const re = /\\(\\s*\\)|, ,|\\( x/g;'],
    ['ts', 'const s = `${a ? b : c}`;'],
    ['ts', 'const w = `setInterval(async () => {});`;'],
    ['ts', '// stops at `(?:(?!,)\\S)+,` and not /[.,;)]+$/'],
    ['ts', "const s = 'render() returns';"],
    ['ts', '// a ? b : c, f(x) and (see above), bytes(in) and bytes(out)'],
    ['ts', '// out = [ H[i]  for i in 0..h )'],
    ['ts', '// DESIGN.md "Request path", "Mechanical summary" and "Recovery and streaming"'],
    ['ts', '/**\n * Semantics: DESIGN.md "Planning and prefix stability" (fit loop), "Mechanical summary" (summary,\n * ledger) and "Oversized input and guards" (rules).\n */'],
    ['ts', '// RFC 9110 and ./docs/DIAGNOSTICS.md'],
    ['md', 'Call `render()` here; see DESIGN.md "Budgets and counting".'],
    ['md', '```\nconst x = f( , );\n§1\n```'],
    ['md', '````\n```\n§1\n```\n````'],
    ['md', '~~~\n```\n§1\n~~~'],
    ['md', '````\n````~~~\n§1\n````'],
  ];
  for (const [kind, src] of good) {
    const found = kind === 'ts' ? scanTs(src) : scanMd(src);
    assert.deepEqual(found, [], src);
  }
});

test('src, docs and DESIGN.md carry no dangling specification references', () => {
  const findings: string[] = [];
  const report = (file: string, fs: Finding[]): void => {
    for (const f of fs) findings.push(`${relative(ROOT, file)}:${f.line}: ${f.rule}: ${f.text}`);
  };
  for (const f of files(join(ROOT, 'src'), '.ts')) report(f, scanTs(readFileSync(f, 'utf8')));
  for (const f of [...files(join(ROOT, 'docs'), '.md'), join(ROOT, 'DESIGN.md')]) report(f, scanMd(readFileSync(f, 'utf8')));
  assert.deepEqual(findings, []);
});
