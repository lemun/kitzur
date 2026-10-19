import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parsePyJson, pyDumps } from '../../tokenize/pyjson.js';
import { isPlainObject } from '../spec.js';

type J = Record<string, unknown>;

export const PACK_VERSIONS: readonly string[] = ['1'];
export const KNOWN_SCRIPTS: readonly string[] = ['check_host', 'collect_config', 'probe_gateway', 'summarize_capture'];
const BLOCK_RE = /===RESULT-BEGIN (\S+)===\r?\n([\s\S]*?)\r?\n===RESULT-END \1 sha256:([0-9a-f]{16})===/g;

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

