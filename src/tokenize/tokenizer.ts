// Exact, offline, zero-dependency encoder for Hugging Face `tokenizer.json` files of the
// Qwen2/Qwen3 family (ByteLevel BPE + NFC + Split-regex pre-tokenizer + added tokens).
// Mirrors HF `tokenizers` (Rust, v0.23.2) `Tokenizer::encode(text, add_special_tokens=false)`:
//   1. split on added tokens (non-normalized ones, leftmost-longest) on the RAW text;
//   2. NFC-normalize every remaining piece (Rust crate unicode-normalization-alignments data);
//   3. split on normalized added tokens (none for Qwen);
//   4. Split pre-tokenizer (Oniguruma regex, behavior Isolated) -> pieces;
//   5. ByteLevel: UTF-8 bytes -> byte-level alphabet (use_regex=false);
//   6. BPE per piece: repeatedly merge the lowest-rank adjacent pair (leftmost on ties).
// Node >= 20, no native code, no network. Uses only: RegExp (u flag, lookahead),
// String.prototype.normalize, typed arrays, node:fs (loader only).

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ONIG_L, ONIG_M, ONIG_N, ONIG_SPACE } from './unicode-tables.js';
import { NFC_EXCEPTION_RANGES } from './nfc-exceptions.js';
import { nfc9 } from './nfc9.js';
export { nfc9 };

export class TokenizerUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenizerUnsupportedError';
  }
}

export interface Tokenizer {
  /** Token ids, identical to Python `Tokenizer.encode(text, add_special_tokens=False).ids`. */
  encode(text: string): number[];
  /** Same as encode(text).length, without materializing the id array. */
  count(text: string): number;
  /** Base vocabulary size + added tokens. */
  readonly vocabSize: number;
  /** Added-token content -> id. */
  readonly addedTokens: ReadonlyMap<string, number>;
  /** Clears the per-piece BPE cache. */
  clearCache(): void;
}

export interface TokenizerOptions {
  /** Max entries in the per-piece BPE cache (default 100_000; 0 disables). */
  cacheSize?: number;
  /** Pieces longer than this many UTF-16 units are not cached (default 256). */
  cacheMaxPieceLength?: number;
  /** BPE words with more than this many initial symbols use the heap algorithm (default 96). */
  heapThreshold?: number;
  /**
   * NFC implementation. 'tables' (default): pure-TS port of the Rust crate HF uses, over its own
   * Unicode 9.0 tables (ICU-independent). 'icu': String.prototype.normalize, never normalizing
   * across the code points whose data differ from HF's tables (src/nfc-exceptions.ts, generated
   * against ICU/Unicode 17; a Node whose ICU is newer than that may disagree on new characters).
   */
  nfc?: 'icu' | 'tables';
}

// ---------------------------------------------------------------- Unicode helpers

/**
 * One code point as a class atom. Printable characters are emitted literally: V8 11.x (Node 20)
 * stops optimizing regexps whose SOURCE exceeds 20 KB (kRegExpTooLargeToOptimize), and the
 * \\u{...} form of the pinned tables is 49 KB (4.4x slower on Node 20). Literal form: ~11 KB.
 */
const atom = (c: number): string => {
  if (c < 0x21 || (c >= 0x7f && c <= 0xa0) || c === 0x2028 || c === 0x2029 || (c >= 0xd800 && c <= 0xdfff))
    return '\\u{' + c.toString(16) + '}';
  const ch = String.fromCodePoint(c);
  return '\\]^-['.includes(ch) ? '\\' + ch : ch;
};

/** Flat [a,b,a,b...] ranges -> body of a JS character class (u flag). */
function classBody(ranges: readonly number[]): string {
  let s = '';
  for (let i = 0; i < ranges.length; i += 2) {
    const a = ranges[i]!;
    const b = ranges[i + 1]!;
    s += a === b ? atom(a) : atom(a) + '-' + atom(b);
  }
  return s;
}

/** V8 11.x source-length limit above which regexps are not optimized (see atom()). */
export const V8_REGEXP_TOO_LARGE_TO_OPTIMIZE = 20 * 1024;

const WS = classBody(ONIG_SPACE);
/** Oniguruma (Unicode 16.0) property tables pinned so results do not depend on Node's ICU. */
const PINNED_PROPS: Record<string, string> = {
  L: classBody(ONIG_L),
  Letter: classBody(ONIG_L),
  M: classBody(ONIG_M),
  Mark: classBody(ONIG_M),
  N: classBody(ONIG_N),
  Number: classBody(ONIG_N),
  White_Space: WS,
  Space: WS,
};

