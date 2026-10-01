// `kitzur config import-eval`: gateway-probes results -> config knobs, as data (DESIGN.md).
//
// Maps gateway probe result schemas into the kitzur configuration:
//     no absolute compaction.triggerTokens/targetTokens (and no margin rule); instead
//        client.outputAllowanceTokens = min(T_plan, max(2000, p99(completion_tokens)))
//     the pack's outputReserve (prompt-only limits) -> budget.planMaxTokens
//     budget.limitCountsMaxTokens only (never server.budgetMode); error-entry kinds mapped to ErrorKind;
//        browserAction -> rules.toolNames.snapshot; basePath printed as the client baseURL;
//        tinyPromptTokens and snapshot.maxTokens only in the provenance sidecar.
// Other deviations from the prototype (each fixes a case it got wrong or loses information on):
//   - only measured, client-config and derived knobs are written; defaults, inconclusive verdicts and the
//     operator's probe flags stay in the provenance (the built-in default or the preset applies), so a
//     re-import never pins a guess; an inconclusive limitCountsMaxTokens stays null (server.type decides,
//     which is strict_total for an unknown server, the prototype's `true`);
//   - an in-stream (HTTP 200 + SSE error) overflow row becomes an SSE entry (status [null]) instead of an
//     empty-match HTTP entry; fingerprinted in-stream bodies need no entry (built-ins match any status);
//   - generated regexes are escaped for JS (Python re.escape writes '\ ' for spaces) and name the numbers
//     they recognise ((?<window>\d+), (?<prompt>\d+), (?<completion>\d+)) when they equal measured values;
//   - observed tool names are added to the default globs only when no default glob matches them;
//   - error rules come only from overflow statuses (400, 413, 422, 5xx; never a 401 "invalid token" or a
//     429), a captured in-stream error only from the error events in its SSE tail (never from content
//     deltas), and a JSON body the pack truncated gives its "message" string, else a rule on the raw body;
//   - the written config is validated as `serve -c` would load it; a failure, or a prompt budget under a
//     quarter of the window (a 32k server with the client's max_tokens 32000), is a conflict (exit 11).
//
// Pure: `mapEvalResults` is a function of the loaded results (no clock, no network, sorted output).
// `readEvalInputs` does the file I/O: result JSON files, pasted RESULT blocks (checksums verified),
// and optionally a raw capture.jsonl (completion-token p99).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parsePyJson, pyDumps } from '../tokenize/pyjson.js';
import type { ErrorRule } from '../types.js';
import { DEFAULT_CONFIG, type Config } from './schema.js';
import { computeBudget, planMaxTokens, resolveBudgetMode } from './derived.js';
import { getPath, isPlainObject, setPath } from './spec.js';
import { globToRegExp, validateConfig } from './validate.js';

type J = Record<string, unknown>;

export const PACK_VERSIONS: readonly string[] = ['1'];
export const KNOWN_SCRIPTS: readonly string[] = ['check_host', 'collect_config', 'probe_gateway', 'summarize_capture'];
const BLOCK_RE = /===RESULT-BEGIN (\S+)===\r?\n([\s\S]*?)\r?\n===RESULT-END \1 sha256:([0-9a-f]{16})===/g;

// ---------------------------------------------------------------- built-in knowledge (from the prototype)

