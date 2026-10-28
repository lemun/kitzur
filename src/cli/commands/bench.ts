import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliIO } from '../io.js';

/** The built benchmark runner: dist/bench/run-all.js, next to dist/src/. */
export function benchEntry(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'bench', 'run-all.js');
}

export function cmdBench(argv: string[], io: CliIO): number {
  const runAll = benchEntry();
  if (!existsSync(runAll)) {
    io.stderr(`kitzur: the benchmark suite is not in this build (${runAll}); run it from a source checkout: npm run bench\n`);
    return 1;
  }
  const r = spawnSync(process.execPath, [runAll, ...argv], { stdio: 'inherit', env: io.env as NodeJS.ProcessEnv, cwd: io.cwd });
  return r.status ?? 1;
}