/** Oniguruma case-insensitive single-char folds onto ASCII letters (CaseFolding.txt, simple). */
const EXTRA_FOLDS: Record<string, string> = { s: '\u017f', k: '\u212a' };
const MULTI_FOLD_TARGETS = ['ss', 'st', 'ff', 'fi', 'fl', 'ffi', 'ffl', 'ft'];

/**
 * Translate the subset of Oniguruma syntax used by HF pre-tokenizer patterns into a
 * Node 20 JS RegExp source (flags 'gu'). Throws TokenizerUnsupportedError on anything else.
 */
export function translateOnigRegex(pat: string): string {
  let out = '';
  const ciStack: boolean[] = [];
  let ci = false;
  let ciRun = '';
  const flushCi = (): void => {
    const low = ciRun.toLowerCase();
    for (const t of MULTI_FOLD_TARGETS) {
      if (low.includes(t)) throw new TokenizerUnsupportedError(`(?i:) literal '${ciRun}' has multi-char case folds`);
    }
    ciRun = '';
  };
  const cps = Array.from(pat);
  let i = 0;
  const readProp = (): { neg: boolean; body: string } => {
    // at cps[i] === '\\', cps[i+1] in p/P
    const neg = cps[i + 1] === 'P';
    if (cps[i + 2] !== '{') throw new TokenizerUnsupportedError('\\p without braces');
    let j = i + 3;
    let name = '';
    while (j < cps.length && cps[j] !== '}') name += cps[j++];
    i = j + 1;
    let n = name;
    let innerNeg = false;
    if (n.startsWith('^')) {
      innerNeg = true;
      n = n.slice(1);
    }
    const pinned = PINNED_PROPS[n];
    let body: string;
    if (pinned !== undefined) body = pinned;
    else {
      // Not pinned: falls back to Node's ICU tables (verify before relying on it).
      try {
        new RegExp(`\\p{${n}}`, 'u');
      } catch {
        throw new TokenizerUnsupportedError(`unknown Unicode property ${n}`);
      }
      body = `\\p{${n}}`;
    }
    return { neg: neg !== innerNeg, body };
  };
  while (i < cps.length) {
    const c = cps[i]!;
    if (c === '\\') {
      const e = cps[i + 1];
      if (e === undefined) throw new TokenizerUnsupportedError('trailing backslash');
      if (e === 'p' || e === 'P') {
        const { neg, body } = readProp();
        out += neg ? `[^${body}]` : `[${body}]`;
        continue;
      }
      i += 2;
      if (e === 's') out += `[${WS}]`;
      else if (e === 'S') out += `[^${WS}]`;
      else if ('rntfv'.includes(e)) out += '\\' + e;
      else if (e === 'd') out += '\\p{Nd}';
      else if (/[A-Za-z0-9]/.test(e)) throw new TokenizerUnsupportedError(`escape \\${e}`);
      else out += '\\' + e;
      continue;
    }
    if (c === '[') {
      i++;
      let body = '';
      let neg = false;
      if (cps[i] === '^') {
        neg = true;
        i++;
      }
      let first = true;
      while (i < cps.length && (cps[i] !== ']' || first)) {
        first = false;
        const d = cps[i]!;
        if (d === '[') throw new TokenizerUnsupportedError('nested character class');
        if (d === '&' && cps[i + 1] === '&') throw new TokenizerUnsupportedError('class intersection');
        if (d === '\\') {
          const e = cps[i + 1];
          if (e === 'p' || e === 'P') {
            const p = readProp();
            if (p.neg) throw new TokenizerUnsupportedError('negated property inside class');
            body += p.body;
            continue;
          }
          i += 2;
          if (e === 's') body += WS;
          else if (e === 'r' || e === 'n' || e === 't' || e === 'f' || e === 'v') body += '\\' + e;
          else if (e === 'd') body += '\\p{Nd}';
          else if (e !== undefined && /[A-Za-z0-9]/.test(e)) throw new TokenizerUnsupportedError(`class escape \\${e}`);
          else body += '\\' + e;
          continue;
        }
        if (ci && /[A-Za-z]/.test(d)) {
          throw new TokenizerUnsupportedError('letters in a class inside (?i:)');
        }
        body += '^-]\\/'.includes(d) ? '\\' + d : d;
        i++;
      }
      if (cps[i] !== ']') throw new TokenizerUnsupportedError('unterminated class');
      i++;
      out += neg ? `[^${body}]` : `[${body}]`;
      continue;
    }
    if (c === '(') {
      if (ci) flushCi();
      ciStack.push(ci);
      if (cps[i + 1] === '?') {
        const rest = cps.slice(i, i + 4).join('');
        if (rest.startsWith('(?i:')) {
          ci = true;
          out += '(?:';
          i += 4;
        } else if (rest.startsWith('(?:') || rest.startsWith('(?=') || rest.startsWith('(?!')) {
          out += rest.slice(0, 3);
          i += 3;
        } else if (rest.startsWith('(?<=') || rest.startsWith('(?<!')) {
          out += rest;
          i += 4;
        } else throw new TokenizerUnsupportedError(`group syntax ${rest}`);
      } else {
        out += '(?:';
        i++;
      }
      continue;
    }
    if (c === ')') {
      if (ci) flushCi();
      if (ciStack.length === 0) throw new TokenizerUnsupportedError('unbalanced )');
      ci = ciStack.pop()!;
      out += ')';
      i++;
      continue;
    }
    if (c === '|') {
      if (ci) flushCi();
      out += '|';
      i++;
      continue;
    }
    if (c === '+' || c === '*' || c === '?') {
      const next = cps[i + 1];
      if (next === '+') throw new TokenizerUnsupportedError('possessive quantifier');
      out += c;
      i++;
      continue;
    }
    if (c === '{') {
      let j = i + 1;
      let q = '';
      while (j < cps.length && cps[j] !== '}') q += cps[j++];
      if (!/^\d+(,\d*)?$/.test(q)) throw new TokenizerUnsupportedError(`brace ${q}`);
      out += `{${q}}`;
      i = j + 1;
      if (cps[i] === '+') throw new TokenizerUnsupportedError('possessive quantifier');
      continue;
    }
    if (c === '.' || c === '^' || c === '$') throw new TokenizerUnsupportedError(`metachar ${c}`);
    if (ci && /[A-Za-z]/.test(c)) {
      ciRun += c;
      const lo = c.toLowerCase();
      out += `[${lo}${lo.toUpperCase()}${EXTRA_FOLDS[lo] ?? ''}]`;
    } else if (ci && c.toLowerCase() !== c.toUpperCase()) {
      throw new TokenizerUnsupportedError('non-ASCII letter inside (?i:)');
    } else {
      out += '/\\]}'.includes(c) ? '\\' + c : c;
    }
    i++;
  }
  if (ciStack.length) throw new TokenizerUnsupportedError('unbalanced (');
  return out;
}

