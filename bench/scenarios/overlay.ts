// Overlay O1 (bench/README.md) and the retry chain of qa150/talk200 (§5.3), applied to a BROWSER-shaped SessionScript.
//
// O1, on every non-`-ref` variant:
//   after step 4   user  `USER-VIEW-R4: run every checkout spec at viewport 1280x720 (VP-OLD-K7Q2M).`   absent-after-supersede
//   after step 12  user  `Correction for USER-VIEW-R4: use viewport 1920x1080 instead (VP-NEW-R3T8W).`   survive (shared-ID path)
//   step 16        assistant text `NOTE: promo banner animates 2s (NOTE-ANIM-C4D9P)`                        survive
//   step 3         todowrite list gains TODO-DROP-Z1H5K; step 24 becomes a todowrite that drops it       absent-after-supersede
//                  and adds TODO-NEW-B8M2N, pending to the end                                          survive
//   latest         every navigate URL and every test tally carries its own code; the last of each is gated.
//
// Planted markers sit in the first 200 characters of their message (tallies: the last 200). The Hebrew variant keeps
// the ASCII markers and uses the cue `בעצם` for the correction.

import type { ChatMessage } from '../../src/types.js';
import { pyDumps } from '../lib/pyjson.js';
import { kind } from './reference.js';
import { assistantWithCalls, fact, MarkerFactory, userMsg, type SessionScript } from './common.js';
import { REF_TODOS, type BrowserGenOptions } from './browser-gen.js';
import type { FactSpec } from './types.js';

export const O1_MARKERS = {
  vpOld: 'VP-OLD-K7Q2M',
  vpNew: 'VP-NEW-R3T8W',
  note: 'NOTE-ANIM-C4D9P',
  todoDrop: 'TODO-DROP-Z1H5K',
  todoNew: 'TODO-NEW-B8M2N',
} as const;

export type Lang = 'en' | 'he';

export const O1_TEXT: Record<Lang, { instr: string; corr: string; note: string; drop: string; add: string; plan: string }> = {
  en: {
    instr: 'USER-VIEW-R4: run every checkout spec at viewport 1280x720 (VP-OLD-K7Q2M).',
    corr: 'Correction for USER-VIEW-R4: use viewport 1920x1080 instead (VP-NEW-R3T8W).',
    note: 'NOTE: promo banner animates 2s (NOTE-ANIM-C4D9P)',
    drop: 'TODO-DROP-Z1H5K: record baseline screenshots of the promo banner',
    add: 'TODO-NEW-B8M2N: re-run the promo specs at the corrected viewport',
    plan: 'Updating the plan: the screenshot baseline is not needed.',
  },
  he: {
    instr: 'USER-VIEW-R4: הרץ את כל בדיקות ה-checkout ברזולוציה 1280x720 (VP-OLD-K7Q2M).',
    corr: 'בעצם, לגבי USER-VIEW-R4: הרץ ברזולוציה 1920x1080 (VP-NEW-R3T8W).',
    note: 'NOTE: באנר המבצע מונפש במשך 2 שניות (NOTE-ANIM-C4D9P)',
    drop: 'TODO-DROP-Z1H5K: לצלם צילומי בסיס של באנר המבצע',
    add: 'TODO-NEW-B8M2N: להריץ שוב את בדיקות המבצע ברזולוציה המעודכנת',
    plan: 'מעדכן את התוכנית: אין צורך בצילומי הבסיס.',
  },
};

export interface LatestSeries {
  /** step -> marker, for every navigate / test step whose output reaches a later request */
  url: Map<number, string>;
  tally: Map<number, string>;
}

/**
 * Codes for the "latest" facts: one per navigate URL and one per test tally that a later request carries (the
 * assistant of step s is first sent in C_{s+1}, so s + 1 < steps). Steps in `skip` (e.g. the huge step, whose test
 * output is replaced) get none.
 */
export function latestSeries(steps: number, seed: number, skip: readonly number[] = []): LatestSeries {
  const mf = new MarkerFactory(seed);
  const url = new Map<number, string>();
  const tally = new Map<number, string>();
  for (let s = 0; s + 1 < steps; s++) {
    if (skip.includes(s)) continue;
    const k = kind(s);
    if (k === 'navigate') url.set(s, mf.make(`NAV-S${s}`));
    else if (k === 'test') tally.set(s, mf.make(`TLY-S${s}`));
  }
  return { url, tally };
}

/** BrowserGen hooks that print the latest-series codes into the navigate URLs and the tally lines. */
export function latestHooks(series: LatestSeries): Pick<BrowserGenOptions, 'urlSuffix' | 'tallySuffix'> {
  return {
    urlSuffix: (s) => (series.url.has(s) ? `?run=${series.url.get(s)!}` : null),
    tallySuffix: (s) => (series.tally.has(s) ? `(${series.tally.get(s)!})` : null),
  };
}

