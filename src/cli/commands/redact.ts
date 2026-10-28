import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { looksLikeHeaders, redactRequest } from '../../diagnostics/redact.js';
import { UsageError, type CliIO } from '../io.js';
import { parseArgs } from '../args.js';
import { asRequest, readRequestFile } from '../requests.js';

const REDACTED = /\.redacted\.jsonl?$/;

/** `kitzur redact <file|dir>... [--out DIR|-]`: same-shape bodies with no message text; logs paths only (stdout with -). */
export function cmdRedact(argv: string[], io: CliIO): number {
  const p = parseArgs(argv, { out: { type: 'string' } });
  if (!p.positionals.length) throw new UsageError('redact needs a request file or a directory of captured request bodies');
  const out = p.values['out'] as string | undefined;
  const files: string[] = [];
  for (const p0 of p.positionals) {
    const path = resolve(io.cwd, p0);
    if (!existsSync(path)) throw new UsageError(`not found: ${p0}`);
    if (!statSync(path).isDirectory()) files.push(path);
    else for (const f of readdirSync(path).sort()) if (/\.jsonl?$/.test(f) && !REDACTED.test(f)) files.push(join(path, f));
  }
  // every input is checked before anything is written
  const dests = new Map<string, string>();
  const jobs = files.map((f) => {
    let items: unknown[];
    try {
      items = readRequestFile(f);
    } catch (e) {
      throw new UsageError(`${basename(f)}: not JSON (${(e as Error).message.split('\n')[0]})`);
    }
    const bodies = items.map((it, i) => {
      const req = asRequest(it);
      const at = items.length > 1 ? `${basename(f)}:${i + 1}` : basename(f);
      if (req) return redactRequest(req);
      if (looksLikeHeaders(it)) throw new UsageError(`${at}: looks like captured headers, which can hold credentials; share request bodies only`);
      throw new UsageError(`${at}: not a chat request body`);
    });
    const dest = out === undefined ? (/\.jsonl?$/.test(f) ? f.replace(/\.(jsonl?)$/, '.redacted.$1') : `${f}.redacted.json`) : join(resolve(io.cwd, out), basename(f));
    if (out !== '-' && dest === f) throw new UsageError(`${basename(f)}: --out would overwrite the input`);
    const prev = out === '-' ? undefined : dests.get(dest);
    if (prev !== undefined) throw new UsageError(`${basename(f)}: --out would overwrite the copy of another input with the same name (${prev})`);
    dests.set(dest, f);
    return { f, bodies, dest };
  });
  for (const { f, bodies, dest } of jobs) {
    const lines = bodies.map((b) => JSON.stringify(b) + '\n').join('');
    if (out === '-') {
      io.stdout(lines);
      continue;
    }
    const text = f.endsWith('.jsonl') ? lines : JSON.stringify(bodies.length === 1 ? bodies[0] : bodies) + '\n';
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
    io.stderr(`redacted ${bodies.length} request(s): ${dest}\n`);
  }
  return 0;
}
