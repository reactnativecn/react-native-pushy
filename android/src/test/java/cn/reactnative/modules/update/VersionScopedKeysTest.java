package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import org.junit.Test;

public class VersionScopedKeysTest {
    @Test
    public void dropsVersionKeysAndKeepsInstallKeys() {
        List<String> doomed = VersionScopedKeys.select(Arrays.asList(
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
        ));
        assertEquals(
            new HashSet<>(Arrays.asList(
                "hash_abc",
                "hash_def",
                "firstLoadMarked",
                "nativeCheckIncomplete",
                "nativeCheckResp")),
            new HashSet<>(doomed));
    }

    @Test
    public void keyNamesMatchTheirOwners() {
        assertEquals("firstLoadMarked", UpdateContext.KEY_FIRST_LOAD_MARKED);
        assertEquals("nativeCheckIncomplete", SyncCoordinator.KEY_ROUND_INCOMPLETE);
        assertEquals("nativeCheckResp", SyncCoordinator.KEY_RESP_CACHE);
        assertEquals("nativeConfig", SyncCoordinator.KEY_CONFIG);
    }
}
