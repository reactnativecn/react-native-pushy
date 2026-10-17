package cn.reactnative.modules.update;

import android.content.SharedPreferences;
import android.util.Log;
import androidx.annotation.Nullable;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The one-time move from the legacy layout (SDKs up to 10.61: the
 * Texts.PREFERENCES_NAME file with native booleans, its "_check" file for
 * the response cache) into StoreSchema's stores. The rules are the shared
 * core's (cpp/patch_core/stored_items.h); this class only does the IO:
 * snapshot both stores, write the plan's puts in one commit, and only once
 * that commit reached disk delete the plan's removes from the legacy files.
 * Every step is safe to repeat, so a process killed anywhere in between
 * finishes the move on its next launch.
 */
final class StoreMigration {
    static final String TAG = Texts.LOG_TAG;

    /** What run() did; for logs and tests. */
    enum Result {
        /** The store already held the schema (legacy leftovers were removed). */
        CURRENT,
        /** The legacy items were carried over and the schema written. */
        MIGRATED,
        /** The puts did not reach disk: the legacy keys stay, the next launch retries. */
        RETRY,
        /** No plan (the core failed): the uuid alone was carried, the next launch retries. */
        FALLBACK,
    }

    interface Planner {
        /**
         * The plan as JSON (MigrateStoredItemsJson); "null" for an unknown
         * layout, null when the core threw.
         */
        @Nullable
        String plan(int legacyLayout, String[] legacy, String[] current);
    }

    static final Planner NATIVE = StoreMigration::migrateStoredItems;

    // librnpushy.so is loaded by UpdateContext's static initializer, which
    // runs before the only caller (its constructor).
    private static native String migrateStoredItems(
        int legacyLayout, String[] legacy, String[] current);

    private StoreMigration() {
    }

    /**
     * Never throws: it runs on the launch path before anything reads the
     * state store. A failure leaves the app on a fresh state store (as a new
     * install) that still carries the install's uuid.
     */
    static Result run(
        SharedPreferences state,
        SharedPreferences legacy,
        SharedPreferences legacyCache,
        Planner planner
    ) {
        try {
            Map<String, Object> legacyItems = new HashMap<>(legacyCache.getAll());
            legacyItems.putAll(legacy.getAll());
            String json = planner.plan(
                StoreSchema.LEGACY_LAYOUT, flatten(legacyItems), flatten(state.getAll()));
            if (json == null || "null".equals(json)) {
                throw new IllegalStateException("no migration plan");
            }
            JSONObject plan = new JSONObject(json);
            JSONArray puts = plan.getJSONArray("puts");
            if (puts.length() > 0) {
                SharedPreferences.Editor editor = state.edit();
                for (int i = 0; i < puts.length(); i++) {
                    JSONArray put = puts.getJSONArray(i);
                    editor.putString(put.getString(0), put.getString(1));
                }
                // One commit, so the schema never lands without the items.
                if (!editor.commit()) {
                    Log.e(TAG, "Failed to persist the migrated state store");
                    return Result.RETRY;
                }
            }
            JSONArray removes = plan.getJSONArray("removes");
            if (removes.length() > 0) {
                SharedPreferences.Editor legacyEditor = legacy.edit();
                SharedPreferences.Editor legacyCacheEditor = legacyCache.edit();
                for (int i = 0; i < removes.length(); i++) {
                    legacyEditor.remove(removes.getString(i));
                    legacyCacheEditor.remove(removes.getString(i));
                }
                // A failure only leaves keys nothing reads: the next launch
                // removes them again.
                boolean removed = legacyEditor.commit();
                if (!legacyCacheEditor.commit() || !removed) {
                    Log.w(TAG, "Failed to remove the legacy state keys");
                }
            }
            return plan.optBoolean("migrated") ? Result.MIGRATED : Result.CURRENT;
        } catch (Throwable e) {
            Log.e(TAG, "State store migration failed", e);
            carryUuid(state, legacy);
            return Result.FALLBACK;
        }
    }

    /**
     * The migration could not run: start like a fresh install, but keep the
     * install's identity (a new uuid would re-bucket every gray release). No
     * schema is written, so the next launch runs the whole migration again.
     */
    private static void carryUuid(SharedPreferences state, SharedPreferences legacy) {
        try {
            if (StoreSchema.readString(state, StoreSchema.KEY_UUID) != null) {
                return;
            }
            Object uuid = legacy.getAll().get(StoreSchema.LEGACY_KEY_UUID);
            if (uuid instanceof String && !((String) uuid).isEmpty()
                && !state.edit().putString(StoreSchema.KEY_UUID, (String) uuid).commit()) {
                Log.e(TAG, "Failed to persist the carried uuid");
            }
        } catch (Throwable e) {
            Log.e(TAG, "Failed to carry the uuid", e);
        }
    }

    /**
     * [key, value, key, value, ...] with every value as text: a legacy
     * boolean is "1" / "0" like the new layout's, anything without a text
     * form (a string set) is "" — still a key to delete, never a value.
     */
    static String[] flatten(Map<String, ?> items) {
        String[] flat = new String[items.size() * 2];
        int i = 0;
        for (Map.Entry<String, ?> entry : items.entrySet()) {
            Object value = entry.getValue();
            flat[i++] = entry.getKey() == null ? "" : entry.getKey();
            if (value instanceof Boolean) {
                flat[i++] = (Boolean) value ? StoreSchema.BOOLEAN_TRUE : StoreSchema.BOOLEAN_FALSE;
            } else if (value instanceof String || value instanceof Number) {
                flat[i++] = value.toString();
            } else {
                flat[i++] = "";
            }
        }
        return flat;
    }
}
