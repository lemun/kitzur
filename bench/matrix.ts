// The declarative bench matrix (bench/README.md§4, §13): cells = system × scenario × window, with tiers, and the
// runKey that caches a cell's results:
//   runKey = sha256(canonicalJSON({system: <system config at the window>, scenario, window, code: <code version>,
//                                  tokenizer: <tokenizer sha256>}))
//
// Systems registered here (benchmark contract ): direct, gobstopper-default, gobstopper-tuned (per-window threshold, ), the
// offline OpenCode-mechanics simulator (opencode-sim: faithful long Continue text; opencode-sim-compat: baseline.py's
// short one), the OpenCode HTTP client (`opencode`), kitzur (preset per window, template per mock render), every
// benchmark contract ablation (T2), the OpenCode client through kitzur (`opencode-kitzur`) and the benchmark contract sweep grid (T3,
// kitzur-sweep-*). registerSystem() stays the typed hook for more.
//
//   node dist/bench/matrix.js [--tier T1] [--only <glob>] [--systems a,b] [--windows 100k,32k] [--json]

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJSON } from '../src/tokenize/canonical.js';
import { ROOT } from './lib/paths.js';
import type { BenchSystem } from './systems/types.js';
import { buildScenario, familyOf, SCENARIO_IDS, type ScenarioDef } from './scenarios/index.js';
import { G8_STYLES } from './scenarios/errors.js';
import { gobTunedThreshold, WINDOWS, WINDOW_IDS, type WindowId, type WindowSpec } from './scenarios/windows.js';
import type { FamilyId } from './scenarios/types.js';

export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4' | 'T5';
export const TIERS: readonly Tier[] = ['T0', 'T1', 'T2', 'T3', 'T4', 'T5'];

/** Everything a system needs to start one isolated run (benchmark contract ). */
export interface SystemContext {
  window: WindowSpec;
  scenario: ScenarioDef;
  runDir: string;
  /** per-run state directory (kitzur stateDir) */
  stateDir: string;
  /** per-run HOME / XDG_* roots, already exported in the worker's environment */
  homeDir: string;
  /** per-run stats / ledger path */
  statsPath: string;
  /** resolved external binaries */
  gobstopperBin: string | null;
  /** the bench tokenizer.json (kitzur --tokenizer) */
  tokenizerPath: string | null;
}

/**
 * How a system is driven:
 *  http      the HTTP harness: mock ← system ← client; `create` returns the proxy (or null for direct)
 *  offline   an in-process simulator (no HTTP; e.g. bench/opencode-sim.ts)
 */
export interface SystemDef {
  id: string;
  /** table row label */
  label: string;
  kind: 'http' | 'offline';
  /** 'scenario' = the scenario's own client; 'opencode' = the OpenCode HTTP client (bench/client/opencode.ts) */
  client: 'scenario' | 'opencode';
  /** the canonical configuration hashed into the runKey (a pure function of the window) */
  config(w: WindowSpec): Record<string, unknown>;
  /** null when the system can run the scenario, else the NOT RUN reason */
  supports(sc: ScenarioDef, w: WindowSpec): string | null;
  /** http systems: the system under test in front of the mock (null = direct) */
  create?(ctx: SystemContext): BenchSystem | null;
  /** runs at 32k/64k on the G8 set and 128k on F1/F2 (benchmark contract T1) */
  allWindows: boolean;
  /** T2 ablation of `ablationOf` (kitzur) */
  ablationOf?: string;
  /** a report comparator row (gobstopper tuned, OpenCode mechanics) */
  comparator?: boolean;
  /**
   * 'auto' (default): byte-exact `-ref` scenarios run through the Python-parity harness path (bench/harness.ts, the
   * legacy non-strict client); 'spec': every scenario through the strict spec driver (a proxy that synthesizes
   * responses, e.g. kitzur, should use this so benchmark contract 's strict client judges them).
   */
  driver?: 'auto' | 'spec';
  /** the system implements RestartableSystem (F13 events; the spec driver's beforeStep hook calls restart()) */
  restartable?: boolean;
  /** false = the cell is structurally inapplicable and not listed at all (unlike supports(), whose reason is reported) */
  applies?(sc: ScenarioDef, w: WindowId): boolean;
  /** explicit cells (tier, scenarios, windows) instead of the T1 rules / the T2 ablation set */
  cells?: { tier: Tier; scenarios: readonly string[]; windows: readonly WindowId[] };
}

