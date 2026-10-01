// Playwright MCP snapshot results (DESIGN.md, §5.6 step 1, ): detection by content, page info,
// the superseded-snapshot stub and slimming.
//
// A Playwright MCP result looks like (OpenCode may cut it at 50 KB and append its truncation notice):
//
//   ### Open tabs                                   (only with more than one tab)
//   - 0: [Checkout - Shop] (https://shop/checkout/cart)
//   - 1: (current) [Payment] (https://shop/checkout/payment)
//
//   ### Page state
//   - Page URL: https://shop/checkout/payment
//   - Page Title: Payment
//   - Page Snapshot:
//   ```yaml
//   - generic [ref=e1]:
//     - link "Cart" [ref=e5] [cursor=pointer]:
//       - /url: /cart
//     - textbox "Email" [ref=e9]
//   ```
//   ...28886 bytes truncated...
//   The tool call succeeded but the output was truncated. Full output saved to: /users/example/.local/share/opencode/tool-output/tool_…
import type { SnapshotInfo } from '../contracts.js';
import { maxFitting } from '../ledger/fit.js';

const SNAPSHOT_MARK = '- Page Snapshot:';
const REF = '[ref=';

/** Number of `[ref=` markers. */
export function countRefs(text: string): number {
  let n = 0;
  for (let i = text.indexOf(REF); i >= 0; i = text.indexOf(REF, i + REF.length)) n++;
  return n;
}

/** : a result with `- Page Snapshot:` or at least 10 `[ref=` markers is a snapshot, whatever produced it. */
export function isSnapshotText(text: string): boolean {
  if (text.includes(SNAPSHOT_MARK)) return true;
  let n = 0;
  for (let i = text.indexOf(REF); i >= 0; i = text.indexOf(REF, i + REF.length)) if (++n >= 10) return true;
  return false;
}

/**
 * Line-anchored  detection for the result of a file tool (read / edit / write): the marker and the `[ref=` lines
 * count only where Playwright prints them, at the start of a line (after an optional line-number gutter, as
 * OpenCode's `00001| `, Kilo's `1 | ` or `1→`). A source file that mentions `'- Page Snapshot:'` in a string or a
 * comment (this very file) is file content, not a page: classified as a snapshot it lost its excerpt in the tool
 * log and became a stub "take a new browser_snapshot" once any later snapshot superseded it. A saved snapshot
 * read back from disk (`Full output saved to: …`) still is one.
 */
// unambiguous (no backtracking between the two runs of blanks, so a line of 100k spaces stays linear)
const GUTTER = '^[ \\t]*(?:\\d+[ \\t]*(?:\\||:|\u2192)[ \\t]*)?';
const MARK_LINE = new RegExp(`${GUTTER}- Page Snapshot:`, 'm');
const REF_LINE = new RegExp(`${GUTTER}- [^\\n]*\\[ref=`, 'gm');
export function isSnapshotFileText(text: string): boolean {
  if (text.includes(SNAPSHOT_MARK) && MARK_LINE.test(text)) return true;
  if (!text.includes(REF)) return false;
  let n = 0;
  REF_LINE.lastIndex = 0;
  while (REF_LINE.exec(text) !== null) if (++n >= 10) return true;
  return false;
}

export interface OpenTab {
  index: number;
  current: boolean;
  title: string;
  url: string;
}

/**
 * The `### Open tabs` block: `- 0: (current) [Title] (url)`, also the markdown-link form `[Title](url)` and
 * 1-based older numbering as written. Returns [] when the result has no such block.
 */
export function parseOpenTabs(text: string): OpenTab[] {
  const at = text.indexOf('### Open tabs');
  if (at < 0) return [];
  const out: OpenTab[] = [];
  const lines = text.slice(at).split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('### ')) break;
    const m = /^\s*-\s*(\d+):\s*(\(current\)\s*)?\[(.*)\]\s*\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)\s*$/.exec(line);
    if (m) out.push({ index: Number(m[1]), current: m[2] !== undefined, title: m[3]!, url: m[4]! });
  }
  return out;
}

const lineValue = (text: string, key: string): string | null => {
  // `[^\\S\\n]*` keeps the indentation on one line (with /m, `^\\s*` is quadratic on runs of blank lines)
  const re = new RegExp(`^[^\\S\\n]*- ${key}:[ \\t]*(.*)$`, 'm');
  const m = re.exec(text);
  return m ? m[1]!.trim() : null;
};

/** OpenCode's truncation notice `Full output saved to: <path>` (Kilo: the same wording). */
export function savedOutputPath(text: string): string | null {
  const m = /Full output saved to:\s*(\S+)/.exec(text);
  if (!m) return null;
  // a loop, not /[.,;)]+$/ (quadratic on a long punctuation run inside the token)
  let e = m[1]!.length;
  while (e > 0 && '.,;)'.includes(m[1]![e - 1]!)) e--;
  return m[1]!.slice(0, e);
}

/** URL, title, refs and saved path of a snapshot result; null when the text is not a snapshot (). */
export function snapshotInfo(text: string): SnapshotInfo | null {
  if (!isSnapshotText(text)) return null;
  let url = lineValue(text, 'Page URL');
  let title = lineValue(text, 'Page Title');
  if (url === null || title === null) {
    const cur = parseOpenTabs(text).find((t) => t.current);
    if (cur) {
      url ??= cur.url;
      title ??= cur.title;
    }
  }
  return { url: url || null, title, refs: countRefs(text), savedPath: savedOutputPath(text) };
}

/** §7: the text that replaces a superseded snapshot result. */
export function snapshotStub(info: SnapshotInfo): string {
  return `[superseded snapshot: ${info.url ?? 'unknown URL'} — "${info.title ?? ''}", ${info.refs} refs; take a new browser_snapshot for current refs]`;
}

