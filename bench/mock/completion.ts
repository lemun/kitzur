// What the mock generates (bench/README.md`completionModel`, §3):
//
//  - `completionModel: 'sim'`: the scripted assistant turn as is; completion_tokens = count(content +
//    json.dumps(tool_calls)), exactly the Python mock's formula (about 67 tokens per reference step);
//  - `{reasoning, text, seed}`: seeded sizes. The reasoning text is the scripted `reasoning_content` (or
//    "Reasoning:") padded with single-token filler words to the drawn size; the visible text is the scripted content
//    padded to the drawn text size when that is larger. completion_tokens = count(reasoning) + the sim formula.
//    The draw depends only on (seed, scenario, session, step, kind), so a retried or interleaved request gets the
//    same turn;
//  - generation is capped (SPEC mode only) at min(forwarded max_tokens, window room): reasoning first, then text,
//    then the tool calls; a cut turn has no tool calls and ends with finish_reason "length";
//  - summarizer / title requests get deterministic placeholders: `template` = the OpenCode SUMMARY_TEMPLATE
//    sections padded to `summaryTokens`, listing every scenario marker visible in the request (baseline.py
//    semantics) and planting the scenario's client-summary markers at 40%…90% of the text; `baseline` =
//    baseline.py's exact filler (`- summary bullet …` × tokens//14, then the sorted visible markers).

import { createHash } from 'node:crypto';
import type { Dist } from '../scenarios/types.js';
import type { ToolCall } from '../../src/types.js';
import { PyRandom } from '../lib/pyrandom.js';
import { cmpCodePoints, pyDumps } from '../lib/pyjson.js';
import type { PromptCounter } from '../lib/render.js';

/** 40 words that are one Qwen3.6 token each with a leading space (MEASURED with HF tokenizers 0.23.2). */
export const FILLER_WORDS: readonly string[] = (
  'the page check state next step test value form button list item order cart price total field label error model ' +
  'plan data file line code path view link user name selector click wait result spec flow reason option update detail'
).split(' ');

export interface DistModel {
  reasoning: Dist;
  text: Dist;
  seed: number;
}

/** A PyRandom seeded from a stable hash of the key parts. */
export function keyedRng(...parts: Array<string | number>): PyRandom {
  const h = createHash('sha256').update(parts.map(String).join('\u0000')).digest();
  return new PyRandom(h.readUInt32BE(0) * 2 ** 21 + (h.readUInt32BE(4) >>> 11)); // 53-bit seed
}

const Z95 = 1.6448536269514722;

/** One draw (≥ 0, integer). lognormal: median·exp(σz), σ = ln(p95/median)/z95, z standard normal (Box-Muller). */
export function drawDist(d: Dist, rng: PyRandom): number {
  if (d.kind === 'fixed') return Math.max(0, Math.round(d.value));
  const u1 = rng.random();
  const u2 = rng.random();
  const z = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
  const sigma = d.p95 > d.median && d.median > 0 ? Math.log(d.p95 / d.median) / Z95 : 0;
  return Math.max(0, Math.round(d.median * Math.exp(sigma * z)));
}

/** n filler words, each with its leading space (exactly n tokens). */
export function fillerWords(n: number, rng: PyRandom | null, offset = 0): string {
  let s = '';
  for (let i = 0; i < n; i++) s += ' ' + FILLER_WORDS[rng ? rng.randbelow(FILLER_WORDS.length) : (offset + i) % FILLER_WORDS.length]!;
  return s;
}

/** The longest prefix of `text` (whole code points) with at most k tokens. */
export function truncateToTokens(text: string, k: number, counter: PromptCounter): string {
  if (k <= 0) return '';
  if (counter.countText(text) <= k) return text;
  const cps = [...text];
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (counter.countText(cps.slice(0, mid).join('')) <= k) lo = mid;
    else hi = mid - 1;
  }
  return cps.slice(0, lo).join('');
}

export interface ScriptedTurn {
  content: string | null;
  reasoning: string | null;
  tool_calls: ToolCall[];
}

export interface GeneratedTurn extends ScriptedTurn {
  finish_reason: 'tool_calls' | 'stop' | 'length';
  completion_tokens: number;
  reasoning_tokens: number;
}

/** The sim formula of mock_server.py. */
export const simCompletion = (t: ScriptedTurn, counter: PromptCounter): number => counter.countText((t.content || '') + pyDumps(t.tool_calls));

/** Apply the distribution model to a scripted turn (no cap). */
export function expandTurn(t: ScriptedTurn, model: DistModel, key: Array<string | number>, counter: PromptCounter): ScriptedTurn {
  const rng = keyedRng(model.seed, ...key);
  const r = drawDist(model.reasoning, rng);
  const x = drawDist(model.text, rng);
  let reasoning = t.reasoning;
  if (r > 0) {
    const head = t.reasoning || 'Reasoning:';
    reasoning = head + fillerWords(Math.max(0, r - counter.countText(head)), rng);
  }
  let content = t.content;
  const have = content ? counter.countText(content) : 0;
  if (x > have) {
    const head = content || 'Note:';
    content = head + fillerWords(Math.max(0, x - counter.countText(head)), rng);
  }
  return { content, reasoning, tool_calls: t.tool_calls };
}

/**
 * completion_tokens of an emitted turn: reasoning + the Python formula when the turn has tool calls (identical to
 * mock_server.py), reasoning + text otherwise (a turn without calls generated no `[]`).
 */
