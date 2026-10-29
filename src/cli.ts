#!/usr/bin/env node
// The kitzur command line (DESIGN.md):
//   kitzur serve | replay | redact | status | count | config {init,show,validate,import-eval} | state {show,reset} | bench | version
// Arguments are parsed here without dependencies. Exit codes: 0 ok, 1 runtime failure, 2 usage or config
// error; `config import-eval` also returns 10 (a safety-critical knob fell back to a default) and 11
// (conflicting measurements). Nothing here prints message content: replay and count print sizes only.
// This file is the entry point only: main dispatches to the modules under src/cli/, which never import it:
//   io.ts (CliIO, UsageError), args.ts (argument parsing and config loading), usage.ts (help text),
//   format.ts (config display), requests.ts (request files), http.ts (HTTP and state-module helpers),
//   commands/ (serve, replay, count, status, diagnostics: doctor/tls-probe/report, redact, config, import-eval, state, bench).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppModuleError, type Logger } from './app.js';
import { ConfigError } from './config/load.js';
import { packageInfo } from './config/paths.js';
import { defaultIO, UsageError, type CliIO } from './cli/io.js';
import { HELP_COMMANDS, USAGE, usageOf, wantsHelp } from './cli/usage.js';
import { cmdDoctor, cmdReport, cmdTlsProbe } from './cli/commands/diagnostics.js';
import { cmdServe } from './cli/commands/serve.js';
import { cmdCount } from './cli/commands/count.js';
import { cmdStatus } from './cli/commands/status.js';
import { cmdReplay } from './cli/commands/replay.js';
import { cmdConfig } from './cli/commands/config.js';
import { cmdState } from './cli/commands/state.js';
import { cmdBench } from './cli/commands/bench.js';
import { cmdRedact } from './cli/commands/redact.js';
import { cmdAutostart } from './cli/commands/autostart.js';

// ---------------------------------------------------------------- main

/** Runs one command; resolves with the exit code. Never calls process.exit. */
export async function main(argv: readonly string[], io: CliIO = defaultIO()): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd && HELP_COMMANDS.has(cmd) && wantsHelp(rest)) {
    io.stdout(usageOf(cmd));
    return 0;
  }
  try {
    switch (cmd) {
      case undefined:
        io.stderr(USAGE);
        return 2;
      case 'help':
      case '--help':
      case '-h':
        io.stdout(USAGE);
        return 0;
      case 'version':
      case '--version':
      case '-V':
        io.stdout(`kitzur ${packageInfo().version} (node ${process.version})\n`);
        return 0;
      case 'serve':
        return await cmdServe(rest, io);
      case 'autostart':
        return await cmdAutostart(rest, io);
      case 'replay':
        return await cmdReplay(rest, io);
      case 'count':
        return await cmdCount(rest, io);
      case 'status':
        return await cmdStatus(rest, io);
      case 'tls-probe':
        return await cmdTlsProbe(rest, io);
      case 'doctor':
        return await cmdDoctor(rest, io);
      case 'report':
        return await cmdReport(rest, io);
      case 'config':
        return await cmdConfig(rest, io);
      case 'state':
        return await cmdState(rest, io);
      case 'bench':
        return cmdBench(rest, io);
      case 'redact':
        return cmdRedact(rest, io);
      default:
        throw new UsageError(`unknown command '${cmd}'`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`kitzur: ${e.message}\nrun 'kitzur help' for usage\n`);
      return 2;
    }
    if (e instanceof ConfigError) {
      for (const i of e.issues) io.stderr(`kitzur: config error: ${i}\n`);
      return 2;
    }
    if (e instanceof AppModuleError) {
      io.stderr(`kitzur: ${e.message}\n`);
      return 1;
    }
    io.stderr(`kitzur: error: ${(e as Error)?.message ?? String(e)}\n`);
    return 1;
  }
}

/** True when this module is the process entry point (also through an npm bin symlink). */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // `kitzur config show | head`: a closed pipe ends the command quietly
  for (const s of [process.stdout, process.stderr]) {
    s.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EPIPE') process.exit(process.exitCode ?? 0);
      throw e;
    });
  }
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      // serve: open keep-alive sockets or timers must not hold the process after a drain
      setTimeout(() => process.exit(code), 2000).unref();
    },
    (e: unknown) => {
      process.stderr.write(`kitzur: fatal: ${(e as Error)?.stack ?? String(e)}\n`);
      process.exit(1);
    },
  );
}

export { defaultIO, UsageError, type CliIO } from './cli/io.js';
export { CONFIG_OPTS, parseArgs, setOpsOf } from './cli/args.js';
export { asRequest, collectRequests } from './cli/requests.js';
export type { Logger };
