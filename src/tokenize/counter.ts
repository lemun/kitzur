// TokenCounter (src/types.ts; DESIGN.md): renders the request with a template profile and counts
// it per message piece, caching each piece's count by (message digest, render context).
//
//   exact     local tokenizer. Σ perMessage + overhead == tokenizer.count(rendered prompt), exactly:
//             pieces are joined next to added tokens, and any boundary that is not (see
//             template.ts) is re-counted jointly, the difference going to the later piece.
//   estimate  no tokenizer: added tokens in template glue count 1 each, other text
//             chars / charsPerToken[class] x safetyFactor (estimate.ts), images imageTokens.
//   remote    prefetch() asks the gateway's tokenize endpoint for every uncached piece; measure()
//             uses those counts and the estimate for anything not fetched (e.g. proxy-generated text).
//
// Requests and messages are treated as immutable: digests and the tools key are memoized by object
// identity (WeakMap), which makes repeated measure() calls on candidates built from the same message
// objects cheap. Supplied `digests` (the engine's) are used as cache keys verbatim.
import type { ChatMessage, ChatRequest, CounterMode, Measure, TokenCounter } from '../types.js';
import { DEFAULT_CONFIG, type Config } from '../config/schema.js';
import type { Tokenizer } from './tokenizer.js';
import type { LoadedTokenizer } from './load.js';
import { createHash } from 'node:crypto';
import { digestOf, sha256Hex } from './canonical.js';
import { classifyContent, estimateText, rawEstimate, textStats, type CharsPerToken } from './estimate.js';
import { createProfile, GLUE_TOKENS, partsText, type Part, type ProfileOptions, type RenderLayout, type TemplateName, type TemplateProfile } from './template.js';
import type { RemoteTokenizer } from './remote.js';

export interface CounterOptions {
  mode: CounterMode;
  template: TemplateName | TemplateProfile;
  /** options for a named template (enableThinking, perMessageOverhead, ...) */
  templateOptions?: ProfileOptions;
  /** required for mode 'exact' */
  tokenizer?: Tokenizer | null;
  /** identity of the tokenizer (e.g. sha256 of tokenizer.json); part of `id` */
  tokenizerId?: string | null;
  imageTokens?: number;
  /** LRU capacity in pieces (config tokenizer.cacheEntries) */
  cacheEntries?: number;
  fallback?: Partial<Config['tokenizer']['fallback']>;
  /** required for mode 'remote' */
  remote?: RemoteTokenizer | null;
}

export interface CounterStats {
  measures: number;
  pieceHits: number;
  pieceMisses: number;
  /** UTF-16 units passed to the local tokenizer */
  tokenizedChars: number;
  /** boundaries that needed a joint recount */
  jointRecounts: number;
  remoteHits: number;
  remoteMisses: number;
  remoteFetched: number;
  entries: number;
}

export interface Counter extends TokenCounter {
  readonly profile: TemplateProfile;
  stats(): CounterStats;
  /** drop all cached piece counts */
  clear(): void;
}

class Lru<V> {
  private readonly m = new Map<string, V>();
  constructor(private readonly cap: number) {}
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  has(k: string): boolean {
    return this.m.has(k);
  }
  set(k: string, v: V): void {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.cap) this.m.delete(this.m.keys().next().value as string);
  }
  get size(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
}

/** A counted piece: n tokens; s/e = its text starts/ends with an added token; z = empty. */
interface Entry {
  n: number;
  s: boolean;
  e: boolean;
  z: boolean;
}

// Added tokens that the built-in templates emit in glue; used by the estimator to count them as 1.
const TEMPLATE_TOKENS = [
  '<|im_start|>', '<|im_end|>', '<|endoftext|>', '<think>', '</think>', '<tool_call>', '</tool_call>',
  '<tool_response>', '</tool_response>', '<|vision_start|>', '<|vision_end|>', '<|image_pad|>', '<|video_pad|>',
];
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
const TEMPLATE_TOKEN_RE = new RegExp(TEMPLATE_TOKENS.map(escapeRe).join('|'), 'g');
/** Unlisted template glue (tags, role names, newlines) is denser than prose: ~3 chars/token on Qwen. */
const GLUE_CHARS_PER_TOKEN = 3;

