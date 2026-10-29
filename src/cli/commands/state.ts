import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stateDirOf } from '../../config/paths.js';
import { UsageError, type CliIO } from '../io.js';
import { CONFIG_OPTS, loadFromArgs, parseArgs } from '../args.js';
import { importState } from '../http.js';

export async function cmdState(argv: string[], io: CliIO): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'show' && sub !== 'reset') throw new UsageError('state needs a subcommand: show, reset');
  const p = parseArgs(rest, { ...CONFIG_OPTS, key: { type: 'string' }, json: { type: 'boolean' }, plans: { type: 'boolean' } });
  const cfg = loadFromArgs(p, io).config;
  const dir = stateDirOf(cfg, io.env);
  const st = await importState();
  const key = p.values['key'] as string | undefined;
  if (sub === 'show') {
    const r = st.showState(dir, key);
    if (r.error) io.stderr(`kitzur: ${r.path}: ${r.error}\n`);
    if (p.values['json']) {
      io.stdout(JSON.stringify({ path: r.path, ...r.state }, null, 1) + '\n');
      return r.error ? 1 : 0;
    }
    const entries = Object.entries(r.state.entries);
    io.stdout(`${r.path}: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${key ? ` matching ${key}` : ''}\n`);
    for (const [k, e] of entries) {
      io.stdout(
        `${k}\n  window ${e.window ?? '-'} (configured ${e.configuredWindow}), maxPrompt ${e.maxPrompt ?? '-'}, maxBodyBytes ${e.maxBodyBytes ?? '-'}, ` +
          `tighten ${e.tighten}, correction ${e.correction} (${e.samples} samples), includeUsageRejected ${e.includeUsageRejected}, updated ${e.updatedAt ?? '-'}\n`,
      );
      for (const t of e.tightenLog ?? []) io.stdout(`  tighten: ${t.at} ${t.rule} rejected raw ${t.rejectedRaw}\n`);
    }
    return r.error ? 1 : 0;
  }
  const gone = st.resetState(dir, key);
  io.stdout(gone.length ? `removed ${gone.length} entr${gone.length === 1 ? 'y' : 'ies'}: ${gone.join(', ')}\n` : 'no matching entries\n');
  if (p.values['plans']) {
    const plans = join(dir, 'plans');
    if (existsSync(plans)) {
      rmSync(plans, { recursive: true, force: true });
      io.stdout(`removed ${plans}\n`);
    }
  }
  io.stdout('restart a running proxy: it keeps its entries in memory and writes them back\n');
  return 0;
}
