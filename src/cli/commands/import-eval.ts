import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setupCounter } from '../../app.js';
import { loadConfig } from '../../config/load.js';
import { validateConfig } from '../../config/validate.js';
import { getPath, isPlainObject } from '../../config/spec.js';
import { parseJsonc } from '../../config/jsonc.js';
import {
  mapEvalResults, mergeImport, readEvalInputs, renderImportReport, sidecarPath, type ImportSidecar, type KnobRecord, type MergeResult,
} from '../../config/import-eval.js';
import { UsageError, type CliIO } from '../io.js';
import { parseArgs } from '../args.js';

export async function cmdImportEval(argv: string[], io: CliIO): Promise<number> {
  const p = parseArgs(argv, {
    out: { type: 'string', short: 'o' }, merge: { type: 'string' }, provenance: { type: 'string' }, 'dry-run': { type: 'boolean' },
    'force-keys': { type: 'string', multiple: true }, 'allow-pack-version': { type: 'string', multiple: true }, 'json-report': { type: 'boolean' },
    port: { type: 'string' }, tokenizer: { type: 'string' }, template: { type: 'string' }, force: { type: 'boolean' },
  });
  if (!p.positionals.length) throw new UsageError('import-eval needs gateway-probes result directories or files');
  const inputs = readEvalInputs(p.positionals.map((x) => resolve(io.cwd, x)), { allowPackVersions: (p.values['allow-pack-version'] as string[] | undefined) ?? [] });
  for (const x of inputs.invalid) io.stderr(`kitzur: invalid input: ${x}\n`);
  if (inputs.invalid.length) return 1;
  if (inputs.candidates > 0 && Object.keys(inputs.results).length === 0) {
    io.stderr('kitzur: no usable gateway-probes result in the inputs (see the warnings)\n');
    for (const w of inputs.warnings) io.stderr(`  - ${w}\n`);
    return 1;
  }
  const port = p.values['port'] !== undefined ? Number(p.values['port']) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) throw new UsageError('--port must be a port number');
  // optional template check: our exact count of the probe's tiny request
  let tinyCount: number | null = null;
  if (p.values['tokenizer']) {
    const l = loadConfig({ env: {}, sets: [
      { path: 'tokenizer.path', raw: String(p.values['tokenizer']), source: 'cli:--tokenizer' },
      ...(p.values['template'] ? [{ path: 'tokenizer.template.name', raw: String(p.values['template']), source: 'cli:--template' }] : []),
    ], cwd: io.cwd });
    const cs = setupCounter(l.config, {});
    if (cs.estimateReason) {
      io.stderr(`kitzur: --tokenizer: ${cs.estimateReason}\n`);
      return 1;
    }
    tinyCount = cs.counter.countRequest({ messages: [{ role: 'user', content: 'Reply with the single word OK.' }] });
  }
  const res = mapEvalResults(inputs.results, { port, capture: inputs.capture, tinyCount });
  const mergePath = p.values['merge'] ? resolve(io.cwd, String(p.values['merge'])) : null;
  const out = resolve(io.cwd, (p.values['out'] as string | undefined) ?? mergePath ?? 'kitzur.config.json');
  const provPath = p.values['provenance'] ? resolve(io.cwd, String(p.values['provenance'])) : sidecarPath(out);
  const forceKeys = ((p.values['force-keys'] as string[] | undefined) ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  let config: Record<string, unknown>;
  let knobs: Record<string, KnobRecord>;
  let merge: MergeResult | null = null;
  const notes: string[] = [];
  if (mergePath) {
    if (!existsSync(mergePath)) {
      io.stderr(`kitzur: --merge ${mergePath}: not found\n`);
      return 1;
    }
    const text = readFileSync(mergePath, 'utf8');
    let existing: unknown;
    try {
      existing = parseJsonc(text, mergePath);
    } catch (e) {
      io.stderr(`kitzur: ${(e as Error).message}\n`);
      return 1;
    }
    if (!isPlainObject(existing)) {
      io.stderr(`kitzur: ${mergePath}: not a JSON object\n`);
      return 1;
    }
    let prev: Record<string, KnobRecord> | null = null;
    const prevPath = sidecarPath(mergePath);
    if (existsSync(prevPath)) {
      try {
        const s = JSON.parse(readFileSync(prevPath, 'utf8')) as Partial<ImportSidecar>;
        prev = isPlainObject(s.knobs) ? (s.knobs as Record<string, KnobRecord>) : null;
      } catch {
        notes.push(`${prevPath}: unreadable; every existing value is treated as hand-set`);
      }
    }
    merge = mergeImport(existing, prev, res, forceKeys);
    config = merge.config;
    knobs = merge.sidecarKnobs;
    if (/\/\/|\/\*/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) notes.push(`comments in ${mergePath} are not preserved (a copy is kept as ${out}.bak)`);
  } else {
    if (existsSync(out) && !p.values['force'] && !p.values['dry-run']) {
      io.stderr(`kitzur: ${out} exists: use --merge ${out} to update it (hand-set values survive) or --force to replace it\n`);
      return 1;
    }
    config = { $comment: 'written by kitzur config import-eval; provenance of every value in the .provenance.json next to this file', ...res.config };
    knobs = Object.fromEntries(Object.entries(res.provenance).filter(([k]) => getPath(res.config, k) !== undefined));
  }
  // the result must load and validate like any config (with --merge: the merged file, its preset included)
  let unusable = false;
  try {
    const check = validateConfig(loadConfig({ env: {}, cwd: dirname(out), object: config }).config, {});
    for (const e of check.errors) notes.push(`the written config does not validate: ${e}`);
    unusable = check.errors.length > 0;
  } catch (e) {
    notes.push(`the written config does not load: ${(e as Error).message}`);
    unusable = true;
  }
  // a config serve would refuse is never "exit 0": report it like conflicting measurements
  const exitCode: 0 | 10 | 11 = unusable ? 11 : res.exitCode;
  const sidecar: ImportSidecar = {
    $comment: 'kitzur config import-eval provenance: the knobs listed under "knobs" were written by the importer and may be updated by a later import; values edited by hand are kept',
    generatedBy: 'kitzur config import-eval',
    inputs: inputs.sources,
    knobs,
    info: res.info,
    warnings: [...inputs.warnings, ...res.warnings, ...(merge?.warnings ?? []), ...notes],
    todos: res.todos,
  };
  if (p.values['json-report']) {
    io.stdout(JSON.stringify({
      inputs: inputs.sources, ignored: inputs.ignored, config, provenance: res.provenance, info: res.info,
      warnings: sidecar.warnings, conflicts: res.conflicts, unsafe: res.unsafe, todos: res.todos, questions: res.questions,
      clientBaseUrl: res.clientBaseUrl, written: merge?.written ?? Object.keys(knobs), kept: merge?.kept ?? [], exitCode,
      out: p.values['dry-run'] ? null : out, provenancePath: p.values['dry-run'] ? null : provPath,
    }, null, 1) + '\n');
  } else {
    const loaderNotes = [...inputs.warnings, ...notes];
    if (inputs.ignored.length) loaderNotes.push(`ignored (not gateway-probes results): ${inputs.ignored.join(', ')}`);
    io.stdout(renderImportReport({ ...res, warnings: [...loaderNotes, ...res.warnings], exitCode }, { inputs: inputs.sources, merge }) + '\n');
  }
  if (!p.values['dry-run']) {
    if (existsSync(out) && mergePath) copyFileSync(out, `${out}.bak`);
    mkdirSync(dirname(out), { recursive: true });
    mkdirSync(dirname(provPath), { recursive: true });
    writeFileSync(out, JSON.stringify(config, null, 2) + '\n');
    writeFileSync(provPath, JSON.stringify(sidecar, null, 2) + '\n');
    io.stderr(`kitzur: wrote ${out} and ${provPath}\n`);
  }
  return exitCode;
}
