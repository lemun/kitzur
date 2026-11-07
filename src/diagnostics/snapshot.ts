import { createHash } from 'node:crypto';
import { computeBudget } from '../config/derived.js';
import { DEFAULT_CONFIG } from '../config/schema.js';
import { DEFAULT_LEAVES, getPath } from '../config/spec.js';
import type { Config, ModelProfiles } from '../config/schema.js';
import type { DoctorResult } from './doctor.js';

export interface SnapshotFacts { version: string; node: string; platform: string; arch: string; home?: string; upstreamHost?: string; tokenizerConfigured: boolean; tokenizerLoads: boolean }

function hostMask(host: string): string {
  const hash = createHash('sha256').update(host.toLowerCase()).digest('hex').slice(0, 6);
  return `host-${hash}`;
}

/** Redact host names and home paths from every free-form diagnostic string. */
export function maskSnapshotString(input: string, facts: Pick<SnapshotFacts, 'home' | 'upstreamHost'>): string {
  let value = input;
  const hosts = new Map<string, string>();
  if (facts.upstreamHost) hosts.set(facts.upstreamHost.toLowerCase(), 'upstream-host');
  value = value.replace(/\bhttps?:\/\/([^/?#\s]+)/gi, (_all, authority: string) => {
    const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d+$/, '');
    const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
    const replacement = hosts.get(bare) ?? hostMask(bare);
    // Userinfo (user:token@) is dropped entirely: it is a credential, not a location.
    const suffix = authority.slice(authority.lastIndexOf('@') + 1 + host.length);
    return _all.replace(authority, replacement + suffix);
  });
  for (const [host, replacement] of hosts) value = value.replace(new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), replacement);
  if (facts.home) value = value.split(facts.home).join('<home>');
  value = value.replace(/(?:[A-Za-z]:)?\\Users\\[^\\/]+/gi, '<home>');
  value = value.replace(/\/(?:Users|home)\/[^/\\\s]+/g, '<home>');
  return value;
}

function primitiveConfigChanges(config: Config): Record<string, number | boolean> {
  const changed: Record<string, number | boolean> = {};
  for (const key of DEFAULT_LEAVES) {
    const value = getPath(config, key);
    if (value !== getPath(DEFAULT_CONFIG, key) && (typeof value === 'number' || typeof value === 'boolean')) changed[key] = value;
  }
  return changed;
}

export function createSnapshot(result: DoctorResult, config: Config, models: ModelProfiles, facts: SnapshotFacts): object {
  const budget = computeBudget(config);
  const perProfile: Record<string, { window: number; trigger: number; target: number }> = {};
  for (const [id, profile] of Object.entries(models).sort(([a], [b]) => a.localeCompare(b))) {
    const b = computeBudget(profile);
    perProfile[maskSnapshotString(id, facts)] = { window: b.window, trigger: b.trigger, target: b.target };
  }
  const clean = (s: string): string => maskSnapshotString(s, facts);
  return {
    version: facts.version, node: facts.node, platform: facts.platform, arch: facts.arch,
    tokenizer: { configured: facts.tokenizerConfigured, loads: facts.tokenizerLoads },
    budget: { window: budget.window, trigger: budget.trigger, target: budget.target },
    ...(Object.keys(perProfile).length ? { profiles: perProfile } : {}),
    checks: result.checks.map(({ code, status, message, fix }) => ({ code: clean(code), status, message: clean(message), ...(fix ? { fix: clean(fix) } : {}) })),
    config: primitiveConfigChanges(config),
  };
}
