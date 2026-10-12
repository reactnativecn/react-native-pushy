package cn.reactnative.modules.update;

import static org.junit.Assert.assertArrayEquals;
import org.junit.Test;

public class CleanupKeepNamesTest {
    @Test
    public void keepsDistinctNonEmptyNamesInOrder() {
        assertArrayEquals(new String[] {"current", "running"},
            CleanupKeepNames.select("current", null, "running"));
        assertArrayEquals(new String[] {"same", "running"},
            CleanupKeepNames.select("same", "same", "running"));
        assertArrayEquals(new String[] {"running"},
            CleanupKeepNames.select(null, "", "running"));
        assertArrayEquals(new String[0], CleanupKeepNames.select(null, null, null));
    }

    @Test
    public void protectsThreeDistinctLiveVersions() {
        assertArrayEquals(new String[] {"current", "previous", "running"},
            CleanupKeepNames.select("current", "previous", "running"));
    }
}
