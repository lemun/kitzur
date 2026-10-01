// The Python reference scenario (bench/scenarios/reference.ts, byte-exact scenario.py) as a ScenarioSpec, so the
// spec-driven paths of the mock (routing by x-sim-scenario) and of the clients (bench/client/agent.ts with `spec`,
// bench/client/opencode.ts) can run it. It adds nothing: goal, system, tools, the scripted turns, the tool outputs
// (one per call, tool_output(step)) and USER_INJECT are reference.ts's own. The scenario generator's `qa46-ref` is
// expected to be canonically identical; this adapter exists so the mock/client code does not depend on it.

import type { ChatMessage, ToolCall } from '../../src/types.js';
import type { FactSpec, ScenarioSpec, SessionSpec } from '../scenarios/types.js';
import {
  assistantMessage, FACTS, GOAL_TEXT, systemPrompt, toolOutput, tools, USER_INJECT, type ScenarioOptions,
} from '../scenarios/reference.js';

/** FactSpec channels of the 7 reference facts (scenario.py FACTS). */
const CHANNELS: Record<string, FactSpec['channel']> = {
  'GOAL-CHK-7F3A': 'head',
  'DECISION-D42': 'decision',
  'USER-RULE-Q7': 'user',
  'UNFINISHED-9K': 'assistant',
  'TODO-P3-RETRY': 'todo',
  'src/pages/legacy/PromoBanner.ts': 'arg-path',
  'staging-3.override.yaml': 'output-path',
};

export const REFERENCE_FACTS: readonly FactSpec[] = FACTS.map(([marker]) => ({
  id: marker, marker, channel: CHANNELS[marker]!, expect: 'survive', gate: true,
}));

export function referenceSession(o: ScenarioOptions = {}, id = 'main', steps = 46): SessionSpec {
  return {
    id,
    seed: 0,
    steps,
    system: () => systemPrompt(),
    tools: () => tools(),
    goal: (): ChatMessage => ({ role: 'user', content: GOAL_TEXT }),
    assistantAt: (step: number): ChatMessage => assistantMessage(step, o),
    toolResults: (step: number, calls: ToolCall[]): ChatMessage[] => calls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: toolOutput(step, o) })),
    userAfter: (step: number): ChatMessage[] => {
      const u = USER_INJECT.get(step);
      return u === undefined ? [] : [{ role: 'user', content: u }];
    },
  };
}

/** `ref` (uncapped) / `ref-cap51200` style ids; `client` selects the client that runs it. */
export function referenceScenario(o: ScenarioOptions = {}, extra: Partial<ScenarioSpec> & { steps?: number } = {}): ScenarioSpec {
  const { steps, ...rest } = extra;
  return {
    id: `ref${o.capBytes ? `-cap${o.capBytes}` : ''}${o.chatty ? '-chatty' : ''}`,
    family: 'F1',
    sessions: [referenceSession(o, 'main', steps ?? 46)],
    facts: [...REFERENCE_FACTS],
    client: 'sim',
    capBytes: o.capBytes ?? null,
    mock: {},
    gates: [],
    expect: 'complete',
    ...rest,
  };
}
