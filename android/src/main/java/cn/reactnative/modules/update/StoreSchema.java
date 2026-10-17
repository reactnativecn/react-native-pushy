package cn.reactnative.modules.update;

import android.content.SharedPreferences;
import androidx.annotation.Nullable;

/**
 * The persisted layout every platform shares (scripts/contract.ts
 * storeSchema): the keys, the two stores, and the State mapping, generated.
 * Every value is a string; an empty one is never stored, a boolean is
 * BOOLEAN_TRUE / BOOLEAN_FALSE, a marker is BOOLEAN_TRUE while set. The
 * state store is written by StoreMigration's one-time move out of the
 * legacy layout before anything reads it.
 */
final class StoreSchema {
    // <generated:store-schema> (scripts/contract.ts; bun scripts/generate-contract.ts)
    static final int VERSION = 1;
    static final String KEY_SCHEMA_VERSION = "schemaVersion";
    static final String STATE_STORE = "pushy_state";
    static final String CACHE_STORE = "pushy_cache";
    // A boolean is stored as one of these; anything else (absent) reads as the
    // field's fallback.
    static final String BOOLEAN_TRUE = "1";
    static final String BOOLEAN_FALSE = "0";
    static final int LEGACY_LAYOUT = 1;
    // Carried by hand when the migration itself cannot run.
    static final String LEGACY_KEY_UUID = "uuid";
    // The state fields (pushy::state::State).
    static final String KEY_PACKAGE_VERSION = "packageVersion";
    static final String KEY_BUILD_TIME = "buildTime";
    static final String KEY_CURRENT_VERSION = "currentVersion";
    static final String KEY_LAST_VERSION = "lastVersion";
    static final String KEY_FIRST_TIME = "firstTime";
    static final String KEY_FIRST_TIME_OK = "firstTimeOk";
    static final String KEY_ROLLED_BACK_VERSION = "rolledBackVersion";
    // Per-version info: name, description, metaInfo and the rescue flags.
    static final String KEY_HASH_INFO = "hash_";
    // Set when a launch consumes first_time; getConstants reports and clears
    // it.
    static final String KEY_FIRST_LOAD_MARKER = "firstLoadMarked";
    // The native round's raw response for the JS side to reuse (§10.3), scoped
    // to the exact logical request and native config that produced it. It
    // describes versions a reset or an upgrade removes.
    static final String KEY_CHECK_CACHE = "nativeCheckResp";
    // Set when a round starts, cleared when it ends (§11.4). Residue on the
    // next launch means the previous process died mid-round: that launch
    // resumes immediately instead of waiting 5s.
    static final String KEY_ROUND_BREADCRUMB = "nativeCheckIncomplete";
    // Identifies the install for gray-release bucketing: must never change.
    static final String KEY_UUID = "uuid";
    // The persisted native check config (JS syncNativeConfig or the host) the
    // cold-start round and the crash hold run from.
    static final String KEY_NATIVE_CONFIG = "nativeConfig";
    // "<binary identity>|<sha256>" of the embedded bundle: keyed by the binary,
    // so it invalidates itself on upgrade.
    static final String KEY_BUNDLE_HASH_CACHE = "bundleHashCache";
    // </generated:store-schema>

    private StoreSchema() {
    }

    static StateCoreResult readState(SharedPreferences store) {
        StateCoreResult state = new StateCoreResult();
        // <generated:read-state> (scripts/contract.ts; bun scripts/generate-contract.ts)
        state.packageVersion = readString(store, KEY_PACKAGE_VERSION);
        state.buildTime = readString(store, KEY_BUILD_TIME);
        state.currentVersion = readString(store, KEY_CURRENT_VERSION);
        state.lastVersion = readString(store, KEY_LAST_VERSION);
        state.firstTime = readBoolean(store, KEY_FIRST_TIME, false);
        state.firstTimeOk = readBoolean(store, KEY_FIRST_TIME_OK, true);
        state.rolledBackVersion = readString(store, KEY_ROLLED_BACK_VERSION);
        // </generated:read-state>
        return state;
    }

    static void writeState(SharedPreferences.Editor editor, StateCoreResult state) {
        // <generated:write-state> (scripts/contract.ts; bun scripts/generate-contract.ts)
        writeString(editor, KEY_PACKAGE_VERSION, state.packageVersion);
        writeString(editor, KEY_BUILD_TIME, state.buildTime);
        writeString(editor, KEY_CURRENT_VERSION, state.currentVersion);
        writeString(editor, KEY_LAST_VERSION, state.lastVersion);
        writeBoolean(editor, KEY_FIRST_TIME, state.firstTime);
        writeBoolean(editor, KEY_FIRST_TIME_OK, state.firstTimeOk);
        writeString(editor, KEY_ROLLED_BACK_VERSION, state.rolledBackVersion);
        // </generated:write-state>
    }

    /** The value, or null when absent or empty (the two read the same). */
    @Nullable
    static String readString(SharedPreferences store, String key) {
        String value = store.getString(key, null);
        return value == null || value.isEmpty() ? null : value;
    }

    static boolean readBoolean(SharedPreferences store, String key, boolean fallback) {
        String value = store.getString(key, null);
        if (BOOLEAN_TRUE.equals(value)) {
            return true;
        }
        if (BOOLEAN_FALSE.equals(value)) {
            return false;
        }
        return fallback;
    }

    static boolean readMarker(SharedPreferences store, String key) {
        return readBoolean(store, key, false);
    }

    /** Removes the key for a null or empty value. */
    static void writeString(SharedPreferences.Editor editor, String key, @Nullable String value) {
        if (value == null || value.isEmpty()) {
            editor.remove(key);
        } else {
            editor.putString(key, value);
        }
    }

    static void writeBoolean(SharedPreferences.Editor editor, String key, boolean value) {
        editor.putString(key, value ? BOOLEAN_TRUE : BOOLEAN_FALSE);
    }

    static void writeMarker(SharedPreferences.Editor editor, String key, boolean set) {
        if (set) {
            editor.putString(key, BOOLEAN_TRUE);
        } else {
            editor.remove(key);
        }
    }
}
