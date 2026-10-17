import { sleep } from './harness.js';

/** Polls `predicate` every 10 ms until it holds; throws after `timeoutMs`. For debounced or async writes. */
export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`waitFor: condition not met within ${timeoutMs} ms`);
    await sleep(10);
  }
}
