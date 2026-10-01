// File locations derived from the config and the environment (DESIGN.md "State dir").
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './schema.js';

/** The state dir: config stateDir, else $XDG_STATE_HOME/kitzur (absolute XDG only), else ~/.local/state/kitzur. */
export function stateDirOf(cfg: Pick<Config, 'stateDir'>, env: Record<string, string | undefined> = process.env, home = homedir()): string {
  if (cfg.stateDir) return cfg.stateDir;
  const x = env['XDG_STATE_HOME'];
  return x && x.startsWith('/') ? join(x, 'kitzur') : join(home, '.local', 'state', 'kitzur');
}

let pkg: { name: string; version: string; root: string } | null = null;

/** name, version and root directory of the installed package (walks up from this module to package.json). */
export function packageInfo(): { name: string; version: string; root: string } {
  if (pkg) return pkg;
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(d, 'package.json');
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string };
        if (j.name === 'kitzur') return (pkg = { name: j.name, version: j.version ?? '0.0.0', root: d });
      } catch {
        /* keep walking */
      }
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return (pkg = { name: 'kitzur', version: '0.0.0-unknown', root: dirname(fileURLToPath(import.meta.url)) });
}
