// OpenCode-shaped messages for the ledger, rules and summary tests (reference implementation, §2.5, §4;
// reference implementation): tool-call-only assistants carry content "" (Kilo: null), arguments are compact
// JSON.stringify output, MCP tools are prefixed `playwright_`, results are plain strings.
import type { ChatMessage, ToolCall } from '../../src/types.js';
import { DEFAULT_CONFIG, type Config } from '../../src/config/schema.js';

export const cfg = (): Config => structuredClone(DEFAULT_CONFIG);

let seq = 0;
export const resetIds = (): void => {
  seq = 0;
};
export const call = (name: string, args: unknown, id?: string): ToolCall => ({
  id: id ?? `call_${String(++seq).padStart(4, '0')}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

export const sys = (text = 'You are a browser automation coding agent.'): ChatMessage => ({ role: 'system', content: text });
export const user = (text: string): ChatMessage => ({ role: 'user', content: text });
export const assistant = (text: string, calls: ToolCall[] = [], extra: Partial<ChatMessage> = {}): ChatMessage =>
  calls.length ? { role: 'assistant', content: text, tool_calls: calls, ...extra } : { role: 'assistant', content: text, ...extra };
export const tool = (c: ToolCall, content: string): ChatMessage => ({ role: 'tool', tool_call_id: c.id, content });

/** A unit: assistant + one result per call. */
export function unit(text: string, calls: Array<[ToolCall, string]>, extra: Partial<ChatMessage> = {}): ChatMessage[] {
  return [assistant(text, calls.map(([c]) => c), extra), ...calls.map(([c, out]) => tool(c, out))];
}

/** OpenCode's truncation notice (tool/truncate.ts, head direction). */
export const opencodeNotice = (removed: number, file: string): string =>
  `\n\n...${removed} bytes truncated...\n\nThe tool call succeeded but the output was truncated. Full output saved to: ${file}\n` +
  'Use Grep to search the full content or Read with offset/limit to view specific sections.';

/** A Playwright MCP snapshot result with page state, optional open tabs and optional OpenCode truncation. */
export function mcpSnapshot(o: {
  url: string;
  title: string;
  tabs?: Array<{ url: string; title: string; current?: boolean }>;
  elements?: number;
  truncatedTo?: string | null;
  code?: string;
}): string {
  const out: string[] = [];
  if (o.code) out.push('### Ran Playwright code', '```js', o.code, '```', '');
  if (o.tabs && o.tabs.length > 1) {
    out.push('### Open tabs');
    o.tabs.forEach((t, i) => out.push(`- ${i}:${t.current ? ' (current)' : ''} [${t.title}] (${t.url})`));
    out.push('');
  }
  out.push('### Page state', `- Page URL: ${o.url}`, `- Page Title: ${o.title}`, '- Page Snapshot:', '```yaml');
  out.push('- generic [active] [ref=e1]:');
  out.push('  - banner [ref=e2]:');
  out.push('    - link "Shop home" [ref=e3] [cursor=pointer]:');
  out.push('      - /url: /');
  out.push('      - img "Shop logo" [ref=e4]');
  out.push('    - navigation [ref=e5]:');
  out.push('      - link "Cart (2)" [ref=e6] [cursor=pointer]:');
  out.push('        - /url: /checkout/cart');
  out.push('  - main [ref=e7]:');
  out.push('    - heading "Checkout" [level=1] [ref=e8]');
  let ref = 9;
  const n = o.elements ?? 12;
  for (let i = 0; i < n; i++) {
    out.push(`    - paragraph [ref=e${ref++}]: Delivery estimate for item ${i} is three to five business days`);
    out.push(`    - textbox "Promo code ${i}" [ref=e${ref++}]:`);
    out.push(`      - text: SAVE${i}`);
    out.push(`    - button "Apply ${i}" [ref=e${ref++}] [cursor=pointer]`);
    out.push(`    - cell "$${i}.99" [ref=e${ref++}]`);
  }
  out.push('```');
  let text = out.join('\n');
  if (o.truncatedTo) text = text.slice(0, Math.floor(text.length * 0.7)).replace(/\n[^\n]*$/, '') + opencodeNotice(12345, o.truncatedTo);
  return text;
}

/** Playwright test runner output (line reporter), with ✓/✘ lines and the final tally. */
export function playwrightOutput(passed: number, failed: Array<{ spec: string; line: number }>): string {
  const lines = [`Running ${passed + failed.length} tests using 4 workers`, ''];
  for (let i = 0; i < passed; i++) lines.push(`  ✓  ${i + 1} [chromium] › checkout/cart.spec.ts:${10 + i}:5 › cart step ${i} (812ms)`);
  failed.forEach((f, i) => {
    lines.push(`  ✘  ${passed + i + 1} [chromium] › ${f.spec}:${f.line}:5 › promo banner (5021ms)`);
    lines.push('    Error: Timed out 5000ms waiting for expect(locator).toBeVisible()');
    lines.push(`    Locator: getByTestId('promo-banner')`);
    lines.push(`    at tests/e2e/${f.spec}:${f.line}`);
  });
  lines.push('');
  lines.push(failed.length ? `  ${passed} passed, ${failed.length} failed` : `  ${passed} passed`);
  return lines.join('\n');
}

export const CONTINUE_SHORT = 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';
