// kitzur public API: configuration, budgets, counting and wiring. The engine and proxy are reached
// through buildApp / buildEngine (loaded dynamically, see app.ts), so this entry point has no static
// dependency on them.
export * from './types.js';
export { DEFAULT_CONFIG, type Config, type ServerType, type BudgetMode } from './config/schema.js';
export { loadConfig, defaultConfig, parseSetArg, ConfigError, ENV_MAP, type LoadOptions, type LoadedConfig, type Provenance, type SetOp } from './config/load.js';
export { validateConfig, checkErrorRule, globToRegExp, type ValidationResult, type ValidateOptions } from './config/validate.js';
export {
  computeBudget, resolveBudgetMode, budgetModeConflict, planMaxTokens, requestMaxTokens, serverFits, clampRange, snapshotRoom, floorFrac,
  type BudgetInputs,
} from './config/derived.js';
export { PRESET_TABLE, listPresets, loadPreset, presetsDir } from './config/presets.js';
export { LEAF_SPECS, DEFAULT_LEAVES, type LeafSpec } from './config/spec.js';
export { stateDirOf, packageInfo } from './config/paths.js';
export { renderInitConfig } from './config/init.js';
export { parseJsonc } from './config/jsonc.js';
export {
  readEvalInputs, mapEvalResults, mergeImport, renderImportReport, sidecarPath, type ImportResult, type KnobRecord, type Confidence,
  type EvalInputs, type ImportSidecar, type MapOptions, type MergeResult,
} from './config/import-eval.js';
export { createCounter, counterFromConfig, type Counter, type CounterOptions, type CounterDeps } from './tokenize/counter.js';
export { loadTokenizerCached, type LoadedTokenizer } from './tokenize/load.js';
export { TokenizerUnsupportedError } from './tokenize/tokenizer.js';
export { TemplateError, type TemplateName } from './tokenize/template.js';
export { canonicalJSON, digestOf } from './tokenize/canonical.js';
export { createRemoteTokenizer, remoteFromConfig, type RemoteTokenizer } from './tokenize/remote.js';
export { SUMMARY_HEADER, type Summarizer, type ToolRules, type SummaryInput, type SummaryOptions, type SummaryRender } from './engine/contracts.js';
export {
  buildApp, buildEngine, setupCounter, loadModules, createLogger, AppModuleError,
  type App, type AppModules, type EngineSetup, type CounterSetup, type ProbeOutcome, type Logger,
} from './app.js';
