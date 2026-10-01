// Window presets (presets/*.json; DESIGN.md preset table). A preset is a config layer applied right
// after the built-in defaults: `--preset 32k`, KITZUR_PRESET, or a top-level "preset" key in the config
// file. A value containing '/' or ending in .json is a path to a preset file instead of a name.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './jsonc.js';
import { isPlainObject } from './spec.js';

/** The preset names shipped in presets/, with their DESIGN §3 window / defaultMaxTokens. */
export const PRESET_TABLE: Readonly<Record<string, { window: number; defaultMaxTokens: number }>> = {
  '32k': { window: 32_000, defaultMaxTokens: 8_000 },
  '64k': { window: 64_000, defaultMaxTokens: 16_000 },
  '100k': { window: 100_000, defaultMaxTokens: 32_000 },
  '128k': { window: 128_000, defaultMaxTokens: 32_000 },
};

let cachedDir: string | null | undefined;

/**
 * The presets/ directory: $KITZUR_PRESETS_DIR, else found by walking up from this module
 * (dist/src/config/ in a build or a vendored tarball, src/config/ in a checkout). null if not found.
 */
export function presetsDir(env: Record<string, string | undefined> = process.env): string | null {
  const override = env['KITZUR_PRESETS_DIR'];
  if (override) return resolve(override);
  if (cachedDir !== undefined) return cachedDir;
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(d, 'presets');
    if (existsSync(join(p, '100k.json'))) return (cachedDir = p);
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return (cachedDir = null);
}

/** Names of the presets available in presetsDir(), sorted by window. */
export function listPresets(dir: string | null = presetsDir()): string[] {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || (a < b ? -1 : 1));
}

export interface LoadedPreset {
  /** the name ('32k') or the file path given */
  name: string;
  file: string;
  /** the config layer (keys starting with '$' removed by the loader, not here) */
  layer: Record<string, unknown>;
}

/** Reads a preset by name or path. Throws an Error naming the available presets when not found. */
export function loadPreset(nameOrPath: string, dir: string | null = presetsDir(), cwd = process.cwd()): LoadedPreset {
  const isPath = nameOrPath.includes('/') || nameOrPath.endsWith('.json');
  const file = isPath ? resolve(cwd, nameOrPath) : dir ? join(dir, `${nameOrPath}.json`) : '';
  if (!file || !existsSync(file)) {
    const avail = listPresets(dir);
    throw new Error(
      isPath
        ? `preset file not found: ${file}`
        : `unknown preset '${nameOrPath}'${avail.length ? ` (available: ${avail.join(', ')})` : ' (no presets/ directory found)'}`,
    );
  }
  const layer = parseJsonc(readFileSync(file, 'utf8'), file);
  if (!isPlainObject(layer)) throw new Error(`${file}: a preset must be a JSON object`);
  return { name: nameOrPath, file, layer };
}
