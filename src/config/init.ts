// `kitzur config init`: a commented starting config (JSON with comments, read by load.ts).
import { PRESET_TABLE } from './presets.js';
import { DEFAULT_CONFIG } from './schema.js';
import { validModelId } from './models.js';

/** Values `config init` can fill in from the command line (written as given; null in the file when absent). */
export interface InitValues {
  upstream?: string;
  /** written as given: an absolute path, or one starting with `~/` (the config loader expands it); the CLI makes other paths absolute first */
  tokenizer?: string;
  /** model profiles to list under "models", in order (from `--model ID[=WINDOW]`) */
  models?: InitModel[];
}

export interface InitModel {
  id: string;
  window?: number;
}

/**
 * Parses repeated `--model ID[=WINDOW]` values; the window follows the last `=`, and a trailing `=` means none
 * (so `--model a=b=` is ID `a=b` with the root window). Throws a message naming the flag on an empty, invalid or repeated ID or a bad window.
 */
export function parseInitModels(args: readonly string[]): InitModel[] {
  const out: InitModel[] = [];
  for (const arg of args) {
    const eq = arg.lastIndexOf('=');
    const id = eq < 0 ? arg : arg.slice(0, eq);
    const raw = eq < 0 || eq === arg.length - 1 ? undefined : arg.slice(eq + 1);
    if (id.trim() === '') throw new Error(`--model ${JSON.stringify(arg)}: empty model ID; pass the exact wire model ID, for example --model org/model-name=32000`);
    if (!validModelId(id)) throw new Error(`--model ${JSON.stringify(id)}: invalid model ID (non-empty, at most 256 characters, no controls or prototype keys)`);
    if (out.some((m) => m.id === id)) throw new Error(`--model ${JSON.stringify(id)}: given twice; pass each model ID once`);
    if (raw === undefined) {
      out.push({ id });
      continue;
    }
    const window = /^\d+(_\d+)*$/.test(raw) ? Number(raw.replaceAll('_', '')) : NaN;
    if (!Number.isSafeInteger(window) || window <= 0) throw new Error(`--model ${JSON.stringify(arg)}: the window must be a positive integer such as 32000 or 32_000; write --model ${id}=32000, or --model ${id} to inherit the root window`);
    out.push({ id, window });
  }
  return out;
}

/** The "models" block appended after "listen" ('' without models, so the text stays as before). */
function renderModels(models: readonly InitModel[] = []): string {
  if (!models.length) return '';
  const entries = models.map((m) => `    ${JSON.stringify(m.id)}: ${m.window === undefined ? '{}' : `{ "budget": { "window": ${m.window} } }`}`);
  return `,

  // Model profiles (CONFIG.md "Model profiles"): each key is an exact wire model ID, the request's "model"
  // field. An entry may set the per-model groups budget, client and tokenizer over the values above:
  //   "budget": { "window": 64000 }, "client": { "compactionPointTokens": 50000 }, "tokenizer": { "path": null }
  "models": {
${entries.join(',\n')}
  }`;
}

/** The starting config text for a preset (default 100k). Throws on an unknown preset name. */
export function renderInitConfig(preset = '100k', values: InitValues = {}): string {
  const p = PRESET_TABLE[preset];
  if (!p) throw new Error(`unknown preset '${preset}' (available: ${Object.keys(PRESET_TABLE).join(', ')})`);
  const port = DEFAULT_CONFIG.listen.port;
  return `// kitzur configuration: JSON with // and /* */ comments. Every knob is documented in CONFIG.md.
// Precedence: built-in defaults < preset < this file < KITZUR_* environment < --set a.b=v.
//   check it:        kitzur config validate --config <this file>
//   see the result:  kitzur config show --config <this file>   (the source of every value)
{
  // Window preset (presets/${preset}.json): budget.window ${p.window}, budget.defaultMaxTokens ${p.defaultMaxTokens}.
  // One of ${Object.keys(PRESET_TABLE).join(', ')}. Values in this file override it.
  "preset": "${preset}",

  "upstream": {
    // REQUIRED: scheme://host[:port] of the OpenAI-compatible gateway, with no path. The client's request
    // path is appended unchanged, so point the client's baseURL at http://127.0.0.1:${port}/<gateway path>
    // (for example http://127.0.0.1:${port}/v1).
    "origin": ${values.upstream ? JSON.stringify(values.upstream) : 'null'}
    // An internal CA:          , "caFile": "/etc/ssl/certs/internal-ca.pem"
    // A request size limit:    , "maxBodyBytes": 1048576
  },

  "server": {
    // vllm | sglang | llamacpp | tgi | ollama | lmstudio | litellm | unknown (the default). Selects the
    // budget mode (does the server count max_tokens against the window?). Left unset here so that
    // config import-eval can fill it in from the measured error bodies.
    // "type": "vllm"
  },

  "tokenizer": {
    // The served model's HF tokenizer.json, for exact counting (a relative path is relative to this
    // file). null = the per-content-class estimate (CONFIG.md "Counting").
    "path": ${values.tokenizer ? JSON.stringify(values.tokenizer) : 'null'},
    // qwen3 | chatml | generic (sim only against the benchmark mock)
    "template": { "name": "qwen3" }
  },

  "listen": { "host": "127.0.0.1", "port": ${port} }${renderModels(values.models)}

  // After the gateway-probes has run:  kitzur config import-eval <results dir> --merge <this file>
}
`;
}
