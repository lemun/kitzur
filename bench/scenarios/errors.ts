// F11 error styles (bench/README.md): one scenario per ErrorStyleId, on the qa46 content (O1 planted, not gated here),
// with the mock's real limit set BELOW kitzur's forwarding ceiling so every style actually overflows ():
//   limitSkewTokens = W − L_fwd + ceil(0.04·W),  L_fwd = hard + O | hard + min(O,1024) | hard   (§7.1)
// The skew depends on the window, so these scenarios are built per window (ScenarioContext).
// `-hidden` variants add hiddenOverheadTokens = 3% (every style but unknown400). `err-http413` takes maxBodyBytes from
// the same system's qa46 cell (floor(0.9·B_max), resolved by the matrix); `err-http413-image` adds two 600 KB image
// messages and uses a fixed 768 KiB.

import type { ChatMessage } from '../../src/types.js';
import { PyRandom } from '../lib/pyrandom.js';
import { fact, makeSession, type ScenarioContext, type ScenarioDef } from './common.js';
import { OPENCODE_CAP_BYTES, qaWithO1 } from './browser.js';
import type { ErrorStyleId, FactSpec, MockOptions } from './types.js';
import { errorSkew, type LimitMode } from './windows.js';

export const ERROR_STYLE_IDS: readonly ErrorStyleId[] = [
  'vllm-legacy', 'vllm-018', 'sglang', 'llamacpp', 'tgi422', 'litellm', 'http413', 'gateway502', 'sse-inline', 'late400',
  'unknown400', 'python-vllm', 'python-llamacpp', 'python-gateway502', 'python-tgi422',
];

/** benchmark contract : the server mode of each style. */
export const STYLE_MODE: Readonly<Record<ErrorStyleId, LimitMode>> = {
  'vllm-legacy': 'strict_total', 'vllm-018': 'strict_total', sglang: 'strict_total', llamacpp: 'prompt_only', tgi422: 'tgi',
  litellm: 'strict_total', http413: 'strict_total', gateway502: 'strict_total', 'sse-inline': 'strict_total',
  late400: 'strict_total', unknown400: 'strict_total',
  'python-vllm': 'strict_total', 'python-llamacpp': 'prompt_only', 'python-gateway502': 'strict_total', 'python-tgi422': 'tgi',
};

/** Styles G6 treats as "configured" (all but unknown400, which tests the pass-through path). */
export const CONFIGURED_STYLES: readonly ErrorStyleId[] = ERROR_STYLE_IDS.filter((s) => s !== 'unknown400');

/** The G8 subset of F11 (benchmark contract Windows). */
export const G8_STYLES: readonly ErrorStyleId[] = ['vllm-018', 'gateway502'];

export const IMAGE_BYTES = 600 * 1024;
export const IMAGE_MAX_BODY_BYTES = 768 * 1024;
export const IMAGE_STEPS = [8, 16] as const;

export function styleMock(style: ErrorStyleId, ctx: ScenarioContext, hidden: boolean): Partial<MockOptions> {
  const mode = STYLE_MODE[style];
  const m: Partial<MockOptions> = {
    render: 'sim',
    limitMode: mode,
    limitSkewTokens: errorSkew(ctx.window, mode),
    errorStyle: style,
    inStreamErrors: style === 'sse-inline',
  };
  if (hidden) m.hiddenOverheadTokens = '3%';
  if (style === 'late400') m.headerDelayMs = 20_000;
  return m;
}

/** A deterministic ~600 KB base64 PNG-ish payload (not a valid image; the mock only measures bytes). */
export function imagePart(seed: number, bytes = IMAGE_BYTES): { type: 'image_url'; image_url: { url: string } } {
  const rng = new PyRandom(seed);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const prefix = 'data:image/png;base64,iVBORw0KGgo';
  const chars: string[] = [];
  for (let i = prefix.length; i < bytes; i++) chars.push(alphabet[rng.randbelow(64)]!);
  return { type: 'image_url', image_url: { url: prefix + chars.join('') } };
}

function build(style: ErrorStyleId, ctx: ScenarioContext, variant: 'base' | 'hidden' | 'image'): ScenarioDef {
  const id = `err-${style}${variant === 'hidden' ? '-hidden' : variant === 'image' ? '-image' : ''}`;
  const { script, facts } = qaWithO1({ id, steps: 46 });
  const o1 = facts.map((f) => ({ ...f, gate: false }));
  let s = script;
  const extra: FactSpec[] = [];
  if (variant === 'image') {
    const markers = ['IMG-A-K4M7Q', 'IMG-B-R8T2W'];
    s = {
      ...script,
      users: (step) => {
        const i = IMAGE_STEPS.indexOf(step as (typeof IMAGE_STEPS)[number]);
        if (i < 0) return script.users(step);
        const m: ChatMessage = { role: 'user', content: [{ type: 'text', text: `Screenshot of the failing promo banner (${markers[i]!}).` }, imagePart(1300 + i)] };
        return [...script.users(step), m];
      },
    };
    extra.push(fact('img-a', markers[0]!, 'user', 'report-only', false), fact('img-b', markers[1]!, 'user', 'report-only', false));
  }
  const mock = styleMock(style, ctx, variant === 'hidden');
  if (variant === 'image') mock.maxBodyBytes = IMAGE_MAX_BODY_BYTES;
  const def: ScenarioDef = {
    id, family: 'F11', sessions: [makeSession(s)], facts: [...o1, ...extra], client: 'sim', capBytes: OPENCODE_CAP_BYTES,
    mock, gates: ['G6'], expect: style === 'unknown400' ? 'error-unchanged' : 'complete',
    windows: G8_STYLES.includes(style) && variant !== 'image' ? ['100k', '64k', '32k'] : ['100k'],
    description: `${style}${variant === 'hidden' ? ' + 3% hidden overhead' : variant === 'image' ? ' with two 600 KB images (768 KiB body limit)' : ''}, real limit below kitzur's forwarding ceiling`,
  };
  if (style === 'http413' && variant !== 'image') def.maxBodyBytesFrom = { scenario: 'qa46', factor: 0.9 };
  return def;
}

export const errorBuilders: Record<string, (ctx: ScenarioContext) => ScenarioDef> = (() => {
  const out: Record<string, (ctx: ScenarioContext) => ScenarioDef> = {};
  for (const style of ERROR_STYLE_IDS) {
    out[`err-${style}`] = (ctx) => build(style, ctx, 'base');
    if (style !== 'unknown400') out[`err-${style}-hidden`] = (ctx) => build(style, ctx, 'hidden');
  }
  out['err-http413-image'] = (ctx) => build('http413', ctx, 'image');
  return out;
})();
