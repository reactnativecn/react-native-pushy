import type { StateCoreResult } from './NativePatchCore';
import logger from './Logger';

// The persisted layout every platform shares (scripts/contract.ts
// storeSchema): the keys, the two stores and the State mapping, generated.
// Every value is a string; an empty one is never stored, a boolean is
// BOOLEAN_TRUE / BOOLEAN_FALSE, a marker is BOOLEAN_TRUE while set.

// <generated:store-schema> (scripts/contract.ts; bun scripts/generate-contract.ts)
export const SCHEMA_VERSION = 1;
export const KEY_SCHEMA_VERSION = 'schemaVersion';
export const STATE_STORE = 'pushy_state';
export const CACHE_STORE = 'pushy_cache';
// A boolean is stored as one of these; anything else (absent) reads as the
// field's fallback.
export const BOOLEAN_TRUE = '1';
export const BOOLEAN_FALSE = '0';
export const LEGACY_LAYOUT = 3;
// Carried by hand when the migration itself cannot run.
export const LEGACY_KEY_UUID = 'uuid';
// The state fields (pushy::state::State).
export const KEY_PACKAGE_VERSION = 'packageVersion';
export const KEY_BUILD_TIME = 'buildTime';
export const KEY_CURRENT_VERSION = 'currentVersion';
export const KEY_LAST_VERSION = 'lastVersion';
export const KEY_FIRST_TIME = 'firstTime';
export const KEY_FIRST_TIME_OK = 'firstTimeOk';
export const KEY_ROLLED_BACK_VERSION = 'rolledBackVersion';
// Per-version info: name, description, metaInfo and the rescue flags.
export const KEY_HASH_INFO = 'hash_';
// Set when a launch consumes first_time; getConstants reports and clears it.
export const KEY_FIRST_LOAD_MARKER = 'firstLoadMarked';
// The native round's raw response for the JS side to reuse (§10.3), scoped
// to the exact logical request and native config that produced it. It
// describes versions a reset or an upgrade removes.
export const KEY_CHECK_CACHE = 'nativeCheckResp';
// Set when a round starts, cleared when it ends (§11.4). Residue on the
// next launch means the previous process died mid-round: that launch
// resumes immediately instead of waiting 5s.
export const KEY_ROUND_BREADCRUMB = 'nativeCheckIncomplete';
// Identifies the install for gray-release bucketing: must never change.
export const KEY_UUID = 'uuid';
// The persisted native check config (JS syncNativeConfig or the host) the
// cold-start round and the crash hold run from.
export const KEY_NATIVE_CONFIG = 'nativeConfig';
// "<binary identity>|<sha256>" of the embedded bundle: keyed by the binary,
// so it invalidates itself on upgrade.
export const KEY_BUNDLE_HASH_CACHE = 'bundleHashCache';
// </generated:store-schema>

const TAG = 'PushyStore';

/** One store, as text. read returns '' for an absent key. */
export interface StoreAccess {
  read(key: string): string;
  write(key: string, value: string): void;
  remove(key: string): void;
}

export function readBoolean(
  store: StoreAccess,
  key: string,
  fallback: boolean,
): boolean {
  const value = store.read(key);
  if (value === BOOLEAN_TRUE) {
    return true;
  }
  if (value === BOOLEAN_FALSE) {
    return false;
  }
  return fallback;
}

export function readMarker(store: StoreAccess, key: string): boolean {
  return readBoolean(store, key, false);
}

/** Removes the key for an absent or empty value. */
export function writeString(
  store: StoreAccess,
  key: string,
  value: string | undefined,
): void {
  if (value) {
    store.write(key, value);
  } else {
    store.remove(key);
  }
}

export function writeBoolean(
  store: StoreAccess,
  key: string,
  value: boolean | undefined,
): void {
  store.write(key, value ? BOOLEAN_TRUE : BOOLEAN_FALSE);
}

export function writeMarker(store: StoreAccess, key: string, set: boolean): void {
  if (set) {
    store.write(key, BOOLEAN_TRUE);
  } else {
    store.remove(key);
  }
}

export function readState(store: StoreAccess): StateCoreResult {
  return {
    // <generated:read-state> (scripts/contract.ts; bun scripts/generate-contract.ts)
    packageVersion: store.read(KEY_PACKAGE_VERSION),
    buildTime: store.read(KEY_BUILD_TIME),
    currentVersion: store.read(KEY_CURRENT_VERSION),
    lastVersion: store.read(KEY_LAST_VERSION),
    firstTime: readBoolean(store, KEY_FIRST_TIME, false),
    firstTimeOk: readBoolean(store, KEY_FIRST_TIME_OK, true),
    rolledBackVersion: store.read(KEY_ROLLED_BACK_VERSION),
    // </generated:read-state>
  };
}

