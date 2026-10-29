import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validateConfig } from '../../config/validate.js';
import { computeBudget } from '../../config/derived.js';
import { DEFAULT_LEAVES, getPath } from '../../config/spec.js';
import { renderInitConfig } from '../../config/init.js';
import { packageInfo } from '../../config/paths.js';
import { exportOpenCode } from '../../config/export-opencode.js';
import { UsageError, type CliIO } from '../io.js';
import { CONFIG_OPTS, loadFromArgs, parseArgs } from '../args.js';
import { derivedLines, display, maskedConfig } from '../format.js';
import { cmdImportEval } from './import-eval.js';
import { isAutoWindow } from '../../config/window.js';

export async function cmdConfig(argv: string[], io: CliIO): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'export-opencode': {
      const p = parseArgs(rest, { ...CONFIG_OPTS, model: { type: 'string' }, 'small-model': { type: 'string' }, provider: { type: 'string' }, 'key-env': { type: 'string' } });
      const model = p.values['model'];
      if (typeof model !== 'string' || !model) throw new UsageError('config export-opencode needs --model ID');
      const l = loadFromArgs(p, io);
      io.stdout(exportOpenCode(l.config, l.models, { model, smallModel: p.values['small-model'] as string | undefined, provider: p.values['provider'] as string | undefined, keyEnv: p.values['key-env'] as string | undefined }));
      return 0;
    }
    case 'init': {
      const p = parseArgs(rest, { preset: { type: 'string', short: 'p' }, out: { type: 'string', short: 'o' }, force: { type: 'boolean' }, upstream: { type: 'string' }, tokenizer: { type: 'string' } });
      const tokenizerArg = p.values['tokenizer'] as string | undefined;
      const text = renderInitConfig((p.values['preset'] as string | undefined) ?? '100k', {
        upstream: p.values['upstream'] as string | undefined,
        // a `~/` path is kept for the config loader; others are relative to the shell's directory, not to the written file's
        tokenizer: tokenizerArg === undefined || tokenizerArg === '' ? undefined : tokenizerArg.startsWith('~/') ? tokenizerArg : resolve(io.cwd, tokenizerArg),
      });
      const out = (p.values['out'] as string | undefined) ?? 'kitzur.config.jsonc';
      if (out === '-') {
        io.stdout(text);
        return 0;
      }
      const path = resolve(io.cwd, out);
      if (existsSync(path) && !p.values['force']) {
        io.stderr(`kitzur: ${path} exists (use --force to overwrite)\n`);
        return 1;
      }
      // the README's `--out ~/.config/kitzur/kitzur.jsonc` on a fresh host: the directory does not exist yet
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      const todo = [p.values['upstream'] ? '' : 'upstream.origin', tokenizerArg ? '' : 'tokenizer.path'].filter(Boolean);
      io.stdout(`wrote ${path}\nnext: ${todo.length ? `set ${todo.join(' and ')}, then: ` : ''}kitzur config validate --config ${out}\n`);
      return 0;
    }
    case 'show': {
      const p = parseArgs(rest, { ...CONFIG_OPTS, model: { type: 'string' }, json: { type: 'boolean' }, changed: { type: 'boolean' }, full: { type: 'boolean' } });
      const l = loadFromArgs(p, io);
      const v = validateConfig(l.config, { provenance: l.provenance });
      const ids = Object.keys(l.models).sort();
      const selected = p.values['model'] as string | undefined;
      if (selected && !Object.hasOwn(l.models, selected)) throw new UsageError(`config show: no configured profile for model '${selected}'`);
      const profiles = selected ? [selected] : ids;
      const derivedByModel = Object.fromEntries(profiles.map((id) => [id, derivedLines(l.models[id]!).slice(1)]));
      if (p.values['json']) {
        io.stdout(JSON.stringify({
          preset: l.preset, configPath: l.configPath, layers: l.layers, config: maskedConfig(l.config), provenance: l.provenance,
          derived: computeBudget(l.config, { counterFixedTokens: l.config.budget.observedFixedPromptTokens }),
          ...(ids.length ? { derivedByModel } : {}), errors: v.errors, warnings: [...l.warnings, ...v.warnings],
        }, null, 1) + '\n');
        return v.errors.length ? 2 : 0;
      }
      io.stdout(`# kitzur ${packageInfo().version} effective config: ${l.layers.join(' < ')}\n`);
      const leaves = DEFAULT_LEAVES.filter((k) => !p.values['changed'] || l.provenance[k] !== 'default');
      const w = Math.max(...leaves.map((k) => k.length), 10);
      for (const k of leaves) {
        io.stdout(`${k.padEnd(w)} = ${display(k, k === 'budget.window' && isAutoWindow(l.config) ? 'auto' : getPath(l.config, k), p.values['full'] === true)}   (${l.provenance[k]})\n`);
      }
      io.stdout('\n' + derivedLines(l.config).join('\n') + '\n');
      for (const id of profiles) {
        const cfg = l.models[id]!;
        io.stdout(`\n# model ${id}${isAutoWindow(cfg) ? ` (auto (fallback ${cfg.budget.window}))` : ''}\n` + derivedLines(cfg).slice(1).join('\n') + '\n');
      }
      for (const x of [...l.warnings, ...v.warnings]) io.stdout(`# warning: ${x}\n`);
      for (const x of v.errors) io.stdout(`# ERROR: ${x}\n`);
      return v.errors.length ? 2 : 0;
    }
    case 'validate': {
      const p = parseArgs(rest, { ...CONFIG_OPTS, model: { type: 'string' }, json: { type: 'boolean' } });
      const l = loadFromArgs(p, io);
      const v = validateConfig(l.config, { provenance: l.provenance, checkFiles: true });
      const warnings = [...l.warnings, ...v.warnings];
      const errors = Object.keys(l.models).flatMap((id) => validateConfig(l.models[id]!, { checkFiles: true }).errors.map((e) => `models[${JSON.stringify(id)}]: ${e}`));
      if (p.values['json']) io.stdout(JSON.stringify({ ok: errors.length === 0 && v.errors.length === 0, errors: [...v.errors, ...errors], warnings }, null, 1) + '\n');
      else {
        for (const e of v.errors) io.stdout(`error: ${e}\n`);
        for (const e of errors) io.stdout(`error: ${e}\n`);
        for (const x of warnings) io.stdout(`warning: ${x}\n`);
        const n = v.errors.length + errors.length;
        io.stdout(n ? `${n} error(s)\n` : `ok (${warnings.length} warning(s))\n`);
      }
      return v.errors.length || errors.length ? 2 : 0;
    }
    case 'import-eval':
      return cmdImportEval(rest, io);
    default:
      throw new UsageError(sub ? `unknown config command '${sub}' (init, show, validate, import-eval, export-opencode)` : 'config needs a subcommand: init, show, validate, import-eval, export-opencode');
  }
}