const DEFAULT_FALLBACK: Config['tokenizer']['fallback'] = DEFAULT_CONFIG.tokenizer.fallback;

export function createCounter(opts: CounterOptions): Counter {
  const mode = opts.mode;
  const fallback = { ...DEFAULT_FALLBACK, ...opts.fallback, charsPerToken: { ...DEFAULT_FALLBACK.charsPerToken, ...opts.fallback?.charsPerToken } };
  const cpt: CharsPerToken = fallback.charsPerToken;
  const safety = fallback.safetyFactor;
  const profile =
    typeof opts.template === 'string'
      ? createProfile(opts.template, { perMessageOverhead: fallback.perMessageOverhead, ...opts.templateOptions })
      : opts.template;
  const imageTokens = opts.imageTokens ?? 1568;
  const tok = opts.tokenizer ?? null;
  const remote = opts.remote ?? null;
  if (mode === 'exact' && !tok) throw new Error("counter mode 'exact' needs a tokenizer");
  if (mode === 'remote' && !remote) throw new Error("counter mode 'remote' needs a remote tokenizer");
  const cap = Math.max(16, opts.cacheEntries ?? 200_000);

  const id =
    `${mode};${profile.id};tok=${opts.tokenizerId ?? (tok ? `vocab${tok.vocabSize}` : 'none')};img=${imageTokens}` +
    (mode === 'exact' ? '' : `;cpt=${Object.values(cpt).join(',')};sf=${safety}`) +
    (mode === 'remote' ? `;remote=${remote!.style}` : '');

  // ------------------------------------------------------------ added-token boundary tests (exact)
  // count(A+B) == count(A) + count(B) when A ends or B starts with an added token, provided no added
  // token contains another's first character after its start or last character before its end
  // (then no added-token match can straddle the boundary). True for Qwen (all are <...>).
  let startRe: RegExp | null = null;
  let endRe: RegExp | null = null;
  let maxTokLen = 0;
  if (tok) {
    const toks = [...tok.addedTokens.keys()].filter((t) => t.length > 0).sort((a, b) => b.length - a.length);
    const firsts = new Set(toks.map((t) => t[0]!));
    const lasts = new Set(toks.map((t) => t[t.length - 1]!));
    const safe = toks.every((t) => {
      for (let j = 1; j < t.length; j++) if (firsts.has(t[j]!)) return false;
      for (let j = 0; j < t.length - 1; j++) if (lasts.has(t[j]!)) return false;
      return true;
    });
    if (safe && toks.length > 0) {
      const alt = toks.map(escapeRe).join('|');
      startRe = new RegExp(`^(?:${alt})`);
      endRe = new RegExp(`(?:${alt})$`);
      maxTokLen = toks[0]!.length;
    }
  }

  const st: CounterStats = {
    measures: 0, pieceHits: 0, pieceMisses: 0, tokenizedChars: 0, jointRecounts: 0,
    remoteHits: 0, remoteMisses: 0, remoteFetched: 0, entries: 0,
  };
  const exactCache = new Lru<Entry>(cap);
  const exactByText = new Lru<Entry>(cap);
  const estCache = new Lru<number>(cap);
  const remoteCache = new Lru<number>(cap);
  const remoteByText = new Lru<number>(cap);
  const msgDigest = new WeakMap<object, string>();
  const toolsDigest = new WeakMap<object, string>();

  const digestFor = (m: ChatMessage): string => {
    if (typeof m !== 'object' || m === null) return digestOf(m);
    let d = msgDigest.get(m);
    if (d === undefined) {
      d = digestOf(m);
      msgDigest.set(m, d);
    }
    return d;
  };
  const envFor = (req: ChatRequest) => ({
    toolsKey(): string {
      const t = req.tools;
      if (!Array.isArray(t)) return '';
      let d = toolsDigest.get(t);
      if (d === undefined) {
        d = digestOf(t);
        toolsDigest.set(t, d);
      }
      return d;
    },
  });

  // ------------------------------------------------------------ piece counting
  /** Content hash of a rendered piece (text plus the positions of image/fixed parts). */
  const pieceHash = (parts: readonly Part[]): string => {
    const h = createHash('sha256');
    for (const p of parts) {
      if (p.k === 'i') h.update('\u0001');
      else if (p.k === 'x') h.update(`\u0002${p.n ?? 0}\u0002`);
      h.update(p.s, 'utf8');
    }
    return h.digest('hex');
  };

  const countExact = (parts: readonly Part[]): Entry => {
    let n = 0;
    let run = '';
    const flush = (): void => {
      if (run.length) {
        n += tok!.count(run);
        st.tokenizedChars += run.length;
        run = '';
      }
    };
    for (const p of parts) {
      if (p.k === 'i') {
        flush();
        n += imageTokens;
      } else if (p.k === 'x') {
        flush();
        n += p.n ?? 0;
      } else {
        run += p.s;
      }
    }
    flush();
    const z = parts.every((p) => p.s.length === 0);
    if (z || startRe === null || endRe === null) return { n, s: false, e: false, z };
    // boundary flags from the first/last maxTokLen characters of the piece text
    let head = '';
    for (let i = 0; i < parts.length && head.length < maxTokLen; i++) head += parts[i]!.s;
    let tail = '';
    for (let i = parts.length - 1; i >= 0 && tail.length < maxTokLen; i--) tail = parts[i]!.s + tail;
    return { n, s: startRe.test(head), e: endRe.test(tail), z };
  };

  const glueEstimate = (s: string): [number, number] => {
    const known = GLUE_TOKENS.get(s);
    if (known !== undefined) return [known, 0];
    let added = 0;
    let rest = s.length;
    TEMPLATE_TOKEN_RE.lastIndex = 0;
    for (let m = TEMPLATE_TOKEN_RE.exec(s); m !== null; m = TEMPLATE_TOKEN_RE.exec(s)) {
      added++;
      rest -= m[0].length;
    }
    return [added, rest / GLUE_CHARS_PER_TOKEN];
  };

  const countEstimate = (parts: readonly Part[]): number => {
    let exact = 0;
    let raw = 0;
    for (const p of parts) {
      if (p.k === 'i') exact += imageTokens;
      else if (p.k === 'x') exact += p.n ?? 0;
      else if (p.k === 'g') {
        const [a, r] = glueEstimate(p.s);
        exact += a;
        raw += r;
      } else if (p.s.length) {
        const ts = textStats(p.s);
        raw += rawEstimate(p.s, p.cls ?? classifyContent(p.s, ts), cpt, ts);
      }
    }
    return exact + Math.ceil(raw * safety);
  };

  // ------------------------------------------------------------ measure
  interface Rec {
    owner: number; // message index, -1 prefix, -2 suffix
    n: number;
    ent: Entry | null;
    parts: () => readonly Part[];
  }

  const layoutOf = (req: ChatRequest): RenderLayout => profile.layout(req, envFor(req));

  const pieceKeys = (req: ChatRequest, L: RenderLayout, digests?: string[]): string[] => {
    const msgs = req.messages;
    const useGiven = Array.isArray(digests) && digests.length === msgs.length;
    if (useGiven) {
      // the engine's digests are the same function of the message (sha256 of its canonical JSON): remember them
      // for this message object, so that a later countRequest of the same objects (the proxy sizes the original
      // request and every attempt) does not hash the whole history again
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        if (typeof m === 'object' && m !== null && !msgDigest.has(m)) msgDigest.set(m, digests![i]!);
      }
    }
    return msgs.map((m, i) => (useGiven ? digests![i]! : digestFor(m)) + '|' + L.ctx[i]);
  };

  function measure(req: ChatRequest, digests?: string[]): Measure {
    st.measures++;
    const L = layoutOf(req);
    const n = req.messages.length;
    const keys = pieceKeys(req, L, digests);
    const recs: Rec[] = [];
    const suffixKey = 'Z|' + partsText(L.suffix);

    const piece = (key: string, owner: number, parts: () => readonly Part[]): Rec => {
      if (mode === 'exact') {
        let ent = exactCache.get(key);
        if (ent === undefined) {
          // another key space (engine digests vs our own) may have counted the same text already
          const ps = parts();
          const th = pieceHash(ps);
          ent = exactByText.get(th);
          if (ent === undefined) {
            st.pieceMisses++;
            ent = countExact(ps);
            exactByText.set(th, ent);
          } else st.pieceHits++;
          exactCache.set(key, ent);
        } else st.pieceHits++;
        return { owner, n: ent.n, ent, parts };
      }
      if (mode === 'remote') {
        let r = remoteCache.get(key);
        if (r === undefined) {
          // prefetch() keys by the counter's own digests; the engine measures with its digests
          r = remoteByText.get(pieceHash(parts()));
          if (r !== undefined) remoteCache.set(key, r);
        }
        if (r !== undefined) {
          st.remoteHits++;
          return { owner, n: r, ent: null, parts };
        }
        st.remoteMisses++;
      }
      let e = estCache.get(key);
      if (e === undefined) {
        st.pieceMisses++;
        e = countEstimate(parts());
        estCache.set(key, e);
      } else st.pieceHits++;
      return { owner, n: e, ent: null, parts };
    };

    if (L.prefix.length) recs.push(piece('P|' + L.prefixKey, -1, () => L.prefix));
    for (let i = 0; i < n; i++) recs.push(piece(keys[i]!, i, () => L.message(i)));
    recs.push(piece(suffixKey, -2, () => L.suffix));

    const perMessage = new Array<number>(n).fill(0);
    let overhead = 0;
    const add = (owner: number, v: number): void => {
      if (owner >= 0) perMessage[owner] = perMessage[owner]! + v;
      else overhead += v;
    };
    for (const r of recs) add(r.owner, r.n);

    // exactness at piece boundaries that are not next to an added token
    if (mode === 'exact' && profile.additive) {
      let run: Rec[] = [];
      const close = (): void => {
        if (run.length > 1) {
          st.jointRecounts++;
          const parts: Part[] = [];
          for (const r of run) parts.push(...r.parts());
          const joint = countExact(parts).n;
          let sum = 0;
          for (const r of run) sum += r.n;
          add(run[run.length - 1]!.owner, joint - sum);
        }
        run = [];
      };
      for (const r of recs) {
        if (r.ent!.z) continue;
        const prev = run[run.length - 1];
        if (prev !== undefined && !(prev.ent!.e || r.ent!.s)) run.push(r);
        else {
          close();
          run = [r];
        }
      }
      close();
    }

    let total = overhead;
    for (const v of perMessage) total += v;
    st.entries = mode === 'exact' ? exactCache.size : estCache.size + remoteCache.size;
    return { perMessage, overhead, total };
  }

  // ------------------------------------------------------------ remote prefetch
  const remoteText = new Lru<number>(Math.min(cap, 50_000));
  const textCache = new Lru<number>(4096);
  async function prefetch(req: ChatRequest): Promise<void> {
    try {
      if (!remote || remote.down()) return;
      const L = layoutOf(req);
      const keys = pieceKeys(req, L);
      const jobs: Array<{ key: string; parts: readonly Part[] }> = [];
      if (L.prefix.length && !remoteCache.has('P|' + L.prefixKey)) jobs.push({ key: 'P|' + L.prefixKey, parts: L.prefix });
      for (let i = 0; i < keys.length; i++) if (!remoteCache.has(keys[i]!)) jobs.push({ key: keys[i]!, parts: L.message(i) });
      const sk = 'Z|' + partsText(L.suffix);
      if (!remoteCache.has(sk)) jobs.push({ key: sk, parts: L.suffix });
      const model = typeof req.model === 'string' ? req.model : null;
      await Promise.all(
        jobs.map(async ({ key, parts }) => {
          // text runs between placeholders are tokenized remotely; images cost imageTokens
          let total = 0;
          let runText = '';
          const runs: string[] = [];
          for (const p of parts) {
            if (p.k === 'i' || p.k === 'x') {
              if (runText) runs.push(runText);
              runText = '';
              total += p.k === 'i' ? imageTokens : p.n ?? 0;
            } else runText += p.s;
          }
          if (runText) runs.push(runText);
          for (const t of runs) {
            const h = t.length > 64 ? sha256Hex(t) : t;
            let c = remoteText.get(h);
            if (c === undefined) {
              const r = await remote.count(t, model);
              if (r === null) return; // give up on this piece: measure() estimates it
              st.remoteFetched++;
              c = r;
              remoteText.set(h, c);
            }
            total += c;
          }
          remoteCache.set(key, total);
          remoteByText.set(pieceHash(parts), total);
        }),
      );
    } catch {
      /* never reject: the estimate covers anything not fetched */
    }
  }

  const counter: Counter = {
    mode,
    id,
    profile,
    countText(text: string): number {
      if (mode === 'exact') {
        // long texts (summaries re-rendered across fit-loop rungs) are cached by content hash
        if (text.length < 1024) return tok!.count(text);
        const h = sha256Hex(text);
        let n = textCache.get(h);
        if (n === undefined) {
          n = tok!.count(text);
          st.tokenizedChars += text.length;
          textCache.set(h, n);
        }
        return n;
      }
      if (mode === 'remote') {
        const h = text.length > 64 ? sha256Hex(text) : text;
        const r = remoteText.get(h);
        if (r !== undefined) return r;
      }
      return estimateText(text, { charsPerToken: cpt, safetyFactor: safety });
    },
    measure,
    countRequest: (req, digests) => measure(req, digests).total,
    stats: () => ({ ...st }),
    clear() {
      exactCache.clear();
      exactByText.clear();
      estCache.clear();
      remoteCache.clear();
      remoteByText.clear();
      remoteText.clear();
      textCache.clear();
    },
  };
  if (mode === 'remote') counter.prefetch = prefetch;
  return counter;
}