/** (server type, regex on the raw body) - first match wins. */
export const SERVER_FINGERPRINTS: ReadonlyArray<readonly [Config['server']['type'], RegExp]> = [
  ['vllm', /maximum context length is \d+ tokens\. However, you requested/],
  ['vllm', /'max_tokens' or 'max_completion_tokens' is too large/],
  ['vllm', /This model's maximum context length is \d+ tokens/],
  ['llamacpp', /exceed_context_size_error|exceeds the available context size/],
  ['tgi', /`inputs` tokens \+ `max_new_tokens` must be <= \d+/],
  ['sglang', /is longer than the model'?s context length \(\d+ tokens\)/],
  ['ollama', /prompt too long; exceeded (?:max )?context length/],
  ['lmstudio', /context length of only \d+ tokens/],
  ['litellm', /ContextWindowExceededError/],
];
const WINDOW_RX = [/maximum context length is (\d+)/, /"n_ctx"\s*:\s*(\d+)/, /must be <= (\d+)/, /context length \((\d+) tokens\)/, /context length of only (\d+)/, /context size is (\d+)/];
const PROMPT_RX = [/\((\d+) in the messages/, /"n_prompt_tokens"\s*:\s*(\d+)/, /Given: (\d+) `inputs`/, /input \((\d+) tokens\)/, /request has (\d+) input tokens/, /prompt has (\d+) tokens/];
const OVERFLOW_WORDS = /context|token|length|too long|too large|exceed/i;
const RATIO_KIND: Readonly<Record<string, keyof Config['tokenizer']['fallback']['charsPerToken']>> = {
  english_prose: 'prose', typescript_code: 'code', playwright_snapshot_en: 'snapshot',
  test_runner_output: 'testOutput', json_api: 'json', playwright_snapshot_he: 'snapshotNonLatin',
};
/** role -> patterns matched against observed tool names; browserAction merges into snapshot (). */
const TOOL_ROLES: ReadonlyArray<readonly [keyof Config['rules']['toolNames'], RegExp[]]> = [
  ['snapshot', [/browser_snapshot$/, /browser_(click|type|fill_form|select_option|hover|press_key|drag|file_upload|handle_dialog|wait_for|evaluate|resize)$/]],
  ['browserNavigate', [/browser_navigate$/, /browser_navigate_back$/, /browser_tabs$/]],
  ['todo', [/^todowrite$/, /^todo_write$/, /^update_todo_list$/]],
  ['read', [/^read$/, /^read_file$/]],
  ['edit', [/^edit$/, /^multiedit$/, /^apply_patch$/, /^patch$/, /^apply_diff$/, /^search_and_replace$/]],
  ['write', [/^write$/, /^write_to_file$/]],
  ['shell', [/^bash$/, /^execute_command$/]],
];
const SERVER_TYPES = new Set(['vllm', 'sglang', 'llamacpp', 'tgi', 'ollama', 'lmstudio', 'litellm']);
/** upstream.timeoutMs upper bound (spec.ts) */
const MAX_TIMEOUT_MS = 24 * 3600 * 1000;
const OVERFLOW_ROWS = ['prompt_alone_over_window', 'prompt_alone_over_window_streaming', 'prompt_plus_max_tokens_over_window', 'both_under_window'] as const;

// ---------------------------------------------------------------- types

/** How a knob's value is known (reference implementation). */
export type Confidence = 'measured' | 'client-config' | 'derived' | 'operator-assumption' | 'default' | 'inconclusive' | 'manual';

export interface KnobRecord {
  value: unknown;
  /** "<script>#/json/pointer" of the evidence */
  source: string;
  /** the mapping rule applied */
  rule: string;
  confidence: Confidence;
}

export interface ImportResult {
  /** the knobs written (nested, keys sorted); default/unknown knobs are absent */
  config: J;
  /** every knob decided, written or not (path -> record) */
  provenance: Record<string, KnobRecord>;
  /** informational values that are not config knobs (tinyPromptTokens, snapshot maxTokens, basePath, ...) */
  info: Record<string, KnobRecord>;
  warnings: string[];
  /** conflicting measurements (exit code 11) */
  conflicts: string[];
  /** safety-critical knobs that are not measured or client-config (exit code 10) */
  unsafe: string[];
  /** what the pack cannot provide: set by hand */
  todos: string[];
  /** human questions from RESULTS_TEMPLATE.md §4 that affect config */
  questions: string[];
  /** the client's baseURL through kitzur (basePath is not a knob; ) */
  clientBaseUrl: string | null;
  /** replay_session_* summaries (report only) */
  replays: string[];
  /** 0 = every safety-critical knob measured or client-config; 10 = some is not; 11 = conflicting measurements */
  exitCode: 0 | 10 | 11;
}

export interface MapOptions {
  /** listen port for the printed client baseURL (default DEFAULT_CONFIG.listen.port) */
  port?: number;
  /** raw capture records (capture.jsonl), for the completion-token p99 */
  capture?: J[] | null;
  /** our exact count of the probe's tiny request, to compare with the server's (template check) */
  tinyCount?: number | null;
}

// ---------------------------------------------------------------- small helpers

const obj = (x: unknown): J => (isPlainObject(x) ? x : {});
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
/** Python truthiness for JSON values. */
const truthy = (x: unknown): boolean =>
  !(x === null || x === undefined || x === false || x === 0 || x === '' || (Array.isArray(x) && x.length === 0) || (isPlainObject(x) && Object.keys(x).length === 0));

function get(d: unknown, ...path: string[]): unknown {
  let cur = d;
  for (const k of path) {
    if (!isPlainObject(cur) || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function firstInt(rxs: RegExp[], text: unknown): number | null {
  const t = typeof text === 'string' ? text : '';
  for (const rx of rxs) {
    const m = rx.exec(t);
    if (m) return parseInt(m[1]!, 10);
  }
  return null;
}

/** Python round() (half to even), for parity with the prototype. */
export function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** The pack's percentile (common.py dist): sorted[min(n-1, round(p/100·(n-1)))]. */
export function packPercentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, pyRound((p / 100) * (s.length - 1)))]!;
}

/** The human message inside an error body (JSON or text), as the prototype's message_of. */
export function messageOf(body: string): string {
  return errorText(body).text;
}

/**
 * The text an error rule is generated from, and what the rule must run on. A JSON body gives its message
 * (`on: 'message'`, as the proxy extracts it). The pack keeps only the first 3000 (probe) or 2000
 * (capture) characters of a body, so a long JSON body arrives cut and unparsable: its message is then
 * read from the first complete `"message": "…"` string, and if there is none the rule runs on the raw
 * body (`on: 'body'`), whose start it matches. A plain-text body is its own message.
 */
export function errorText(body: string): { text: string; on: 'message' | 'body' } {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    if (!/^\s*[{[]/.test(body)) return { text: body, on: 'message' };
    const m = /"message"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(body);
    if (m) {
      try {
        const t = JSON.parse(m[1]!) as unknown;
        if (typeof t === 'string' && t.trim()) return { text: t, on: 'message' };
      } catch {
        /* fall through */
      }
    }
    return { text: body, on: 'body' };
  }
  if (isPlainObject(j)) {
    const e = j['error'];
    if (isPlainObject(e) && typeof e['message'] === 'string') return { text: e['message'], on: 'message' };
    for (const k of ['message', 'error', 'detail']) if (typeof j[k] === 'string') return { text: j[k] as string, on: 'message' };
  }
  return { text: body, on: 'message' };
}

/**
 * The error events of a captured SSE tail (capture.jsonl in_stream_error: the masked last 2000 characters
 * of a 200 stream, content deltas included): the payload of each complete `data:` line with a top-level
 * "error". Content and usage chunks are never returned, so no rule is generated from model output.
 */
export function sseErrorPayloads(tail: string): string[] {
  const out: string[] = [];
  for (const line of tail.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m) continue;
    try {
      const ev = JSON.parse(m[1]!) as unknown;
      if (isPlainObject(ev) && 'error' in ev) out.push(m[1]!);
    } catch {
      /* the first line of the tail is usually cut */
    }
  }
  return out;
}

/**
 * HTTP statuses an overflow can arrive with: 400/413/422 and 5xx (a gateway may re-status it). 401, 403,
 * 404 and 429 bodies ("invalid token", "tokens per minute") are never turned into overflow rules.
 */
const overflowStatus = (s: number): boolean => s === 400 || s === 413 || s === 422 || (s >= 500 && s <= 599);

const escapeJs = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Regex for an error message seen in a real body: the text escaped (first 300 chars), masked tokens
 * (<url>, <host>, <ip>, <email>, <gateway-host>) as \S+, and digit runs as \d+ - named after the measured
 * value they equal (window, prompt, completion; first occurrence each), so the rule can teach numbers.
 *
 * The rule runs on every upstream error body, so it must not backtrack catastrophically (ReDoS): adjacent
 * quantified pieces with overlapping classes (`\S+\S+`, `\d+\S+`, `\S+,\S+,\S+` from a body that lists hosts)
 * take exponential time on a non-matching body. So a run of masks and digit runs with nothing between them
 * becomes one `\S+` (a digit run there loses its name), and a mask followed by a literal that starts with a
 * non-space character stops at the first occurrence of that literal (`(?:(?!,)\S)+,`). Every quantified piece
 * is then bounded by literals it cannot run into, and matching is polynomial. A leading or trailing mask is a
 * single character: the rule is searched unanchored, so that matches exactly the same bodies.
 */
export function messageRegex(msg: string, known: { window?: number | null; prompt?: number | null; completion?: number | null } = {}): string {
  const text = msg.trim().slice(0, 300);
  type Piece = { k: 'lit'; s: string } | { k: 'dig'; v: number } | { k: 'mask' };
  const raw: Piece[] = [];
  for (const tok of text.split(/(\d+|<(?:url|host|ip|email|gateway-host)>)/)) {
    if (tok === '') continue;
    if (/^\d+$/.test(tok)) raw.push({ k: 'dig', v: Number(tok) });
    else if (/^<(?:url|host|ip|email|gateway-host)>$/.test(tok)) raw.push({ k: 'mask' });
    else raw.push({ k: 'lit', s: tok });
  }
  // merge every run of masks and digit runs that holds a mask into one mask
  const pieces: Piece[] = [];
  for (let i = 0; i < raw.length; ) {
    if (raw[i]!.k === 'lit') {
      pieces.push(raw[i++]!);
      continue;
    }
    let j = i;
    let mask = false;
    for (; j < raw.length && raw[j]!.k !== 'lit'; j++) if (raw[j]!.k === 'mask') mask = true;
    if (mask) pieces.push({ k: 'mask' });
    else pieces.push(...raw.slice(i, j)); // a single digit run (split keeps digit runs maximal)
    i = j;
  }
  const named = new Set<string>();
  let out = '';
  pieces.forEach((p, i) => {
    if (p.k === 'lit') out += escapeJs(p.s);
    else if (p.k === 'dig') {
      const name = (['window', 'prompt', 'completion'] as const).find((k) => known[k] != null && known[k] === p.v && !named.has(k));
      if (name) {
        named.add(name);
        out += `(?<${name}>\\d+)`;
      } else out += '\\d+';
    } else {
      const next = pieces[i + 1];
      // the rule is searched unanchored: a leading or trailing mask needs one character, not a run (a leading
      // `\S+` costs O(n²) on a long non-space body)
      const q = i === 0 || i === pieces.length - 1 ? '' : '+';
      if (next && next.k === 'lit' && !/^\s/.test(next.s)) {
        // stop at the first occurrence of the next literal (its first 16 characters, on a code-point boundary)
        const stop = Array.from(next.s).slice(0, 16).join('');
        out += `(?:(?!${escapeJs(stop)})\\S)${q}`;
      } else out += `\\S${q}`;
    }
  });
  return out;
}

function fingerprint(text: string): Config['server']['type'] | null {
  for (const [t, rx] of SERVER_FINGERPRINTS) if (rx.test(text)) return t;
  return null;
}

/** sha256(text)[:16], the pack's block checksum. */
export function packDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** True when `text` is exactly the pack's canonical file form: json.dumps(indent=1, ensure_ascii=False, sort_keys=True) + "\n". */
export function isCanonicalPackText(text: string): boolean {
  try {
    return pyDumps(parsePyJson(text), { indent: 1, ensureAscii: false, sortKeys: true }) + '\n' === text;
  } catch {
    return false;
  }
}

/** Pasted RESULT blocks in a text (probe.out, a chat transcript), with checksum verification. */
export function extractBlocks(text: string): Array<{ name: string; body: string; digest: string; ok: boolean }> {
  const out: Array<{ name: string; body: string; digest: string; ok: boolean }> = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const body = m[2]!;
    out.push({ name: m[1]!, body, digest: m[3]!, ok: packDigest(body) === m[3] });
  }
  return out;
}

/** "%Y-%m-%dT%H:%M:%S%z" (local time with offset) -> epoch ms; NaN when unparsable. */
export function parseGenerated(s: unknown): number {
  if (typeof s !== 'string') return NaN;
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:([+-])(\d\d):?(\d\d)|Z)?$/.exec(s.trim());
  if (!m) return NaN;
  return Date.parse(m[2] ? `${m[1]}${m[2]}${m[3]}:${m[4]}` : `${m[1]}Z`);
}

// ---------------------------------------------------------------- loading (I/O)

interface Candidate {
  script: string;
  obj: J;
  src: string;
  canonical: boolean;
  digest: string;
  block: boolean;
}

export interface EvalInputs {
  /** script name -> result object (one per script; every replay_session_<label> kept) */
  results: Record<string, J>;
  /** script name -> the file (or file#block) it came from */
  sources: Record<string, string>;
  /** raw capture.jsonl records, if one was given */
  capture: J[] | null;
  warnings: string[];
  /** files that are not gateway-probes results */
  ignored: string[];
  /** fatal input problems (exit code 1) */
  invalid: string[];
  /** number of result candidates seen (valid or not) */
  candidates: number;
}

/**
 * Reads gateway-probes inputs: directories (their direct entries) and files. `*.json` with `script` and
 * `pack_version` are results; `*.out|*.txt|*.md|*.log` are scanned for RESULT blocks; `capture.jsonl`
 * is read as raw capture records. Blocks with a wrong checksum are ignored with a warning.
 */
export function readEvalInputs(paths: string[], opts: { allowPackVersions?: readonly string[] } = {}): EvalInputs {
  const allow = new Set([...PACK_VERSIONS, ...(opts.allowPackVersions ?? [])]);
  const warnings: string[] = [];
  const ignored: string[] = [];
  const invalid: string[] = [];
  const cands: Candidate[] = [];
  let capture: J[] | null = null;
  const files: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      invalid.push(`input not found: ${p}`);
      continue;
    }
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) if (statSync(join(p, f)).isFile()) files.push(join(p, f));
    } else files.push(p);
  }
  for (const f of files) {
    const name = basename(f);
    if (name.endsWith('.jsonl') && name.startsWith('capture')) {
      capture = capture ?? [];
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as unknown;
          if (isPlainObject(r)) capture.push(r);
        } catch {
          warnings.push(`${name}: an unreadable line was skipped`);
        }
      }
    } else if (name.endsWith('.json')) {
      const txt = readFileSync(f, 'utf8');
      let o: unknown;
      try {
        o = JSON.parse(txt);
      } catch (e) {
        warnings.push(`${name}: unreadable JSON (${(e as Error).name}), ignored`);
        continue;
      }
      if (!isPlainObject(o) || typeof o['script'] !== 'string' || !('pack_version' in o)) {
        ignored.push(name);
        continue;
      }
      const canonical = isCanonicalPackText(txt);
      if (!canonical) warnings.push(`${name}: not in the pack's canonical form (edited by hand?)`);
      cands.push({ script: o['script'], obj: o, src: name, canonical, digest: packDigest(txt.replace(/\n+$/, '')), block: false });
    } else if (/\.(out|txt|md|log)$/.test(name)) {
      for (const b of extractBlocks(readFileSync(f, 'utf8'))) {
        if (!b.ok) {
          warnings.push(`${name}: block ${b.name} checksum MISMATCH (altered while copying), ignored`);
          continue;
        }
        let o: unknown;
        try {
          o = JSON.parse(b.body);
        } catch {
          warnings.push(`${name}: block ${b.name} is not JSON, ignored`);
          continue;
        }
        if (!isPlainObject(o)) continue;
        cands.push({ script: b.name, obj: o, src: `${name}#${b.name}`, canonical: true, digest: b.digest, block: true });
      }
    } else ignored.push(name);
  }

  const byScript = new Map<string, Candidate[]>();
  for (const c of cands) {
    const pv = c.obj['pack_version'];
    if (typeof pv !== 'string' || !allow.has(pv)) {
      invalid.push(`${c.src}: unsupported pack_version ${JSON.stringify(pv)} (supported: ${[...allow].join(', ')}; see --allow-pack-version)`);
      continue;
    }
    if (!KNOWN_SCRIPTS.includes(c.script) && !/^replay_session_.+$/.test(c.script)) {
      ignored.push(`${c.src} (unknown script ${c.script})`);
      continue;
    }
    byScript.set(c.script, [...(byScript.get(c.script) ?? []), c]);
  }
  const results: Record<string, J> = {};
  const sources: Record<string, string> = {};
  for (const [script, cs] of [...byScript.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    // newest 'generated' wins; on equal times a verified block beats a file that differs from it (edited)
    const sorted = [...cs].sort((a, b) => {
      const ta = parseGenerated(a.obj['generated']);
      const tb = parseGenerated(b.obj['generated']);
      const na = Number.isNaN(ta) ? -Infinity : ta;
      const nb = Number.isNaN(tb) ? -Infinity : tb;
      return nb - na || Number(b.block) - Number(a.block) || Number(b.canonical) - Number(a.canonical);
    });
    const pick = sorted[0]!;
    const digests = new Set(cs.map((c) => c.digest));
    if (digests.size > 1) {
      const sameTime = cs.filter((c) => c.obj['generated'] === pick.obj['generated']);
      warnings.push(
        sameTime.length > 1 && new Set(sameTime.map((c) => c.digest)).size > 1
          ? `${script}: the file differs from the verified block with the same 'generated'; using ${pick.src}`
          : `${script}: ${digests.size} different versions found; using the newest 'generated' (${pick.src})`,
      );
    }
    results[script] = pick.obj;
    sources[script] = pick.src;
  }
  return { results, sources, capture, warnings, ignored, invalid, candidates: cands.length };
}

