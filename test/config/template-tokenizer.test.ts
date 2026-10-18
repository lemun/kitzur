import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/config/load.js';
import { validateConfig } from '../../src/config/validate.js';
import { doctor } from '../../src/diagnostics/doctor.js';
import { ROOT } from '../helpers.js';

// Minimal byte-level BPE: no development tokenizer download is needed.
function fixture(tokens: string[]): string {
  const bytes = Array.from({ length: 256 }, (_, i) => i);
  const visible = bytes.filter(b => (b >= 33 && b <= 126) || (b >= 161 && b <= 172) || b >= 174);
  let extra = 256;
  const vocab = Object.fromEntries(bytes.map(b => [String.fromCharCode(visible.includes(b) ? b : extra++), b]));
  return JSON.stringify({
    model: { type: 'BPE', vocab, merges: [] },
    pre_tokenizer: { type: 'Sequence', pretokenizers: [
      { type: 'Split', pattern: { Regex: '\\s+' }, behavior: 'Isolated', invert: false },
      { type: 'ByteLevel', use_regex: false, add_prefix_space: false },
    ] },
    added_tokens: tokens.map((content, i) => ({ content, id: 256 + i, special: true })),
  });
}

test('validation and doctor warn about missing template tokens, without rejecting the config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kitzur-template-'));
  try {
    const cfg = defaultConfig();
    cfg.tokenizer.path = join(dir, 'tokenizer.json');
    const qwen = ['<|im_start|>', '<|im_end|>', '<think>', '</think>'];
    writeFileSync(cfg.tokenizer.path, fixture(qwen.filter(t => t !== '<|im_start|>')));
    const result = validateConfig(cfg, { checkFiles: true });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some(w => /qwen3.*<\|im_start\|>/.test(w)), result.warnings.join('\n'));
    assert.ok(!validateConfig(cfg).warnings.some(w => /missing.*tokens/.test(w)), 'file checks are opt-in');
    const report = await doctor(cfg);
    const warning = report.checks.find(c => c.code === 'tokenizer.template');
    assert.equal(warning?.status, 'warn');
    assert.match(warning?.message ?? '', /qwen3.*<\|im_start\|>/);
    assert.equal(report.exitCode, 0);
    writeFileSync(cfg.tokenizer.path, fixture(qwen));
    assert.ok(!validateConfig(cfg, { checkFiles: true }).warnings.some(w => /missing.*tokens/.test(w)));
    assert.equal((await doctor(cfg)).checks.find(c => c.code === 'tokenizer.template'), undefined);
    for (const name of ['sim', 'chatml', 'generic'] as const) {
      cfg.tokenizer.template.name = name;
      writeFileSync(cfg.tokenizer.path, fixture(name === 'generic' ? [] : ['<|im_start|>', '<|im_end|>']));
      assert.ok(!validateConfig(cfg, { checkFiles: true }).warnings.some(w => /missing.*tokens/.test(w)), name);
    }
    cfg.tokenizer.template.name = 'qwen3';
    cfg.tokenizer.mode = 'estimate';
    assert.ok(!validateConfig(cfg, { checkFiles: true }).warnings.some(w => /missing.*tokens/.test(w)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('security documentation discloses the verbatim client session ID in stats', () => {
  const doc = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8');
  const row = doc.split('\n').find(line => line.startsWith('| `stats.path`')) ?? '';
  assert.match(row, /client_session.*x-session-id.*verbatim/);
  assert.doesNotMatch(row, /No:.*sizes only/);
});
