import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, freshLearnedEntry } from '../../src/proxy/state.js';

const temp = (): string => mkdtempSync(join(tmpdir(), 'kitzur-model-state-'));
const identities: Record<string, { configuredWindow: number; counterId: string }> = {
  'gateway|a': { configuredWindow: 128_000, counterId: 'counter-a' },
  'gateway|b': { configuredWindow: 200_000, counterId: 'counter-b' },
};
const identityFor = (key: string) => identities[key] ?? { configuredWindow: 100_000, counterId: 'root' };

test('learned entries for models with different identities survive restart', async () => {
  const dir = temp();
  const first = new StateStore({ dir, configuredWindow: 100_000, counterId: 'root', identityFor });
  first.set('gateway|a', { ...freshLearnedEntry(128_000, 'counter-a'), window: 110_000 });
  first.set('gateway|b', { ...freshLearnedEntry(200_000, 'counter-b'), window: 180_000 });
  await first.close();

  const restarted = new StateStore({ dir, configuredWindow: 100_000, counterId: 'root', identityFor });
  assert.deepEqual(restarted.discarded, []);
  assert.equal(restarted.entry('gateway|a').window, 110_000);
  assert.equal(restarted.entry('gateway|b').window, 180_000);
});

test('only keys with changed window or counter identity are discarded', async () => {
  const dir = temp();
  const first = new StateStore({ dir, configuredWindow: 100_000, counterId: 'root', identityFor });
  for (const key of Object.keys(identities)) first.set(key, { ...first.entry(key), window: 75_000 });
  await first.close();

  const changed = new StateStore({
    dir,
    configuredWindow: 100_000,
    counterId: 'root',
    identityFor: (key) => key === 'gateway|a'
      ? { configuredWindow: 128_000, counterId: 'changed-counter' }
      : identityFor(key),
  });
  assert.deepEqual(changed.discarded, ['gateway|a']);
  assert.equal(changed.entry('gateway|a').window, null);
  assert.equal(changed.entry('gateway|b').window, 75_000);
  assert.deepEqual(changed.entry('gateway|a').counterId, 'changed-counter');

  const windowChanged = new StateStore({
    dir,
    configuredWindow: 100_000,
    counterId: 'root',
    identityFor: (key) => key === 'gateway|b'
      ? { configuredWindow: 201_000, counterId: 'counter-b' }
      : identityFor(key),
  });
  assert.deepEqual(windowChanged.discarded, ['gateway|b']);
});

test('legacy learned.json keeps its format and default constant identity', async () => {
  const dir = temp();
  const legacy = { version: 2, entries: { old: { ...freshLearnedEntry(100_000, 'root'), samples: 3 } } };
  const path = join(dir, 'learned.json');
  const original = `${JSON.stringify(legacy, null, 1)}\n`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, original);
  const store = new StateStore({ dir, configuredWindow: 100_000, counterId: 'root' });
  assert.equal(store.entry('old').samples, 3);
  assert.equal(store.entry('new').configuredWindow, 100_000);
  assert.deepEqual(store.discarded, []);
  assert.equal(readFileSync(path, 'utf8'), original);
});