export function completionTokens(t: ScriptedTurn, counter: PromptCounter): number {
  const r = t.reasoning ? counter.countText(t.reasoning) : 0;
  return r + (t.tool_calls.length ? simCompletion(t, counter) : counter.countText(t.content || ''));
}

/**
 * Cap a turn at `cap` generated tokens (null = uncapped), in generation order: reasoning, text, tool calls. A cut
 * turn has no tool calls, finish_reason "length" and at most `cap` completion tokens.
 */
export function capTurn(t: ScriptedTurn, cap: number | null, counter: PromptCounter): GeneratedTurn {
  const rTok = t.reasoning ? counter.countText(t.reasoning) : 0;
  const full = completionTokens(t, counter);
  if (cap === null || full <= cap) return { ...t, finish_reason: t.tool_calls.length ? 'tool_calls' : 'stop', completion_tokens: full, reasoning_tokens: rTok };
  if (rTok >= cap) {
    const reasoning = truncateToTokens(t.reasoning ?? '', cap, counter);
    const n = counter.countText(reasoning);
    return { content: null, reasoning: reasoning || null, tool_calls: [], finish_reason: 'length', completion_tokens: n, reasoning_tokens: n };
  }
  const content = t.content ? truncateToTokens(t.content, cap - rTok, counter) || null : null;
  const out: ScriptedTurn = { content, reasoning: t.reasoning, tool_calls: [] };
  return { ...out, finish_reason: 'length', completion_tokens: completionTokens(out, counter), reasoning_tokens: rTok };
}

// ---------------------------------------------------------------- summarizer / title placeholders

export interface SummaryOptions {
  style: 'template' | 'baseline';
  tokens: number;
  /** scenario markers visible in the summarizer request (any order; sorted here) */
  visible: readonly string[];
  /** markers that exist only in the client summary, with their relative position (0..1) */
  plant?: ReadonlyArray<{ marker: string; at: number }>;
}

/** baseline.py compact(): the filler, "\n", the sorted visible markers joined by spaces. */
export function baselineSummary(tokens: number, visible: readonly string[]): string {
  return ('- ' + 'summary bullet '.repeat(6) + '\n').repeat(Math.floor(tokens / 14)) + '\n' + [...visible].sort(cmpCodePoints).join(' ');
}

function templateSummary(nFill: number, visible: readonly string[], plant: ReadonlyArray<{ marker: string; at: number }>): string {
  const fill: string[] = [];
  for (let i = 0; i < nFill; i++) fill.push(`- detail ${i + 1}:` + fillerWords(8, null, i * 8));
  const head = [
    '## Objective',
    '- Continue the scripted benchmark task; keep every constraint and identifier listed below.',
    '',
    '## Important Details',
    '- Preserved identifiers: ' + (visible.length ? [...visible].sort(cmpCodePoints).join(' ') : '(none)'),
    '',
    '## Work State',
    '### Completed',
  ];
  const tail = ['', '### Active', '- Continuing from the last completed step.', '', '### Blocked', '- (none)', '', '## Next Move',
    '1. Continue with the next scripted step.', '2. (none)', '', '## Relevant Files', '- (none)'];
  const lines = [...head, ...(fill.length ? fill : ['- (none)']), ...tail];
  if (plant.length) {
    // insert each planted marker as its own bullet at the line nearest to its character fraction
    const total = lines.join('\n').length;
    const sorted = [...plant].sort((a, b) => b.at - a.at); // back to front keeps earlier offsets valid
    for (const p of sorted) {
      let acc = 0;
      let idx = lines.length;
      for (let i = 0; i < lines.length; i++) {
        if (acc >= p.at * total) {
          idx = i;
          break;
        }
        acc += lines[i]!.length + 1;
      }
      lines.splice(idx, 0, `- Client note: ${p.marker}`);
    }
  }
  return lines.join('\n');
}

/** The summarizer placeholder: at most `tokens` tokens (template style), deterministic. */
export function summaryPlaceholder(o: SummaryOptions, counter: PromptCounter): string {
  const plant = o.plant ?? [];
  const planted = new Set(plant.map((p) => p.marker));
  const visible = o.visible.filter((m) => !planted.has(m));
  if (o.style === 'baseline') {
    const base = baselineSummary(o.tokens, visible);
    if (!plant.length) return base;
    const lines = base.split('\n');
    for (const p of [...plant].sort((a, b) => b.at - a.at)) lines.splice(Math.round(p.at * lines.length), 0, `- ${p.marker}`);
    return lines.join('\n');
  }
  let lo = 0;
  let hi = Math.max(1, Math.ceil(o.tokens / 4));
  while (counter.countText(templateSummary(hi, visible, plant)) <= o.tokens) hi *= 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (counter.countText(templateSummary(mid, visible, plant)) <= o.tokens) lo = mid;
    else hi = mid - 1;
  }
  return templateSummary(lo, visible, plant);
}

export const TITLE_PLACEHOLDER = 'Scripted benchmark session';

/** Default positions of the client-summary markers: one at 40%, two at 40% and 90%, more spread between. */
export function plantPositions(markers: readonly string[]): Array<{ marker: string; at: number }> {
  if (markers.length === 1) return [{ marker: markers[0]!, at: 0.4 }];
  return markers.map((marker, i) => ({ marker, at: 0.4 + (0.5 * i) / (markers.length - 1) }));
}
