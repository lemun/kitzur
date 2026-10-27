#!/usr/bin/env node
// The kitzur command line (DESIGN.md, §10):
//   kitzur serve | replay | status | count | config {init,show,validate,import-eval} | state {show,reset} | bench | version
// Arguments are parsed here without dependencies. Exit codes: 0 ok, 1 runtime failure, 2 usage or config
// error; `config import-eval` also returns 10 (a safety-critical knob fell back to a default) and 11
// (conflicting measurements). Nothing here prints message content: replay and count print sizes only.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppModuleError, type Logger } from './app.js';
import { ConfigError } from './config/load.js';
import { validateConfig } from './config/validate.js';
import { computeBudget } from './config/derived.js';
import { DEFAULT_LEAVES, getPath } from './config/spec.js';
import { isAutoWindow } from './config/window.js';
import { renderInitConfig } from './config/init.js';
import { packageInfo } from './config/paths.js';
import { exportOpenCode } from './config/export-opencode.js';
import { defaultIO, UsageError, type CliIO } from './cli/io.js';
import { CONFIG_OPTS, loadFromArgs, parseArgs } from './cli/args.js';
import { HELP_COMMANDS, USAGE, usageOf, wantsHelp } from './cli/usage.js';
import { derivedLines, display, maskedConfig } from './cli/format.js';
import { cmdDoctor, cmdReport, cmdTlsProbe } from './cli/commands/diagnostics.js';
import { cmdServe } from './cli/commands/serve.js';
import { cmdCount } from './cli/commands/count.js';
import { cmdStatus } from './cli/commands/status.js';
import { cmdReplay } from './cli/commands/replay.js';
import { cmdState } from './cli/commands/state.js';
import { cmdBench } from './cli/commands/bench.js';
import { cmdImportEval } from './cli/commands/import-eval.js';

// ---------------------------------------------------------------- commands

async function cmdConfig(argv: string[], io: CliIO): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'export-opencode': {
      const p = parseArgs(rest, { ...CONFIG_OPTS, model: { type: 'string' }, 'small-model': { type: 'string' }, provider: { type: 'string' }, 'key-env': { type: 'string' } });
      const model = p.values['model'];
      if (typeof model !== 'string' || !model) throw new UsageError('config export-opencode needs --model ID');
      const l = loadFromArgs(p, io);
      io.stdout(exportOpenCode(l.config, l.models, { model, smallModel: p.values['small-model'] as string | undefined, provider: p.values['provider'] as string | undefined, keyEnv: p.values['key-env'] as string | undefined }));
      return 0;
    }
    case 'init': {
      const p = parseArgs(rest, { preset: { type: 'string', short: 'p' }, out: { type: 'string', short: 'o' }, force: { type: 'boolean' }, upstream: { type: 'string' }, tokenizer: { type: 'string' } });
      const tokenizerArg = p.values['tokenizer'] as string | undefined;
      const text = renderInitConfig((p.values['preset'] as string | undefined) ?? '100k', {
        upstream: p.values['upstream'] as string | undefined,
        // a `~/` path is kept for the config loader; others are relative to the shell's directory, not to the written file's
        tokenizer: tokenizerArg === undefined || tokenizerArg === '' ? undefined : tokenizerArg.startsWith('~/') ? tokenizerArg : resolve(io.cwd, tokenizerArg),
      });
      const out = (p.values['out'] as string | undefined) ?? 'kitzur.config.jsonc';
      if (out === '-') {
        io.stdout(text);
        return 0;
      }
      const path = resolve(io.cwd, out);
      if (existsSync(path) && !p.values['force']) {
        io.stderr(`kitzur: ${path} exists (use --force to overwrite)\n`);
        return 1;
      }
      // the README's `--out ~/.config/kitzur/kitzur.jsonc` on a fresh host: the directory does not exist yet
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      const todo = [p.values['upstream'] ? '' : 'upstream.origin', tokenizerArg ? '' : 'tokenizer.path'].filter(Boolean);
      io.stdout(`wrote ${path}\nnext: ${todo.length ? `set ${todo.join(' and ')}, then: ` : ''}kitzur config validate --config ${out}\n`);
      return 0;
    }
    case 'show': {
      const p = parseArgs(rest, { ...CONFIG_OPTS, json: { type: 'boolean' }, changed: { type: 'boolean' }, full: { type: 'boolean' } });
      const l = loadFromArgs(p, io);
      const v = validateConfig(l.config, { provenance: l.provenance });
      if (p.values['json']) {
        io.stdout(JSON.stringify({
          preset: l.preset, configPath: l.configPath, layers: l.layers, config: maskedConfig(l.config), provenance: l.provenance,
          derived: computeBudget(l.config, { counterFixedTokens: l.config.budget.observedFixedPromptTokens }),
          errors: v.errors, warnings: [...l.warnings, ...v.warnings],
        }, null, 1) + '\n');
        return v.errors.length ? 2 : 0;
      }
      io.stdout(`# kitzur ${packageInfo().version} effective config: ${l.layers.join(' < ')}\n`);
      const leaves = DEFAULT_LEAVES.filter((k) => !p.values['changed'] || l.provenance[k] !== 'default');
      const w = Math.max(...leaves.map((k) => k.length), 10);
      for (const k of leaves) {
        io.stdout(`${k.padEnd(w)} = ${display(k, k === 'budget.window' && isAutoWindow(l.config) ? 'auto' : getPath(l.config, k), p.values['full'] === true)}   (${l.provenance[k]})\n`);
      }
      io.stdout('\n' + derivedLines(l.config).join('\n') + '\n');
      for (const x of [...l.warnings, ...v.warnings]) io.stdout(`# warning: ${x}\n`);
      for (const x of v.errors) io.stdout(`# ERROR: ${x}\n`);
      return v.errors.length ? 2 : 0;
    }
    case 'validate': {
      const p = parseArgs(rest, { ...CONFIG_OPTS, json: { type: 'boolean' } });
      const l = loadFromArgs(p, io);
      const v = validateConfig(l.config, { provenance: l.provenance, checkFiles: true });
      const warnings = [...l.warnings, ...v.warnings];
      if (p.values['json']) io.stdout(JSON.stringify({ ok: v.errors.length === 0, errors: v.errors, warnings }, null, 1) + '\n');
      else {
        for (const e of v.errors) io.stdout(`error: ${e}\n`);
        for (const x of warnings) io.stdout(`warning: ${x}\n`);
        io.stdout(v.errors.length ? `${v.errors.length} error(s)\n` : `ok (${warnings.length} warning(s))\n`);
      }
      return v.errors.length ? 2 : 0;
    }
    case 'import-eval':
      return cmdImportEval(rest, io);
    default:
      throw new UsageError(sub ? `unknown config command '${sub}' (init, show, validate, import-eval, export-opencode)` : 'config needs a subcommand: init, show, validate, import-eval, export-opencode');
  }
}

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
