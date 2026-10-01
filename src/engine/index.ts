// The engine's public surface (DESIGN.md, §5): LeanEngine/createEngine, the plan store and its JSONL
// persistence, and the budget and error-body helpers the proxy shares with the engine (§3, §5.7, §8).
export { LeanEngine, createEngine, type EngineDeps, type EngineOptions, type EngineTrace } from './engine.js';
export { MemoryPlanStore, type PlanPersistence, type MemoryStoreOptions, type StoreStats } from './store.js';
export { createFilePersistence, type FilePersistence, type FilePersistenceOptions } from './store-file.js';
export {
  budgetMode, computeBudget, decideMaxTokens, ffloor, fits, maxTokensFields, requestedMaxTokens, serverFits, serverLimit,
} from './budget.js';
export { contextLengthExceeded, fixedPromptTooLarge, fmtK, OPENCODE_RETRY_RE, type ErrorBody } from './impossible.js';
export { correctionPct, defaultLearnedEntry, learnedKey, learnedValid, planningInputs, templateKwargs } from './learned.js';
export { chainKeys, CHAIN_ROOT, digestOf, inputsHash, planKey } from './canonical.js';
export { pairingDefects, defectsSubset } from './pairing.js';
export { parseFaults } from './faults.js';
