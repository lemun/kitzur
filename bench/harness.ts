// One experiment, like reference-harness sim/run.py: mock upstream <- system under test <- simulated agent,
// all in one run directory with the reference layout (mock.jsonl, reqs/, client.jsonl, origs/,
// ledger.jsonl, proxy.args, proxy.log, proxy_status.json, mock.out), so both bench/analyze.ts and the
// frozen Python analyze.py can read it.
//
// Differences from run.py: the mock and the agent run in this process (the system may be a child
// process, e.g. gobstopper); ports are chosen by the OS (port 0) instead of free_port() probing.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runAgent, type AgentResult, type ClientRecord } from './client/agent.js';
import { MockServer, type MockRecord, type MockServerOptions } from './mock/server.js';
import { PromptCounter } from './lib/render.js';
import { benchTokenizer, RAW_RESULTS_DIR } from './lib/paths.js';
import type { ScenarioOptions } from './scenarios/reference.js';
import type { BenchSystem, SystemReport } from './systems/types.js';

export interface RunSpec {
  name: string;
  /** default bench/results/raw/<name> (wiped first, like run.py) */
  runDir?: string;
  system: BenchSystem;
  scenario?: ScenarioOptions;
  mock?: Omit<MockServerOptions, 'counter' | 'outDir' | 'scenario'>;
  client?: { steps?: number; maxTokens?: number; stream?: boolean; usage?: boolean; saveOrigs?: boolean; session?: string | null; waitForServerClose?: boolean };
  counter?: PromptCounter;
  log?: (line: string) => void;
}

export interface RunResult {
  name: string;
  runDir: string;
  mock: MockRecord[];
  client: ClientRecord[];
  agent: AgentResult;
  system: SystemReport;
  ms: { total: number; client: number };
}

let sharedCounter: PromptCounter | null = null;
/** One counter (and segment cache) per process: the mock and the agent count the same texts. */
export function defaultCounter(): PromptCounter {
  return (sharedCounter ??= new PromptCounter(benchTokenizer()));
}

export async function runExperiment(spec: RunSpec): Promise<RunResult> {
  const t0 = performance.now();
  const runDir = spec.runDir ?? join(RAW_RESULTS_DIR, spec.name);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const counter = spec.counter ?? defaultCounter();
  const mock = new MockServer({ ...spec.mock, counter, outDir: runDir, scenario: spec.scenario ?? {} });
  await mock.start(0);
  writeFileSync(join(runDir, 'mock.out'), mock.startupLine() + '\n');
  let system: SystemReport | null = null;
  let agent: AgentResult;
  try {
    const base = await spec.system.start(mock.url, runDir);
    agent = await runAgent({
      base,
      counter,
      outDir: runDir,
      scenario: spec.scenario ?? {},
      saveOrigs: spec.client?.saveOrigs ?? true,
      ...(spec.client?.steps !== undefined ? { steps: spec.client.steps } : {}),
      ...(spec.client?.maxTokens !== undefined ? { maxTokens: spec.client.maxTokens } : {}),
      ...(spec.client?.stream !== undefined ? { stream: spec.client.stream } : {}),
      ...(spec.client?.usage !== undefined ? { usage: spec.client.usage } : {}),
      session: spec.client?.session ?? null,
      ...(spec.client?.waitForServerClose === false ? { waitForServerClose: false } : {}),
      ...(spec.log ? { log: spec.log } : {}),
    });
  } finally {
    system = await spec.system.stop();
    await mock.stop();
  }
  return {
    name: spec.name,
    runDir,
    mock: mock.records,
    client: agent.records,
    agent,
    system,
    ms: { total: performance.now() - t0, client: agent.ms },
  };
}