export interface CounterDeps {
  /** a loaded tokenizer (loadTokenizerCached); null/undefined = none */
  tokenizer?: Tokenizer | null;
  /** tokenizer identity for `id`; defaults to the LoadedTokenizer sha256 */
  tokenizerId?: string | null;
  /** the gateway tokenize client (remoteFromConfig); used only without a tokenizer */
  remote?: RemoteTokenizer | null;
}

/**
 * The counter the config describes (DESIGN.md): 'exact' with a tokenizer, else 'remote' when a
 * tokenize endpoint client is given, else 'estimate'. Loading the tokenizer (loadTokenizerCached,
 * which throws TokenizerUnsupportedError for unsupported files) and building the remote client
 * (remoteFromConfig) are the caller's, so that startup can do them in the background.
 */
export function counterFromConfig(cfg: Config, deps: CounterDeps = {}): Counter {
  const t = cfg.tokenizer;
  const tokenizer = deps.tokenizer ?? null;
  const mode: CounterMode = tokenizer ? 'exact' : deps.remote ? 'remote' : 'estimate';
  return createCounter({
    mode,
    template: t.template.name,
    templateOptions: { enableThinking: t.template.enableThinking, perMessageOverhead: t.fallback.perMessageOverhead },
    tokenizer,
    tokenizerId: deps.tokenizerId ?? (tokenizer as Partial<LoadedTokenizer> | null)?.sha256 ?? null,
    imageTokens: t.imageTokens,
    cacheEntries: t.cacheEntries,
    fallback: t.fallback,
    remote: mode === 'remote' ? deps.remote ?? null : null,
  });
}
