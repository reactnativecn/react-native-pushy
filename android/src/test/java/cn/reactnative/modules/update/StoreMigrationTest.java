package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.SharedPreferences;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;

// The Android side of the persisted layout: StoreSchema's State mapping and
// StoreMigration's IO around the shared core's plan, against
// cpp/patch_core/tests/stored-items-vectors.json. The vectors' plans stand in
// for the core (the .so does not load on the JVM); the legacy values are
// typed as SharedPreferences returns them.
public class StoreMigrationTest {
    /** An in-memory SharedPreferences whose commit can be made to fail. */
    static final class FakePrefs implements SharedPreferences {
        final Map<String, Object> values = new HashMap<>();
        boolean failCommit;
        int commits;

        FakePrefs(Map<String, Object> initial) {
            values.putAll(initial);
        }

        @Override
        public Map<String, ?> getAll() {
            return new HashMap<>(values);
        }

        @Override
        public String getString(String key, String fallback) {
            // ClassCastException like the platform for a non-string value.
            return values.containsKey(key) ? (String) values.get(key) : fallback;
        }

        @Override
        public Set<String> getStringSet(String key, Set<String> fallback) {
            throw new UnsupportedOperationException();
        }

        @Override
        public int getInt(String key, int fallback) {
            throw new UnsupportedOperationException();
        }

        @Override
        public long getLong(String key, long fallback) {
            throw new UnsupportedOperationException();
        }

        @Override
        public float getFloat(String key, float fallback) {
            throw new UnsupportedOperationException();
        }

        @Override
        public boolean getBoolean(String key, boolean fallback) {
            throw new UnsupportedOperationException();
        }

        @Override
        public boolean contains(String key) {
            return values.containsKey(key);
        }

        @Override
        public Editor edit() {
            return new FakeEditor();
        }

        @Override
        public void registerOnSharedPreferenceChangeListener(
            OnSharedPreferenceChangeListener listener) {
        }

        @Override
        public void unregisterOnSharedPreferenceChangeListener(
            OnSharedPreferenceChangeListener listener) {
        }

        final class FakeEditor implements Editor {
            private final Map<String, Object> puts = new HashMap<>();
            private final Set<String> removes = new HashSet<>();

            @Override
            public Editor putString(String key, String value) {
                puts.put(key, value);
                return this;
            }

            @Override
            public Editor putStringSet(String key, Set<String> value) {
                throw new UnsupportedOperationException();
            }

            @Override
            public Editor putInt(String key, int value) {
                throw new UnsupportedOperationException();
            }

            @Override
            public Editor putLong(String key, long value) {
                throw new UnsupportedOperationException();
            }

            @Override
            public Editor putFloat(String key, float value) {
                throw new UnsupportedOperationException();
            }

            @Override
            public Editor putBoolean(String key, boolean value) {
                throw new UnsupportedOperationException("the layout stores text only");
            }

            @Override
            public Editor remove(String key) {
                removes.add(key);
                return this;
            }

            @Override
            public Editor clear() {
                throw new UnsupportedOperationException("never clear a whole store");
            }

            // Like the platform: memory changes even when the disk write
            // fails, and removes apply before puts.
            @Override
            public boolean commit() {
                apply();
                commits++;
                return !failCommit;
            }

            @Override
            public void apply() {
                for (String key : removes) {
                    values.remove(key);
                }
                values.putAll(puts);
            }
        }
    }

    private static JSONArray vectors() throws IOException, JSONException {
        String path = "cpp/patch_core/tests/stored-items-vectors.json";
        File dir = new File(System.getProperty("user.dir")).getAbsoluteFile();
        while (dir != null && !new File(dir, path).isFile()) {
            dir = dir.getParentFile();
        }
        if (dir == null) {
            throw new IOException(path + " not found above " + System.getProperty("user.dir"));
        }
        return new JSONObject(new String(
            Files.readAllBytes(new File(dir, path).toPath()), StandardCharsets.UTF_8))
            .getJSONArray("cases");
    }

