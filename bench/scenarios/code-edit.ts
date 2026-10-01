// F3 code-edit (bench/README.md): `code60`, a 60-step refactoring session over 25 files with read / edit /
// apply_patch / bash test / grep / write, a todowrite every 15 steps and a snapshot every 15 steps.
// Facts: a DECISION at step 3; a path that appears only in an early `write` argument; a path that appears only in a
// failing test's stack trace; a BLOCKED tag; a cue+overlap correction with no shared ID; the latest test tally.
// Content reuses reference.ts generators (codeFile, testOutput, snapshot) with seeded PyRandom streams.

import type { ChatMessage } from '../../src/types.js';
import { PyRandom } from '../lib/pyrandom.js';
import { pyDumps } from '../lib/pyjson.js';
import { codeFile, snapshot, systemPrompt, testOutput, tools as referenceTools, WORDS, type ToolDef } from './reference.js';
import { assistantWithCalls, capOutput, fact, MarkerFactory, makeSession, userMsg, type ScenarioContext, type ScenarioDef } from './common.js';
import { OPENCODE_CAP_BYTES } from './browser.js';
import type { FactSpec } from './types.js';

const AREAS = ['cart', 'payment', 'shipping', 'promo', 'review'] as const;
const NAMES = ['Helpers', 'Selectors', 'Fixtures', 'Steps', 'Assertions'] as const;
const cap1 = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The 25 files of the session. */
export const CODE_FILES: readonly string[] = AREAS.flatMap((a) => NAMES.map((n) => `src/checkout/${a}/${cap1(a)}${n}.ts`));

export const CODE_STEPS = 60;
const TODO_STEPS = [5, 20, 35, 50];
const SNAP_STEPS = [7, 22, 37, 52];
const CYCLE = ['read', 'edit', 'test', 'grep', 'apply_patch', 'read', 'edit', 'test'] as const;
type CodeKind = 'ls' | 'decision' | 'write' | 'todo' | 'snapshot' | (typeof CYCLE)[number];

export function codeKind(step: number): CodeKind {
  if (step === 0) return 'ls';
  if (step === 3) return 'decision';
  if (step === 4) return 'write';
  if (TODO_STEPS.includes(step)) return 'todo';
  if (SNAP_STEPS.includes(step)) return 'snapshot';
  return CYCLE[step % CYCLE.length]!;
}

export const APPLY_PATCH_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'apply_patch',
    description: 'Apply a patch in the *** Begin Patch / *** End Patch format to one or more files.',
    parameters: { type: 'object', properties: { patchText: { type: 'string', description: 'the full patch text' } }, required: ['patchText'] },
  },
};

export interface CodeMarkers {
  goal: string;
  decision: string;
  writePath: string;
  tracePath: string;
  blocked: string;
  ffOld: string;
  wkNew: string;
  tallies: Map<number, string>;
}

const FAILING_TRACE_STEP = 10;
const BLOCKED_STEP = 25; // an edit step (25 % 8 === 1)
const CORR_STEPS = { old: 9, new: 33 };

export function codeMarkers(seed = 3003): CodeMarkers {
  const mf = new MarkerFactory(seed);
  const tallies = new Map<number, string>();
  for (let s = 0; s + 1 < CODE_STEPS; s++) if (codeKind(s) === 'test') tallies.set(s, mf.make(`TLY-S${s}`));
  return {
    goal: mf.make('GOAL-CE'),
    decision: mf.make('DECISION'),
    writePath: `src/checkout/fixtures/gift-wrap-${mf.make('FX').slice(3).toLowerCase()}.fixture.ts`,
    tracePath: `src/checkout/helpers/retry-banner-${mf.make('TR').slice(3).toLowerCase()}.ts`,
    blocked: mf.make('BLK'),
    ffOld: mf.make('FF'),
    wkNew: mf.make('WK'),
    tallies,
  };
}

class CodeGen {
  constructor(readonly m: CodeMarkers) {}

  private file(rng: PyRandom): string {
    return CODE_FILES[rng.randbelow(CODE_FILES.length)]!;
  }

  plan(step: number): { text: string; calls: Array<[string, Record<string, unknown>]> } {
    const rng = new PyRandom(90_000 + step);
    const k = codeKind(step);
    const f = this.file(rng);
    const w = rng.choice(WORDS);
    const say = (t: string): string => (rng.random() < 0.2 ? '' : `${t} (step ${step})`);
    switch (k) {
      case 'ls':
        return { text: say('Listing the checkout sources.'), calls: [['bash', { command: 'git ls-files src/checkout tests/e2e/checkout' }]] };
      case 'decision':
        return {
          text: `${this.m.decision}: keep every checkout helper in src/checkout/helpers and never import from tests/. Reading ${f} next.`,
          calls: [['read', { filePath: `/repo/${f}` }]],
        };
      case 'write':
        return {
          text: say('Adding a gift-wrap fixture.'),
          calls: [['write', { filePath: `/repo/${this.m.writePath}`, content: `export const giftWrap = { label: '${w}', price: 4.99 };\n` }]],
        };
      case 'todo':
        return { text: say('Updating the plan.'), calls: [['todowrite', { todos: this.todos(step) }]] };
      case 'snapshot':
        return { text: say('Checking the rendered checkout page.'), calls: [['browser_snapshot', {}]] };
      case 'read':
        return { text: say(`Reading ${f}.`), calls: [['read', { filePath: `/repo/${f}` }]] };
      case 'edit':
        return {
          text: step === BLOCKED_STEP
            ? `BLOCKED: the payment sandbox rejects every test card (${this.m.blocked}); continuing with the cart helpers.`
            : say(`Editing ${f}.`),
          calls: [['edit', { filePath: `/repo/${f}`, oldString: `page.locator('.${w}-btn')`, newString: `page.getByTestId('${w}-btn')` }]],
        };
      case 'apply_patch':
        return {
          text: say(`Patching ${f}.`),
          calls: [['apply_patch', { patchText: `*** Begin Patch\n*** Update File: ${f}\n@@\n-  await page.locator('.${w}').click();\n+  await page.getByTestId('${w}').click();\n*** End Patch` }]],
        };
      case 'test': {
        const spec = rng.choice(AREAS);
        return { text: say(`Running the ${spec} specs.`), calls: [['bash', { command: `npx playwright test tests/e2e/checkout/${spec}.spec.ts --reporter=line` }]] };
      }
      case 'grep':
        return { text: say('Searching for class selectors.'), calls: [['grep', { pattern: "locator\\('\\.", path: '/repo/src/checkout' }]] };
    }
  }

