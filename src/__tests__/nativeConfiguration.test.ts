import { describe, expect, test } from 'bun:test';
import type { PushyConfiguration } from '../../harmony/pushy/src/main/ets/PushyConfiguration';
import { normalizePushyConfiguration } from '../../harmony/pushy/src/main/ets/PushyConfiguration';
import { evalHarmonyModule } from './nativeSources';

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
  const store = evalHarmonyModule(
    'UpdateContext.ts',
    'const store = Object.create(UpdateContext.prototype); store.preferences = preferences; store.flushBatchDepth = 0; store;',
    {
      preferences,
      util: { generateRandomUUID: () => 'native-installation-id' },
      KEY_CONFIG: 'nativeConfig',
      KEY_RESP_CACHE: 'nativeCheckResp',
      recordJsRound: (config: string) => clearedSignals.push(config),
      logger: { error() {} },
      getErrorMessage: (error: unknown) => String(error),
    }
  ) as ConfigStore;
  return {
    store,
    values,
    clearedSignals,
    fail: (value: boolean) => {
      shouldFail = value;
    },
    flushes: () => flushes,
  };
}

describe('native configuration normalization', () => {
  test('appKey alone supplies Pushy endpoints without automatically activating', () => {
    const config = JSON.parse(
      normalizePushyConfiguration({ appKey: 'test-app' })
    );
    expect(config.endpoints).toEqual([
      'https://update.react-native.cn/api',
      'https://update.reactnative.cn/api',
    ]);
    expect(config.queryUrls).toHaveLength(2);
    expect(config.afterDownload).toBe('none');
    expect(config.disabled).toBe(false);
    expect(config.packageVersion).toBeUndefined();
  });

  test('custom endpoints do not inherit public discovery, and are deduplicated', () => {
    const options: PushyConfiguration = {
      appKey: 'test-app',
      endpoints: [
        'https://updates.example/api/',
        'https://updates.example/api',
      ],
      afterDownload: 'setNeedUpdate',
    };
    const original = JSON.stringify(options);
    const config = JSON.parse(normalizePushyConfiguration(options));
    expect(config.endpoints).toEqual(['https://updates.example/api']);
    expect(config.queryUrls).toEqual([]);
    expect(config.afterDownload).toBe('setNeedUpdate');
    expect(JSON.stringify(options)).toBe(original);
  });

  test('allows explicit discovery URLs and version identity overrides', () => {
    const config = JSON.parse(
      normalizePushyConfiguration({
        appKey: 'test-app',
        endpoints: ['http://localhost:8080/api'],
        queryUrls: ['https://updates.example/endpoints.json?v=1'],
        packageVersion: '2.0',
        rn: '0.77.3',
        rnu: 'test-sdk',
        disabled: true,
      })
    );
    expect(config.packageVersion).toBe('2.0');
    expect(config.disabled).toBe(true);
    expect(config.queryUrls[0]).toContain('?v=1');
  });

  for (const [name, options] of [
    ['missing key', {}],
    ['blank key', { appKey: '   ' }],
    ['wrong key type', { appKey: 12 }],
    ['empty endpoints', { appKey: 'a', endpoints: [] }],
    ['null endpoints', { appKey: 'a', endpoints: null }],
    ['non-array endpoints', { appKey: 'a', endpoints: 'https://example.com' }],
    ['unsafe scheme', { appKey: 'a', endpoints: ['file:///tmp/update'] }],
    [
      'credentials',
      { appKey: 'a', endpoints: ['https://user:pass@example.com'] },
    ],
    ['relative URL', { appKey: 'a', endpoints: ['/api'] }],
    ['base query', { appKey: 'a', endpoints: ['https://example.com/api?x=1'] }],
    ['wrong discovery type', { appKey: 'a', queryUrls: [42] }],
    ['wrong activation', { appKey: 'a', afterDownload: 'immediate' }],
    ['wrong disabled type', { appKey: 'a', disabled: 'false' }],
    ['blank package version', { appKey: 'a', packageVersion: '' }],
    ['unknown option', { appKey: 'a', endponts: ['https://example.com'] }],
  ] as const) {
    test(`rejects ${name} before storage is touched`, () => {
      expect(() =>
        normalizePushyConfiguration(options as unknown as PushyConfiguration)
      ).toThrow();
    });
  }
});

describe('actual native configuration store', () => {
  test('configuration invalidates cache and old in-flight commits, even across A-B-A', async () => {
    const h = storeHarness();
    await h.store.setNativeConfig('A');
    const oldGeneration = h.store.getResetGeneration();
    h.values.set('nativeCheckResp', 'stale');
    await h.store.setNativeConfig('B');
    expect(h.values.has('nativeCheckResp')).toBe(false);
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