/** §6.3: the condensed form of a snapshot in the summary tool log. */
export function snapshotCondensed(info: SnapshotInfo): string {
  return info.url !== null ? `[snapshot: ${info.url} — "${info.title ?? ''}", ${info.refs} refs]` : `[snapshot: ${info.refs} refs]`;
}

/** : the marker appended to a slimmed snapshot. It must not invite a re-snapshot. */
export function slimMarker(kept: number, total: number, savedPath: string | null): string {
  const tail = savedPath
    ? `Full output: ${savedPath}; use grep/Read on it or browser_evaluate for specific text.`
    : 'Use browser_evaluate for specific text.';
  return (
    `[kitzur: snapshot slimmed to fit this model's context: kept ${kept} of ${total} elements (interactive and headings); ` +
    `text of other elements omitted. Re-requesting the snapshot will not show more. ${tail}]`
  );
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const TREE_LINE = /^\s*- /;
const HEADER_LINE = /^\s*- Page (?:URL|Title|Snapshot):/;

/**
 * §5.6 step 1 (). Keeps the page-state header (`### Page state`, `- Page URL/Title/Snapshot:` and the yaml
 * fences, the `### Open tabs` block), OpenCode's `Full output saved to:` line, every element line with a `[ref=`
 * whose role is in `roles`, and then, in document order while `count` stays within `maxTokens`, the kept
 * elements' direct `- text:` and `- /url:` child lines. Everything else (other elements, console messages, the
 * executed code, the rest of the truncation notice) is dropped. Indentation is kept; the marker is appended after
 * a blank line. Returns null when even the header, elements and marker exceed `maxTokens`.
 */
export function slimSnapshotText(
  text: string,
  maxTokens: number,
  count: (s: string) => number,
  roles: ReadonlySet<string>,
): string | null {
  const lines = text.split('\n');
  // the tree region: after "- Page Snapshot:" (and its ``` fence) while lines are list items; without the
  // marker (a snapshot detected by its refs alone), every list-item line except the page-state header
  let inTree: (i: number) => boolean;
  const header = new Set<number>();
  const snapAt = lines.findIndex((l) => l.trimStart().startsWith(SNAPSHOT_MARK));
  if (snapAt >= 0) {
    let start = snapAt + 1;
    if (start < lines.length && /^\s*```/.test(lines[start]!)) header.add(start++);
    let end = start;
    while (end < lines.length && TREE_LINE.test(lines[end]!)) end++;
    if (end < lines.length && /^\s*```\s*$/.test(lines[end]!)) header.add(end);
    inTree = (i) => i >= start && i < end;
  } else {
    inTree = (i) => TREE_LINE.test(lines[i]!) && !HEADER_LINE.test(lines[i]!);
  }
  let tabs = false;
  lines.forEach((l, i) => {
    if (inTree(i)) return;
    if (/^#{2,4} Open tabs\b/.test(l)) tabs = true;
    else if (/^#{2,4} /.test(l) || !l.trim()) tabs = false;
    if (/^#{2,4} (?:Page state|Page|Open tabs)\s*$/.test(l) || HEADER_LINE.test(l) || l.includes('Full output saved to:') || (tabs && /^\s*- \d+:/.test(l))) {
      header.add(i);
    }
  });

  const keep = new Array<boolean>(lines.length).fill(false);
  const children: number[] = []; // candidate child lines, document order
  let total = 0;
  let kept = 0;
  // one pass with a stack of open ancestors: a line's parent is the nearest earlier tree line indented less
  const stack: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!inTree(i)) {
      keep[i] = header.has(i);
      continue;
    }
    const line = lines[i]!;
    const d = indentOf(line);
    while (stack.length > 0 && indentOf(lines[stack[stack.length - 1]!]!) >= d) stack.pop();
    const parent = stack.length > 0 ? stack[stack.length - 1]! : -1;
    stack.push(i);
    if (!line.includes(REF)) {
      // a direct `- text:` / `- /url:` child of a kept element
      if (parent >= 0 && keep[parent] && /^\s*- (?:text|\/url):/.test(line)) children.push(i);
      continue;
    }
    total++;
    // Playwright's yaml writer single-quotes a key that needs it, e.g. a name with ": " in it:
    // `- 'link "Step 1: Shipping" [ref=e5] [cursor=pointer]':` is still a link
    const role = /^\s*- '?([A-Za-z][\w-]*)/.exec(line)?.[1]?.toLowerCase();
    if (role === undefined || !roles.has(role)) continue;
    keep[i] = true;
    kept++;
  }
  const savedPath = savedOutputPath(text);
  const marker = slimMarker(kept, total, savedPath);
  const build = (nChildren: number): string => {
    const k = keep.slice();
    for (let c = 0; c < nChildren; c++) k[children[c]!] = true;
    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) if (k[i]) out.push(lines[i]!);
    while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
    out.push('', marker);
    return out.join('\n');
  };
  const base = build(0);
  if (count(base) > maxTokens) return null;
  if (children.length === 0) return base;
  // estimate the children that fit at the base text's tokens-per-char ratio, then settle it with exact counts
  const baseTokens = count(base);
  const ratio = baseTokens / Math.max(1, base.length);
  let room = maxTokens - baseTokens;
  let guess = 0;
  for (const j of children) {
    room -= Math.ceil((lines[j]!.length + 1) * ratio);
    if (room < 0) break;
    guess++;
  }
  const n = maxFitting(0, children.length, guess, (k) => count(build(k)) <= maxTokens);
  return build(n);
}
