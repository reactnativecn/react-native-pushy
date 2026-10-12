package cn.reactnative.modules.update;

import android.os.Build;
import android.util.Log;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Java mirror of cpp/patch_core/install_record.h — keep in sync by hand.
 * The completion record written as the last step of a two-phase install and
 * read back before a version directory is trusted.
 */
final class InstallRecord {
    static final int SCHEMA = 1;
    static final String FILE_NAME = ".pushy-complete";
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
     * bundleSha256 is mandatory for schema 1: a version whose bundle could
     * not be hashed must fail its install, never be recorded unverifiable.
     */
    static String build(String versionHash, String bundleSha256, String artifactSha256)
        throws IOException, JSONException {
        if (bundleSha256 == null || bundleSha256.isEmpty()) {
            throw new IOException("Bundle version " + versionHash + " has no bundle digest.");
        }
        JSONObject record = new JSONObject();
        record.put("schema", SCHEMA);
        record.put("versionHash", versionHash);
        record.put("bundleSha256", bundleSha256);
        if (artifactSha256 != null && !artifactSha256.isEmpty()) {
            record.put("artifactSha256", artifactSha256);
        }
        return record.toString();
    }

    /**
     * Writes the record and fsyncs it, then the directory holding it: the
     * rename that follows must find the record on disk, and the new
     * directory entry is only durable once the directory itself is synced.
     */
    static void write(File versionDir, String recordJson) throws IOException {
        File file = new File(versionDir, FILE_NAME);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(recordJson.getBytes(StandardCharsets.UTF_8));
            out.flush();
            out.getFD().sync();
        }
        syncDirectory(versionDir);
    }

    // java.nio.file (the only way to open a directory for fsync from Java)
    // is API 26+ on Android; below that the file fsync above is all there
    // is. Best-effort by design: a file system that refuses to open a
    // directory for reading must not fail the install. Also called by the
    // installer on the versions root after the staging -> version rename:
    // that rename changes the parent's entries, which only the parent's own
    // sync makes durable.
    static void syncDirectory(File dir) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        try (java.nio.channels.FileChannel channel = java.nio.channels.FileChannel.open(
                dir.toPath(), java.nio.file.StandardOpenOption.READ)) {
            channel.force(true);
        } catch (Throwable e) {
            Log.w("pushy", "Directory fsync skipped for " + dir + ": " + e);
        }
    }

    /**
     * Parsed record, or null when the file is absent or malformed. An empty
     * file (legacy marker) yields an empty JSONObject.
     */
    static JSONObject read(File versionDir) {
        File file = new File(versionDir, FILE_NAME);
        if (!file.isFile()) {
            return null;
        }
        if (file.length() == 0) {
            return new JSONObject();
        }
        if (file.length() > 64 * 1024) {
            return null;
        }
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] bytes = new byte[(int) file.length()];
            int offset = 0;
            while (offset < bytes.length) {
                int read = in.read(bytes, offset, bytes.length - offset);
                if (read < 0) {
                    break;
                }
                offset += read;
            }
            return new JSONObject(new String(bytes, 0, offset, StandardCharsets.UTF_8));
        } catch (IOException | JSONException e) {
            return null;
        }
    }

    /**
     * Presence check: the record exists and, unless legacy-empty, names this
     * version. No digest work — this runs on launch / dedup paths.
     */
    static boolean isComplete(File versionDir, String versionHash) {
        JSONObject record = read(versionDir);
        return record != null && (record.length() == 0 || names(record, versionHash));
    }

    /** A schema-1 record for this version (the legacy empty marker has no fields). */
    private static boolean names(JSONObject record, String versionHash) {
        return record.optInt("schema", 0) == SCHEMA
            && versionHash.equals(record.optString("versionHash", ""));
    }

    /**
     * Launch / dedup presence check: the bundle exists and the record names
     * this version. No digest work.
     */
    static boolean isInstalled(File versionDir, String versionHash) {
        return bundleFile(versionDir).isFile() && isComplete(versionDir, versionHash);
    }

    /**
     * Activation check of an installed version: the bundle exists and its
     * bytes match the record's digest. Throws with the reason otherwise.
     */
    static void verifyInstalled(File versionDir, String versionHash) throws IOException {
        File bundle = bundleFile(versionDir);
        if (!bundle.isFile()) {
            throw new IOException("Bundle version " + versionHash + " not found.");
        }
        verifyForActivation(versionDir, versionHash, bundle);
    }

    /**
     * Activation check: re-hashes the bundle against the record's digest,
     * which schema 1 makes mandatory (only the legacy empty marker has none).
     * Throws with the reason when the directory must not be activated.
     */
    static void verifyForActivation(File versionDir, String versionHash, File bundleFile)
        throws IOException {
        JSONObject record = read(versionDir);
        if (record == null) {
            throw new IOException("Bundle version " + versionHash + " has no valid completion record.");
        }
        if (record.length() == 0) {
            return;
        }
        if (!names(record, versionHash)) {
            throw new IOException("Bundle version " + versionHash + " completion record mismatch.");
        }
        Object digest = record.opt("bundleSha256");
        String expected = digest instanceof String ? (String) digest : "";
        if (expected.isEmpty()) {
            throw new IOException("Bundle version " + versionHash + " completion record mismatch.");
        }
        String actual = UpdateFileUtils.sha256Hex(bundleFile);
        if (!expected.equalsIgnoreCase(actual)) {
            throw new IOException("Bundle version " + versionHash + " bundle digest mismatch.");
        }
    }
}