    // A vector's legacy values as SharedPreferences holds them.
    private static Map<String, Object> typed(JSONObject object) throws JSONException {
        Map<String, Object> values = new HashMap<>();
        for (Iterator<String> keys = object.keys(); keys.hasNext(); ) {
            String key = keys.next();
            Object value = object.get(key);
            if (value instanceof JSONObject || value instanceof JSONArray) {
                Set<String> set = new HashSet<>();
                set.add(value.toString());
                value = set;
            }
            values.put(key, value);
        }
        return values;
    }

    // How the core reads a legacy value (see the vectors' doc).
    private static Map<String, String> text(Map<String, ?> values) {
        Map<String, String> text = new HashMap<>();
        for (Map.Entry<String, ?> entry : values.entrySet()) {
            Object value = entry.getValue();
            text.put(entry.getKey(), value instanceof Boolean
                ? ((Boolean) value ? "1" : "0")
                : value instanceof String || value instanceof Number ? value.toString() : "");
        }
        return text;
    }

    private static Map<String, String> pairs(String[] flat) {
        Map<String, String> pairs = new HashMap<>();
        for (int i = 0; i + 1 < flat.length; i += 2) {
            pairs.put(flat[i], flat[i + 1]);
        }
        return pairs;
    }

    @Test
    public void replaysTheSharedVectors() throws Exception {
        JSONArray cases = vectors();
        int replayed = 0;
        for (int i = 0; i < cases.length(); i++) {
            JSONObject vector = cases.getJSONObject(i);
            if (vector.isNull("plan")) {
                continue;
            }
            String name = vector.getString("name");
            Map<String, Object> legacyValues = typed(vector.getJSONObject("legacy"));
            // The response cache is the legacy "_check" file's.
            Map<String, Object> cacheValues = new HashMap<>();
            Object cache = legacyValues.remove(StoreSchema.KEY_CHECK_CACHE);
            if (cache != null) {
                cacheValues.put(StoreSchema.KEY_CHECK_CACHE, cache);
            }
            FakePrefs legacy = new FakePrefs(legacyValues);
            FakePrefs legacyCache = new FakePrefs(cacheValues);
            FakePrefs state = new FakePrefs(typed(vector.getJSONObject("current")));
            JSONObject plan = vector.getJSONObject("plan");
            final Map<String, String> wantLegacy = text(typed(vector.getJSONObject("legacy")));
            final Map<String, String> wantCurrent = text(typed(vector.getJSONObject("current")));

            StoreMigration.Result result = StoreMigration.run(
                state, legacy, legacyCache, (layout, legacyFlat, currentFlat) -> {
                    assertEquals(name, StoreSchema.LEGACY_LAYOUT, layout);
                    assertEquals(name, wantLegacy, pairs(legacyFlat));
                    assertEquals(name, wantCurrent, pairs(currentFlat));
                    return plan.toString();
                });

            assertEquals(name, plan.getBoolean("migrated")
                ? StoreMigration.Result.MIGRATED : StoreMigration.Result.CURRENT, result);
            JSONObject after = vector.getJSONObject("after");
            assertEquals(name, typed(after.getJSONObject("current")), state.values);
            Map<String, Object> legacyAfter = new HashMap<>(legacy.values);
            legacyAfter.putAll(legacyCache.values);
            assertEquals(name, text(typed(after.getJSONObject("legacy"))), text(legacyAfter));
            // The puts land in one commit.
            assertTrue(name, state.commits <= 1);
            replayed++;
        }
        assertTrue(replayed >= 10);
    }

    private static JSONObject firstVector() throws Exception {
        return vectors().getJSONObject(0);
    }

