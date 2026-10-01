// Copyright 2012-2015 The Rust Project Developers. MIT; see LICENSES/unicode-normalization-alignments-MIT.txt.
// ICU-independent NFC, a line-by-line port of the Rust crate unicode-normalization-alignments
// 0.1.12 (Decompositions + Recompositions, src/decompose.rs and src/recompose.rs) over its
// Unicode 9.0 tables (src/nfc9-tables.ts). This is exactly what HF tokenizers' `NFC` normalizer
// computes, whatever ICU/Unicode version the running Node ships.
import { NFC9_CCC, NFC9_DECOMP, NFC9_COMP } from './nfc9-tables.js';

const nums = (s: string): number[] => s.split(',').map((x) => parseInt(x, 36));

// Hangul constants (Unicode 9.0.0 section 3.12), as in the crate's normalize.rs.
const S_BASE = 0xac00, L_BASE = 0x1100, V_BASE = 0x1161, T_BASE = 0x11a7;
const L_COUNT = 19, V_COUNT = 21, T_COUNT = 28;
const N_COUNT = V_COUNT * T_COUNT, S_COUNT = L_COUNT * N_COUNT;
const S_LAST = S_BASE + S_COUNT - 1, L_LAST = L_BASE + L_COUNT - 1, V_LAST = V_BASE + V_COUNT - 1, T_LAST = T_BASE + T_COUNT - 1;
const T_FIRST = T_BASE + 1;

let ready = false;
let CCC: Uint8Array; // indexed by code point, sized to the largest entry
const DECOMP = new Map<number, Int32Array>();
const COMP = new Map<number, number>(); // a * 0x110000 + b -> composite
let NEEDS: Uint8Array; // 1 = code point can make a string non-NFC (see init)

const ccc = (c: number): number => (c < CCC.length ? CCC[c]! : 0);

function compose(a: number, b: number): number {
  if (a >= L_BASE && a <= L_LAST && b >= V_BASE && b <= V_LAST)
    return S_BASE + (a - L_BASE) * N_COUNT + (b - V_BASE) * T_COUNT;
  if (a >= S_BASE && a <= S_LAST && b >= T_FIRST && b <= T_LAST && (a - S_BASE) % T_COUNT === 0) return a + (b - T_BASE);
  return COMP.get(a * 0x110000 + b) ?? -1;
}

function init(): void {
  const c = nums(NFC9_CCC);
  let cp = 0;
  let max = 0;
  for (let i = 0; i < c.length; i += 2) max = Math.max(max, (cp += c[i]!));
  CCC = new Uint8Array(max + 1);
  cp = 0;
  for (let i = 0; i < c.length; i += 2) CCC[(cp += c[i]!)] = c[i + 1]!;
  const d = nums(NFC9_DECOMP);
  cp = 0;
  for (let i = 0; i < d.length; ) {
    cp += d[i]!;
    const n = d[i + 1]!;
    DECOMP.set(cp, Int32Array.from(d.slice(i + 2, i + 2 + n)));
    i += 2 + n;
  }
  const k = nums(NFC9_COMP);
  const seconds = new Set<number>();
  for (let i = 0; i < k.length; i += 3) {
    COMP.set(k[i]! * 0x110000 + k[i + 1]!, k[i + 2]!);
    seconds.add(k[i + 1]!);
  }
  ready = true;
  // NEEDS = ccc != 0, or decomposes to something that does not recompose to itself (NFC_QC=No),
  // or can be the second half of a composition (NFC_QC=Maybe, incl. Hangul V/T jamo).
  // A string with none of these is returned unchanged by the crate's algorithm.
  const set = new Set<number>(seconds);
  for (let x = 0; x < CCC.length; x++) if (CCC[x]) set.add(x);
  for (const x of DECOMP.keys()) if (nfc9Full(String.fromCodePoint(x)) !== String.fromCodePoint(x)) set.add(x);
  for (let x = V_BASE; x <= V_LAST; x++) set.add(x);
  for (let x = T_FIRST; x <= T_LAST; x++) set.add(x);
  let top = 0;
  for (const x of set) if (x > top) top = x;
  NEEDS = new Uint8Array(top + 1);
  for (const x of set) NEEDS[x] = 1;
  // Every other code point has ccc=0, is NFC_QC=Yes and is not the second half of any
  // composition, so nothing before it can reorder or compose with anything after it: the
  // text splits into independent spans there. Only spans with a NEEDS char are processed,
  // together with the one boundary char right before them (it may compose with them).
}

// Scratch buffers reused across calls.
let cps = new Int32Array(256);
let cls = new Uint8Array(256);