// ---------------------------------------------------------------- NFC (HF-exact)

/** Every code point below U+0300 is NFC-inert (ccc=0, NFC_QC=Yes). */
const MAYBE_NOT_NFC = /[^\u0000-\u02ff]/;
const NFC_EXCEPTION_RE = new RegExp(`[${classBody(NFC_EXCEPTION_RANGES)}]`, 'u');
const NFC_EXCEPTION_RE_G = new RegExp(`[${classBody(NFC_EXCEPTION_RANGES)}]`, 'gu');

/**
 * NFC as computed by HF tokenizers (Unicode 9.0 normalization tables). ICU (Node) knows
 * newer characters; code points in NFC_EXCEPTION_RANGES are unknown to the Rust tables and
 * behave as inert starters there, so we never let ICU normalize across them.
 */
export function hfNfc(s: string): string {
  if (!MAYBE_NOT_NFC.test(s)) return s;
  if (!NFC_EXCEPTION_RE.test(s)) return s.normalize('NFC');
  let out = '';
  let last = 0;
  NFC_EXCEPTION_RE_G.lastIndex = 0;
  for (let m = NFC_EXCEPTION_RE_G.exec(s); m !== null; m = NFC_EXCEPTION_RE_G.exec(s)) {
    out += s.slice(last, m.index).normalize('NFC') + m[0];
    last = m.index + m[0].length;
  }
  return out + s.slice(last).normalize('NFC');
}

// ---------------------------------------------------------------- byte-level alphabet

