import { resolve } from 'node:path';
import { stateDirOf } from '../../config/paths.js';
import { manageAutostart, runAutostart } from '../../autostart.js';
import { CONFIG_OPTS, loadFromArgs, parseArgs } from '../args.js';
import { UsageError, type CliIO } from '../io.js';

export async function cmdAutostart(argv: string[], io: CliIO): Promise<number> {
  const [action, ...rest] = argv;
  if (action !== 'install' && action !== 'remove' && action !== 'status' && action !== 'run') {
    throw new UsageError('autostart needs install, remove, status or run');
  }
  // Only persist the config path: transient CLI overrides disappear at next login.
  const p = parseArgs(rest, CONFIG_OPTS);
  if (p.positionals.length) throw new UsageError('unexpected autostart arguments');
  const loaded = loadFromArgs(p, io);
  const path = loaded.configPath ? resolve(io.cwd, loaded.configPath) : null;
  const dir = resolve(io.cwd, stateDirOf(loaded.config, io.env));
  if (action !== 'run') return manageAutostart(action, path, dir, io.stdout);
  if (!path) throw new UsageError('autostart run requires a config file (--config PATH)');
  return runAutostart(loaded.config, path, dir, { env: io.env, log: io.stdout });
}
