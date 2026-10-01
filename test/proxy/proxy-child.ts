// Runs the proxy in its own process for the latency test (bench/README.md: "the proxy runs as a
// child process"): a pass-through fake engine, the test character counter, stats to the given file.
//   node dist/test/proxy/proxy-child.js <upstream origin> <state dir>
// Prints `listening on http://127.0.0.1:<port>` and drains on SIGTERM.
import { join } from 'node:path';
import { createProxyServer, installSignalHandlers } from '../../src/proxy/server.js';
import { StateStore } from '../../src/proxy/state.js';
import { StatsWriter } from '../../src/proxy/stats.js';
import { passthroughEngine } from './fake-engine.js';
import { charCounter, testConfig } from './harness.js';

const [origin, dir] = process.argv.slice(2);
if (!origin || !dir) {
  console.error('usage: proxy-child.js ORIGIN STATE_DIR');
  process.exit(2);
}
const cfg = testConfig({ upstream: { origin }, stateDir: dir, stats: { path: join(dir, 'stats.jsonl') }, calibration: { enabled: false } });
const counter = charCounter();
const proxy = createProxyServer(cfg, {
  engine: passthroughEngine(),
  counter,
  state: new StateStore({ dir, configuredWindow: cfg.budget.window, counterId: counter.id }),
  stats: new StatsWriter(cfg.stats.path),
  faults: null,
});
const { port } = await proxy.listen();
installSignalHandlers(proxy, { drainMs: 5000 });
console.log(`listening on http://127.0.0.1:${port}`);
