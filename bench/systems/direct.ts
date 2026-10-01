import type { BenchSystem, SystemReport } from './types.js';

/** No proxy: the agent talks to the mock directly (run.py --direct). */
export class Direct implements BenchSystem {
  readonly name = 'direct';
  readonly args = null;
  async start(upstream: string): Promise<string> {
    return upstream;
  }
  async stop(): Promise<SystemReport> {
    return { ledger: [], status: null, meta: {} };
  }
}