/** The "latest" FactSpecs of a series: each value until the next one appears; only the last is gated. */
export function latestFacts(series: LatestSeries): FactSpec[] {
  const out: FactSpec[] = [];
  for (const [name, ch] of [['url', 'url'], ['tally', 'tally']] as const) {
    const steps = [...series[name].keys()].sort((a, b) => a - b);
    steps.forEach((s, i) => {
      const next = steps[i + 1];
      const id = `${name}-s${s}`;
      out.push(fact(id, series[name].get(s)!, ch, 'latest', next === undefined, next === undefined ? undefined : `${name}-s${next}`));
    });
  }
  return out;
}

/** Apply O1's message-level changes (steps 3, 4, 12, 16, 24) to a BROWSER-shaped script. */
export function applyO1(base: SessionScript, lang: Lang = 'en'): SessionScript {
  const T = O1_TEXT[lang];
  const todos3 = [{ content: T.drop, status: 'pending' }, ...REF_TODOS.map((t) => ({ ...t }))];
  const todos24 = [
    { content: T.add, status: 'pending' },
    { content: REF_TODOS[0]!.content, status: 'completed' },
    { content: REF_TODOS[1]!.content, status: 'in_progress' },
    { content: REF_TODOS[2]!.content, status: 'pending' },
    { content: REF_TODOS[3]!.content, status: 'pending' },
  ];
  return {
    ...base,
    assistant: (step): ChatMessage => {
      if (step === 3) {
        const a = base.assistant(3);
        return assistantWithCalls(3, (a.content as string | null) ?? null, [['todowrite', { todos: todos3 }]]);
      }
      if (step === 16) {
        const a = base.assistant(16);
        const t = (a.content as string | null) ?? '';
        return { ...a, content: t ? `${T.note}\n${t}` : T.note };
      }
      if (step === 24) return assistantWithCalls(24, `${T.plan} (step 24)`, [['todowrite', { todos: todos24 }]]);
      return base.assistant(step);
    },
    results: (step) => {
      if (step === 3) return [pyDumps(todos3, { indent: 2 })];
      if (step === 24) return [pyDumps(todos24, { indent: 2 })];
      return base.results(step);
    },
    users: (step) => {
      const u = base.users(step);
      if (step === 4) return [...u, userMsg(T.instr)];
      if (step === 12) return [...u, userMsg(T.corr)];
      return u;
    },
  };
}

/** O1's own facts (all gated). */
export function o1Facts(): FactSpec[] {
  const M = O1_MARKERS;
  return [
    fact('o1-vp-old', M.vpOld, 'user', 'absent-after-supersede', true, 'o1-vp-new'),
    fact('o1-vp-new', M.vpNew, 'user', 'survive', true),
    fact('o1-note', M.note, 'assistant', 'survive', true),
    fact('o1-todo-drop', M.todoDrop, 'todo', 'absent-after-supersede', true, 'o1-todo-new'),
    fact('o1-todo-new', M.todoNew, 'todo', 'survive', true),
  ];
}

// ---------------------------------------------------------------- the retry chain (qa150, talk200)

export const CHAIN_MARKERS = { a: 'RT-A-Q4M8K', b: 'RT-B-W7N2X', c: 'RT-C-H5P9J' } as const;
export const CHAIN_STEPS = { a: 30, b: 60, c: 110 } as const;
export const CHAIN_TEXT = {
  a: 'USER-RETRY-R9: run the checkout specs with retries=1 (RT-A-Q4M8K).',
  b: 'Actually, for USER-RETRY-R9 use retries=2 instead (RT-B-W7N2X).',
  c: 'Correction for USER-RETRY-R9: use retries=0 (RT-C-H5P9J).',
} as const;

export function applyChain(base: SessionScript): SessionScript {
  const at = new Map<number, string>([
    [CHAIN_STEPS.a, CHAIN_TEXT.a],
    [CHAIN_STEPS.b, CHAIN_TEXT.b],
    [CHAIN_STEPS.c, CHAIN_TEXT.c],
  ]);
  return {
    ...base,
    users: (step) => {
      const t = at.get(step);
      const u = base.users(step);
      return t === undefined ? u : [...u, userMsg(t)];
    },
  };
}

export function chainFacts(): FactSpec[] {
  const M = CHAIN_MARKERS;
  return [
    fact('chain-a', M.a, 'user', 'absent-after-supersede', true, 'chain-b'),
    fact('chain-b', M.b, 'user', 'absent-after-supersede', true, 'chain-c'),
    fact('chain-c', M.c, 'user', 'survive', true),
  ];
}
