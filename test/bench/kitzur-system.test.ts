// kitzur as a bench system (bench/systems/kitzur.ts) through the real CLI child process:
//  - F13: the spec agent's beforeStep hook restarts it (SIGTERM / SIGKILL / wiped state dir) and the upstream bodies stay
//    canonically equal to a run without restarts (I5);
//  - the OpenCode HTTP client runs behind it and saves its own request bodies (origs/, client.jsonl), which the metrics
//    collect as the client side (formerly "direct only").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJSON } from '../../src/tokenize/canonical.js';
import { runAgent } from '../../bench/client/agent.js';
import { runOpenCode } from '../../bench/client/opencode.js';
import { PromptCounter } from '../../bench/lib/render.js';
import { collectRunDir } from '../../bench/metrics/collect.js';
import { MockServer } from '../../bench/mock/server.js';
import { buildScenario } from '../../bench/scenarios/index.js';
import { WINDOWS } from '../../bench/scenarios/windows.js';
import { Kitzur, KITZUR_CLI } from '../../bench/systems/kitzur.js';
import { loadTokenizer } from '../../src/tokenize/tokenizer.js';
import { testTokenizerPath } from '../helpers.js';

const tok = testTokenizerPath();
const skip = !tok ? 'no dev tokenizer' : !existsSync(KITZUR_CLI) ? 'dist/src/cli.js not built' : false;

/** Run qa46 at 32k/8k (compactions early) for `steps` steps through kitzur, restarting it before the given steps. */
async function run(root: string, name: string, steps: number, restarts: Map<number, 'sigterm' | 'sigkill' | 'fresh-state'>): Promise<{ restarts: number }> {
  const counter = new PromptCounter(loadTokenizer(tok!));
  const w = WINDOWS['32k'];
  const sc = buildScenario('qa46', '32k');
  const dir = join(root, name);
  const mock = new MockServer({ counter, outDir: dir, limit: w.W, spec: { render: 'sim', ...sc.mock }, scenarios: [sc] });
  await mock.start(0);
  const lean = new Kitzur({ preset: '32k', tokenizer: tok, stateDir: join(dir, 'state') });
  let n = 0;
  try {
    const base = await lean.start(mock.url, dir);
    const r = await runAgent({
      base, counter, outDir: dir, spec: sc, strict: true, maxTokens: w.O, saveOrigs: true, steps,
      beforeStep: async ({ step }) => {
        const kind = restarts.get(step);
        if (!kind) return;
        n++;
        return lean.restart(kind);
      },
    });
    assert.equal(r.error, null, JSON.stringify(r.error));
  } finally {
    await lean.stop();
    await mock.stop();
  }
  return { restarts: n };
}

test('F13: kitzur restarted (sigterm, sigkill, fresh-state) forwards canonically the same bodies as without restarts (I5)', { skip, timeout: 240_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'kitzur-restart-'));
  try {
    const steps = 14;
    await run(root, 'control', steps, new Map());
    const r = await run(root, 'restarted', steps, new Map([[4, 'sigterm'], [8, 'sigkill'], [11, 'fresh-state']]));
    assert.equal(r.restarts, 3);
    const counter = new PromptCounter(loadTokenizer(tok!));
    const sc = buildScenario('qa46', '32k');
    const view = (d: string): string[] =>
      collectRunDir(join(root, d), { counter, facts: sc.facts, steps: { [sc.sessions[0]!.id]: steps } }).up.map((u) => canonicalJSON(u.digests));
    const a = view('control');
    const b = view('restarted');
    assert.ok(a.length >= steps);
    assert.deepEqual(b, a, 'divergence must be 0');
    const ctl = collectRunDir(join(root, 'control'), { counter, facts: sc.facts, steps: { [sc.sessions[0]!.id]: steps } });
    const rewrites = ctl.up.filter((u, i) => i > 0 && u.digests.length < ctl.up[i - 1]!.digests.length).length;
    assert.ok(rewrites >= 1, 'the window is small enough that kitzur compacted inside the restarted range');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the OpenCode client behind kitzur saves its request bodies; the run dir yields client and upstream records', { skip, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'kitzur-oc-'));
  try {
    const counter = new PromptCounter(loadTokenizer(tok!));
    const w = WINDOWS['100k'];
    const sc = buildScenario('qa46-ref', '100k');
    const mock = new MockServer({ counter, outDir: root, limit: w.W, spec: { render: 'sim', ...sc.mock }, scenarios: [sc] });
    await mock.start(0);
    const lean = new Kitzur({ preset: '100k', tokenizer: tok, stateDir: join(root, 'state') });
    try {
      const base = await lean.start(mock.url, root);
      const r = await runOpenCode({ base, counter, spec: sc, session: sc.sessions[0]!.id, mode: 'faithful', context: w.W, output: w.O, outDir: root, steps: 6 });
      assert.equal(r.error, null);
      assert.equal(r.stepsCompleted, 6);
    } finally {
      await lean.stop();
      await mock.stop();
    }
    assert.ok(readdirSync(join(root, 'origs')).length >= 7, 'one orig per request (6 main + 1 title)');
    const rr = collectRunDir(root, { counter, facts: sc.facts, steps: { [sc.sessions[0]!.id]: 6 } });
    const main = rr.client.filter((c) => c.kind === 'main');
    assert.equal(main.length, 6);
    assert.ok(main.every((c) => c.digests.length > 0 && c.prompt !== null && c.clientErrorKind === null));
    assert.equal(rr.client.filter((c) => c.kind === 'title').length, 1);
    // kitzur passed everything through below its trigger: the upstream main bodies equal the client's
    const up = rr.up.filter((u) => u.kind === 'main');
    assert.deepEqual(up.map((u) => u.digests), main.map((c) => c.digests));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
