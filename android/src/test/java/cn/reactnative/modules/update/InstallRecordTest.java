package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;

import java.io.File;
import org.junit.Test;

/**
 * The record logic itself is the shared core's (cpp/patch_core/install_record.h,
 * replayed against tests/install-record-vectors.json by the C++ test); the JVM
 * cannot load the Android library, so only the paths built here are tested.
 */
public class InstallRecordTest {
    private static final String HASH = "0123456789abcdef";

    @Test
    public void stagingDirectoryIsASibling() {
        File version = new File("/data/_update/" + HASH);
        assertEquals(new File("/data/_update/" + HASH + InstallRecord.STAGING_SUFFIX),
            InstallRecord.stagingDirectoryFor(version));
    }

    @Test
    public void bundleLivesInTheVersionDirectory() {
        File version = new File("/data/_update/" + HASH);
        assertEquals(new File(version, "index.bundlejs"), InstallRecord.bundleFile(version));
    }
}
