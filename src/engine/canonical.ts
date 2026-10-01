// Digests, the hash chain and plan keys (DESIGN.md, §5.3).
//
//   d_i    = sha256(canonicalJSON(H[i]))            every field included, reasoning too (ADR-8)
//   K_i    = sha256(K_{i-1} ‖ d_i),  K_{-1} = sha256("kitzur/chain/1")   (hex strings concatenated)
//   key(b) = sha256(K_{b-1} ‖ hash(P))
//
// The chain is derived from gobstopper v0.7.2 (MIT), crates/gobstopper-adapters/src/request/mod.rs:522-533
// (h_i = sha256_hex(h_{i-1} ‖ d_i)); the digest itself is ours (canonical JSON of the whole message).
import { createHash } from 'node:crypto';
import type { ChatMessage, PlanningInputs } from '../types.js';
import { canonicalJSON, compareCodePoints, digestOf, sha256Hex } from '../tokenize/canonical.js';

export { canonicalJSON, digestOf, sha256Hex };

/**
 * sha256(canonicalJSON(v)) without building the canonical string: small pieces are batched, large
 * string values are fed to the hash directly. Byte-identical to digestOf (every piece is well-formed
 * UTF-16, since JSON.stringify escapes lone surrogates, so per-piece UTF-8 equals the whole's).
 */
export function streamDigest(v: unknown): string {
  const h = createHash('sha256');
  let buf = '';
  const flush = (): void => {
    if (buf) {
      h.update(buf, 'utf8');
      buf = '';
    }
  };
  const put = (s: string): void => {
    if (s.length > 4096) {
      flush();
      h.update(s, 'utf8');
    } else {
      buf += s;
      if (buf.length > 65_536) flush();
    }
  };
  const walk = (x: unknown): void => {
    if (x === null || x === undefined) return put('null');
    switch (typeof x) {
      case 'string':
      case 'number':
        return put(JSON.stringify(x));
      case 'boolean':
        return put(x ? 'true' : 'false');
      case 'bigint':
        return put(x.toString());
      case 'object':
        break;
      default:
        return put('null');
    }
    if (Array.isArray(x)) {
      put('[');
      for (let i = 0; i < x.length; i++) {
        if (i) put(',');
        walk(x[i]);
      }
      return put(']');
    }
    const src = x instanceof Map ? Object.fromEntries(x as Map<string, unknown>) : (x as Record<string, unknown>);
    const keys = Object.keys(src).filter((k) => src[k] !== undefined).sort(compareCodePoints);
    put('{');
    for (let i = 0; i < keys.length; i++) {
      if (i) put(',');
      put(JSON.stringify(keys[i]!) + ':');
      walk(src[keys[i]!]);
    }
    put('}');
  };
  walk(v);
  flush();
  return h.digest('hex');
}

/** K_{-1}: the chain key of the empty history. */
export const CHAIN_ROOT = sha256Hex('kitzur/chain/1');

/** K_0..K_{n-1} for the given digests. */
export function chainKeys(digests: readonly string[]): string[] {
  const out = new Array<string>(digests.length);
  let k = CHAIN_ROOT;
  for (let i = 0; i < digests.length; i++) {
    k = sha256Hex(k + digests[i]!);
    out[i] = k;
  }
  return out;
}

/** Chain key of H[0..b) (K_{b-1}; CHAIN_ROOT for b = 0). */
export const chainAt = (K: readonly string[], b: number): string => (b <= 0 ? CHAIN_ROOT : K[b - 1]!);

/** hash(P): sha256 of the canonical JSON of the planning inputs. */
export const inputsHash = (P: PlanningInputs): string => sha256Hex(canonicalJSON(P));

/** planKey = sha256(K_{b-1} ‖ hash(P)). */
export const planKey = (chainKey: string, pHash: string): string => sha256Hex(chainKey + pHash);

/**
 * Digest cache by object identity. Original messages are new objects on every request (the proxy
 * parses each body), but rewrites and summary messages live in long-lived plans, so their digests
 * are computed once.
 */
export class DigestCache {
  private readonly byObject = new WeakMap<object, string>();

  of(m: ChatMessage): string {
    if (typeof m !== 'object' || m === null) return digestOf(m);
    let d = this.byObject.get(m);
    if (d === undefined) {
      d = streamDigest(m);
      this.byObject.set(m, d);
    }
    return d;
  }

  all(msgs: readonly ChatMessage[]): string[] {
    return msgs.map((m) => this.of(m));
  }
}
