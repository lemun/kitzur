import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeInstance } from './diagnostics/doctor.js';
import type { Config } from './config/schema.js';

export const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));
const psQuote = (s: string): string => `'${s.replaceAll("'", "''")}'`;
/** Windows CommandLineToArgvW quoting. */
export function windowsQuote(s: string): string {
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}
export function shortcutArguments(configPath: string, cli = cliPath): string {
  return `${windowsQuote(cli)} autostart run --config ${windowsQuote(configPath)}`;
}
export function shortcutScript(configPath: string, stateDir: string, node = process.execPath, cli = cliPath): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$startup = [Environment]::GetFolderPath('Startup')",
    "if (-not $startup) { throw 'Windows Startup folder is unavailable' }",
    "$path = Join-Path $startup 'Kitzur.lnk'",
    "$link = (New-Object -ComObject WScript.Shell).CreateShortcut($path)",
    `$link.TargetPath = ${psQuote(node)}`,
    `$link.Arguments = ${psQuote(shortcutArguments(configPath, cli))}`,
    `$link.WorkingDirectory = ${psQuote(stateDir)}`,
    '$link.WindowStyle = 7', '$link.Save()', 'Write-Output $path',
  ].join('\n');
}
function powershell(script: string): string {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(r.error?.message ?? (r.stderr.trim() || `PowerShell exited ${r.status}`));
  return r.stdout.trim();
}

/** Only an absent listener permits launch. */
export async function runAutostart(cfg: Config, configPath: string, stateDir: string, opts: {
  env?: NodeJS.ProcessEnv; timeoutMs?: number; cli?: string; node?: string; log(s: string): void;
}): Promise<number> {
  const state = await probeInstance(cfg.listen.host, cfg.listen.port, opts.timeoutMs, cfg.listen.token);
  if (state !== 'absent') {
    opts.log(state === 'responsive' ? 'kitzur: already running\n' : `kitzur: port ${cfg.listen.port} occupied (${state}); refusing to start\n`);
    return state === 'responsive' ? 0 : 1;
  }
  const logs = join(stateDir, 'logs');
  mkdirSync(logs, { recursive: true });
  const fd = openSync(join(logs, 'serve-stdio.log'), 'a', 0o600);
  try {
    const child = spawn(opts.node ?? process.execPath, [opts.cli ?? cliPath, 'serve', '--config', configPath], {
      detached: true, windowsHide: true, stdio: ['ignore', fd, fd], cwd: dirname(configPath), env: opts.env,
    });
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
    child.unref();
    opts.log(`kitzur: started detached; output in ${join(logs, 'serve-stdio.log')}\n`);
    return 0;
  } finally { closeSync(fd); }
}

export function manageAutostart(action: 'install' | 'remove' | 'status', configPath: string | null, stateDir: string, log: (s: string) => void): number {
  if (process.platform !== 'win32') {
    log(`kitzur: see deploy/README.md for the ${process.platform === 'darwin' ? 'launchd' : 'systemd'} service template\n`);
    return 0;
  }
  // Without PowerShell, fall back to the default per-user Startup folder so status/remove and the manual steps still work.
  let startup: string;
  try { startup = powershell("[Environment]::GetFolderPath('Startup')"); } catch { startup = ''; }
  const path = join(startup || join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), 'Kitzur.lnk');
  if (action === 'remove') { rmSync(path, { force: true }); log(`removed ${path}\n`); return 0; }
  if (action === 'status') {
    if (!existsSync(path)) { log(`not installed: ${path}\n`); return 0; }
    log(`installed: ${path}\n${powershell(`$l=(New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(path)}); 'TargetPath: ' + $l.TargetPath; 'Arguments: ' + $l.Arguments; 'WindowStyle: ' + $l.WindowStyle; 'WorkingDirectory: ' + $l.WorkingDirectory`)}\n`);
    return 0;
  }
  if (!configPath) throw new Error('autostart install requires a config file (--config PATH)');
  try {
    mkdirSync(stateDir, { recursive: true });
    log(`installed: ${powershell(shortcutScript(configPath, stateDir))}\n`);
    return 0;
  } catch (e) {
    log(`kitzur: shortcut creation failed: ${(e as Error).message}\nManual setup: open shell:startup; create Kitzur.lnk targeting ${windowsQuote(process.execPath)} with arguments ${shortcutArguments(configPath)}; set Start in to ${windowsQuote(stateDir)} and Run to Minimized. Execution policy was not changed.\n`);
    return 1;
  }
}
