package cn.reactnative.modules.update;

import java.io.File;
import java.io.IOException;

/**
 * The completion record written as the last step of a two-phase install and
 * read back before a version directory is trusted. The logic is the shared
 * core's (cpp/patch_core/install_record.h, over JNI); only the paths are
 * built here. Every call does file IO and checkActivation hashes the whole
 * bundle: callers run on worker threads (download tasks, the state serial
 * thread, the sync coordinator), except the launch-time reads of
 * isInstalled / recordedBundleSha256, which only stat and read the record.
 */
final class InstallRecord {
    // Mirrors install_record.h kStagingSuffix (scripts/check-constant-parity.js).
    static final String STAGING_SUFFIX = ".staging";
    /** The JS bundle inside a version directory. */
    static final String BUNDLE_FILE_NAME = "index.bundlejs";

    private InstallRecord() {
    }

    static File bundleFile(File versionDir) {
        return new File(versionDir, BUNDLE_FILE_NAME);
    }

    static File stagingDirectoryFor(File versionDir) {
        return new File(versionDir.getPath() + STAGING_SUFFIX);
    }

    /**
     * Launch / dedup presence check: the bundle exists and the record names
     * this version (or is the legacy empty marker). No digest work.
     */
    static boolean isInstalled(File versionDir, String versionHash) {
        return isComplete(versionDir.getPath(), versionHash, BUNDLE_FILE_NAME);
    }

    /**
     * Activation check: the bundle exists and its bytes match the record's
     * mandatory digest (the legacy empty marker has none). A directory
     * without a record passes only when {@code grandfathered} (it is the
     * persisted current or last version). Throws with the reason otherwise.
     */
    static void verifyInstalled(File versionDir, String versionHash, boolean grandfathered)
        throws IOException {
        String reason = checkActivation(
            versionDir.getPath(), versionHash, BUNDLE_FILE_NAME, grandfathered);
        if (reason != null) {
            throw new IOException(reason);
        }
    }

    /**
     * Writes the record (with the staged bundle's digest: knownBundleSha256
     * when the bundle was hashed while extracted, else hashed now) into the
     * staging directory, atomically and durably.
     */
    static void seal(
        File stagingDir, String versionHash, String artifactSha256, String knownBundleSha256
    ) throws IOException {
        String reason = sealStaging(stagingDir.getPath(), versionHash, BUNDLE_FILE_NAME,
            artifactSha256, knownBundleSha256);
        if (reason != null) {
            throw new IOException(reason);
        }
    }

    /** Renames the sealed staging directory to the (absent) version directory. */
    static void promote(File stagingDir, File versionDir) throws IOException {
        String reason = promoteStaging(stagingDir.getPath(), versionDir.getPath());
        if (reason != null) {
            throw new IOException(reason);
        }
    }

    /** The record's bundleSha256 (crash attribution); "" when there is none. */
    static String recordedBundleSha256(File versionDir) {
        String digest = bundleSha256Of(versionDir.getPath());
        return digest == null ? "" : digest;
    }

    private static native boolean isComplete(
        String versionDir, String versionHash, String bundleFileName);

    // These return null on success, the reason otherwise.
    private static native String checkActivation(
        String versionDir, String versionHash, String bundleFileName, boolean grandfathered);

    private static native String sealStaging(
        String stagingDir,
        String versionHash,
        String bundleFileName,
        String artifactSha256,
        String knownBundleSha256);

    private static native String promoteStaging(String stagingDir, String versionDir);

    private static native String bundleSha256Of(String versionDir);
}