function bytesToUnicode(): string[] {
  const bs: number[] = [];
  for (let b = 0x21; b <= 0x7e; b++) bs.push(b);
  for (let b = 0xa1; b <= 0xac; b++) bs.push(b);
  for (let b = 0xae; b <= 0xff; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const out: string[] = new Array(256);
  for (let i = 0; i < 256; i++) out[bs[i]!] = String.fromCharCode(cs[i]!);
  return out;
}

// ---------------------------------------------------------------- merge table

/** Open-addressing hash (a,b) -> (rank,newId). ids < 2^31. */
class PairTable {
  private readonly mask: number;
  private readonly ka: Int32Array;
  private readonly kb: Int32Array;
  readonly rank: Int32Array;
  readonly newId: Int32Array;
  constructor(n: number) {
    let cap = 1;
    while (cap < n * 2) cap <<= 1;
    this.mask = cap - 1;
    this.ka = new Int32Array(cap).fill(-1);
    this.kb = new Int32Array(cap);
    this.rank = new Int32Array(cap);
    this.newId = new Int32Array(cap);
  }
  private slot(a: number, b: number): number {
    let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca77)) >>> 0;
    h ^= h >>> 15;
    return h & this.mask;
  }
  set(a: number, b: number, rank: number, newId: number): void {
    let s = this.slot(a, b);
    for (;;) {
      const x = this.ka[s]!;
      if (x === -1 || (x === a && this.kb[s] === b)) {
        this.ka[s] = a;
        this.kb[s] = b;
        this.rank[s] = rank; // later duplicates overwrite, like Rust's HashMap collect
        this.newId[s] = newId;
        return;
      }
      s = (s + 1) & this.mask;
    }
  }
  /** Slot index or -1. */
  find(a: number, b: number): number {
    let s = this.slot(a, b);
    for (;;) {
      const x = this.ka[s]!;
      if (x === -1) return -1;
      if (x === a && this.kb[s] === b) return s;
      s = (s + 1) & this.mask;
    }
  }
}

// ---------------------------------------------------------------- tokenizer

