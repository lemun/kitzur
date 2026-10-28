// File locations derived from the config and the environment (DESIGN.md "State, scope and limitations").
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

/**
 * The config file `serve` and the other config-reading commands use when neither --config nor KITZUR_CONFIG
 * is given: $XDG_CONFIG_HOME/kitzur/kitzur.jsonc (absolute XDG only), else on Windows
 * %APPDATA%\kitzur\kitzur.jsonc, else $HOME/.config/kitzur/kitzur.jsonc. Read from `env` only, so a caller
 * with an empty environment never picks up the user's file. null when no candidate exists.
 */
export function defaultConfigPath(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, exists: (f: string) => boolean = existsSync): string | null {
  const p = platform === 'win32' ? win32 : posix;
  const x = env['XDG_CONFIG_HOME'];
  let dir: string | null = null;
  if (x && p.isAbsolute(x)) dir = p.join(x, 'kitzur');
  else if (platform === 'win32' && env['APPDATA'] && win32.isAbsolute(env['APPDATA'])) dir = win32.join(env['APPDATA'], 'kitzur');
  else if (env['HOME'] && p.isAbsolute(env['HOME'])) dir = p.join(env['HOME'], '.config', 'kitzur');
  if (!dir) return null;
  const f = p.join(dir, 'kitzur.jsonc');
  return exists(f) ? f : null;
}