function nfc9Full(s: string): string {
  // 1. Canonical decomposition + canonical ordering (stable sort of each run of ccc != 0).
  let n = 0;
  let runStart = -1;
  const push = (c: number): void => {
    if (n === cps.length) {
      const a = new Int32Array(n * 2); a.set(cps); cps = a;
      const b = new Uint8Array(n * 2); b.set(cls); cls = b;
    }
    const k = ccc(c);
    if (k === 0) {
      if (runStart >= 0) sortRun(runStart, n);
      runStart = -1;
    } else if (runStart < 0) runStart = n;
    cps[n] = c;
    cls[n] = k;
    n++;
  };
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c <= 0x7f) push(c);
    else if (c >= S_BASE && c <= S_LAST) {
      const si = c - S_BASE;
      push(L_BASE + Math.floor(si / N_COUNT));
      push(V_BASE + Math.floor((si % N_COUNT) / T_COUNT));
      const ti = si % T_COUNT;
      if (ti > 0) push(T_BASE + ti);
    } else {
      const dd = DECOMP.get(c);
      if (dd === undefined) push(c);
      else for (let j = 0; j < dd.length; j++) push(dd[j]!);
    }
  }
  if (runStart >= 0) sortRun(runStart, n);

  // 2. Recomposition: the crate's Recompositions state machine.
  const out: number[] = [];
  let composee = -1;
  let lastCcc = -1; // -1 = None
  const buffer: number[] = [];
  for (let i = 0; i < n; i++) {
    const ch = cps[i]!;
    const chClass = cls[i]!;
    if (composee < 0) {
      if (chClass !== 0) { out.push(ch); continue; }
      composee = ch;
      continue;
    }
    if (lastCcc < 0) {
      const r = compose(composee, ch);
      if (r >= 0) { composee = r; continue; }
      if (chClass === 0) { out.push(composee); composee = ch; continue; }
      buffer.push(ch);
      lastCcc = chClass;
    } else {
      if (lastCcc >= chClass) {
        if (chClass === 0) {
          out.push(composee);
          for (const b of buffer) out.push(b);
          buffer.length = 0;
          composee = ch;
          lastCcc = -1;
          continue;
        }
        buffer.push(ch);
        lastCcc = chClass;
        continue;
      }
      const r = compose(composee, ch);
      if (r >= 0) { composee = r; continue; }
      buffer.push(ch);
      lastCcc = chClass;
    }
  }
  if (composee >= 0) out.push(composee);
  for (const b of buffer) out.push(b);
  let r = '';
  for (let i = 0; i < out.length; i += 4096) r += String.fromCodePoint(...out.slice(i, i + 4096));
  return r;
}

/** Stable insertion sort of cps/cls[a, b) by ccc (runs are short). */
function sortRun(a: number, b: number): void {
  for (let i = a + 1; i < b; i++) {
    const c = cps[i]!;
    const k = cls[i]!;
    let j = i - 1;
    while (j >= a && cls[j]! > k) { cps[j + 1] = cps[j]!; cls[j + 1] = cls[j]!; j--; }
    cps[j + 1] = c;
    cls[j + 1] = k;
  }
}

const MAYBE_NOT_NFC = /[^\u0000-\u02ff]/;

/** NFC exactly as HF tokenizers (unicode-normalization-alignments 0.1.12, Unicode 9.0). */
export function nfc9(s: string): string {
  if (!MAYBE_NOT_NFC.test(s)) return s;
  if (!ready) init();
  const needs = NEEDS;
  const top = needs.length;
  let out = '';
  let last = 0; // s[last..] not yet copied to out
  let prevStart = -1; // start index of the previous code point
  for (let i = 0; i < s.length; ) {
    let c = s.charCodeAt(i);
    let w = 1;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); w = 2; }
    }
    if (c < 0x300 || c >= top || needs[c] === 0) { prevStart = i; i += w; continue; }
    // Region: the boundary char before (if any, and not already emitted) + maximal NEEDS run.
    const start = prevStart >= last ? prevStart : i;
    let j = i + w;
    while (j < s.length) {
      let e = s.charCodeAt(j);
      let v = 1;
      if (e >= 0xd800 && e <= 0xdbff && j + 1 < s.length) {
        const f = s.charCodeAt(j + 1);
        if (f >= 0xdc00 && f <= 0xdfff) { e = 0x10000 + ((e - 0xd800) << 10) + (f - 0xdc00); v = 2; }
      }
      if (e < 0x300 || e >= top || needs[e] === 0) break;
      j += v;
    }
    out += s.slice(last, start) + nfc9Full(s.slice(start, j));
    last = j;
    prevStart = -1;
    i = j;
  }
  return last === 0 ? s : out + s.slice(last);
}