  todos(step: number): Array<{ content: string; status: string }> {
    const items = ['Move cart helpers to src/checkout/helpers', 'Replace class selectors in payment steps', 'Add gift-wrap fixture coverage', 'Run the full checkout suite'];
    const done = TODO_STEPS.indexOf(step);
    return items.map((content, i) => ({ content, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' }));
  }

  assistant(step: number): ChatMessage {
    const p = this.plan(step);
    return assistantWithCalls(step, p.text, p.calls);
  }

  outputRaw(step: number): string {
    const rng = new PyRandom(95_000 + step);
    const k = codeKind(step);
    const p = this.plan(step);
    const args = p.calls[0]![1];
    switch (k) {
      case 'ls':
        return [...CODE_FILES, ...AREAS.map((a) => `tests/e2e/checkout/${a}.spec.ts`)].join('\n');
      case 'decision':
      case 'read':
        return codeFile(rng, rng.choice([3000, 6000, 9000]), (args['filePath'] as string).split('/').pop()!);
      case 'write':
        return 'Wrote file successfully.';
      case 'todo':
        return pyDumps(args['todos'], { indent: 2 });
      case 'snapshot':
        return snapshot(rng, rng.choice([20000, 30000, 40000]), 'https://staging-3.shop.example/checkout/review');
      case 'edit':
        return 'Edit applied successfully.';
      case 'apply_patch':
        return `Success. Updated the following files:\nM ${(args['patchText'] as string).split('\n')[1]!.slice('*** Update File: '.length)}`;
      case 'test': {
        const failing = step === FAILING_TRACE_STEP;
        let out = testOutput(rng, rng.choice([2500, 4000, 6000]), !failing && rng.random() < 0.5);
        if (failing) {
          // one extra stack frame, only here: the path appears in no other message
          out = out.replace(/(\n    at tests\/e2e\/checkout\/[^\n]*)/, `$1\n    at retryBanner (${this.m.tracePath}:88:13)`);
        }
        const t = this.m.tallies.get(step);
        return t ? `${out} (${t})` : out;
      }
      case 'grep': {
        const lines: string[] = [];
        for (let i = 0; i < 30; i++) lines.push(`/repo/${this.file(rng)}:${rng.randint(1, 300)}:  await page.locator('.${rng.choice(WORDS)}-btn').click();`);
        return lines.join('\n');
      }
    }
  }
}

export function codeFacts(m: CodeMarkers): FactSpec[] {
  const out: FactSpec[] = [
    fact('ce-goal', m.goal, 'head', 'survive', true),
    fact('ce-decision', m.decision, 'decision', 'survive', true),
    fact('ce-write-path', m.writePath, 'arg-path', 'survive', true),
    fact('ce-trace-path', m.tracePath, 'output-path', 'survive', true),
    fact('ce-blocked', m.blocked, 'assistant', 'survive', true),
    fact('ce-ff-old', m.ffOld, 'user', 'absent-after-supersede', true, 'ce-wk-new'),
    fact('ce-wk-new', m.wkNew, 'user', 'survive', true),
  ];
  const ts = [...m.tallies.keys()].sort((a, b) => a - b);
  ts.forEach((s, i) => {
    const next = ts[i + 1];
    out.push(fact(`tally-s${s}`, m.tallies.get(s)!, 'tally', 'latest', next === undefined, next === undefined ? undefined : `tally-s${next}`));
  });
  return out;
}

export function code60(_ctx: ScenarioContext): ScenarioDef {
  const m = codeMarkers();
  const g = new CodeGen(m);
  const users = new Map<number, string>([
    [CORR_STEPS.old, `Run the payment specs in the firefox project only (${m.ffOld}).`],
    [CORR_STEPS.new, `Actually, run the payment specs in the webkit project only, instead of firefox (${m.wkNew}).`],
  ]);
  const session = makeSession({
    id: 'default',
    seed: 3003,
    steps: CODE_STEPS,
    system: () => systemPrompt(),
    tools: () => [...referenceTools(), APPLY_PATCH_TOOL],
    goal: () => userMsg(`Task ${m.goal}: refactor the checkout helpers under src/checkout/ to data-testid locators, keep every checkout spec green, and do not touch tests/legacy/.`),
    assistant: (s) => g.assistant(s),
    results: (s) => [capOutput(g.outputRaw(s), s, OPENCODE_CAP_BYTES)],
    users: (s) => (users.has(s) ? [userMsg(users.get(s)!)] : []),
  });
  return {
    id: 'code60', family: 'F3', sessions: [session], facts: codeFacts(m), client: 'sim', capBytes: OPENCODE_CAP_BYTES,
    mock: { render: 'sim' }, gates: [], expect: 'complete', windows: ['100k'],
    description: '60-step code-edit session over 25 files (read/edit/apply_patch/test/grep/write, todowrite and snapshot every 15 steps)',
  };
}
