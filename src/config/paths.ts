// File locations derived from the config and the environment (DESIGN.md "State dir").
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './schema.js';

/**
 * The default state dir: $XDG_STATE_HOME/kitzur (absolute XDG only), else on Windows
 * %LOCALAPPDATA%\Kitzur\state, else ~/.local/state/kitzur.
 */
export function defaultStateDir(env: Record<string, string | undefined> = process.env, home = homedir(), platform: NodeJS.Platform = process.platform): string {
  const p = platform === 'win32' ? win32 : posix;
  const x = env['XDG_STATE_HOME'];
  if (x && p.isAbsolute(x)) return p.join(x, 'kitzur');
  const local = env['LOCALAPPDATA'];
  if (platform === 'win32' && local && win32.isAbsolute(local)) return win32.join(local, 'Kitzur', 'state');
  return p.join(home, '.local', 'state', 'kitzur');
}

/** The state dir: config stateDir, else defaultStateDir. */
export function stateDirOf(cfg: Pick<Config, 'stateDir'>, env: Record<string, string | undefined> = process.env, home = homedir(), platform: NodeJS.Platform = process.platform): string {
  return cfg.stateDir || defaultStateDir(env, home, platform);
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
