import { describe, expect, test } from 'bun:test';
import { storedItems } from '../../scripts/contract';
import { evalHarmonyModule, harmonyStoreSchema, source } from './nativeSources';

// The Harmony side of the persisted layout (scripts/contract.ts storeSchema):
// what a reset to the packaged bundle and a binary upgrade delete, through
// the actual UpdateContext.removeKeys, and the one-time migration out of the
// legacy layout, through the actual StoreSchema.migrateStore, against the
// shared vectors (cpp/patch_core/tests/stored-items-vectors.json).

interface ClearedKeys {
  keys: string[];
  prefixes: string[];
}

function lifecycleHarness() {
  const values = new Map<string, string>([
    ['schemaVersion', '1'],
    ['uuid', 'installation-id'],
    ['nativeConfig', '{"appKey":"k"}'],
    ['bundleHashCache', '1.0|1|sha'],
    ['nativeCheckIncomplete', '1'],
    ['firstLoadMarked', '1'],
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
      ...harmonyStoreSchema(),
      preferences,
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
  'schemaVersion',
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

  test('the state mapping writes text and reads it back', () => {
    const schema = harmonyStoreSchema() as {
      readState: (store: unknown) => Record<string, unknown>;
      writeState: (store: unknown, state: Record<string, unknown>) => void;
    };
    const values = new Map<string, string>();
    const store = {
      read: (key: string) => values.get(key) ?? '',
      write: (key: string, value: string) => values.set(key, value),
      remove: (key: string) => values.delete(key),
    };
    expect(schema.readState(store)).toMatchObject({
      firstTime: false,
      firstTimeOk: true,
      currentVersion: '',
    });
    const state = {
      packageVersion: '1.0',
      buildTime: '1700',
      currentVersion: 'b',
      lastVersion: '',
      firstTime: true,
      firstTimeOk: false,
      rolledBackVersion: '',
    };
    schema.writeState(store, state);
    expect(Object.fromEntries(values)).toEqual({
      packageVersion: '1.0',
      buildTime: '1700',
      currentVersion: 'b',
      firstTime: '1',
      firstTimeOk: '0',
    });
    expect(schema.readState(store)).toEqual(state);
  });
});

type Value = string | boolean | number | Record<string, unknown> | unknown[];
interface Plan {
  schemaVersion: number;
  migrated: boolean;
  puts: [string, string][];
  removes: string[];
}
interface Vector {
  name: string;
  layout: string | number;
  legacy: Record<string, Value>;
  current: Record<string, string>;
  plan: Plan | null;
  after: { legacy: Record<string, Value>; current: Record<string, string> };
}

const vectors = JSON.parse(
  source('cpp/patch_core/tests/stored-items-vectors.json')
).cases as Vector[];

// How the core reads a legacy value (see the vectors' doc).
const text = (value: Value) =>
  typeof value === 'string'
    ? value
    : typeof value === 'boolean'
      ? value
        ? '1'
        : '0'
      : typeof value === 'number'
        ? String(value)
        : '';

interface MigrationStore {
  snapshot(): Record<string, unknown>;
  put(key: string, value: string): void;
  remove(key: string): void;
  flush(): Promise<void>;
}

function fakeStore(initial: Record<string, unknown>) {
  const values = new Map<string, unknown>(Object.entries(initial));
  const failures = { flush: false };
  const store: MigrationStore = {
    snapshot: () => Object.fromEntries(values),
    put: (key, value) => values.set(key, value),
    remove: (key) => values.delete(key),
    flush: async () => {
      if (failures.flush) {
        throw new Error('disk full');
      }
    },
  };
  return { values, store, failures };
}

const schema = harmonyStoreSchema() as {
  LEGACY_LAYOUT: number;
  migrateStore: (
    state: MigrationStore,
    legacy: MigrationStore,
    planner: (layout: number, legacy: string[], current: string[]) => string
  ) => Promise<string>;
};

const pairs = (flat: string[]) =>
  Object.fromEntries(
    flat.flatMap((_, i) => (i % 2 === 0 ? [[flat[i], flat[i + 1]]] : []))
  );

describe('harmony state store migration', () => {
  for (const vector of vectors.filter((candidate) => candidate.plan)) {
    test(vector.name, async () => {
      const legacy = fakeStore(vector.legacy);
      const state = fakeStore(vector.current);
      const result = await schema.migrateStore(
        state.store,
        legacy.store,
        (layout, legacyFlat, currentFlat) => {
          // The snapshots reach the core as the vectors read them.
          expect(layout).toBe(schema.LEGACY_LAYOUT);
          expect(pairs(legacyFlat)).toEqual(
            Object.fromEntries(
              Object.entries(vector.legacy).map(([key, value]) => [
                key,
                text(value),
              ])
            )
          );
          expect(pairs(currentFlat)).toEqual(vector.current);
          return JSON.stringify(vector.plan);
        }
      );
      expect(result).toBe(vector.plan?.migrated ? 'migrated' : 'current');
      expect(Object.fromEntries(state.values)).toEqual(vector.after.current);
      expect(Object.fromEntries(legacy.values)).toEqual(vector.after.legacy);
    });
  }

  const full = vectors[0];
  const plan = () => JSON.stringify(full.plan);

  test('the legacy keys stay until the state store is on disk', async () => {
    const legacy = fakeStore(full.legacy);
    const state = fakeStore({});
    state.failures.flush = true;
    expect(await schema.migrateStore(state.store, legacy.store, plan)).toBe(
      'retry'
    );
    expect(Object.fromEntries(legacy.values)).toEqual(full.legacy);
    // The puts are in memory: this launch already reads the migrated items.
    expect(state.values.get('uuid')).toBe('install-uuid');
  });

  // The next launch finishes the deletes (the "killed after the puts" vector).
  test('a failed legacy delete does not fail the migration', async () => {
    const legacy = fakeStore(full.legacy);
    const state = fakeStore({});
    legacy.failures.flush = true;
    expect(await schema.migrateStore(state.store, legacy.store, plan)).toBe(
      'migrated'
    );
    expect(Object.fromEntries(state.values)).toEqual(full.after.current);
  });

  for (const [what, planner] of [
    [
      'the core throws',
      () => {
        throw new Error('bad_alloc');
      },
    ],
    ['the core has no plan', () => 'null'],
  ] as const) {
    test(`${what}: a fresh state store that keeps the uuid, retried next launch`, async () => {
      const legacy = fakeStore(full.legacy);
      const state = fakeStore({});
      expect(
        await schema.migrateStore(state.store, legacy.store, planner)
      ).toBe('fallback');
      expect(Object.fromEntries(state.values)).toEqual({
        uuid: 'install-uuid',
      });
      expect(Object.fromEntries(legacy.values)).toEqual(full.legacy);
      // Next launch: the core works again and completes the move.
      expect(await schema.migrateStore(state.store, legacy.store, plan)).toBe(
        'migrated'
      );
      expect(Object.fromEntries(state.values)).toEqual(full.after.current);
      expect(Object.fromEntries(legacy.values)).toEqual(full.after.legacy);
    });
  }

  // Negative control: a store adapter that ignored the plan's order and
  // deleted the legacy keys before the state store was durable would lose the
  // uuid on a failed flush; the real one does not.
  test('the uuid survives a failed flush followed by a fallback launch', async () => {
    const legacy = fakeStore(full.legacy);
    const state = fakeStore({});
    state.failures.flush = true;
    await schema.migrateStore(state.store, legacy.store, plan);
    // The process dies: memory is lost, only the legacy store is on disk.
    const relaunched = fakeStore({});
    expect(
      await schema.migrateStore(relaunched.store, legacy.store, () => 'null')
    ).toBe('fallback');
    expect(relaunched.values.get('uuid')).toBe('install-uuid');
  });
});
