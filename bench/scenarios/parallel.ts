// F7 parallel calls (bench/README.md): `par46`. Every navigate/snapshot step issues 2–4 calls in one assistant
// message (navigate/snapshot first, then console, network and screenshot tools), answered by as many tool messages in
// the same order; the extra outputs are seeded by (step, i). One snapshot step has a 60,000-char third result.
// Uncapped, like the Python A_* runs, so the 60k result stays whole. Gate: G1 (strict positional pairing).

import type { ChatMessage, ToolCall } from '../../src/types.js';
import { PyRandom } from '../lib/pyrandom.js';
import { kind, WORDS } from './reference.js';
import { fact, makeSession, MarkerFactory, type ScenarioContext, type ScenarioDef, type SessionScript } from './common.js';
import { refFacts } from './browser.js';
import { BrowserGen } from './browser-gen.js';

const EXTRA_TOOLS = ['browser_console_messages', 'browser_network_requests', 'browser_take_screenshot'] as const;
export const PAR_BIG_STEP = 14; // a snapshot step; its third result is 60,000 chars
export const PAR_BIG_CHARS = 60_000;

/** Number of calls at a step: 2–4 on navigate/snapshot steps, 1 elsewhere. */
export function parallelCalls(step: number): number {
  const k = kind(step);
  if (k !== 'navigate' && k !== 'snapshot') return 1;
  if (step === PAR_BIG_STEP) return 3;
  return 2 + new PyRandom(7000 + step).randbelow(3);
}

function extraOutput(step: number, i: number, marker: string | null): string {
  const rng = new PyRandom(700_000 + step * 10 + i);
  const tool = EXTRA_TOOLS[i - 1]!;
  const target = step === PAR_BIG_STEP && i === 2 ? PAR_BIG_CHARS : rng.randint(800, 5000);
  const head = tool === 'browser_take_screenshot'
    ? `Took the viewport screenshot of the checkout page (step ${step})`
    : tool === 'browser_console_messages' ? `### Console messages (step ${step})` : `### Network requests (step ${step})`;
  const lines = [marker ? `${head} [${marker}]` : head];
  let size = lines[0]!.length;
  let n = 0;
  while (size < target) {
    n++;
    const w = rng.choice(WORDS);
    const line = tool === 'browser_network_requests'
      ? `[GET] https://staging-3.shop.example/api/${w}/${rng.randint(100, 9999)} => [${rng.choice([200, 200, 200, 304, 404])}] ${rng.randint(1, 900)}ms`
      : tool === 'browser_console_messages'
        ? `[${rng.choice(['log', 'info', 'warning', 'error'])}] ${w} component rendered in ${rng.randint(1, 400)}ms @ checkout.js:${rng.randint(10, 9000)}`
        : `  region ${n}: ${w} ${rng.randint(0, 1920)}x${rng.randint(0, 1080)}`;
    lines.push(line);
    size += line.length + 1;
  }
  let out = lines.join('\n');
  if (step === PAR_BIG_STEP && i === 2) out = out.slice(0, PAR_BIG_CHARS);
  return out;
}

export function par46(_ctx: ScenarioContext): ScenarioDef {
  const mf = new MarkerFactory(7007);
  const second = mf.make('PAR-SECOND');
  const big = mf.make('PAR-BIG');
  const secondStep = 9; // a snapshot step with >= 2 calls
  const gen = new BrowserGen({ id: 'default', steps: 46, capBytes: null });
  const base = gen.script();
  const script: SessionScript = {
    ...base,
    assistant: (step): ChatMessage => {
      const a = base.assistant(step);
      const n = parallelCalls(step);
      if (n === 1) return a;
      const first = (a.tool_calls as ToolCall[])[0]!;
      const calls: ToolCall[] = [first];
      for (let i = 1; i < n; i++) {
        calls.push({ id: first.id.replace(/_0$/, `_${i}`), type: 'function', function: { name: EXTRA_TOOLS[i - 1]!, arguments: '{}' } });
      }
      return { ...a, tool_calls: calls };
    },
    results: (step) => {
      const n = parallelCalls(step);
      const out = base.results(step);
      for (let i = 1; i < n; i++) {
        const marker = step === secondStep && i === 1 ? second : step === PAR_BIG_STEP && i === 2 ? big : null;
        out.push(extraOutput(step, i, marker));
      }
      return out;
    },
  };
  return {
    id: 'par46', family: 'F7', sessions: [makeSession(script)],
    facts: [...refFacts(false), fact('par-second', second, 'output-head', 'survive', false), fact('par-big-head', big, 'output-head', 'survive', false)],
    client: 'sim', capBytes: null, mock: { render: 'sim' }, gates: ['G1'], expect: 'complete', windows: ['100k'],
    description: 'navigate/snapshot steps issue 2–4 parallel calls; step 14 has a 60,000-char third result; uncapped',
  };
}
