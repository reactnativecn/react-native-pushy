package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import org.junit.Test;

public class VersionScopedKeysTest {
    private static final List<String> STORED = Arrays.asList(
        "schemaVersion",
        "uuid",
        "nativeConfig",
        "bundleHashCache",
        "packageVersion",
        "currentVersion",
        "hash_abc",
        "hash_def",
        "firstLoadMarked",
        "nativeCheckIncomplete",
        null
    );

    // The round breadcrumb survives both: it only decides whether the next
    // launch resumes the round without the start delay. The response cache
    // lives in the cache store, which both events clear as a whole.
    private static final HashSet<String> VERSION_KEYS = new HashSet<>(Arrays.asList(
        "hash_abc", "hash_def", "firstLoadMarked"));

    @Test
    public void resetDropsVersionKeysAndKeepsInstallKeys() {
        assertEquals(VERSION_KEYS, new HashSet<>(VersionScopedKeys.clearedOnReset(STORED)));
    }

    @Test
    public void upgradeDropsVersionKeysAndKeepsInstallKeys() {
        assertEquals(VERSION_KEYS, new HashSet<>(VersionScopedKeys.clearedOnUpgrade(STORED)));
    }

    @Test
    public void keyNamesMatchTheirOwners() {
        assertEquals("firstLoadMarked", StoreSchema.KEY_FIRST_LOAD_MARKER);
        assertEquals("nativeCheckIncomplete", StoreSchema.KEY_ROUND_BREADCRUMB);
        assertEquals("nativeCheckResp", StoreSchema.KEY_CHECK_CACHE);
        assertEquals("nativeConfig", StoreSchema.KEY_NATIVE_CONFIG);
    }
}
