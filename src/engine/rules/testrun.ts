// Test-runner results (DESIGN.md "test"): recognized by the shell command (rules.test.commands) or by
// content (`N passed` / `N failed` / `Tests:`); condensed to the failure lines plus the final tally.
import { capHead, collapseWs } from '../ledger/text.js';

const FAILURE_LINE = /✘|✗|\bFAIL\b|Error:|expected|AssertionError|Timed out/i;
const TALLY_LINE = /\b\d+\s+(?:passed|failed|flaky|skipped|passing|failing|pending|errors?|did not run)\b|^\s*Tests?:\s/i;
// `[^\S\n]*`, not `\s*`: with /m, `^\s*` rescans a whole run of blank lines from every line start (quadratic:
// 37 s on an output of 80,000 blank lines)
const CONTENT_TEST = /\b\d+ (?:passed|failed)\b|^[^\S\n]*Tests:/m;
const FAILURE_LINE_MAX = 200;
/**
 * One line of Playwright's tally block. Its list/line/dot reporters print one count line per outcome, each followed
 * by the affected tests indented deeper, and end with the passed count:
 *   `  2 failed` / `    [chromium] › promo.spec.ts:44:5 › …` / `  1 flaky` / `    …` / `  11 passed (45.2s)`
 */
const PW_COUNT_LINE = /^\s*\d+\s+(?:passed|failed|flaky|skipped|interrupted|did not run)(?:\s*\([^)]*\))?\s*$/i;
const indentOf = (l: string): number => l.length - l.trimStart().length;

/** `rules.test.maxFailureLines` failure lines (trimmed, capped) and the final tally line of a test output. */
export interface TestSummary {
  failures: string[];
  tally: string | null;
}

/**
 * The last line that looks like a tally (`12 passed, 2 failed`, jest `Tests:`), trimmed; null if none. When that
 * line ends a Playwright tally block, the block's count lines are joined in order (`2 failed, 1 flaky, 11 passed
 * (45.2s)`), so the failed count is not lost behind the final passed line.
 */
export function tallyLine(text: string): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.length >= 400 || !TALLY_LINE.test(l)) continue;
    if (!PW_COUNT_LINE.test(l)) return collapseWs(l);
    const parts = [collapseWs(l)];
    const d = indentOf(l);
    for (let j = i - 1; j >= 0; j--) {
      const p = lines[j]!;
      if (!p.trim()) break;
      if (indentOf(p) > d) continue; // the tests listed under a count line
      if (indentOf(p) === d && p.length < 400 && PW_COUNT_LINE.test(p)) parts.unshift(collapseWs(p));
      else break;
    }
    return parts.join(', ');
  }
  return null;
}

export function summarizeTest(text: string, maxFailureLines: number): TestSummary {
  const failures: string[] = [];
  const tally = tallyLine(text);
  if (maxFailureLines > 0) {
    for (const l of text.split('\n')) {
      if (!FAILURE_LINE.test(l)) continue;
      const c = collapseWs(l);
      if (!c || c === tally) continue;
      failures.push(capHead(c, FAILURE_LINE_MAX));
      if (failures.length >= maxFailureLines) break;
    }
  }
  return { failures, tally };
}

/** Condensed test result: failure lines then the tally, joined with "; ". */
export function condenseTest(text: string, maxFailureLines: number): string | null {
  const s = summarizeTest(text, maxFailureLines);
  const parts = [...s.failures];
  if (s.tally) parts.push(s.tally);
  return parts.length ? parts.join('; ') : null;
}

export function isTestContent(text: string): boolean {
  return CONTENT_TEST.test(text);
}

/** rules.test.commands, compiled case-insensitively (a bad pattern is a configuration error). */
export function testCommandMatcher(pattern: string): (cmd: string) => boolean {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (e) {
    throw new Error(`rules.test.commands is not a valid regular expression: ${(e as Error).message}`);
  }
  return (cmd) => re.test(cmd);
}
