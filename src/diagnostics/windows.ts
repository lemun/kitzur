import { spawnSync } from 'node:child_process';
import type { DoctorCheck } from './doctor.js';

/** Runs a command and returns its stdout, or null when it is missing or fails. */
export type CommandRunner = (command: string, args: string[]) => string | null;

export interface WindowsDeps {
  platform?: NodeJS.Platform;
  run?: CommandRunner;
  env?: Record<string, string | undefined>;
  /** Returns the `kitzur autostart status` output, or null when it cannot be read. */
  autostartStatus?: (stateDir: string) => Promise<string | null>;
}

const defaultRun: CommandRunner = (command, args) => {
  const r = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return r.error || r.status !== 0 ? null : r.stdout;
};

async function defaultAutostartStatus(stateDir: string): Promise<string | null> {
  // Imported lazily: autostart.ts imports doctor.ts.
  const { manageAutostart } = await import('../autostart.js');
  let out = '';
  try { manageAutostart('status', null, stateDir, (s) => { out += s; }); } catch { return out || null; }
  return out;
}

/** Parses `netsh int ipv4 show excludedportrange protocol=tcp`; rows are "<start> <end> [*]". */
export function parseExcludedPortRanges(output: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s+\*)?\s*$/.exec(line);
    if (!m) continue;
    const start = Number(m[1]), end = Number(m[2]);
    if (start <= end && end <= 65535) ranges.push([start, end]);
  }
  return ranges;
}

/** Nearest port above `port` (then below) outside every range, or null. */
export function portOutside(ranges: Array<[number, number]>, port: number): number | null {
  const free = (p: number): boolean => !ranges.some(([s, e]) => p >= s && p <= e);
  for (let p = port + 1; p <= 65535; p++) if (free(p)) return p;
  for (let p = port - 1; p >= 1024; p--) if (free(p)) return p;
  return null;
}

const SYNCED_SEGMENT = /(?:^|\\)(?:onedrive(?: - [^\\]+)?|dropbox|google drive|icloud ?drive)(?:\\|$)/i;

/** The synced root containing `path`, or null. Compares Windows paths case-insensitively. */
export function syncedRoot(path: string, env: Record<string, string | undefined>): string | null {
  const norm = (p: string): string => p.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
  const target = norm(path);
  for (const key of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
    const root = env[key];
    if (root && (target === norm(root) || target.startsWith(norm(root) + '\\'))) return root;
  }
  const m = SYNCED_SEGMENT.exec(path.replaceAll('/', '\\'));
  return m ? path.slice(0, m.index + m[0].replace(/\\$/, '').length) : null;
}

/** Windows-only doctor checks that need no administrator rights; empty on other platforms. */
export async function windowsChecks(input: { port: number; stateDir: string; logFile: string; configPath?: string }, deps: WindowsDeps = {}): Promise<DoctorCheck[]> {
  if ((deps.platform ?? process.platform) !== 'win32') return [];
  const checks: DoctorCheck[] = [];
  const run = deps.run ?? defaultRun;
  const env = deps.env ?? process.env;

  let ranges: Array<[number, number]> | null = null;
  try {
    const out = run('netsh', ['int', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp']);
    if (out !== null) ranges = parseExcludedPortRanges(out);
  } catch { /* a missing netsh is not a finding */ }
  const hit = ranges?.find(([s, e]) => input.port >= s && input.port <= e);
  if (ranges && hit) {
    const alt = portOutside(ranges, input.port);
    checks.push({ code: 'windows.port', status: 'warn', message: `listen.port ${input.port} is inside the Windows excluded TCP port range ${hit[0]}-${hit[1]}; binding it fails.`,
      fix: alt === null ? 'Set listen.port to a port outside the ranges `netsh int ipv4 show excludedportrange protocol=tcp` lists.' : `Set listen.port to ${alt}, which is outside every excluded range.` });
  } else checks.push({ code: 'windows.port', status: 'ok', message: ranges ? `listen.port ${input.port} is outside the Windows excluded TCP port ranges.` : 'Windows excluded TCP port ranges could not be read; check skipped.' });

  const labelled: Array<[string, string | undefined]> = [['state directory', input.stateDir], ['log file', input.logFile], ['config file', input.configPath]];
  const synced = labelled.filter(([, p]) => p && syncedRoot(p, env)).map(([label]) => label);
  if (synced.length) checks.push({ code: 'windows.synced_folder', status: 'warn', message: `The ${synced.join(', ')} ${synced.length > 1 ? 'are' : 'is'} under a OneDrive or similar synced folder, where file locks and renames can fail.`,
    fix: 'Move stateDir, log.file and the config to a local folder such as %LOCALAPPDATA%\\kitzur.' });
  else checks.push({ code: 'windows.synced_folder', status: 'ok', message: 'State, log and config paths are outside synced folders.' });

  let status: string | null = null;
  try { status = await (deps.autostartStatus ?? defaultAutostartStatus)(input.stateDir); } catch { /* reported as unknown */ }
  if (status?.startsWith('installed:')) checks.push({ code: 'windows.autostart', status: 'ok', message: 'The per-user Startup shortcut (Kitzur.lnk) is installed.' });
  else if (status?.startsWith('not installed:')) checks.push({ code: 'windows.autostart', status: 'ok', message: 'The per-user Startup shortcut is not installed; run `kitzur autostart install --config PATH` to start Kitzur at sign-in.' });
  else checks.push({ code: 'windows.autostart', status: 'ok', message: 'The per-user Startup shortcut state could not be read; run `kitzur autostart status`.' });
  return checks;
}