export function writeState(store: StoreAccess, state: StateCoreResult): void {
  // <generated:write-state> (scripts/contract.ts; bun scripts/generate-contract.ts)
  writeString(store, KEY_PACKAGE_VERSION, state.packageVersion);
  writeString(store, KEY_BUILD_TIME, state.buildTime);
  writeString(store, KEY_CURRENT_VERSION, state.currentVersion);
  writeString(store, KEY_LAST_VERSION, state.lastVersion);
  writeBoolean(store, KEY_FIRST_TIME, state.firstTime);
  writeBoolean(store, KEY_FIRST_TIME_OK, state.firstTimeOk);
  writeString(store, KEY_ROLLED_BACK_VERSION, state.rolledBackVersion);
  // </generated:write-state>
}

/** A store's IO for the migration: a snapshot, in-memory writes, a flush. */
export interface MigrationStore {
  snapshot(): Record<string, Object>;
  put(key: string, value: string): void;
  remove(key: string): void;
  /** Resolves once the store is on disk; rejects when it is not. */
  flush(): Promise<void>;
}

/** NativePatchCore.migrateStoredItems: the plan as JSON, 'null' for an unknown layout. */
export type MigrationPlanner = (
  legacyLayout: number,
  legacy: string[],
  current: string[],
) => string;

interface MigrationPlan {
  migrated?: boolean;
  puts?: string[][];
  removes?: string[];
}

/**
 * [key, value, key, value, ...] with every value as text: a legacy boolean
 * is '1' / '0' like the new layout's, anything without a text form is '' —
 * still a key to delete, never a value.
 */
export function flattenStore(items: Record<string, Object>): string[] {
  const flat: string[] = [];
  for (const key of Object.keys(items)) {
    const value: Object | null | undefined = items[key];
    flat.push(key);
    if (typeof value === 'boolean') {
      flat.push(value ? BOOLEAN_TRUE : BOOLEAN_FALSE);
    } else if (typeof value === 'string' || typeof value === 'number') {
      flat.push(String(value));
    } else {
      flat.push('');
    }
  }
  return flat;
}

/**
 * The one-time move from the legacy layout (SDKs up to 10.61: preferences
 * Texts.PREFERENCES_NAME, booleans native or 'true') into the state store,
 * by the shared core's plan (cpp/patch_core/stored_items.h). The puts land
 * in memory at once (everything after this reads them); the legacy keys are
 * deleted only once the state store's flush succeeded. Every step is safe to
 * repeat, so a process killed anywhere in between finishes the move on its
 * next launch. Never throws: a failure leaves a fresh state store (as a new
 * install) that still carries the install's uuid. Resolves with what it did
 * ('current' | 'migrated' | 'retry' | 'fallback'), for logs and tests.
 */
export function migrateStore(
  state: MigrationStore,
  legacy: MigrationStore,
  planner: MigrationPlanner,
): Promise<string> {
  let plan: MigrationPlan;
  try {
    const text = planner(
      LEGACY_LAYOUT,
      flattenStore(legacy.snapshot()),
      flattenStore(state.snapshot()),
    );
    const parsed = JSON.parse(text) as MigrationPlan | null;
    if (!parsed || !Array.isArray(parsed.puts) || !Array.isArray(parsed.removes)) {
      throw new Error('no migration plan');
    }
    plan = parsed;
    for (const put of plan.puts ?? []) {
      state.put(put[0], put[1]);
    }
  } catch (error) {
    logger.error(TAG, `state store migration failed: ${String(error)}`);
    return carryUuid(state, legacy).then(() => 'fallback');
  }
  const migrated = plan.migrated === true;
  const written = (plan.puts ?? []).length > 0 ? state.flush() : Promise.resolve();
  return written.then(
    () => {
      const removes = plan.removes ?? [];
      if (removes.length === 0) {
        return migrated ? 'migrated' : 'current';
      }
      for (const key of removes) {
        legacy.remove(key);
      }
      // A failure only leaves keys nothing reads: the next launch removes
      // them again.
      return legacy.flush().then(
        () => (migrated ? 'migrated' : 'current'),
        (error: Object) => {
          logger.warn(TAG, `failed to remove the legacy keys: ${String(error)}`);
          return migrated ? 'migrated' : 'current';
        },
      );
    },
    (error: Object) => {
      // The legacy keys stay until the puts are on disk.
      logger.error(TAG, `failed to persist the migrated store: ${String(error)}`);
      return 'retry';
    },
  );
}

// The migration could not run: start like a fresh install, but keep the
// install's identity (a new uuid would re-bucket every gray release). No
// schema is written, so the next launch runs the whole migration again.
function carryUuid(state: MigrationStore, legacy: MigrationStore): Promise<void> {
  try {
    const current = state.snapshot()[KEY_UUID];
    const uuid = legacy.snapshot()[LEGACY_KEY_UUID];
    if (typeof current === 'string' && current.length > 0) {
      return Promise.resolve();
    }
    if (typeof uuid !== 'string' || uuid.length === 0) {
      return Promise.resolve();
    }
    state.put(KEY_UUID, uuid);
    return state.flush().catch((error: Object) => {
      logger.error(TAG, `failed to persist the carried uuid: ${String(error)}`);
    });
  } catch (error) {
    logger.error(TAG, `failed to carry the uuid: ${String(error)}`);
    return Promise.resolve();
  }
}