/** A system under test that can be restarted between client steps (F13: sigterm / sigkill / fresh-state). */
export interface RestartableSystem extends BenchSystem {
  /** restart before the next request; returns the (possibly new) base URL */
  restart(kind: 'sigterm' | 'sigkill' | 'fresh-state'): Promise<string>;
}

const SYSTEMS = new Map<string, SystemDef>();

/** The hook for later waves (kitzur, kitzur ablations, OpenCode via kitzur). */
export function registerSystem(def: SystemDef): void {
  if (SYSTEMS.has(def.id)) throw new Error(`system ${def.id} already registered`);
  SYSTEMS.set(def.id, def);
}
export function getSystem(id: string): SystemDef {
  const s = SYSTEMS.get(id);
  if (!s) throw new Error(`unknown system ${id} (have ${[...SYSTEMS.keys()].join(', ')})`);
  return s;
}
export function systemIds(): string[] {
  return [...SYSTEMS.keys()];
}

// ---------------------------------------------------------------- built-in systems

export const GOB_VERSION = '0.7.2';

/** gobstopper tuned @ W/O (benchmark contract ). */
export function gobTunedArgs(w: WindowSpec): string[] {
  return ['--threshold', String(gobTunedThreshold(w)), '--keep-recent', '2', '--carry-max-chars', '40000'];
}

const OFFLINE_OK = new Set(['qa46-ref', 'talk80-ref']);
const opencodeClientPath = (): string => join(ROOT, 'dist', 'bench', 'client', 'opencode.js');
const hasRestart = (sc: ScenarioDef): boolean => !!sc.events?.some((e) => e.kind !== 'client-compact');

function httpSupports(sc: ScenarioDef): string | null {
  if (sc.client !== 'sim' && !existsSync(opencodeClientPath())) return `scenario client '${sc.client}' needs bench/client/opencode.ts (not built yet)`;
  return null;
}

registerSystem({
  id: 'direct', label: 'direct', kind: 'http', client: 'scenario', allWindows: true, restartable: true,
  config: () => ({ system: 'direct' }),
  supports: (sc) => httpSupports(sc),
  create: () => null,
});

registerSystem({
  id: 'gobstopper-default', label: `gobstopper ${GOB_VERSION} defaults`, kind: 'http', client: 'scenario', allWindows: false, restartable: true,
  config: () => ({ system: 'gobstopper', version: GOB_VERSION, args: [] }),
  supports: (sc) => httpSupports(sc),
  create: (ctx) => gob(ctx, [], 'gobstopper-default'),
});

registerSystem({
  id: 'gobstopper-tuned', label: `gobstopper ${GOB_VERSION} tuned`, kind: 'http', client: 'scenario', allWindows: true, comparator: true, restartable: true,
  config: (w) => ({ system: 'gobstopper', version: GOB_VERSION, args: gobTunedArgs(w) }),
  supports: (sc) => httpSupports(sc),
  create: (ctx) => gob(ctx, gobTunedArgs(ctx.window), 'gobstopper-tuned'),
});

registerSystem({
  id: 'opencode-sim', label: 'OpenCode mechanics (offline, long Continue)', kind: 'offline', client: 'opencode', allWindows: true, comparator: true,
  config: () => ({ system: 'opencode-sim', continueText: 'long', summaryTokens: 1500 }),
  // the offline simulator only replays the reference scenario: other cells are not listed at all
  applies: (sc) => OFFLINE_OK.has(sc.id),
  supports: () => null,
});

registerSystem({
  id: 'opencode-sim-compat', label: 'OpenCode mechanics (offline, baseline.py)', kind: 'offline', client: 'opencode', allWindows: true,
  config: () => ({ system: 'opencode-sim', continueText: 'short', summaryTokens: 1500 }),
  applies: (sc) => OFFLINE_OK.has(sc.id),
  supports: () => null,
});

registerSystem({
  id: 'opencode', label: 'OpenCode client, direct', kind: 'http', client: 'opencode', allWindows: true, comparator: true,
  config: () => ({ system: 'opencode-client', mode: 'faithful' }),
  // the OpenCode client is not driven by the sim agent, so F13's per-step restart hook does not apply to it
  applies: (sc) => !hasRestart(sc),
  supports: () => (existsSync(opencodeClientPath()) ? null : 'bench/client/opencode.ts is not built'),
  create: () => null,
});

// ---------------------------------------------------------------- kitzur, its ablations, the sweep