// ---------------------------------------------------------------- mapping (pure)

/** Maps loaded results to config knobs + provenance (reference implementation, adapted; see the header). */
export function mapEvalResults(R: Record<string, J>, opts: MapOptions = {}): ImportResult {
  const cfg: J = {};
  const prov: Record<string, KnobRecord> = {};
  const info: Record<string, KnobRecord> = {};
  const warn: string[] = [];
  const conflicts: string[] = [];
  /**
   * Records a decision; writes it into the config only when the pack determined it (measured, from the
   * client config, or derived from those). Defaults, inconclusive verdicts and the operator's own probe
   * flags (operator-assumption) stay in the provenance only: written, they would pin a guess over a preset.
   */
  const put = (path: string, value: unknown, source: string, rule: string, confidence: Confidence): void => {
    prov[path] = { value, source, rule, confidence };
    if (confidence === 'measured' || confidence === 'client-config' || confidence === 'derived') setPath(cfg, path, value);
  };
  const note = (path: string, value: unknown, source: string, rule: string, confidence: Confidence): void => {
    info[path] = { value, source, rule, confidence };
  };

  const probe = R['probe_gateway'] ?? null;
  const cap = R['summarize_capture'] ?? null;
  const cc = R['collect_config'] ?? null;
  const host = R['check_host'] ?? null;
  const T = obj(probe?.['tests']);
  const pcfg = obj(probe?.['config']);

  // ---- client config (collect_config): first non-null per key in list order (globals, then project levels)
  let model: string | null = null;
  let compaction: J | null = null;
  let toolOutput: J | null = null;
  let modelEntry: J | null = null;
  let limit: J | null = null;
  let otm = 32000;
  let otmSet = false;
  if (cc) {
    const files = arr(cc['files']).filter((f) => isPlainObject(f) && isPlainObject(f['config'])) as J[];
    const seen: Record<string, string[]> = {};
    for (const f of files) {
      const c = obj(f['config']);
      const where = `${str(f['kind'])}/${str(f['file'])}`;
      for (const key of ['model', 'compaction', 'tool_output']) {
        if (c[key] === null || c[key] === undefined) continue;
        (seen[key] ??= []).push(where);
        if (key === 'model' && model === null) model = str(c[key]);
        if (key === 'compaction' && compaction === null) compaction = obj(c[key]);
        if (key === 'tool_output' && toolOutput === null) toolOutput = obj(c[key]);
      }
    }
    for (const [key, ws] of Object.entries(seen)) {
      if (ws.length > 1) warn.push(`collect_config: '${key}' is set in ${ws.length} files (${ws.join(', ')}); using the first (${ws[0]})`);
    }
    if (model && model.includes('/')) {
      const [pid, mid] = [model.slice(0, model.indexOf('/')), model.slice(model.indexOf('/') + 1)];
      for (const f of files) {
        const lm = get(f['config'], 'provider', pid, 'models', mid);
        if (isPlainObject(lm) && Object.keys(lm).length) {
          modelEntry = lm;
          limit = isPlainObject(lm['limit']) ? lm['limit'] : null;
          break;
        }
      }
      if (!modelEntry) warn.push(`collect_config: model ${model} not found under provider.${pid}.models`);
    } else if (files.length) warn.push(`collect_config: no 'model' of the form provider/model; client limits unknown`);
    const env = obj(cc['env']);
    const o = str(env['OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX']) || str(env['KILO_EXPERIMENTAL_OUTPUT_TOKEN_MAX']);
    if (o && /^\d+$/.test(o)) {
      otm = parseInt(o, 10);
      otmSet = true;
    }
  }

  // ---- overflow rows
  const ov = obj(T['overflow']);
  const rows: Record<string, J> = {};
  for (const [k, v] of Object.entries(ov)) if (isPlainObject(v)) rows[k] = v;
  const rowPrompt = (r: J): number | null => {
    const pt = num(get(r, 'usage', 'prompt_tokens'));
    if (pt) return pt;
    return firstInt(PROMPT_RX, get(r, 'rejection', 'body'));
  };
  const rowErrorText = (r: J): string => str(get(r, 'rejection', 'body')) || arr(r['in_stream_errors']).filter((x) => typeof x === 'string').join(' ');

  // ---- window
  const wins: Array<[number, string, Confidence]> = [];
  const ids = arr(get(T, 'models', 'ids'));
  const mml = arr(get(T, 'models', 'max_model_len'));
  ids.forEach((mid, i) => {
    const w = num(mml[i]);
    if (mid === pcfg['model'] && w) wins.push([w, 'probe_gateway#/tests/models/max_model_len', 'measured']);
  });
  for (const [name, r] of Object.entries(rows)) {
    const w = firstInt(WINDOW_RX, rowErrorText(r));
    if (w) wins.push([w, `probe_gateway#/tests/overflow/${name}/rejection/body`, 'measured']);
  }
  for (const e of arr(cap?.['errors'])) {
    const w = firstInt(WINDOW_RX, get(e, 'body'));
    if (w) wins.push([w, 'summarize_capture#/errors', 'measured']);
  }
  const lctx = num(limit?.['context']);
  if (lctx) wins.push([lctx, 'collect_config#limit.context', 'client-config']);
  const pw = num(pcfg['window']);
  if (pw) wins.push([pw, 'probe_gateway#/config/window', 'operator-assumption']);
  const measured = wins.filter((w) => w[2] === 'measured');
  const pick: [number, string, Confidence] = measured.length
    ? measured.reduce((a, b) => (b[0] < a[0] ? b : a))
    : wins[0] ?? [DEFAULT_CONFIG.budget.window, 'preset:100k', 'default'];
  if (new Set(wins.map((w) => w[0])).size > 1) {
    warn.push(`window candidates disagree: ${[...new Set(wins.map((w) => `${w[0]} (${w[1]})`))].join(', ')}; using ${pick[0]}`);
  }
  if (new Set(measured.map((w) => w[0])).size > 1) {
    conflicts.push(`measured windows differ: ${[...new Set(measured.map((w) => w[0]))].join(' vs ')}`);
  }
  const W = pick[0];
  put('budget.window', W, pick[1], 'min of measured windows, else client limit.context, else the probe flag', pick[2]);

  // ---- does the limit count max_tokens (overflow case evidence)
  const A = rows['prompt_alone_over_window'];
  const C = rows['prompt_plus_max_tokens_over_window'];
  const D = rows['both_under_window'];
  let verdict: boolean | null = null;
  let vsrc = 'default: none (server.type decides; unknown = strict_total)';
  let vconf: Confidence = 'default';
  if (C) {
    const p = rowPrompt(C);
    vsrc = 'probe_gateway#/tests/overflow/prompt_plus_max_tokens_over_window';
    if (C['accepted'] === false && isPlainObject(C['rejection'])) {
      const cbody = str(get(C, 'rejection', 'body')) ?? '';
      const recognized = fingerprint(cbody) !== null || truthy(get(C, 'rejection', 'opencode_kilo_would_detect_overflow')) || truthy(get(C, 'rejection', 'gobstopper_text_match'));
      const abody = A ? str(get(A, 'rejection', 'body')) : null;
      const sameAsA = !!abody && messageOf(abody) === messageOf(cbody);
      if (p !== null && p >= W) {
        warn.push('case C was rejected but its prompt alone is >= window: window assumption wrong');
        vconf = 'inconclusive';
      } else if (recognized) {
        verdict = true;
        vconf = 'measured';
      } else if (sameAsA && !(D && D['accepted'] === false)) {
        verdict = true;
        vconf = 'derived';
        warn.push('case C rejected with an unrecognized body identical to case A; D accepted: limitCountsMaxTokens=true is derived, not proven');
      } else {
        vconf = 'inconclusive';
        warn.push('case C rejected with an unrecognized body: cannot tell overflow from other failures');
      }
    } else if (C['accepted'] === true) {
      const m = num(C['max_tokens']) ?? 0;
      if (p !== null && p + m > W) {
        verdict = false;
        vconf = 'measured';
        if (D && D['accepted'] === false) conflicts.push('case C (prompt + max_tokens over the window) was accepted but the control D was rejected');
      } else {
        vconf = 'inconclusive';
        warn.push(`case C accepted but prompt ${p} + max_tokens ${m} <= window ${W}: undersized probe (chars_per_token_used=${JSON.stringify(ov['chars_per_token_used'] ?? null)}); kept the default`);
      }
    }
  }
  if (D && D['accepted'] === false) warn.push('control case D (both under window) was REJECTED: the real limit is below the assumed window');
  if (A && A['accepted'] === true) warn.push(`case A (prompt over window) was ACCEPTED with prompt_tokens=${rowPrompt(A)}: window larger than ${W} or silent truncation`);
  put('budget.limitCountsMaxTokens', verdict, vsrc, 'overflow cases A/C/D (C rejected with an overflow body = true; accepted with prompt + max_tokens > W = false)', vconf);

  // ---- error map
  const fps: Array<Config['server']['type']> = [];
  const entries: Array<ErrorRule & { from: string; srcKind: string; key: string }> = [];
  const addEntry = (from: string, status: Array<number | null>, msg: string, srcKind: string, knownNums: { window?: number | null; prompt?: number | null; completion?: number | null }, on: 'message' | 'body' = 'message'): void => {
    const match = messageRegex(msg, knownNums);
    const key = messageRegex(msg); // dedupe on the unnamed form: the same body seen for A and C
    const hasGroup = /\(\?<(window|prompt|completion)>/.test(match);
    const kind: ErrorRule['kind'] =
      srcKind === 'output_overflow' ? 'max_tokens_too_large' : srcKind === 'ambiguous_overflow' ? 'gateway_error' : hasGroup ? 'overflow_prompt' : 'overflow_unknown';
    const dup = entries.find((e) => JSON.stringify(e.status) === JSON.stringify(status) && e.key === key && e.on === on);
    if (dup) {
      // the same body for different cases (e.g. A and C) is a generic overflow
      if (dup.srcKind !== srcKind && dup.srcKind !== 'ambiguous_overflow') {
        dup.srcKind = 'context_overflow';
        dup.kind = hasGroup ? 'overflow_prompt' : 'overflow_unknown';
      }
      return;
    }
    entries.push({ id: '', server: 'gateway-probes', status, match, on, kind, from, srcKind, key });
  };
  for (const name of OVERFLOW_ROWS) {
    const r = rows[name];
    if (!r) continue;
    const known = { window: W, prompt: rowPrompt(r), completion: num(r['max_tokens']) };
    const sse = arr(r['in_stream_errors']).filter((x): x is string => typeof x === 'string');
    for (const e of sse) {
      const fp = fingerprint(e);
      if (fp) fps.push(fp);
      else {
        const et = errorText(e);
        addEntry(name, [null], et.text, 'context_overflow', known, et.on);
      }
    }
    if (r['accepted'] !== false || !isPlainObject(r['rejection'])) continue;
    const rej = r['rejection'];
    const body = str(rej['body']) ?? '';
    const et = errorText(body);
    const msg = et.text;
    const fp = fingerprint(body);
    if (fp) fps.push(fp);
    const status = num(rej['status']);
    if (fp === null && status !== null && !overflowStatus(status)) {
      warn.push(`case ${name} was rejected with HTTP ${status}, which is not an overflow status (credentials, rate limit?); no error rule from it`);
    } else if (fp === null && status !== null) {
      const srcKind = !OVERFLOW_WORDS.test(msg) ? 'ambiguous_overflow' : name.startsWith('prompt_plus') ? 'output_overflow' : 'context_overflow';
      addEntry(name, [status], msg, srcKind, known, et.on);
    }
  }
  for (const e of arr(cap?.['errors'])) {
    const body = str(get(e, 'body')) ?? '';
    const status = num(get(e, 'status'));
    if (status === null || fingerprint(body) !== null) continue;
    if (status === 200) {
      // an in-stream error: the body is the stream's tail, so only its error events are evidence
      const payloads = sseErrorPayloads(body);
      if (!payloads.length) warn.push('summarize_capture: an in-stream error whose error event is not in the captured tail was skipped');
      for (const pl of payloads) {
        if (fingerprint(pl) !== null) continue;
        const et = errorText(pl);
        if (OVERFLOW_WORDS.test(et.text)) addEntry('summarize_capture#/errors', [null], et.text, 'context_overflow', { window: W }, et.on);
      }
      continue;
    }
    if (!overflowStatus(status)) continue;
    const et = errorText(body);
    if (truthy(get(e, 'opencode_kilo_would_detect_overflow')) || OVERFLOW_WORDS.test(et.text)) {
      addEntry('summarize_capture#/errors', [status], et.text, 'context_overflow', { window: W }, et.on);
    }
  }
  const types = [...new Set(fps)];
  if (types.length > 1) conflicts.push(`error bodies fingerprint different servers: ${types.join(', ')}`);
  let stype: Config['server']['type'] | null = fps[0] ?? null;
  if (stype) {
    put('server.type', stype, 'probe_gateway#/tests/overflow/*/rejection/body', 'first built-in fingerprint that matches an overflow body', 'measured');
  } else {
    const owned = arr(get(T, 'models', 'owned_by')).filter((x): x is string => typeof x === 'string' && SERVER_TYPES.has(x));
    if (owned.length === 1) {
      stype = owned[0] as Config['server']['type'];
      put('server.type', stype, 'probe_gateway#/tests/models/owned_by', 'models owned_by names a known server (no overflow fingerprint)', 'derived');
    } else put('server.type', 'unknown', 'probe_gateway#/tests/overflow', 'no fingerprint matched', 'default');
  }
  entries.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.match < b.match ? -1 : a.match > b.match ? 1 : 0));
  const custom: ErrorRule[] = entries.map((e, i) => ({
    id: `gateway-probes.${i + 1}`,
    server: 'gateway-probes',
    status: e.status,
    match: e.match,
    on: e.on,
    kind: e.kind,
    note: `from ${e.from} (${e.srcKind}${e.status?.[0] === null ? ', in-stream' : ''})`,
  }));
  if (custom.length) put('errors.custom', custom, 'probe_gateway#/tests/overflow + summarize_capture#/errors', 'escaped real error messages that no built-in fingerprint matches', 'measured');
  else put('errors.custom', [], 'probe_gateway#/tests/overflow', 'every overflow body matched a built-in fingerprint (or none was seen)', 'default');
  const B = rows['prompt_alone_over_window_streaming'];
  if (B) {
    const seen = arr(B['in_stream_errors']).length > 0;
    note('errors.inStreamSeen', seen, 'probe_gateway#/tests/overflow/prompt_alone_over_window_streaming', 'HTTP 200 + SSE error event on a streaming overflow', 'measured');
    if (seen) put('errors.inStream', true, 'probe_gateway#/tests/overflow/prompt_alone_over_window_streaming', 'the gateway reports overflows in-stream', 'measured');
  }

  // ---- streaming usage
  const st = obj(T['stream']);
  const wi = obj(st['with_include_usage']);
  const wo = obj(st['without_stream_options']);
  const incFrac = num(cap?.['include_usage_fraction']);
  let inject = false;
  let why: string;
  let iconf: Confidence;
  if ('error' in wi && !('error' in wo)) {
    [why, iconf] = ['server rejects stream_options', 'measured'];
  } else if (truthy(wi['usage_present']) && !truthy(wo['usage_present'])) {
    inject = incFrac === null || incFrac < 1.0;
    [why, iconf] = [`usage only when asked; client asks in ${incFrac === null ? 'an unknown share' : incFrac} of requests`, incFrac !== null ? 'measured' : 'derived'];
  } else if (truthy(wo['usage_present'])) {
    [why, iconf] = ['server always sends usage', 'measured'];
  } else {
    [why, iconf] = ['no usage in streams (or stream test missing)', Object.keys(wi).length ? 'measured' : 'default'];
  }
  put('stream.injectIncludeUsage', inject, 'probe_gateway#/tests/stream + summarize_capture#/include_usage_fraction', why, iconf);
  let usageOk: boolean | null = Object.keys(st).length ? truthy(wi['usage_present']) || truthy(wo['usage_present']) : null;
  const urf = num(cap?.['usage_returned_fraction_of_200']);
  if (cap && urf !== null && (num(cap['stream_fraction']) ?? 0) > 0.5) usageOk = urf >= 0.95 || (usageOk && inject);
  put('calibration.usageAvailable', usageOk, 'probe_gateway#/tests/stream, summarize_capture#/usage_returned_fraction_of_200', 'usage in streams (and >= 95% of captured 200s)', usageOk !== null ? 'measured' : 'default');

  // ---- max_tokens
  const mode = (counter: unknown): number | null => {
    const items = Object.entries(obj(counter)).filter(([k, v]) => k !== 'None' && typeof v === 'number') as Array<[string, number]>;
    if (!items.length) return null;
    // Python sorted((count, value))[-1]: highest count, ties to the larger value *string*
    items.sort(([ka, va], [kb, vb]) => va - vb || (ka < kb ? -1 : ka > kb ? 1 : 0));
    return parseInt(items[items.length - 1]![0], 10);
  };
  const mt = mode(cap?.['max_tokens_values']) ?? mode(cap?.['max_completion_tokens_values']);
  const lout = num(limit?.['output']);
  if (mt) put('budget.defaultMaxTokens', mt, 'summarize_capture#/max_tokens_values', 'mode of the max_tokens the client sent', 'measured');
  else if (lout) put('budget.defaultMaxTokens', Math.min(lout, otm), 'collect_config#limit.output', 'min(limit.output, OUTPUT_TOKEN_MAX) (OpenCode transform.ts:1481-1483)', 'client-config');
  else put('budget.defaultMaxTokens', num(pcfg['max_tokens']) ?? DEFAULT_CONFIG.budget.defaultMaxTokens, 'probe_gateway#/config/max_tokens', 'the probe flag', Object.keys(pcfg).length ? 'operator-assumption' : 'default');
  if (mt && lout && Math.min(lout, otm) !== mt) warn.push(`collect_config predicts max_tokens=${Math.min(lout, otm)} but capture observed ${mt}`);
  const defaultMaxTokens = (prov['budget.defaultMaxTokens']!.value as number) ?? DEFAULT_CONFIG.budget.defaultMaxTokens;

  // ---- client: output limit, compaction point (OpenCode overflow.ts usable(); Kilo threshold_percent)
  if (lout) put('client.outputLimit', lout, 'collect_config#limit.output', 'copy', 'client-config');
  if (otmSet) put('client.outputTokenMax', otm, 'collect_config#/env/*_EXPERIMENTAL_OUTPUT_TOKEN_MAX', 'copy', 'client-config');
  const comp = compaction ?? {};
  if (lctx) {
    const maxOut = Math.min(lout || otm, otm) || otm;
    const lin = num(limit?.['input']);
    const reserved = num(comp['reserved']);
    const usable = lin ? Math.max(0, lin - (reserved !== null ? reserved : Math.min(20000, maxOut))) : Math.max(0, lctx - maxOut);
    const pct = num(comp['threshold_percent']);
    const kilo = pct !== null ? Math.min(usable, Math.floor((lctx * pct) / 100)) : null;
    if (comp['auto'] === false) {
      put('client.compactionPointTokens', W, 'collect_config#compaction.auto', 'auto=false: the client never compacts, so its point is the window', 'client-config');
    } else if ((kilo || usable) <= 0) {
      // usable() is 0 when limit.context <= the client's max output: the client compacts after every step
      put('client.compactionPointTokens', 0, 'collect_config#limit+compaction', 'OpenCode usable() is 0: not written', 'inconclusive');
      warn.push(`collect_config: limit.context ${lctx} leaves no room above the client's max output ${maxOut}: the client compacts after every step; fix limit.context/limit.output in the client config`);
    } else {
      put('client.compactionPointTokens', kilo || usable, 'collect_config#limit+compaction',
        'OpenCode usable() (overflow.ts:10-20)' + (kilo ? ', Kilo threshold_percent (overflow.ts:89-98)' : ''), 'client-config');
    }
  } else {
    put('client.compactionPointTokens', null, 'derived', 'W − min(outputLimit ?? T_plan, outputTokenMax) (OpenCode defaults)', 'default');
  }
  const mb = num(toolOutput?.['max_bytes']);
  if (mb) put('client.toolOutputMaxBytes', mb, 'collect_config#tool_output.max_bytes', 'copy', 'client-config');

  // ---- completion tokens: allowance () and the prompt-only reserve ()
  const rcDist = obj(cap?.['reported_completion_tokens']);
  let p99: number | null = null;
  let p99src = '';
  if (opts.capture && opts.capture.length) {
    const vals = opts.capture
      .map((r) => num(get(r, 'response', 'usage', 'completion_tokens')))
      .filter((x): x is number => x !== null);
    p99 = packPercentile(vals, 99);
    p99src = 'capture.jsonl (p99)';
  }
  if (p99 === null && num(rcDist['max']) !== null) {
    p99 = num(rcDist['max']);
    p99src = 'summarize_capture#/reported_completion_tokens/max (upper bound of p99)';
  }
  const lcFinal = prov['budget.limitCountsMaxTokens']!;
  if (lcFinal.value === false && num(rcDist['max']) !== null) {
    const reserve = Math.min(defaultMaxTokens, Math.max(8192, Math.ceil(1.5 * num(rcDist['max'])!)));
    put('budget.planMaxTokens', reserve, 'summarize_capture#/reported_completion_tokens/max', 'prompt-only limit: outputReserve = min(max_tokens, max(8192, 1.5 × max completion)) ()', 'derived');
  }
  const tPlan = (prov['budget.planMaxTokens']?.value as number | undefined) ?? defaultMaxTokens;
  if (p99 !== null) {
    put('client.outputAllowanceTokens', Math.min(tPlan, Math.max(2000, p99)), p99src, 'min(T_plan, max(2000, p99 completion_tokens)) ()', 'measured');
  } else {
    put('client.outputAllowanceTokens', null, 'none', 'no completion data: min(7000, floor(T_plan/2))', 'default');
  }

  // ---- tokenizer fallback (chars/token per content class), template anchor, thinking
  const ratio = obj(T['ratio']);
  const cpt: Record<string, number> = { ...DEFAULT_CONFIG.tokenizer.fallback.charsPerToken };
  for (const [k, v] of Object.entries(ratio)) {
    const c = num(get(v, 'chars_per_token_content'));
    if (!c) continue;
    const cls = RATIO_KIND[k];
    if (!cls) {
      warn.push(`probe ratio kind '${k}' has no kitzur content class; ignored`);
      continue;
    }
    cpt[cls] = c;
    put(`tokenizer.fallback.charsPerToken.${cls}`, c, `probe_gateway#/tests/ratio/${k}/chars_per_token_content`, 'copy (the estimator applies fallback.safetyFactor)', 'measured');
  }
  const tiny = num(get(T, 'basic', 'usage', 'prompt_tokens'));
  note('tokenizer.calibration.tinyPromptTokens', tiny, 'probe_gateway#/tests/basic/usage/prompt_tokens', "server count of the request 'Reply with the single word OK.'", tiny ? 'measured' : 'default');
  if (tiny && opts.tinyCount != null) {
    note('tokenizer.calibration.tinyPromptCheck', { server: tiny, ours: opts.tinyCount, overhead: tiny - opts.tinyCount }, 'probe_gateway#/tests/basic', 'our count of the same request with the configured tokenizer + template', 'derived');
    if (Math.abs(tiny - opts.tinyCount) > 2) warn.push(`template check: the server counts ${tiny} tokens for the tiny probe request, we count ${opts.tinyCount}: check tokenizer.template.name`);
  }
  const think = get(modelEntry, 'options', 'chat_template_kwargs', 'enable_thinking');
  if (typeof think === 'boolean') put('tokenizer.template.enableThinking', think, 'collect_config#models.<id>.options.chat_template_kwargs', 'copy', 'client-config');
  const ek = arr(pcfg['extra_body_keys']);
  if (ek.length) warn.push(`probe used extra body keys ${JSON.stringify(ek)}: template overhead measured with them`);

  // ---- reasoning
  const bm = obj(get(T, 'basic', 'message'));
  const keys = [...arr(bm['keys']), ...arr(get(wi, 'delta_keys')), ...arr(get(wo, 'delta_keys'))];
  const field = keys.includes('reasoning_content') ? 'reasoning_content' : keys.includes('reasoning') ? 'reasoning' : null;
  const hasBm = Object.keys(bm).length > 0;
  put('reasoning.serverEmits', hasBm ? truthy(bm['reasoning_content_chars']) || truthy(bm['reasoning_chars']) : null, 'probe_gateway#/tests/basic/message', 'reasoning chars > 0', hasBm ? 'measured' : 'default');
  if (field) put('reasoning.field', field, 'probe_gateway#/tests/basic/message/keys', 'the key present', 'measured');
  const sb = num(cap?.['requests_with_reasoning_sent_back']);
  put('reasoning.sentBackByClient', sb !== null ? sb > 0 : null, 'summarize_capture#/requests_with_reasoning_sent_back', '> 0', sb !== null ? 'measured' : 'default');

  // ---- summary message shape
  const fu = get(T, 'tools', 'gobstopper_shape_followup');
  if (isPlainObject(fu)) {
    put('compaction.summaryRole', fu['status'] === 200 ? 'user' : 'merge-into-first-user', 'probe_gateway#/tests/tools/gobstopper_shape_followup',
      'two consecutive user messages accepted = user', 'measured');
  }

  // ---- tool names: observed exact names the default globs miss are added
  const names = new Set<string>();
  for (const ts of arr(cap?.['tool_sets'])) for (const n of arr(get(ts, 'names'))) if (typeof n === 'string') names.add(n);
  for (const n of Object.keys(obj(cap?.['tool_result_chars_by_tool']))) names.add(n);
  for (const [role, rxs] of TOOL_ROLES) {
    const hit = [...names].filter((n) => rxs.some((rx) => rx.test(n))).sort();
    if (!hit.length) continue;
    const defaults = DEFAULT_CONFIG.rules.toolNames[role];
    const missing = hit.filter((n) => !defaults.some((g) => globToRegExp(g).test(n)));
    note(`rules.toolNames.${role}.observed`, hit, 'summarize_capture#/tool_sets', 'observed exact names for the role', 'measured');
    if (missing.length) {
      put(`rules.toolNames.${role}`, [...defaults, ...missing], 'summarize_capture#/tool_sets', 'default globs + observed names they miss', 'measured');
    }
  }
  const mcp = [...new Set(arr(cc?.['files']).flatMap((f) => Object.keys(obj(get(f, 'config', 'mcp')))))].sort();
  if (mcp.length) put('rules.mcpServers', mcp, 'collect_config#mcp', 'MCP server names', 'client-config');

  // ---- snapshot sizes -> tokens (informational; feeds the one-snapshot-per-epoch warning)
  const trc = obj(cap?.['tool_result_chars_by_tool']);
  const snap = Object.entries(trc).filter(([k, v]) => /browser_(snapshot|navigate|click)/.test(k) && truthy(v)).map(([, v]) => obj(v));
  if (snap.length) {
    const p90 = Math.max(...snap.map((v) => num(v['p90']) ?? 0));
    const mx = Math.max(...snap.map((v) => num(v['max']) ?? 0));
    put('rules.snapshot.p90Tokens', Math.max(1, pyRound(p90 / cpt['snapshot']!)), 'summarize_capture#/tool_result_chars_by_tool', 'p90 chars / charsPerToken.snapshot', 'derived');
    note('rules.snapshot.maxTokens', pyRound(mx / cpt['snapshot']!), 'summarize_capture#/tool_result_chars_by_tool', 'max chars / charsPerToken.snapshot', 'derived');
  }

  // ---- fixed prompt, prefix caching, timeout
  const fp = arr(cap?.['sessions_detail']).map((s) => num(get(s, 'first_request_reported_prompt'))).filter((x): x is number => !!x).sort((a, b) => a - b);
  if (fp.length) put('budget.observedFixedPromptTokens', fp[Math.floor(fp.length / 2)]!, 'summarize_capture#/sessions_detail/*/first_request_reported_prompt', 'median', 'measured');
  const cpt_ = obj(cap?.['cached_prompt_tokens']);
  if (truthy(cpt_['max'])) put('cache.prefixCaching', 'on', 'summarize_capture#/cached_prompt_tokens', 'cached_tokens reported', 'measured');
  const lat = num(get(cap, 'latency_secs', 'max'));
  if (lat) put('upstream.timeoutMs', Math.min(MAX_TIMEOUT_MS, Math.trunc(Math.max(600, 3 * lat) * 1000)), 'summarize_capture#/latency_secs/max', 'max(600 s, 3 × max latency), at most 24 h', 'derived');

  // ---- not in the pack
  const basePath = str(pcfg['base_path']);
  note('upstream.basePath', basePath, 'probe_gateway#/config/base_path', 'not a knob: the client path is appended unchanged ()', basePath ? 'measured' : 'default');
  const port = opts.port ?? DEFAULT_CONFIG.listen.port;
  const clientBaseUrl = basePath !== null ? `http://127.0.0.1:${port}${basePath}` : null;
  const todos = [
    'upstream.origin: scheme://host[:port] of the gateway (masked in the pack; set by hand)',
    "tokenizer.path: the model's tokenizer.json (exact counting)",
    'tokenizer.endpoint.style/path: the gateway tokenize endpoint, if any (not probed; calibration only)',
  ];
  if (!prov['cache.prefixCaching']) todos.push("cache.prefixCaching: 'on' if the server has prefix caching (human Q1)");
  const questions = [
    'Q1 server + version and prefix caching -> server.type, cache.prefixCaching',
    'Q2 is there a LiteLLM layer that rewrites errors -> errors.custom',
    'Q3 share of non-Latin (Hebrew) UI -> tokenizer.fallback.charsPerToken.snapshotNonLatin, rules.snapshot.p90Tokens',
    'Q5 is thinking enabled -> tokenizer.template.enableThinking',
  ];

  // ---- host and replays (report only)
  const node = str(host?.['node']);
  const nm = node ? /^v(\d+)/.exec(node) : null;
  if (nm && parseInt(nm[1]!, 10) < 20) warn.push(`host node ${node} < 20: kitzur will not run`);
  const sysd = str(host?.['systemd_user']);
  if (sysd && sysd !== 'running' && sysd !== 'degraded') warn.push(`host systemd --user is '${sysd}': install kitzur without the user unit (deploy/README.md)`);
  const replays: string[] = [];
  for (const [name, r] of Object.entries(R).filter(([k]) => k.startsWith('replay_session_')).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const rows_ = arr(r['rows']);
    replays.push(
      `${name.slice('replay_session_'.length)}: ${num(r['steps_completed']) ?? '?'}/${rows_.length} steps, ${num(r['compactions']) ?? 0} compactions, ` +
        `peak prompt ${num(r['peak_prompt_tokens']) ?? '?'}, sum ${num(r['sum_prompt_tokens']) ?? '?'}${r['stopped_with_error'] ? ', stopped with an error' : ''}`,
    );
  }

  // ---- the written config must be usable on its own (built-in defaults + these knobs, as `serve -c` loads it)
  const eff = structuredClone(DEFAULT_CONFIG) as unknown as J;
  for (const k of Object.keys(prov)) {
    const v = getPath(cfg, k);
    if (v !== undefined) setPath(eff, k, v);
  }
  const effCfg = eff as unknown as Config;
  for (const e of validateConfig(effCfg).errors) conflicts.push(`the imported config does not validate: ${e}`);
  const effB = computeBudget(effCfg);
  if (effB.budget > 0 && effB.budget < effB.window / 4) {
    // e.g. a 32k server with OpenCode's default max_tokens 32000: every request would be refused
    conflicts.push(
      `window ${effB.window} and T_plan ${effB.planMaxTokens} (budget.defaultMaxTokens: ${prov['budget.defaultMaxTokens']!.source}) leave a prompt budget of ` +
        `only ${effB.budget}: set budget.planMaxTokens (the 32k preset reserves 8,000; kitzur fits each request's max_tokens anyway)`,
    );
  }

  // ---- safety-critical knobs (§7.6)
  const okConf = (c: Confidence | undefined): boolean => c === 'measured' || c === 'client-config';
  const unsafe: string[] = [];
  for (const k of ['budget.window', 'budget.limitCountsMaxTokens', 'budget.defaultMaxTokens']) {
    if (!okConf(prov[k]?.confidence)) unsafe.push(`${k} is ${prov[k]?.confidence ?? 'unset'}`);
  }
  if (prov['server.type']?.confidence !== 'measured' && !custom.length) unsafe.push('overflow recognition: no server fingerprint and no custom error entry');
  const exitCode: 0 | 10 | 11 = conflicts.length ? 11 : unsafe.length ? 10 : 0;

  return {
    config: sortKeysDeep(cfg) as J,
    provenance: sortKeysDeep(prov) as Record<string, KnobRecord>,
    info: sortKeysDeep(info) as Record<string, KnobRecord>,
    warnings: warn,
    conflicts,
    unsafe,
    todos,
    questions,
    clientBaseUrl,
    replays,
    exitCode,
  };
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (!isPlainObject(v)) return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeysDeep(v[k])]));
}

