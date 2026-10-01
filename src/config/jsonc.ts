// JSON with comments, for config and preset files: `// line` and `/* block */` comments and trailing
// commas are removed outside strings, then the text is parsed with JSON.parse. Errors carry the file
// name and the line:column of the failure.

/** Removes comments and trailing commas outside JSON strings. Line breaks are kept, so positions map 1:1 to lines. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      // copy a string literal verbatim (escapes included)
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      // keep newlines so line numbers in parse errors stay right
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === ',') {
      // drop the comma when only whitespace/comments separate it from a closing bracket
      let j = i + 1;
      for (;;) {
        while (j < n && /\s/.test(text[j]!)) j++;
        if (text[j] === '/' && text[j + 1] === '/') {
          while (j < n && text[j] !== '\n') j++;
        } else if (text[j] === '/' && text[j + 1] === '*') {
          const end = text.indexOf('*/', j + 2);
          j = end < 0 ? n : end + 2;
        } else break;
      }
      out += text[j] === '}' || text[j] === ']' ? ' ' : ',';
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * A JSON.parse error of `text` without any of the text: newer V8 quotes up to 21 characters of the input
 * around an unexpected token (`Unexpected token 'B', ..."rization":Bearer SK-"... is not valid JSON`), which
 * would print a mistyped header value (a credential) or a captured prompt. Returns the reason and, when the
 * message lets us find it, the 0-based position of the failure.
 */
export function jsonErrorInfo(message: string, text: string): { reason: string; pos: number | null } {
  const msg = message.split('\n')[0]!;
  // V8: GetErrorMessageWithEllipses (10 characters of context on each side; the whole input when <= 21 chars)
  const m = /^Unexpected token '([\s\S])', ([\s\S]*) is not valid JSON$/.exec(msg);
  if (m) {
    let snip = m[2]!;
    const lead = snip.startsWith('...');
    if (lead) snip = snip.slice(3);
    const trail = snip.endsWith('...');
    if (trail) snip = snip.slice(0, -3);
    if (snip.startsWith('"') && snip.endsWith('"') && snip.length >= 2) snip = snip.slice(1, -1);
    let pos: number | null = null;
    const at = text.indexOf(snip);
    if (at >= 0) pos = lead ? at + 10 : trail ? at + snip.length - 10 : Math.max(0, text.indexOf(m[1]!));
    return { reason: 'unexpected character', pos };
  }
  const p = /position (\d+)/.exec(msg);
  // every other V8 / Node 20 message is content-free; drop any double-quoted span all the same
  const reason = msg.replace(/\s*\(line \d+ column \d+\)/, '').replace(/ (?:in JSON )?at position \d+/, '').replace(/"[\s\S]*"/, '…').trim();
  return { reason: reason || 'invalid JSON', pos: p ? Number(p[1]) : null };
}

/** 1-based line and column of a 0-based position. */
export function lineCol(text: string, pos: number): { line: number; col: number } {
  const before = text.slice(0, pos);
  return { line: before.split('\n').length, col: pos - before.lastIndexOf('\n') };
}

/** Parses JSONC. Throws an Error "<source>:<line>:<col>: invalid JSON (<reason>)" that never quotes the text. */
export function parseJsonc(text: string, source = 'config'): unknown {
  const body = stripJsonc(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  try {
    return JSON.parse(body) as unknown;
  } catch (e) {
    const { reason, pos } = jsonErrorInfo((e as Error).message, body);
    let where = '';
    if (pos !== null) {
      const { line, col } = lineCol(body, pos);
      where = `:${line}:${col}`;
    }
    throw new Error(`${source}${where}: invalid JSON (${reason})`);
  }
}