/** A kitzur configuration: the preset of the window plus `--set` overrides (values may depend on the window). */
export interface KitzurVariant {
  id: string;
  label: string;
  /** config overrides; a function for window-dependent values (clamp: client.compactionPointTokens = W) */
  set?: Record<string, string | number | boolean | null> | ((w: WindowSpec) => Record<string, string | number | boolean | null>);
  /** tokenizer.template.name: 'match' = the mock's render (), 'mismatch' = the other one (benchmark contract ) */
  template?: 'match' | 'mismatch';
  /** no --tokenizer (estimate counting) */
  noTokenizer?: boolean;
}

const setOf = (v: KitzurVariant, w: WindowSpec): Record<string, string | number | boolean | null> =>
  typeof v.set === 'function' ? v.set(w) : { ...(v.set ?? {}) };

export function kitzurConfig(v: KitzurVariant, w: WindowSpec): Record<string, unknown> {
  return { system: 'kitzur', preset: w.id, template: v.template ?? 'match', set: setOf(v, w), tokenizer: v.noTokenizer ? 'none' : 'bench' };
}

/** The template kitzur counts with for a scenario: the mock's render, or the other one for the mismatch ablation. */
export function kitzurTemplate(v: KitzurVariant, sc: ScenarioDef): 'sim' | 'qwen3' {
  const render = sc.mock.render ?? 'sim';
  if ((v.template ?? 'match') === 'match') return render;
  return render === 'sim' ? 'qwen3' : 'sim';
}

let leanModule: typeof import('./systems/kitzur.js') | null = null;
function lean(ctx: SystemContext, v: KitzurVariant, name: string): BenchSystem {
  if (!leanModule) throw new Error('call loadSystemModules() first');
  return new leanModule.Kitzur({
    name, preset: ctx.window.id, tokenizer: v.noTokenizer ? null : ctx.tokenizerPath, stateDir: ctx.stateDir,
    set: { 'tokenizer.template.name': kitzurTemplate(v, ctx.scenario), ...setOf(v, ctx.window) },
  });
}

export const KITZUR_DEFAULT: KitzurVariant = { id: 'kitzur', label: 'kitzur' };

registerSystem({
  id: 'kitzur', label: 'kitzur', kind: 'http', client: 'scenario', allWindows: true, driver: 'spec', restartable: true,
  config: (w) => kitzurConfig(KITZUR_DEFAULT, w),
  supports: (sc) => httpSupports(sc),
  create: (ctx) => lean(ctx, KITZUR_DEFAULT, 'kitzur'),
});

registerSystem({
  id: 'opencode-kitzur', label: 'OpenCode client through kitzur', kind: 'http', client: 'opencode', allWindows: true, driver: 'spec',
  config: (w) => ({ ...kitzurConfig(KITZUR_DEFAULT, w), client: 'opencode-client', mode: 'faithful' }),
  applies: (sc) => !hasRestart(sc),
  supports: () => (existsSync(opencodeClientPath()) ? null : 'bench/client/opencode.ts is not built'),
  create: (ctx) => lean(ctx, KITZUR_DEFAULT, 'kitzur'),
});

/** benchmark contract ablations (T2: qa46-ref, talk80, huge180k, rs46 at 100k and 32k, compared with kitzur default). */
export const ABLATIONS: readonly KitzurVariant[] = [
  { id: 'kitzur-ledger-off', label: 'ledger off', set: { 'ledger.enabled': false } },
  { id: 'kitzur-snapshot-off', label: 'snapshot rules off', set: { 'rules.snapshot.stub': 'off', 'rules.snapshot.slim': false } },
  { id: 'kitzur-stub-eager', label: 'eager stubs', set: { 'rules.snapshot.stub': 'eager' } },
  { id: 'kitzur-oversize-off', label: 'oversize off', set: { 'oversize.enabled': false } },
  { id: 'kitzur-admission-off', label: 'admission off', set: { 'oversize.admission': false } },
  { id: 'kitzur-clamp', label: 'clamp (client point = W)', set: (w) => ({ 'budget.maxTokensClamp.enabled': true, 'client.compactionPointTokens': w.W }) },
  { id: 'kitzur-estimate', label: 'estimated counting', set: { 'tokenizer.mode': 'estimate' }, noTokenizer: true },
  { id: 'kitzur-template-mismatch', label: 'template mismatch', template: 'mismatch' },
  { id: 'kitzur-summary-0.02', label: 'summaryFraction 0.02', set: { 'compaction.summaryFraction': 0.02 } },
  { id: 'kitzur-summary-0.08', label: 'summaryFraction 0.08', set: { 'compaction.summaryFraction': 0.08 } },
  { id: 'kitzur-keeprecent-2', label: 'keepRecent 2', set: { 'compaction.keepRecent': 2 } },
  { id: 'kitzur-reasoning-drop', label: 'reasoning tail drop', set: { 'reasoning.tail': 'drop' } },
  { id: 'kitzur-summaryrole-merge', label: 'summaryRole merge', set: { 'compaction.summaryRole': 'merge-into-first-user' } },
];
export const ABLATION_SCENARIOS = ['qa46-ref', 'talk80', 'huge180k', 'rs46'] as const;
export const ABLATION_WINDOWS: readonly WindowId[] = ['100k', '32k'];

