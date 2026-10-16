import { describe, expect, test } from 'bun:test';
import { storedItems } from '../../scripts/contract';
import { evalHarmonyModule } from './nativeSources';

// What a reset to the packaged bundle and a binary upgrade delete on Harmony:
// the generated lists (scripts/contract.ts storedItems) through the actual
// UpdateContext.removeKeys, against a store holding every kind of key.

interface ClearedKeys {
  keys: string[];
  prefixes: string[];
}

function lifecycleHarness() {
  const values = new Map<string, string>([
    ['uuid', 'installation-id'],
    ['nativeConfig', '{"appKey":"k"}'],
    ['bundleHashCache', '1.0|1|sha'],
    ['nativeCheckIncomplete', '1'],
    ['nativeCheckResp', '{}'],
    ['firstLoadMarked', 'true'],
    ['hash_a', '{"name":"a"}'],
    ['hash_b', '{"name":"b"}'],
    ['currentVersion', 'a'],
  ]);
  const preferences = {
    getSync: (key: string, fallback: string) => values.get(key) ?? fallback,
    putSync: (key: string, value: string) => values.set(key, value),
    deleteSync: (key: string) => values.delete(key),
    getAllSync: () => Object.fromEntries(values),
  };
  const module = evalHarmonyModule(
    'UpdateContext.ts',
    `const store = Object.create(UpdateContext.prototype);
     store.preferences = preferences;
     ({ store, RESET_CLEARED, UPGRADE_CLEARED });`,
    {
      preferences,
      KEY_CONFIG: 'nativeConfig',
      KEY_RESP_CACHE: 'nativeCheckResp',
      logger: { error() {} },
      getErrorMessage: (error: unknown) => String(error),
    }
  ) as {
    store: { removeKeys: (cleared: ClearedKeys, event: string) => void };
    RESET_CLEARED: ClearedKeys;
    UPGRADE_CLEARED: ClearedKeys;
  };
  return { values, ...module };
}

// The install's own keys and the state fields (rewritten by the state core).
const survivors = [
  'uuid',
  'nativeConfig',
  'bundleHashCache',
  'nativeCheckIncomplete',
  'currentVersion',
];

describe('harmony stored-item lifecycle', () => {
  for (const event of ['reset', 'binaryUpgrade'] as const) {
    test(`${event} drops the version keys and keeps the install's`, () => {
      const h = lifecycleHarness();
      h.store.removeKeys(
        event === 'reset' ? h.RESET_CLEARED : h.UPGRADE_CLEARED,
        event
      );
      expect([...h.values.keys()].sort()).toEqual([...survivors].sort());
    });
  }

  test('the contract keeps the breadcrumb, uuid and config on both events', () => {
    for (const name of ['RoundBreadcrumb', 'Uuid', 'NativeConfig']) {
      expect(storedItems.find((item) => item.name === name)?.clearedOn).toEqual(
        []
      );
    }
  });
});
