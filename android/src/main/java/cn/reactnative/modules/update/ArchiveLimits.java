package cn.reactnative.modules.update;

/**
 * Damage bounds for a corrupt or hostile update package. The accounting
 * itself (entry count, sizes, ratios, reserved names, the unknown-length
 * probe plan) is the shared core's (cpp/patch_core/archive_limits.h, over
 * JNI); the constants below are the ones this side still compares against
 * itself, mirrored by hand (scripts/check-constant-parity.js asserts they
 * match the header).
 */
final class ArchiveLimits {
    static final long MAX_ARCHIVE_BYTES = 512L * 1024 * 1024;
    static final long MAX_TOTAL_UNCOMPRESSED_BYTES = 2048L * 1024 * 1024;
    static final long MAX_ENTRY_BYTES = 512L * 1024 * 1024;
    static final long MAX_MANIFEST_BYTES = 16L * 1024 * 1024;
    static final long FREE_DISK_MARGIN_BYTES = 64L * 1024 * 1024;

    private ArchiveLimits() {
    }

    /**
     * Fails when the file system holding {@code target} cannot take
     * {@code bytesToWrite} more bytes plus the safety margin. 0 usable space
     * (unsupported file system) is treated as unknown and passes.
     */
    static void ensureFreeSpace(java.io.File target, long bytesToWrite)
        throws java.io.IOException {
        java.io.File probe = target;
        while (probe != null && !probe.exists()) {
            probe = probe.getParentFile();
        }
        if (probe == null) {
            return;
        }
        long usable = probe.getUsableSpace();
        if (usable <= 0) {
            return;
        }
        long needed = Math.max(0, bytesToWrite) + FREE_DISK_MARGIN_BYTES;
        if (usable < needed) {
            throw new java.io.IOException(
                "insufficient disk space: need " + needed + " bytes, have " + usable);
        }
    }

    /**
     * The central directory (one entry per index) through the shared
     * EntryAccumulator. Returns the total uncompressed size; throws with the
     * first violation.
     */
    static native long checkEntries(
        long archiveBytes, String[] names, long[] sizes, long[] compressedSizes)
        throws java.io.IOException;

    /**
     * Before one chunk of a download is written: {bytes to probe for, 0 when
     * no probe is due; the reservation end after the chunk}. writtenBefore
     * counts this response's body bytes before the chunk.
     */
    static native long[] planFreeSpaceProbe(
        long knownTotal, long writtenBefore, long chunkBytes, long reservedUntil);
}