for (const v of ABLATIONS) {
  registerSystem({
    id: v.id, label: v.label, kind: 'http', client: 'scenario', allWindows: true, driver: 'spec', ablationOf: 'kitzur',
    config: (w) => kitzurConfig(v, w),
    // reasoning.tail only matters where the client sends reasoning back (rs46)
    applies: (sc) => v.id !== 'kitzur-reasoning-drop' || sc.id === 'rs46',
    supports: (sc) => httpSupports(sc),
    create: (ctx) => lean(ctx, v, v.id),
  });
}

/** benchmark contract sweep (small grid, T3): triggerFraction × targetFraction × summaryFraction on qa46 at 100k, over HTTP. */
export const SWEEP = {
  triggerFraction: [0.9, 0.95, 1.0],
  targetFraction: [0.3, 0.35, 0.45],
  summaryFraction: [0.03, 0.04, 0.06],
  scenarios: ['qa46'],
  windows: ['100k'] as WindowId[],
} as const;
export const sweepId = (t: number, g: number, s: number): string => `kitzur-sweep-t${t}-g${g}-s${s}`;
for (const t of SWEEP.triggerFraction) {
  for (const g of SWEEP.targetFraction) {
    for (const sf of SWEEP.summaryFraction) {
      const v: KitzurVariant = {
        id: sweepId(t, g, sf), label: `sweep trigger ${t} target ${g} summary ${sf}`,
        set: { 'compaction.triggerFraction': t, 'compaction.targetFraction': g, 'compaction.summaryFraction': sf },
      };
      registerSystem({
        id: v.id, label: v.label, kind: 'http', client: 'scenario', allWindows: true, driver: 'spec',
        cells: { tier: 'T3', scenarios: SWEEP.scenarios, windows: SWEEP.windows },
        config: (w) => kitzurConfig(v, w),
        supports: (sc) => httpSupports(sc),
        create: (ctx) => lean(ctx, v, v.id),
      });
    }
  }
}

let gobModule: typeof import('./systems/gobstopper.js') | null = null;
function gob(ctx: SystemContext, args: string[], name: string): BenchSystem {
  if (!ctx.gobstopperBin) throw new Error('gobstopper binary not found (KITZUR_GOBSTOPPER_BIN or KITZUR_REF_DIR)');
  if (!gobModule) throw new Error('call loadSystemModules() first');
  return new gobModule.Gobstopper({ bin: ctx.gobstopperBin, args, name });
}

/** Load the modules the built-in http systems need (kept lazy so the matrix itself stays importable anywhere). */
export async function loadSystemModules(): Promise<void> {
  gobModule ??= await import('./systems/gobstopper.js');
  leanModule ??= await import('./systems/kitzur.js');
}

// ---------------------------------------------------------------- cells

export interface Cell {
  system: string;
  scenario: string;
  window: WindowId;
  tier: Tier;
  family: FamilyId;
  runKey: string;
  /** null = runnable; else the NOT RUN reason (the cell is still listed so the report can say so) */
  skip: string | null;
}

export interface MatrixOptions {
  tiers?: Tier[];
  /** glob over "system/scenario/window", e.g. "*\/qa46*\/100k" */
  only?: string;
  systems?: string[];
  windows?: WindowId[];
  scenarios?: string[];
  codeVersion?: string;
  tokenizerSha?: string;
}

export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

export function runKey(system: SystemDef, scenario: string, w: WindowSpec, codeVersion: string, tokenizerSha: string): string {
  return createHash('sha256')
    .update(canonicalJSON({ system: system.config(w), scenario, window: w.id, code: codeVersion, tokenizer: tokenizerSha }))
    .digest('hex');
}

