// Every common first-run failure says what went wrong and what to do next, in one line: the offending
// value or key, and a command, flag or config key to fix it. Driven through main() in process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type CliIO } from '../../src/cli.js';

interface Row {
  name: string;
  argv: (dir: string) => string[];
  code: number;
  /** the offending value or key */
  names: RegExp;
  /** the next step: a command, flag or config key */
  next: RegExp;
  /** the next step is the usage hint main() prints on the line after the error, not on the error line */
  nextLine?: boolean;
  /** `config validate` reports on stdout; everything else on stderr */
  stdout?: boolean;
  /** needs a directory the test user cannot write (not as root, not on Windows) */
  readOnly?: boolean;
  /** process.env overrides for the run (validate resolves the default state dir from process.env) */
  env?: (dir: string) => Record<string, string>;
}

const ROWS: Row[] = [
  { name: 'config file not found', argv: (d) => ['config', 'show', '--config', join(d, 'missing.json')], code: 2, names: /missing\.json/, next: /kitzur config init --out \S*missing\.json/ },
  { name: 'config not a JSON object', argv: (d) => ['config', 'show', '--config', join(d, 'array.json')], code: 2, names: /array\.json: the config must be a JSON object/, next: /kitzur config init/ },
  { name: 'unknown option', argv: () => ['serve', '--bogus'], code: 2, names: /unknown option --bogus/, next: /kitzur <command> --help/ },
  { name: 'unknown short option', argv: () => ['count', '-x'], code: 2, names: /unknown option -x/, next: /kitzur <command> --help/ },
  { name: 'unknown command', argv: () => ['frob'], code: 2, names: /unknown command 'frob'/, next: /kitzur help/, nextLine: true },
  { name: 'invalid --set', argv: () => ['config', 'show', '--set', 'listen.port'], code: 2, names: /"listen\.port"/, next: /key=value \(kitzur config show --full/ },
  { name: 'port out of range', argv: () => ['config', 'validate', '--port', '70000'], code: 2, names: /listen\.port: .*70000/, next: /cli:--port/, stdout: true },
  { name: 'count: request file missing', argv: (d) => ['count', join(d, 'nope.json')], code: 2, names: /not found: \S*nope\.json/, next: /pass a captured Chat Completions body: JSON with a messages array/ },
  { name: 'replay: request file missing', argv: (d) => ['replay', join(d, 'nope.json')], code: 2, names: /not found: \S*nope\.json/, next: /pass a captured Chat Completions body: JSON with a messages array/ },
  { name: 'count: not a chat body', argv: (d) => ['count', join(d, 'nochat.json')], code: 2, names: /nochat\.json: not a chat request/, next: /pass a captured Chat Completions body: JSON with a messages array/ },
  { name: 'replay: not a chat body', argv: (d) => ['replay', join(d, 'nochat.json')], code: 1, names: /nochat\.json +ERROR not a chat request/, next: /pass a captured Chat Completions body: JSON with a messages array/, stdout: true },
  { name: 'stateDir not writable', argv: (d) => ['config', 'validate', '--state-dir', join(d, 'ro', 'state')], code: 0, names: /stateDir: \S*state is not writable/, next: /--state-dir DIR or set stateDir/, stdout: true, readOnly: true },
  { name: 'default stateDir not writable', argv: () => ['config', 'validate'], env: (d) => ({ XDG_STATE_HOME: join(d, 'ro') }), code: 0, names: /stateDir: \S*ro\/kitzur is not writable/, next: /--state-dir DIR or set stateDir/, stdout: true, readOnly: true },
  { name: 'upstream.origin unset at serve', argv: () => ['serve', '--port', '0'], code: 2, names: /upstream\.origin is required/, next: /--upstream .*kitzur config init/ },
  { name: 'tokenizer unreadable (count)', argv: (d) => ['count', '--tokenizer', join(d, 'tok.json'), join(d, 'chat.json')], code: 2, names: /tok\.json failed to load/, next: /--tokenizer FILE, or --estimate/ },
  { name: 'tokenizer unreadable (validate)', argv: (d) => ['config', 'validate', '--tokenizer', join(d, 'tok.json')], code: 0, names: /tokenizer\.path: \S*tok\.json could not be loaded/, next: /--tokenizer or tokenizer\.path/, stdout: true },
  { name: '--model with no profile', argv: (d) => ['count', '--model', 'nope', join(d, 'chat.json')], code: 2, names: /--model nope: no configured profile/, next: /under models in the config/ },
];

const canMakeReadOnly = process.platform !== 'win32' && process.getuid?.() !== 0;

for (const row of ROWS) {
  test(`error message: ${row.name}`, { skip: row.readOnly && !canMakeReadOnly ? 'needs a non-root POSIX user' : false }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kitzur-err-'));
    writeFileSync(join(dir, 'array.json'), '[1]');
    writeFileSync(join(dir, 'nochat.json'), '{"x":1}');
    writeFileSync(join(dir, 'chat.json'), '{"model":"example","messages":[{"role":"user","content":"hi"}]}');
    writeFileSync(join(dir, 'tok.json'), 'not a tokenizer');
    mkdirSync(join(dir, 'ro'));
    if (row.readOnly) chmodSync(join(dir, 'ro'), 0o555);
    const saved = { ...process.env };
    Object.assign(process.env, row.env?.(dir));
    try {
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIO = { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), env: { HOME: dir }, cwd: dir, onSignal: () => undefined };
      const code = await main(row.argv(dir), io);
      const text = (row.stdout ? out : err).join('');
      assert.equal(code, row.code, text);
      const lines = text.split('\n');
      const at = lines.findIndex((l) => row.names.test(l));
      assert.ok(at >= 0, `no line names the offending value: ${text}`);
      const line = lines[row.nextLine ? at + 1 : at] ?? '';
      assert.match(line, row.next);
    } finally {
      for (const k of Object.keys(row.env?.(dir) ?? {})) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      chmodSync(join(dir, 'ro'), 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
