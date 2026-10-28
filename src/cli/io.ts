import type { AppModules } from '../app.js';

// ---------------------------------------------------------------- IO and errors

export interface CliIO {
  stdout(s: string): void;
  stderr(s: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** registers the graceful-stop handler for SIGTERM/SIGINT (tests inject their own) */
  onSignal(handler: (signal: string) => void): void;
  /** engine/proxy factories instead of the dynamically loaded modules (tests, embedders) */
  modules?: AppModules;
}

export function defaultIO(): CliIO {
  return {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
    cwd: process.cwd(),
    onSignal: (h) => {
      process.on('SIGTERM', () => h('SIGTERM'));
      process.on('SIGINT', () => h('SIGINT'));
    },
  };
}

/** Bad command line (exit 2). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}