/** Does a scenario run at a window for a system (benchmark contract "Windows", §13 T1)? */
function inT1(sys: SystemDef, sc: ScenarioDef, w: WindowId): boolean {
  if (!sc.windows.includes(w)) return false;
  if (w === '100k') return true;
  if (!sys.allWindows) return false;
  // F14's impossible cells are defined at 32k only
  if (sc.family === 'F14') return true;
  // G8 set: F1, F2, F4, F9, F11 (vllm-018, gateway502), F13 at 32k/64k; F1/F2 also at 128k
  if (w === '128k') return sc.family === 'F1' || sc.family === 'F2';
  if (sc.family === 'F11') return G8_STYLES.some((s) => sc.id === `err-${s}` || sc.id === `err-${s}-hidden`);
  return ['F1', 'F2', 'F4', 'F9', 'F13'].includes(sc.family);
}

export function matrix(o: MatrixOptions = {}): Cell[] {
  const tiers = o.tiers ?? ['T1', 'T2'];
  const code = o.codeVersion ?? codeVersion();
  const tok = o.tokenizerSha ?? 'unknown';
  const only = o.only ? globToRegExp(o.only) : null;
  const out: Cell[] = [];
  const ids = o.scenarios ?? SCENARIO_IDS;
  for (const sysId of o.systems ?? systemIds()) {
    const sys = getSystem(sysId);
    for (const id of ids) {
      for (const w of WINDOW_IDS) {
        if (o.windows && !o.windows.includes(w)) continue;
        const sc = buildScenario(id, w);
        if (sys.applies && !sys.applies(sc, w)) continue;
        let tier: Tier | null = null;
        if (sys.cells) {
          if (sys.cells.scenarios.includes(id) && sys.cells.windows.includes(w)) tier = sys.cells.tier;
        } else if (sys.ablationOf) {
          if ((ABLATION_SCENARIOS as readonly string[]).includes(id) && ABLATION_WINDOWS.includes(w)) tier = 'T2';
        } else if (inT1(sys, sc, w)) tier = 'T1';
        if (tier === null || !tiers.includes(tier)) continue;
        if (only && !only.test(`${sysId}/${id}/${w}`)) continue;
        out.push({
          system: sysId, scenario: id, window: w, tier, family: familyOf(id),
          runKey: runKey(sys, id, WINDOWS[w], code, tok), skip: sys.supports(sc, WINDOWS[w]),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- versions

function walkTs(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (name === 'results' || name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walkTs(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
}

let codeMemo: string | null = null;
/**
 * Bench sources that cannot change a cell's results (the report side, the fuzz and latency suites of benchmark component): left
 * out of the code version, so editing them does not invalidate the cached cells.
 */
export const CODE_VERSION_EXCLUDED: readonly string[] = ['bench/fuzz/', 'bench/latency.ts', 'bench/report.ts', 'bench/run-all.ts', 'bench/verify.ts'];

/** sha256 over every .ts source under bench/ and src/ (paths and contents) but CODE_VERSION_EXCLUDED: the "code version" of a runKey. */
export function codeVersion(): string {
  if (codeMemo) return codeMemo;
  // run-all --snapshot runs a frozen copy of dist/ and passes the code version it computed when it froze it
  const pinned = process.env['KITZUR_BENCH_CODE_VERSION'];
  if (pinned && /^[0-9a-f]{64}$/.test(pinned)) return (codeMemo = pinned);
  const files: string[] = [];
  walkTs(join(ROOT, 'bench'), files);
  walkTs(join(ROOT, 'src'), files);
  const h = createHash('sha256');
  for (const f of files.filter((x) => !CODE_VERSION_EXCLUDED.some((e) => relative(ROOT, x).startsWith(e)))) h.update(relative(ROOT, f)).update('\0').update(readFileSync(f)).update('\0');
  return (codeMemo = h.digest('hex'));
}

export function fileSha256(path: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ---------------------------------------------------------------- CLI

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
  const cells = matrix({
    tiers: (flag('--tier')?.split(',') as Tier[] | undefined) ?? ['T1', 'T2'],
    ...(flag('--only') ? { only: flag('--only')! } : {}),
    ...(flag('--systems') ? { systems: flag('--systems')!.split(',') } : {}),
    ...(flag('--windows') ? { windows: flag('--windows')!.split(',') as WindowId[] } : {}),
  });
  if (args.includes('--json')) console.log(JSON.stringify(cells, null, 1));
  else {
    for (const c of cells) console.log(`${c.tier} ${c.system.padEnd(20)} ${c.scenario.padEnd(28)} ${c.window.padEnd(5)} ${c.runKey.slice(0, 12)} ${c.skip ? `NOT RUN: ${c.skip}` : ''}`);
    console.log(`${cells.length} cells, ${cells.filter((c) => !c.skip).length} runnable`);
  }
}
