import type { Config, ModelProfiles } from '../config/schema.js';
import { setDiscoveredWindows } from '../config/window.js';
import type { Counter } from '../tokenize/counter.js';
import type { Engine, LearnedEntry } from '../types.js';

export interface ModelRuntime {
  cfg: Config;
  counter: Counter;
  engine: Engine;
  estimateReason?: string | null;
  tokenizer?: { sha256: string | null; sourceBytes: number; loadMs: number };
}

/** Exact model IDs select a profile runtime; unknown IDs keep the root runtime. */
export class ModelRuntimeMap {
  private readonly byModel = new Map<string, ModelRuntime>();
  private readonly unknownModels = new Set<string>();

  constructor(readonly root: ModelRuntime, profiles: ModelProfiles, runtimes: ReadonlyMap<string, ModelRuntime>) {
    for (const id of Object.keys(profiles)) {
      const runtime = runtimes.get(id);
      if (runtime) this.byModel.set(id, runtime);
    }
  }

  forModel(model?: string): ModelRuntime {
    return model === undefined ? this.root : this.byModel.get(model) ?? this.root;
  }

  /** Compatibility alias for callers that used the original runtimeFor name. */
  runtimeFor(model?: string): ModelRuntime {
    return this.forModel(model);
  }

  shouldWarnUnknown(model?: string): boolean {
    if (model === undefined || this.byModel.has(model) || this.unknownModels.has(model)) return false;
    // Keep diagnostics bounded even if clients send arbitrary model IDs.
    if (this.unknownModels.size >= 100) return false;
    this.unknownModels.add(model);
    return true;
  }

  setLearned(model: string | undefined, key: string, entry: LearnedEntry): void {
    this.forModel(model).engine.setLearned(key, entry);
  }

  setDiscoveredWindows(windows: Readonly<Record<string, number>>): void {
    const owned = new Map<ModelRuntime, Record<string, number>>();
    for (const [model, window] of Object.entries(windows)) {
      const runtime = this.forModel(model);
      const group = owned.get(runtime) ?? {};
      group[model] = window;
      owned.set(runtime, group);
    }
    for (const [runtime, discovered] of owned) {
      setDiscoveredWindows(runtime.cfg, discovered);
    }
  }
}

