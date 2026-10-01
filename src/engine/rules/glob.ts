// Tool-name globs (DESIGN.md): `*` is the only wildcard, the rest is literal; matching is case-insensitive
// and anchored. The defaults match by suffix because OpenCode prefixes MCP tools with `<server>_`
// (playwright_browser_snapshot) while other clients send the bare name (browser_snapshot).
import type { Config } from '../../config/schema.js';

export type ToolRole = keyof Config['rules']['toolNames'];

export function globToRegExp(glob: string): RegExp {
  const src = glob
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${src}$`, 'i');
}

/** name -> the roles whose globs match it, in the key order of rules.toolNames. Results are memoized. */
export function roleMatcher(toolNames: Config['rules']['toolNames']): (name: string) => ToolRole[] {
  const table = (Object.keys(toolNames) as ToolRole[]).map((role) => ({ role, res: toolNames[role].map(globToRegExp) }));
  const memo = new Map<string, ToolRole[]>();
  return (name: string): ToolRole[] => {
    let r = memo.get(name);
    if (r === undefined) {
      r = table.filter((t) => t.res.some((re) => re.test(name))).map((t) => t.role);
      if (memo.size > 4096) memo.clear();
      memo.set(name, r);
    }
    return r.slice();
  };
}