// ---------------------------------------------------------------- merge (§7.4)

/** The provenance sidecar written next to the config. */
export interface ImportSidecar {
  $comment: string;
  generatedBy: 'kitzur config import-eval';
  inputs: Record<string, string>;
  /** knobs import-eval wrote (value as written): these may be overwritten by a later import */
  knobs: Record<string, KnobRecord>;
  info: Record<string, KnobRecord>;
  warnings: string[];
  todos: string[];
}

export interface MergeResult {
  config: J;
  sidecarKnobs: Record<string, KnobRecord>;
  written: string[];
  kept: string[];
  warnings: string[];
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeysDeep(a)) === JSON.stringify(sortKeysDeep(b));

/**
 * Merges imported knobs into an existing config: a knob is overwritten only if it is absent, or the
 * previous sidecar lists it with the value still in the file (imported and not hand-edited since), or it
 * is named in `forceKeys` (a key or a section prefix). Hand-set values survive, with a warning when
 * they differ from the measurement. Knobs the importer did not write (defaults) never overwrite anything.
 */
export function mergeImport(existing: J, prevKnobs: Record<string, KnobRecord> | null, res: ImportResult, forceKeys: readonly string[] = []): MergeResult {
  const config = structuredClone(existing);
  const written: string[] = [];
  const kept: string[] = [];
  const warnings: string[] = [];
  const sidecarKnobs: Record<string, KnobRecord> = {};
  // previously imported knobs that are still untouched stay "imported"
  for (const [path, rec] of Object.entries(prevKnobs ?? {})) {
    if (same(getPath(config, path), rec.value)) sidecarKnobs[path] = rec;
  }
  const forced = (p: string): boolean => forceKeys.some((k) => p === k || p.startsWith(k + '.'));
  for (const [path, rec] of Object.entries(res.provenance)) {
    if (getPath(res.config, path) === undefined) continue; // not written (default/unknown)
    const cur = getPath(config, path);
    const imported = prevKnobs?.[path] !== undefined && same(cur, prevKnobs[path]!.value);
    if (cur === undefined || imported || forced(path)) {
      setPath(config, path, structuredClone(rec.value));
      sidecarKnobs[path] = rec;
      written.push(path);
    } else {
      kept.push(path);
      if (!same(cur, rec.value)) {
        warnings.push(`${path}: config has ${JSON.stringify(cur)} (hand-set), the pack says ${JSON.stringify(rec.value)} [${rec.confidence}]; kept (use --force-keys ${path})`);
      }
    }
  }
  return { config, sidecarKnobs: sortKeysDeep(sidecarKnobs) as Record<string, KnobRecord>, written: written.sort(), kept: kept.sort(), warnings };
}