interface AddedTok {
  content: string;
  id: number;
  normalized: boolean;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

function literalAlternation(toks: AddedTok[]): RegExp | null {
  if (toks.length === 0) return null;
  // Longest first => JS leftmost-first alternation == aho-corasick LeftmostLongest.
  const sorted = [...toks].sort((x, y) => y.content.length - x.content.length || (x.content < y.content ? -1 : 1));
  return new RegExp(sorted.map((t) => escapeRe(t.content)).join('|'), 'gu');
}

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

function unsupported(msg: string): never {
  throw new TokenizerUnsupportedError(msg);
}

function checkPreTokenizer(pt: unknown): string {
  // Accept Sequence[Split(Regex, Isolated, invert=false), ByteLevel(use_regex=false, add_prefix_space=false)]
  if (!isObj(pt) || pt['type'] !== 'Sequence' || !Array.isArray(pt['pretokenizers'])) unsupported('pre_tokenizer must be a Sequence');
  const seq = pt['pretokenizers'] as unknown[];
  if (seq.length !== 2) unsupported('pre_tokenizer Sequence must have 2 entries');
  const [split, bl] = seq;
  if (!isObj(split) || split['type'] !== 'Split') unsupported('first pre_tokenizer must be Split');
  if (split['behavior'] !== 'Isolated' || split['invert'] !== false) unsupported('Split must be Isolated, invert=false');
  const pattern = split['pattern'];
  if (!isObj(pattern) || typeof pattern['Regex'] !== 'string') unsupported('Split pattern must be Regex');
  if (!isObj(bl) || bl['type'] !== 'ByteLevel' || bl['use_regex'] !== false || bl['add_prefix_space'] !== false)
    unsupported('second pre_tokenizer must be ByteLevel(use_regex=false, add_prefix_space=false)');
  return pattern['Regex'] as string;
}

function checkNormalizer(n: unknown): boolean {
  if (n === null || n === undefined) return false;
  if (isObj(n) && n['type'] === 'NFC') return true;
  if (isObj(n) && n['type'] === 'Sequence' && Array.isArray(n['normalizers'])) {
    const ns = n['normalizers'] as unknown[];
    if (ns.length === 0) return false;
    if (ns.length === 1 && isObj(ns[0]) && ns[0]['type'] === 'NFC') return true;
  }
  return unsupported(`normalizer ${JSON.stringify(n)}`);
}

/**
 * Compile vocab + merges into typed arrays. Kept in its own function so no closure of the
 * returned tokenizer captures the parsed JSON (V8 context allocation would retain ~100 MB).
 */
interface CompiledBpe {
  byteToId: Int32Array;
  /** [a, b, newId] per merge rank. */
  triples: Int32Array;
  maxBaseId: number;
}

function compileBpe(model: Json): CompiledBpe {
  const vocabObj = model['vocab'];
  if (!isObj(vocabObj)) unsupported('model.vocab');
  // Plain-object lookups: ~2x faster than copying 248k entries into a Map first.
  const vocabRec = vocabObj as Record<string, number>;
  const has = Object.prototype.hasOwnProperty;
  const get = (k: string): number | undefined => (has.call(vocabRec, k) ? vocabRec[k] : undefined);
  let maxBaseId = -1;
  for (const k in vocabRec) if (vocabRec[k]! > maxBaseId) maxBaseId = vocabRec[k]!;

  const b2u = bytesToUnicode();
  const byteToId = new Int32Array(256);
  for (let b = 0; b < 256; b++) {
    const id = get(b2u[b]!);
    if (id === undefined) unsupported(`byte ${b} missing from vocab`);
    byteToId[b] = id;
  }

  const merges = model['merges'];
  if (!Array.isArray(merges)) unsupported('model.merges');
  // Legacy "a b" strings: like Rust convert_merges_to_hashmap (models/bpe/model.rs:369-386),
  // "#version" lines are skipped (they take no rank) and a line must split into exactly 2 parts.
  const legacy = merges.filter((m) => !(typeof m === 'string' && m.startsWith('#version')));
  const triples = new Int32Array(legacy.length * 3);
  for (let r = 0; r < legacy.length; r++) {
    const m = legacy[r] as unknown;
    let a: string;
    let b: string;
    if (typeof m === 'string') {
      const parts = m.split(' ');
      if (parts.length !== 2) unsupported(`bad merge line ${r + 1}: ${m}`);
      a = parts[0]!;
      b = parts[1]!;
    } else if (Array.isArray(m) && m.length === 2) {
      a = String(m[0]);
      b = String(m[1]);
    } else unsupported('merge entry format');
    const ia = get(a);
    const ib = get(b);
    const ic = get(a + b);
    if (ia === undefined || ib === undefined || ic === undefined) unsupported(`merge token out of vocab: ${a} ${b}`);
    triples[3 * r] = ia;
    triples[3 * r + 1] = ib;
    triples[3 * r + 2] = ic;
  }
  return { triples, byteToId, maxBaseId };
}

function pairTableFrom(triples: Int32Array): PairTable {
  const n = triples.length / 3;
  const table = new PairTable(n);
  // In rank order: later duplicates overwrite, like Rust's HashMap collect.
  for (let r = 0; r < n; r++) table.set(triples[3 * r]!, triples[3 * r + 1]!, r, triples[3 * r + 2]!);
  return table;
}

export function tokenizerFromJson(json: unknown, opts: TokenizerOptions = {}, pre?: CompiledBpe): Tokenizer {
  if (!isObj(json)) unsupported('tokenizer.json is not an object');
  const model = json['model'];
  if (!isObj(model) || model['type'] !== 'BPE') unsupported('model must be BPE');
  if (model['dropout'] !== null && model['dropout'] !== undefined && model['dropout'] !== 0) unsupported('BPE dropout');
  if (model['continuing_subword_prefix'] || model['end_of_word_suffix']) unsupported('BPE subword prefix/suffix');
  if (model['byte_fallback'] === true) unsupported('BPE byte_fallback');
  if (model['ignore_merges'] === true) unsupported('BPE ignore_merges'); // easy to add: whole-piece vocab lookup first
  const useNfc = checkNormalizer(json['normalizer']);
  const nfc = opts.nfc === 'icu' ? hfNfc : nfc9;
  const regexSrc = translateOnigRegex(checkPreTokenizer(json['pre_tokenizer']));
  if (regexSrc.length > V8_REGEXP_TOO_LARGE_TO_OPTIMIZE)
    process.emitWarning(`pre-tokenizer regexp source is ${regexSrc.length} chars; V8 < 12 will not optimize it`);
  const preRe = new RegExp(regexSrc, 'gu');
  if (opts.nfc === 'icu' && (typeof ''.normalize !== 'function' || 'e\u0301'.normalize('NFC') !== '\u00e9'))
    unsupported('String.prototype.normalize is not functional (Node built without ICU?)');

  const compiled = pre ?? compileBpe(model);
  const { byteToId } = compiled;
  const table = pairTableFrom(compiled.triples);
  let maxId = compiled.maxBaseId;

  const added: AddedTok[] = [];
  const addedMap = new Map<string, number>();
  for (const t of (json['added_tokens'] as unknown[]) ?? []) {
    if (!isObj(t)) continue;
    if (t['single_word'] || t['lstrip'] || t['rstrip']) unsupported(`added token options on ${String(t['content'])}`);
    const tok: AddedTok = { content: String(t['content']), id: t['id'] as number, normalized: t['normalized'] === true };
    added.push(tok);
    addedMap.set(tok.content, tok.id);
    if (tok.id > maxId) maxId = tok.id;
  }
  const rawSplit = literalAlternation(added.filter((t) => !t.normalized));
  const normSplit = literalAlternation(
    added.filter((t) => t.normalized).map((t) => ({ ...t, content: useNfc ? nfc(t.content) : t.content })),
  );
  const vocabSize = maxId + 1;

  // ------------------------------------------------------------ BPE core
  const cacheSize = opts.cacheSize ?? 100_000;
  const cacheMaxLen = opts.cacheMaxPieceLength ?? 256;
  const heapThreshold = opts.heapThreshold ?? 96;
  const cache = new Map<string, Int32Array>();
  const rankArr = table.rank;
  const newIdArr = table.newId;

  let bytes = new Uint8Array(1024);
  let syms = new Int32Array(1024);
  let ranks = new Int32Array(1024);
  let slots = new Int32Array(1024);

  /** UTF-8 encode s into `bytes`; returns length. Lone surrogates -> U+FFFD (like TextEncoder). */
  function utf8(s: string): number {
    if (bytes.length < s.length * 3) bytes = new Uint8Array(s.length * 3 + 16);
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c < 0x80) {
        bytes[n++] = c;
        continue;
      }
      if (c < 0x800) {
        bytes[n++] = 0xc0 | (c >> 6);
        bytes[n++] = 0x80 | (c & 63);
        continue;
      }
      if (c >= 0xd800 && c <= 0xdfff) {
        const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
          bytes[n++] = 0xf0 | (c >> 18);
          bytes[n++] = 0x80 | ((c >> 12) & 63);
          bytes[n++] = 0x80 | ((c >> 6) & 63);
          bytes[n++] = 0x80 | (c & 63);
          continue;
        }
        c = 0xfffd;
      }
      bytes[n++] = 0xe0 | (c >> 12);
      bytes[n++] = 0x80 | ((c >> 6) & 63);
      bytes[n++] = 0x80 | (c & 63);
    }
    return n;
  }

  const NONE = 0x7fffffff;

  /** Simple O(n^2) variant: merge the leftmost lowest-rank pair until none applies. */
  function mergeSmall(n: number): number {
    for (let i = 0; i < n - 1; i++) {
      const s = table.find(syms[i]!, syms[i + 1]!);
      ranks[i] = s < 0 ? NONE : rankArr[s]!;
      slots[i] = s;
    }
    while (n > 1) {
      let best = NONE;
      let bi = -1;
      for (let i = 0; i < n - 1; i++) {
        const r = ranks[i]!;
        if (r < best) {
          best = r;
          bi = i;
        }
      }
      if (bi < 0) break;
      syms[bi] = newIdArr[slots[bi]!]!;
      // remove bi+1
      for (let j = bi + 1; j < n - 1; j++) {
        syms[j] = syms[j + 1]!;
        ranks[j] = ranks[j + 1]!;
        slots[j] = slots[j + 1]!;
      }
      n--;
      if (bi > 0) {
        const s = table.find(syms[bi - 1]!, syms[bi]!);
        ranks[bi - 1] = s < 0 ? NONE : rankArr[s]!;
        slots[bi - 1] = s;
      }
      if (bi < n - 1) {
        const s = table.find(syms[bi]!, syms[bi + 1]!);
        ranks[bi] = s < 0 ? NONE : rankArr[s]!;
        slots[bi] = s;
      }
    }
    return n;
  }

  /** Port of Rust `Word::merge_all` (min-heap on (rank, pos), stale-entry check). */
  function mergeHeap(n: number): number {
    const prev = new Int32Array(n);
    const next = new Int32Array(n);
    const alive = new Uint8Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      prev[i] = i - 1;
      next[i] = i + 1 < n ? i + 1 : -1;
    }
    // binary heap of (rank, pos, newId) packed in parallel arrays
    let hr = new Int32Array(n);
    let hp = new Int32Array(n);
    let hn = new Int32Array(n);
    let size = 0;
    const less = (i: number, j: number): boolean => hr[i]! < hr[j]! || (hr[i] === hr[j] && hp[i]! < hp[j]!);
    const swap = (i: number, j: number): void => {
      let t = hr[i]!; hr[i] = hr[j]!; hr[j] = t;
      t = hp[i]!; hp[i] = hp[j]!; hp[j] = t;
      t = hn[i]!; hn[i] = hn[j]!; hn[j] = t;
    };
    const push = (rank: number, pos: number, nid: number): void => {
      if (size === hr.length) {
        const g = (a: Int32Array): Int32Array<ArrayBuffer> => { const x = new Int32Array(a.length * 2); x.set(a); return x; };
        hr = g(hr); hp = g(hp); hn = g(hn);
      }
      let i = size++;
      hr[i] = rank; hp[i] = pos; hn[i] = nid;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!less(i, p)) break;
        swap(i, p);
        i = p;
      }
    };
    const pop = (): void => {
      size--;
      if (size > 0) {
        hr[0] = hr[size]!; hp[0] = hp[size]!; hn[0] = hn[size]!;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < size && less(l, m)) m = l;
          if (r < size && less(r, m)) m = r;
          if (m === i) break;
          swap(i, m);
          i = m;
        }
      }
    };
    for (let i = 0; i < n - 1; i++) {
      const s = table.find(syms[i]!, syms[i + 1]!);
      if (s >= 0) push(rankArr[s]!, i, newIdArr[s]!);
    }
    while (size > 0) {
      const pos = hp[0]!;
      const nid = hn[0]!;
      pop();
      if (!alive[pos]) continue;
      const nx = next[pos]!;
      if (nx === -1) continue;
      const s = table.find(syms[pos]!, syms[nx]!);
      if (s < 0 || newIdArr[s] !== nid) continue; // expired entry
      syms[pos] = nid;
      alive[nx] = 0;
      const nn = next[nx]!;
      next[pos] = nn;
      if (nn !== -1) prev[nn] = pos;
      const pv = prev[pos]!;
      if (pv >= 0) {
        const s2 = table.find(syms[pv]!, syms[pos]!);
        if (s2 >= 0) push(rankArr[s2]!, pv, newIdArr[s2]!);
      }
      if (nn !== -1) {
        const s3 = table.find(syms[pos]!, syms[nn]!);
        if (s3 >= 0) push(rankArr[s3]!, pos, newIdArr[s3]!);
      }
    }
    let k = 0;
    for (let i = 0; i < n; i++) if (alive[i]) syms[k++] = syms[i]!;
    return k;
  }

  function bpe(piece: string): Int32Array {
    const useCache = cacheSize > 0 && piece.length < cacheMaxLen;
    if (useCache) {
      const hit = cache.get(piece);
      if (hit !== undefined) return hit;
    }
    const n = utf8(piece);
    if (syms.length < n) {
      syms = new Int32Array(n * 2);
      ranks = new Int32Array(n * 2);
      slots = new Int32Array(n * 2);
    }
    for (let i = 0; i < n; i++) syms[i] = byteToId[bytes[i]!]!;
    const k = n > heapThreshold ? mergeHeap(n) : mergeSmall(n);
    const res = syms.slice(0, k);
    if (useCache) {
      if (cache.size >= cacheSize) cache.clear();
      cache.set(piece, res);
    }
    return res;
  }

  // ------------------------------------------------------------ pipeline
  type Sink = (ids: Int32Array | number) => void;

  function preTokenize(seg: string, sink: Sink): void {
    if (seg.length === 0) return;
    preRe.lastIndex = 0;
    let last = 0;
    for (let m = preRe.exec(seg); m !== null; m = preRe.exec(seg)) {
      if (m.index > last) sink(bpe(seg.slice(last, m.index))); // gap (Isolated keeps it)
      if (m[0].length === 0) {
        preRe.lastIndex++; // unreachable for Qwen's pattern; mirrors onig find_iter advancing
        continue;
      }
      sink(bpe(m[0]));
      last = m.index + m[0].length;
    }
    if (last < seg.length) sink(bpe(seg.slice(last)));
  }

  function afterRawSplit(seg: string, sink: Sink): void {
    if (seg.length === 0) return;
    const norm = useNfc ? nfc(seg) : seg;
    if (normSplit === null) return preTokenize(norm, sink);
    splitOn(norm, normSplit, sink, preTokenize);
  }

  function splitOn(s: string, re: RegExp, sink: Sink, rest: (seg: string, sink: Sink) => void): void {
    re.lastIndex = 0;
    let last = 0;
    for (let m = re.exec(s); m !== null; m = re.exec(s)) {
      rest(s.slice(last, m.index), sink);
      sink(addedMap.get(m[0])!);
      last = m.index + m[0].length;
    }
    rest(s.slice(last), sink);
  }

  function run(text: string, sink: Sink): void {
    if (rawSplit === null) afterRawSplit(text, sink);
    else splitOn(text, rawSplit, sink, afterRawSplit);
  }

  return {
    vocabSize,
    addedTokens: addedMap,
    encode(text: string): number[] {
      const out: number[] = [];
      run(text, (x) => {
        if (typeof x === 'number') out.push(x);
        else for (let i = 0; i < x.length; i++) out.push(x[i]!);
      });
      return out;
    },
    count(text: string): number {
      let n = 0;
      run(text, (x) => {
        n += typeof x === 'number' ? 1 : x.length;
      });
      return n;
    },
    clearCache(): void {
      cache.clear();
    },
  };
}

