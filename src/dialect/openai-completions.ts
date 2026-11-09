// OpenAI legacy Completions (/v1/completions): read-only prompt extraction and counting.
//
//  - routing: any path ending in /completions but not /chat/completions, method POST.
//  - parse: reads only `prompt`; the body is never modified or re-serialized, so integer precision does
//    not matter here. Token-id prompts are reported, not counted.
//  - count: every prompt is counted as text; fill-in-the-middle sentinels are ordinary text.

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Any path ending in /completions but not /chat/completions (any prefix, trailing slashes ignored), method POST. */
export function isLegacyCompletionsPath(method: string, pathname: string): boolean {
  if (method !== 'POST') return false;
  let p = pathname;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p.endsWith('/completions') && !p.endsWith('/chat/completions');
}

export type LegacyPromptResult =
  | { ok: true; prompts: string[] }
  | { ok: false; reason: 'not_json' | 'not_object' | 'no_prompt' | 'token_ids' | 'unsupported' };

const isNumberArray = (x: unknown): x is number[] => Array.isArray(x) && x.every((n) => typeof n === 'number');

/**
 * Reads the prompt of a legacy Completions body: a string gives one prompt, an array of strings gives one
 * per element. Token ids (an array of numbers, or of number arrays) are `token_ids`; bytes that are not
 * UTF-8 or not JSON are `not_json`.
 */
export function parseLegacyPrompt(raw: Buffer): LegacyPromptResult {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (!isObj(value)) return { ok: false, reason: 'not_object' };
  const prompt = value['prompt'];
  if (prompt === undefined) return { ok: false, reason: 'no_prompt' };
  if (typeof prompt === 'string') return { ok: true, prompts: [prompt] };
  if (!Array.isArray(prompt)) return { ok: false, reason: 'unsupported' };
  if (prompt.length === 0) return { ok: false, reason: 'no_prompt' };
  if (prompt.every((p) => typeof p === 'string')) return { ok: true, prompts: prompt as string[] };
  if (isNumberArray(prompt) || prompt.every(isNumberArray)) return { ok: false, reason: 'token_ids' };
  return { ok: false, reason: 'unsupported' };
}

/** Sum and maximum of the per-prompt counts; both 0 for no prompts. */
export function countLegacyPrompt(counter: { countText(text: string): number }, prompts: string[]): { total: number; max: number } {
  let total = 0;
  let max = 0;
  for (const p of prompts) {
    const n = counter.countText(p);
    total += n;
    if (n > max) max = n;
  }
  return { total, max };
}
