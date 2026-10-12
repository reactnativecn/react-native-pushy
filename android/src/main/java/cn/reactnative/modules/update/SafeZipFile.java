package cn.reactnative.modules.update;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;


public class SafeZipFile extends ZipFile {

    public SafeZipFile(File file) throws IOException {
        super(file);
    }

    // Bytes written by unzipToFile across the archive: the central
    // directory's declared sizes are checked up front (inspect), the actual
    // stream is re-checked here — headers can lie.
    private long totalWritten = 0;

    /**
     * Walks the central directory once and hands it to the shared accounting
     * (ArchiveLimits.checkEntries: entry count, per-entry and total size,
     * compression ratios, reserved `.pushy-` names) before a single byte is
     * extracted. Returns the total uncompressed size.
     */
    long inspect(long archiveBytes) throws IOException {
        ArrayList<? extends ZipEntry> entries = Collections.list(entries());
        int count = entries.size();
        String[] names = new String[count];
        long[] sizes = new long[count];
        long[] compressedSizes = new long[count];
        for (int i = 0; i < count; i++) {
            ZipEntry entry = entries.get(i);
            names[i] = entry.getName();
            sizes[i] = entry.getSize();
            compressedSizes[i] = entry.getCompressedSize();
        }
        return ArchiveLimits.checkEntries(archiveBytes, names, sizes, compressedSizes);
    }

    @Override
    public Enumeration<? extends ZipEntry> entries() {
        return new SafeZipEntryIterator(super.entries());
    }

    private static class SafeZipEntryIterator implements Enumeration<ZipEntry> {

        final private Enumeration<? extends ZipEntry> delegate;

        private SafeZipEntryIterator(Enumeration<? extends ZipEntry> delegate) {
            this.delegate = delegate;
        }

        @Override
        public boolean hasMoreElements() {
            return delegate.hasMoreElements();
        }

        @Override
        public ZipEntry nextElement() {
            ZipEntry entry = delegate.nextElement();
            if (null != entry) {
                String name = entry.getName();
                /**
                 * avoid ZipperDown
                 */
                if (null != name && (name.contains("../") || name.contains("..\\"))) {
                    throw new SecurityException("illegal entry: " + name);
                }
            }
            return entry;
        }
    }

    public void unzipToPath(ZipEntry ze, File targetPath) throws IOException {
        unzipToPath(ze, targetPath, null);
    }

    /** As above; a non-null digest is fed every byte written for the entry. */
    void unzipToPath(ZipEntry ze, File targetPath, MessageDigest digest) throws IOException {
        String name = ze.getName();
        File target = new File(targetPath, name);

        // Fixing a Zip Path Traversal Vulnerability
        // https://support.google.com/faqs/answer/9294009
        String canonicalPath = target.getCanonicalPath();
        if (!canonicalPath.startsWith(targetPath.getCanonicalPath() + File.separator)) {
            throw new SecurityException("Illegal name: " + name);
        }
        if (ze.isDirectory()) {
            target.mkdirs();
            return;
        }
        unzipToFile(ze, target, digest);
    }

    public void unzipToFile(ZipEntry ze, File target) throws IOException {
        unzipToFile(ze, target, null);
    }

    private void unzipToFile(ZipEntry ze, File target, MessageDigest digest) throws IOException {
        UpdateFileUtils.ensureParentDirectory(target);

        // The declared size is the budget when known; otherwise the global
        // per-entry cap. Either way the stream may not exceed it.
        long declared = ze.getSize();
        long budget = declared >= 0
            ? Math.min(declared, ArchiveLimits.MAX_ENTRY_BYTES)
            : ArchiveLimits.MAX_ENTRY_BYTES;
        long written = 0;
        // One 64KB buffer, no extra buffered wrappers: every read/write is
        // already a large block.
        try (InputStream input = getInputStream(ze)) {
            try (OutputStream output = digest == null
                     ? new FileOutputStream(target)
                     : new DigestOutputStream(new FileOutputStream(target), digest)) {
                byte[] buffer = new byte[UpdateFileUtils.BUFFER_SIZE];
                int n;
                while ((n = input.read(buffer, 0, buffer.length)) >= 0) {
                    written += n;
                    totalWritten += n;
                    if (written > budget) {
                        throw new IOException(
                            "archive entry exceeds its declared size: " + ze.getName());
                    }
                    if (totalWritten > ArchiveLimits.MAX_TOTAL_UNCOMPRESSED_BYTES) {
                        throw new IOException("archive expands beyond "
                            + ArchiveLimits.MAX_TOTAL_UNCOMPRESSED_BYTES + " bytes");
                    }
                    output.write(buffer, 0, n);
                }
            }
        }
    }

}
