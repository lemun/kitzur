/** A system under test sits between the simulated agent and the mock upstream. */
export interface BenchSystem {
  /** short identifier used in run names and tables */
  readonly name: string;
  /** `proxy.args` for analyze.py (null = direct: analyze prints "(direct)") */
  readonly args: string[] | null;
  /** start in front of `upstream` (http://127.0.0.1:MOCK); returns the base URL the agent talks to */
  start(upstream: string, runDir: string): Promise<string>;
  /** stop; returns whatever the system reports (status JSON, ledger, ...) */
  stop(): Promise<SystemReport>;
}

export interface SystemReport {
  /** one record per client chat request, in order (gobstopper-compatible fields), when the system has a ledger */
  ledger: Array<Record<string, unknown>>;
  status: unknown;
  /** process-level stats (e.g. wall time, exit code) */
  meta: Record<string, unknown>;
}