    @Test
    public void theLegacyKeysStayUntilTheStateStoreIsOnDisk() throws Exception {
        JSONObject vector = firstVector();
        FakePrefs legacy = new FakePrefs(typed(vector.getJSONObject("legacy")));
        FakePrefs legacyCache = new FakePrefs(new HashMap<>());
        FakePrefs state = new FakePrefs(new HashMap<>());
        state.failCommit = true;
        String plan = vector.getJSONObject("plan").toString();

        assertEquals(StoreMigration.Result.RETRY,
            StoreMigration.run(state, legacy, legacyCache, (l, a, b) -> plan));
        assertEquals(typed(vector.getJSONObject("legacy")), legacy.values);
        // In memory already: this launch reads the migrated items.
        assertEquals("install-uuid", StoreSchema.readString(state, StoreSchema.KEY_UUID));
    }

    @Test
    public void aFailedCoreKeepsTheUuidAndRetriesNextLaunch() throws Exception {
        JSONObject vector = firstVector();
        FakePrefs legacy = new FakePrefs(typed(vector.getJSONObject("legacy")));
        FakePrefs legacyCache = new FakePrefs(new HashMap<>());
        FakePrefs state = new FakePrefs(new HashMap<>());
        List<StoreMigration.Planner> failures = new ArrayList<>();
        failures.add((l, a, b) -> null);
        failures.add((l, a, b) -> "null");
        failures.add((l, a, b) -> {
            throw new UnsatisfiedLinkError("no native");
        });
        failures.add((l, a, b) -> "{not json");
        for (StoreMigration.Planner planner : failures) {
            state.values.clear();
            assertEquals(StoreMigration.Result.FALLBACK,
                StoreMigration.run(state, legacy, legacyCache, planner));
            Map<String, Object> uuidOnly = new HashMap<>();
            uuidOnly.put(StoreSchema.KEY_UUID, "install-uuid");
            assertEquals(uuidOnly, state.values);
            assertEquals(typed(vector.getJSONObject("legacy")), legacy.values);
        }
        String plan = vector.getJSONObject("plan").toString();
        // The core's plan never overwrites what the store holds, so the
        // carried uuid is simply kept (the vector's plan is for an empty store).
        state.values.clear();
        assertEquals(StoreMigration.Result.MIGRATED,
            StoreMigration.run(state, legacy, legacyCache, (l, a, b) -> plan));
        assertEquals(typed(vector.getJSONObject("after").getJSONObject("current")), state.values);
    }

    @Test
    public void flattenReadsLegacyValuesAsText() {
        Map<String, Object> values = new HashMap<>();
        values.put("on", true);
        values.put("off", false);
        values.put("count", 3);
        values.put("text", "x");
        values.put("set", new HashSet<String>());
        Map<String, String> want = new HashMap<>();
        want.put("on", "1");
        want.put("off", "0");
        want.put("count", "3");
        want.put("text", "x");
        want.put("set", "");
        assertEquals(want, pairs(StoreMigration.flatten(values)));
    }

    @Test
    public void theStateMappingWritesTextAndReadsItBack() {
        FakePrefs store = new FakePrefs(new HashMap<>());
        StateCoreResult empty = StoreSchema.readState(store);
        assertNull(empty.currentVersion);
        assertFalse(empty.firstTime);
        assertTrue(empty.firstTimeOk);

        StateCoreResult state = new StateCoreResult();
        state.packageVersion = "1.0";
        state.buildTime = "28000000";
        state.currentVersion = "b";
        state.lastVersion = "";
        state.firstTime = true;
        state.firstTimeOk = false;
        SharedPreferences.Editor editor = store.edit();
        StoreSchema.writeState(editor, state);
        editor.commit();
        Map<String, Object> want = new HashMap<>();
        want.put("packageVersion", "1.0");
        want.put("buildTime", "28000000");
        want.put("currentVersion", "b");
        want.put("firstTime", "1");
        want.put("firstTimeOk", "0");
        assertEquals(want, store.values);

        StateCoreResult read = StoreSchema.readState(store);
        assertEquals("b", read.currentVersion);
        assertNull(read.lastVersion);
        assertTrue(read.firstTime);
        assertFalse(read.firstTimeOk);
    }
}
