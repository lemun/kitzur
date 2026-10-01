// Tool rules (DESIGN.md): role lookup by tool-name glob, result classification (content detection of
// snapshots first, ), snapshot info / stub / slimming (§5.6, ) and the condensed tool-log result (§6.3).
import type { ToolCall } from '../../types.js';
import type { Config } from '../../config/schema.js';
import type { ResultKind, SnapshotInfo, ToolRules, ToolRulesFactory } from '../contracts.js';
import { capHead, collapseWs, cpLength, fmtInt, safeHead, safeTail } from '../ledger/text.js';
import { roleMatcher, type ToolRole } from './glob.js';
import { isSnapshotFileText, isSnapshotText, slimSnapshotText, snapshotCondensed, snapshotInfo, snapshotStub } from './snapshot.js';
import { condenseTest, isTestContent, testCommandMatcher } from './testrun.js';

export type { ToolRole } from './glob.js';

/** Parsed tool-call arguments when they are a JSON object; null otherwise (invalid JSON, arrays, scalars). */
export function parseArgs(call: ToolCall | null | undefined): Record<string, unknown> | null {
  const raw = call?.function?.arguments as unknown;
  let v: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The shell command of a call (`command`, else `cmd`), if a string. */
export function commandOf(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  const c = args['command'] ?? args['cmd'];
  return typeof c === 'string' ? c : null;
}

/** Tool name of a call ('' when missing). */
export const callName = (call: ToolCall | null | undefined): string => {
  const n = call?.function?.name;
  return typeof n === 'string' ? n : '';
};

export interface ToolRulesExt extends ToolRules {
  /** true when the call's command matches rules.test.commands */
  isTestCall(call: ToolCall | null): boolean;
}

export function createToolRulesExt(cfg: Config): ToolRulesExt {
  const r = cfg.rules;
  const role = roleMatcher(r.toolNames);
  const isTestCommand = testCommandMatcher(r.test.commands);
  const roles = new Set(r.snapshot.interactiveRoles.map((x) => x.toLowerCase()));
  const ex = r.excerpt;

  const isTestCall = (call: ToolCall | null): boolean => {
    const cmd = commandOf(parseArgs(call));
    return cmd !== null && isTestCommand(cmd);
  };

  /**
   * Content detection of test output (`N passed` / `N failed` / `Tests:`) applies to shell tools, tools with no
   * role (an MCP test runner) and results without a call. A file, todo or browser tool returns file content, a
   * list or page text: a README that says "3 passed locally" is not a test run, and classifying it as one would
   * replace the real run under "Last test run".
   */
  const mayRunTests = (call: ToolCall | null): boolean => {
    if (!call) return true;
    const rs = role(callName(call));
    return rs.length === 0 || rs.includes('shell');
  };

  /** a read / edit / write result is file content: only a line-anchored snapshot counts (snapshot.ts) */
  const isFileCall = (call: ToolCall | null): boolean => {
    if (!call) return false;
    const rs = role(callName(call));
    return rs.includes('read') || rs.includes('edit') || rs.includes('write');
  };

  const classify = (text: string, call: ToolCall | null): ResultKind => {
    if (isFileCall(call) ? isSnapshotFileText(text) : isSnapshotText(text)) return 'snapshot';
    if (isTestCall(call) || (mayRunTests(call) && isTestContent(text))) return 'test';
    return 'other';
  };

  const generic = (text: string): string => {
    const t = text.trim();
    if (!t) return '(empty)';
    if (cpLength(t) <= ex.shortVerbatimChars || t.length <= ex.headChars + ex.tailChars) return collapseWs(t);
    const head = ex.headChars > 0 ? safeHead(t, ex.headChars) : '';
    const tail = ex.tailChars > 0 ? safeTail(t, ex.tailChars) : '';
    const omitted = cpLength(t.slice(head.length, t.length - tail.length));
    let s = `${fmtInt(omitted)} chars omitted`;
    if (head && tail) s += `: "${collapseWs(head)}" … "${collapseWs(tail)}"`;
    else if (head) s += `: "${collapseWs(head)}" …`;
    else if (tail) s += `: … "${collapseWs(tail)}"`;
    return s;
  };

  const condense = (text: string, call: ToolCall | null): string => {
    // the todo list lives only in "Open todos" (latest wins); its echo must not revive a dropped item (§6.3)
    if (call && role(callName(call)).includes('todo')) {
      const first = text.trim().split('\n', 1)[0] ?? '';
      return /\b(?:error|invalid|failed)\b/i.test(first) ? `error: ${capHead(collapseWs(first), 120)}` : 'ok';
    }
    const kind = classify(text, call);
    if (kind === 'snapshot') return snapshotCondensed(snapshotInfo(text)!);
    if (kind === 'test') {
      const c = condenseTest(text, r.test.maxFailureLines);
      if (c !== null) return c;
    }
    return generic(text);
  };

  return {
    role: (name: string): ToolRole[] => role(name),
    classify,
    snapshotInfo,
    stubText: (info: SnapshotInfo) => snapshotStub(info),
    slimSnapshot: (text, maxTokens, count) => (isSnapshotText(text) ? slimSnapshotText(text, maxTokens, count, roles) : null),
    condense,
    isTestCall,
  };
}

/** ToolRulesFactory (src/engine/contracts.ts). */
export const createToolRules: ToolRulesFactory = (cfg: Config): ToolRules => createToolRulesExt(cfg);