// ---------------------------------------------------------------- compiled cache
// Layout (little-endian): "LCTK" u32 version | 32-byte sha256(tokenizer.json bytes) |
// u32 headerLen | header JSON (tokenizer.json minus vocab/merges, plus maxBaseId) | pad4 |
// u32 nMerges | i32 byteToId[256] | i32 triples[3*nMerges]
const MAGIC = 0x4b54434c; // "LCTK"
const CACHE_VERSION = 1;

export function serializeCompiled(json: unknown, sha256: Uint8Array): Uint8Array {
  if (!isObj(json) || !isObj(json['model'])) unsupported('tokenizer.json is not an object');
  const c = compileBpe(json['model']);
  const { vocab: _v, merges: _m, ...modelRest } = json['model'];
  const header = new TextEncoder().encode(JSON.stringify({ ...json, model: modelRest, maxBaseId: c.maxBaseId }));
  const headLen = 4 + 4 + 32 + 4 + header.length;
  const pad = (4 - (headLen % 4)) % 4;
  const buf = new Uint8Array(headLen + pad + 4 + 256 * 4 + c.triples.length * 4);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, CACHE_VERSION, true);
  buf.set(sha256.subarray(0, 32), 8);
  dv.setUint32(40, header.length, true);
  buf.set(header, 44);
  let off = headLen + pad;
  dv.setUint32(off, c.triples.length / 3, true);
  off += 4;
  new Int32Array(buf.buffer, off, 256).set(c.byteToId);
  off += 1024;
  new Int32Array(buf.buffer, off, c.triples.length).set(c.triples);
  return buf;
}

