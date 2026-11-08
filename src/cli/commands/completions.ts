import { UsageError, type CliIO } from '../io.js';
import { parseArgs } from '../args.js';
import { NO_CONFIG_COMMANDS, USAGE, usageOf } from '../usage.js';

/** One command's completion words: subcommands (or fixed first arguments) and flags. */
export interface CommandCompletion {
  name: string;
  subs: string[];
  flags: string[];
}

const SHELLS = ['bash', 'zsh', 'fish'] as const;
const WORD = /^[a-z][a-z-]*(\|[a-z][a-z-]*)*$/;

/** Commands, subcommands and flags, derived from USAGE so completion cannot drift from the help text. */
export function completionData(): CommandCompletion[] {
  const byName = new Map<string, CommandCompletion>();
  for (const l of USAGE.split('\n').slice(2)) {
    if (l === '') break;
    const m = /^ {2}(\S+)(?: (\S+))?/.exec(l);
    if (!m) continue;
    const name = m[1]!;
    let c = byName.get(name);
    if (!c) {
      const flags = new Set([...usageOf(name).matchAll(/--[a-z][a-z-]*/g)].map((f) => f[0]));
      if (!NO_CONFIG_COMMANDS.has(name)) for (const s of ['-c', '-p', '-s']) flags.add(s);
      c = { name, subs: [], flags: [...flags] };
      byName.set(name, c);
    }
    if (m[2] && WORD.test(m[2])) for (const s of m[2].split('|')) if (!c.subs.includes(s)) c.subs.push(s);
  }
  return [...byName.values()];
}

const words = (xs: readonly string[]): string => xs.join(' ');

export function renderBash(data: readonly CommandCompletion[]): string {
  const cases = data.map((c) => `    ${c.name}) subs="${words(c.subs)}"; flags="${words(c.flags)}" ;;`);
  return `# bash completion for kitzur: source <(kitzur completions bash)
_kitzur() {
  local cur=\${COMP_WORDS[COMP_CWORD]} subs= flags=
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "${words(data.map((c) => c.name))}" -- "$cur"))
    return
  fi
  case \${COMP_WORDS[1]} in
${cases.join('\n')}
  esac
  if [[ $cur == -* ]]; then
    COMPREPLY=($(compgen -W "$flags" -- "$cur"))
  elif [ "$COMP_CWORD" -eq 2 ] && [ -n "$subs" ]; then
    COMPREPLY=($(compgen -W "$subs" -- "$cur"))
  fi
}
complete -o default -F _kitzur kitzur
`;
}

export function renderZsh(data: readonly CommandCompletion[]): string {
  const cases = data.map((c) => `    ${c.name}) subs=(${words(c.subs)}); flags=(${words(c.flags)}) ;;`);
  return `#compdef kitzur
# zsh completion for kitzur: save as _kitzur in a directory on $fpath, or source <(kitzur completions zsh)
_kitzur() {
  local -a subs flags
  if (( CURRENT == 2 )); then
    compadd -- ${words(data.map((c) => c.name))}
    return
  fi
  case \${words[2]} in
${cases.join('\n')}
  esac
  if [[ \${words[CURRENT]} == -* ]]; then
    compadd -- $flags
  elif (( CURRENT == 3 && \${#subs} )); then
    compadd -- $subs
  else
    _files
  fi
}
if [ "$funcstack[1]" = "_kitzur" ]; then _kitzur "$@"; else compdef _kitzur kitzur; fi
`;
}

export function renderFish(data: readonly CommandCompletion[]): string {
  const lines = [
    '# fish completion for kitzur: kitzur completions fish > ~/.config/fish/completions/kitzur.fish',
    'function __kitzur_cmd; set -l t (commandline -opc); test (count $t) -ge 2; and test "$t[2]" = $argv[1]; end',
    `complete -c kitzur -n __fish_use_subcommand -f -a '${words(data.map((c) => c.name))}'`,
  ];
  for (const c of data) {
    const is = `__kitzur_cmd ${c.name}`;
    if (c.subs.length) lines.push(`complete -c kitzur -n '${is}; and test (count (commandline -opc)) -eq 2' -f -a '${words(c.subs)}'`);
    for (const f of c.flags) lines.push(`complete -c kitzur -n '${is}' ${f.startsWith('--') ? `-l ${f.slice(2)}` : `-s ${f.slice(1)}`}`);
  }
  return lines.join('\n') + '\n';
}

/** `kitzur completions bash|zsh|fish`: prints a completion script for that shell. */
export function cmdCompletions(argv: string[], io: CliIO): number {
  const p = parseArgs(argv, {});
  const [shell, ...extra] = p.positionals;
  if (!SHELLS.includes(shell as (typeof SHELLS)[number])) throw new UsageError(`completions needs one of ${SHELLS.join(', ')}`);
  if (extra.length) throw new UsageError(`completions takes one shell (got ${extra.join(' ')})`);
  const data = completionData();
  io.stdout(shell === 'bash' ? renderBash(data) : shell === 'zsh' ? renderZsh(data) : renderFish(data));
  return 0;
}
