import { describe, expect, test } from 'bun:test';
import {
  evalHarmonyModule,
  harmonyConfigBindings,
  harmonyStoreSchema,
} from './nativeSources';

// Option validation (normalizePushyConfiguration) is the shared core's
// NormalizeConfiguration, covered by cpp/update_flow_core/tests/
// native-config-vectors.json; this file exercises the Harmony store around it.

interface ConfigStore {
  setNativeConfig: (config: string) => Promise<void>;
  getResetGeneration: () => number;
  commitSyncResult: (
    generation: number,
    hash: string,
    info: string,
    activate: boolean,
    cache: string
  ) => Promise<boolean>;
}

function storeHarness() {
  const values = new Map<string, string>();
  const cacheValues = new Map<string, string>();
  let flushes = 0;
  let shouldFail = false;
  const clearedSignals: string[] = [];
  const preferences = {
    getSync: (key: string, fallback: string) => values.get(key) ?? fallback,
    putSync: (key: string, value: string) => values.set(key, value),
    deleteSync: (key: string) => values.delete(key),
    flush: async () => {
      flushes++;
      if (shouldFail) throw new Error('storage unavailable');
    },
  };
  const cachePreferences = {
    getSync: (key: string, fallback: string) =>
      cacheValues.get(key) ?? fallback,
    putSync: (key: string, value: string) => cacheValues.set(key, value),
    deleteSync: (key: string) => cacheValues.delete(key),
    flush: async () => {
      if (shouldFail) throw new Error('storage unavailable');
    },
  };
  const store = evalHarmonyModule(
    'UpdateContext.ts',
    `const store = Object.create(UpdateContext.prototype);
     store.preferences = preferences;
     store.cachePreferences = cachePreferences;
     store.flushBatchDepth = 0;
     store;`,
    {
      ...harmonyStoreSchema(),
      preferences,
      cachePreferences,
      util: { generateRandomUUID: () => 'native-installation-id' },
      recordJsRound: (config: string) => clearedSignals.push(config),
      logger: { error() {} },
      getErrorMessage: (error: unknown) => String(error),
      NativePatchCore: harmonyConfigBindings,
    }
  ) as ConfigStore;
  return {
    store,
    values,
    cacheValues,
    clearedSignals,
    fail: (value: boolean) => {
      shouldFail = value;
    },
    // The state store's flushes.
    flushes: () => flushes,
  };
}

describe('actual native configuration store', () => {
  test('configuration invalidates cache and old in-flight commits, even across A-B-A', async () => {
    const h = storeHarness();
    await h.store.setNativeConfig('A');
    const oldGeneration = h.store.getResetGeneration();
    h.cacheValues.set('nativeCheckResp', 'stale');
    await h.store.setNativeConfig('B');
    expect(h.cacheValues.has('nativeCheckResp')).toBe(false);
    await h.store.setNativeConfig('A');
    expect(h.store.getResetGeneration()).toBe(oldGeneration + 2);
    expect(
      await h.store.commitSyncResult(oldGeneration, 'old', '{}', true, 'stale')
    ).toBe(false);
    expect(h.values.has('hash_old')).toBe(false);
    expect(h.values.get('uuid')).toBe('native-installation-id');
    expect(h.clearedSignals).toEqual(['', '', '']);
  });

  test('identical configuration is idempotent but still confirms persistence', async () => {
    const h = storeHarness();
    await h.store.setNativeConfig('A');
    const generation = h.store.getResetGeneration();
    await h.store.setNativeConfig('A');
    expect(h.store.getResetGeneration()).toBe(generation);
    expect(h.flushes()).toBe(2);
  });

  test('storage errors reject and an equal-value retry can recover', async () => {
    const h = storeHarness();
    h.fail(true);
    await expect(h.store.setNativeConfig('A')).rejects.toThrow(
      'storage unavailable'
    );
    h.fail(false);
    await h.store.setNativeConfig('A');
    expect(h.flushes()).toBe(2);
  });
});
