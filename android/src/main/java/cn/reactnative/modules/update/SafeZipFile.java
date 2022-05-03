package cn.reactnative.modules.update;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Enumeration;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

public class SafeZipFile extends ZipFile {

    public SafeZipFile(File file) throws IOException {
        super(file);
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
                    throw new SecurityException("illegal entry: " + entry.getName());
                }
            }
            return entry;
        }
    }

    public void unzipToFile(ZipEntry entry, File output) throws IOException {
        InputStream inputStream = null;
        try {
            inputStream = getInputStream(entry);
            writeOutInputStream(output, inputStream);
        } finally {
            if (inputStream != null) {
                inputStream.close();
            }
        }
    }

    private void writeOutInputStream(File file, InputStream inputStream) throws IOException {
        BufferedOutputStream output = null;
        try {
            output = new BufferedOutputStream(
                    new FileOutputStream(file));
            BufferedInputStream input = new BufferedInputStream(inputStream);
            byte b[] = new byte[8192];
            int n;
            while ((n = input.read(b, 0, 8192)) >= 0) {
                output.write(b, 0, n);
            }
        } finally {
            if (output != null) {
                output.close();
            }
        }
    }
}