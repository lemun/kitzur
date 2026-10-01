// The scenario registry: every family of bench/README.mdby id. Scenarios are built per window (F11's server limit
// depends on it); most ignore the window.

import type { ScenarioContext, ScenarioDef } from './common.js';
import { cc60kilo, cc60oc, cc60ocOverflow } from './client-compacts.js';
import { code60 } from './code-edit.js';
import { corr60 } from './corrections.js';
import { errorBuilders } from './errors.js';
import { he46 } from './hebrew.js';
import { hugeBuilders } from './huge.js';
import { impSys, impTools, impUser } from './impossible.js';
import { il3x46, il3x46Conc, ilSoloBuilders } from './interleave.js';
import { nu46, nu46Server } from './no-usage.js';
import { par46 } from './parallel.js';
import { qa150, qa46, qa46Ref, qa46RefQwen3 } from './browser.js';
import { talk200, talk80, talk80Qwen3, talk80Ref } from './talk.js';
import { rs46 } from './reasoning.js';
import { rs46Freshstate, rs46Sigkill, rs46Sigterm } from './restart.js';
import type { FamilyId } from './types.js';
import { WINDOWS, type WindowId } from './windows.js';

export type ScenarioBuilder = (ctx: ScenarioContext) => ScenarioDef;

const BUILDERS: ReadonlyArray<[string, FamilyId, ScenarioBuilder]> = [
  ['qa46-ref', 'F1', qa46Ref],
  ['qa46', 'F1', qa46],
  ['qa150', 'F1', qa150],
  ['talk80-ref', 'F2', talk80Ref],
  ['talk80', 'F2', talk80],
  ['talk200', 'F2', talk200],
  ['code60', 'F3', code60],
  ...Object.entries(hugeBuilders).map(([id, b]): [string, FamilyId, ScenarioBuilder] => [id, 'F4', b]),
  ['he46', 'F5', he46],
  ['rs46', 'F6', rs46],
  ['par46', 'F7', par46],
  ['il3x46', 'F8', il3x46],
  ['il3x46-conc', 'F8', il3x46Conc],
  ...Object.entries(ilSoloBuilders).map(([id, b]): [string, FamilyId, ScenarioBuilder] => [id, 'F8', b]),
  ['corr60', 'F9', corr60],
  ['cc60-oc', 'F10', cc60oc],
  ['cc60-oc-overflow', 'F10', cc60ocOverflow],
  ['cc60-kilo', 'F10', cc60kilo],
  ...Object.entries(errorBuilders).map(([id, b]): [string, FamilyId, ScenarioBuilder] => [id, 'F11', b]),
  ['nu46', 'F12', nu46],
  ['nu46-server', 'F12', nu46Server],
  ['rs46-sigterm', 'F13', rs46Sigterm],
  ['rs46-sigkill', 'F13', rs46Sigkill],
  ['rs46-freshstate', 'F13', rs46Freshstate],
  ['imp-tools', 'F14', impTools],
  ['imp-sys', 'F14', impSys],
  ['imp-user', 'F14', impUser],
  // realism (report-only; )
  ['qa46-ref-qwen3', 'F1', qa46RefQwen3],
  ['talk80-qwen3', 'F2', talk80Qwen3],
];

const BY_ID = new Map<string, { family: FamilyId; build: ScenarioBuilder }>();
for (const [id, family, build] of BUILDERS) {
  if (BY_ID.has(id)) throw new Error(`duplicate scenario id ${id}`);
  BY_ID.set(id, { family, build });
}

export const SCENARIO_IDS: readonly string[] = BUILDERS.map(([id]) => id);

export const FAMILY_NAMES: Readonly<Record<FamilyId, string>> = {
  F1: 'BROWSER', F2: 'Talkative', F3: 'Code-edit', F4: 'Huge outputs', F5: 'Hebrew', F6: 'Reasoning', F7: 'Parallel calls',
  F8: 'Interleaved sessions', F9: 'Corrections', F10: 'Client compactions', F11: 'Error styles', F12: 'No usage',
  F13: 'Restart', F14: 'Impossible requests',
};

export function familyOf(id: string): FamilyId {
  const e = BY_ID.get(id);
  if (!e) throw new Error(`unknown scenario ${id}`);
  return e.family;
}

export function hasScenario(id: string): boolean {
  return BY_ID.has(id);
}

/** Build a scenario for a window (default 100k/32k). */
export function buildScenario(id: string, window: WindowId = '100k'): ScenarioDef {
  const e = BY_ID.get(id);
  if (!e) throw new Error(`unknown scenario ${id} (have ${SCENARIO_IDS.length})`);
  const def = e.build({ window: WINDOWS[window] });
  if (def.id !== id) throw new Error(`scenario builder for ${id} returned ${def.id}`);
  if (def.family !== e.family) throw new Error(`scenario ${id}: family ${def.family} != registry ${e.family}`);
  return def;
}

export type { ScenarioDef, ScenarioContext } from './common.js';