// ---------------------------------------------------------------- report

const show = (v: unknown, max = 60): string => {
  const s = JSON.stringify(v) ?? 'null';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
};

/** The human report (knob table, info, warnings, conflicts, TODOs, questions, derived budget). */
export function renderImportReport(res: ImportResult, extra: { inputs?: Record<string, string>; merge?: MergeResult | null } = {}): string {
  const lines: string[] = [];
  if (extra.inputs) {
    lines.push('inputs:');
    for (const [k, v] of Object.entries(extra.inputs)) lines.push(`  ${k.padEnd(26)} ${v}`);
    lines.push('');
  }
  const rows = Object.entries(res.provenance);
  const w = Math.max(...rows.map(([k]) => k.length), 10);
  lines.push(`${'knob'.padEnd(w)}  ${'value'.padEnd(34)} ${'confidence'.padEnd(19)} source`);
  for (const [k, r] of rows) {
    const writtenMark = getPath(res.config, k) === undefined ? ' ' : '*';
    lines.push(`${writtenMark}${k.padEnd(w - 1)}  ${show(r.value, 34).padEnd(34)} ${r.confidence.padEnd(19)} ${r.source}`);
  }
  lines.push(`(* = written to the config; others keep the built-in default)`);
  if (Object.keys(res.info).length) {
    lines.push('', 'informational (provenance sidecar only):');
    for (const [k, r] of Object.entries(res.info)) lines.push(`  ${k}: ${show(r.value, 80)} [${r.confidence}]`);
  }
  // the budget this config gives (built-in defaults + imported knobs)
  const eff = structuredClone(DEFAULT_CONFIG) as unknown as J;
  for (const [k] of Object.entries(res.provenance)) {
    const v = getPath(res.config, k);
    if (v !== undefined) setPath(eff, k, v);
  }
  const ec = eff as unknown as Config;
  const b = computeBudget(ec, { counterFixedTokens: ec.budget.observedFixedPromptTokens });
  lines.push(
    '',
    `derived (DESIGN §3): mode ${resolveBudgetMode(ec)}, W ${b.window}, T_plan ${planMaxTokens(ec)}, margin ${b.margin}, budget ${b.budget}, ` +
      `clientPoint ${b.clientPoint}, allowance ${b.allowance}, hard ${b.hard}, trigger ${b.trigger}, target ${b.target}`,
  );
  if (res.clientBaseUrl) lines.push(`client baseURL = ${res.clientBaseUrl}   (the proxy appends the client path unchanged)`);
  if (res.replays.length) lines.push('', 'replays:', ...res.replays.map((r) => `  ${r}`));
  const all = [...res.warnings, ...(extra.merge?.warnings ?? [])];
  if (all.length) lines.push('', 'warnings:', ...all.map((x) => `  - ${x}`));
  if (res.conflicts.length) lines.push('', 'CONFLICTS (exit 11):', ...res.conflicts.map((x) => `  - ${x}`));
  if (res.unsafe.length) lines.push('', 'safety-critical knobs not measured (exit 10):', ...res.unsafe.map((x) => `  - ${x}`));
  lines.push('', 'set by hand (not in the pack):', ...res.todos.map((x) => `  - ${x}`));
  lines.push('', 'human questions that affect config (RESULTS_TEMPLATE.md §4):', ...res.questions.map((x) => `  - ${x}`));
  if (extra.merge) {
    lines.push('', `merge: wrote ${extra.merge.written.length} knob(s), kept ${extra.merge.kept.length} hand-set knob(s)`);
  }
  lines.push('', `exit code ${res.exitCode}: ${res.exitCode === 0 ? 'every safety-critical knob measured' : res.exitCode === 10 ? 'some safety-critical knob fell back to a default' : 'conflicting measurements or an unusable config'}`);
  return lines.join('\n');
}

/** Sidecar path for a config path: x.json / x.jsonc -> x.provenance.json. */
export function sidecarPath(configPath: string): string {
  return configPath.replace(/\.jsonc?$/, '') + '.provenance.json';
}