export function tokenizerFromCompiled(buf: Uint8Array, expectSha256?: Uint8Array, opts?: TokenizerOptions): Tokenizer | null {
  if (buf.length < 48 || new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) return null; // LE hosts only
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== CACHE_VERSION) return null;
  if (expectSha256) for (let i = 0; i < 32; i++) if (buf[8 + i] !== expectSha256[i]) return null;
  const hl = dv.getUint32(40, true);
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(44, 44 + hl))) as Json;
  let off = 44 + hl;
  off += (4 - (off % 4)) % 4;
  const n = dv.getUint32(off, true);
  off += 4;
  const aligned = new Uint8Array(buf.length - off); // copy => aligned Int32 views
  aligned.set(buf.subarray(off));
  const byteToId = new Int32Array(aligned.buffer, 0, 256);
  const triples = new Int32Array(aligned.buffer, 1024, n * 3);
  return tokenizerFromJson(header, opts, { byteToId, triples, maxBaseId: header['maxBaseId'] as number });
}

export interface LoadOptions extends TokenizerOptions {
  /** Path of a compiled cache file; created/refreshed when missing or stale (best effort). */
  cachePath?: string;
}

export function loadTokenizer(path: string, opts: LoadOptions = {}): Tokenizer {
  const bytes = readFileSync(path);
  if (opts.cachePath) {
    const sha = createHash('sha256').update(bytes).digest();
    try {
      const t = tokenizerFromCompiled(readFileSync(opts.cachePath), sha, opts);
      if (t) return t;
    } catch {
      /* stale or corrupt cache: rebuild */
    }
    const json = JSON.parse(bytes.toString('utf8')) as unknown;
    const tok = tokenizerFromJson(json, opts);
    try {
      writeFileSync(opts.cachePath + '.tmp', serializeCompiled(json, sha));
      renameSync(opts.cachePath + '.tmp', opts.cachePath);
    } catch {
      /* read-only location: run without cache */
    }
    return tok;
  }
  return tokenizerFromJson(JSON.parse(bytes.toString('utf8')) as unknown, opts);
}
