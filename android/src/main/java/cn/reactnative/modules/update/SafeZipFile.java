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
        // https://support.google.com/faqs/answer/9294009
        String canonicalPath = file.getCanonicalPath();
        if (!canonicalPath.startsWith(UpdateContext.getRootDir())) {
            throw new SecurityException("illegal entry: " + file.getName());
        }
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