// ---------------------------------------------------------------- usage

export const USAGE = `usage: kitzur <command> [options]

  autostart install|remove|status|run [--config FILE]  per-user Windows login startup
  serve                         run the proxy (logs the bound address to a file)
  replay <file|dir>...          run captured request bodies through the engine offline; sizes only,
                                plus a live-vs-fresh determinism check; --explain shows content-free retention outcomes
  redact <file|dir>... [--out DIR|-]  copy request bodies with every text replaced by same-length filler
                                (default: <name>.redacted.json next to the input)
  count <request.json>          exact token count of a request (per message, no content)
  status [--url URL] [--json]   Show a running instance’s status
  doctor [--model ID] [--client-config PATH] [--json] [--check-upstream] [--timeout-ms N]  read-only setup diagnostics
  tls-probe [origin] [--ca-file FILE] [--json] [--timeout-ms N]  inspect the TLS chain
  report <stats.jsonl> [--json]  aggregate request stats; sizes only
  config init [--preset 100k] [--upstream URL] [--tokenizer FILE] [--out FILE|-] [--force]
  config show [--changed] [--json]      effective config with the source of every value
  config validate [--json]              errors and startup warnings
  config import-eval <dir|file>... [--out FILE] [--merge FILE] [--provenance FILE] [--dry-run]
  config export-opencode --model ID [--small-model ID] [--provider NAME] [--key-env NAME]
                     [--force-keys a.b,c] [--allow-pack-version N] [--json-report] [--port N] [--force]
  state show [--key K] [--json]         learned entries in the state dir
  state reset [--key K] [--plans]       remove learned entries (and the plan store)
  bench [args...]                       run the benchmark suite (dist/bench/run-all.js)
  version

config options (serve, replay, count, status, doctor, config show|validate, state):
  -c, --config FILE      JSON config file (comments allowed)       also KITZUR_CONFIG;
                         default ~/.config/kitzur/kitzur.jsonc if it exists
  -p, --preset NAME      32k | 64k | 100k | 128k, or a preset file   also KITZUR_PRESET
  -s, --set a.b=v        set any key (repeatable)                    also KITZUR_SET="a.b=v;c.d=w"
  --upstream URL  --host H  --port N  --tokenizer FILE  --template NAME
  --state-dir DIR  --stats FILE  --log-level L  --shadow
  --log-file PATH  --foreground (opt into TTY console echo)
Precedence: defaults < preset < config file < KITZUR_* env < command line. Every key: CONFIG.md.
`;

/** Commands that answer --help / -h with their usage (bench forwards help flags to the suite only after `--`). */
export const HELP_COMMANDS = new Set(['autostart', 'serve', 'replay', 'count', 'status', 'doctor', 'tls-probe', 'report', 'config', 'state', 'bench', 'redact', 'version']);

/** Commands that read no config, so their usage leaves out the config options. */
export const NO_CONFIG_COMMANDS = new Set(['report', 'bench', 'redact', 'version']);

/** One command's USAGE lines (with their continuation lines), plus the config options unless it reads no config. */
export function usageOf(cmd: string): string {
  const [, , ...lines] = USAGE.split('\n');
  const own: string[] = [];
  let mine = false;
  for (const l of lines) {
    if (l === '') break;
    const m = /^ {2}(\S+)/.exec(l);
    if (m) mine = m[1] === cmd;
    if (mine) own.push(l);
  }
  const configOpts = NO_CONFIG_COMMANDS.has(cmd) ? '' : `\n${USAGE.slice(USAGE.indexOf('config options'))}`;
  return `usage: kitzur ${cmd} [options]\n\n${own.join('\n')}\n${configOpts}`;
}

/** True when argv asks for help (--help or -h before any `--`). */
export const wantsHelp = (argv: readonly string[]): boolean => {
  const end = argv.indexOf('--');
  return (end < 0 ? argv : argv.slice(0, end)).some((a) => a === '--help' || a === '-h');
};
