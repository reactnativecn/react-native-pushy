package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import org.junit.Test;

public class VersionScopedKeysTest {
    private static final List<String> STORED = Arrays.asList(
        "uuid",
        "nativeConfig",
        "bundleHashCache",
        "packageVersion",
        "currentVersion",
        "hash_abc",
        "hash_def",
        "firstLoadMarked",
        "nativeCheckIncomplete",
        "nativeCheckResp",
        null
    );

    // The round breadcrumb survives both: it only decides whether the next
    // launch resumes the round without the start delay.
    private static final HashSet<String> VERSION_KEYS = new HashSet<>(Arrays.asList(
        "hash_abc", "hash_def", "firstLoadMarked", "nativeCheckResp"));

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
        assertEquals("firstLoadMarked", UpdateContext.KEY_FIRST_LOAD_MARKED);
        assertEquals("nativeCheckIncomplete", SyncCoordinator.KEY_ROUND_INCOMPLETE);
        assertEquals("nativeCheckResp", SyncCoordinator.KEY_RESP_CACHE);
        assertEquals("nativeConfig", SyncCoordinator.KEY_CONFIG);
    }
}
