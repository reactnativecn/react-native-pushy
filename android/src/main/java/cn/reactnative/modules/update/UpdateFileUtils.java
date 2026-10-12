package cn.reactnative.modules.update;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

final class UpdateFileUtils {
    /** The one IO block size: stream copies, digests, downloads, unzip. */
    static final int BUFFER_SIZE = 64 * 1024;

    private UpdateFileUtils() {
    }

    // Server-provided identifiers (hash/originHash/fileName) become child
    // names under the update root; anything that could resolve outside of it
    // (path separators, "..", ".") must be rejected before touching the
    // filesystem.
    static boolean isSafePathComponent(String name) {
        return name != null
                && !name.isEmpty()
                && !name.equals(".")
                && !name.equals("..")
                && !name.contains("/")
                && !name.contains("\\")
                && name.indexOf('\0') < 0;
    }

    static void ensureDirectory(File directory) throws IOException {
        if (!directory.exists() && !directory.mkdirs() && !directory.exists()) {
            throw new IOException("Failed to create directory: " + directory);
        }
    }

    static void ensureParentDirectory(File file) throws IOException {
        File parent = file.getParentFile();
        if (parent != null) {
            ensureDirectory(parent);
        }
    }

    static void removeDirectory(File file) throws IOException {
        if (file.isDirectory()) {
            File[] files = file.listFiles();
            if (files != null) {
                for (File child : files) {
                    String name = child.getName();
                    if (name.equals(".") || name.equals("..")) {
                        continue;
                    }
                    removeDirectory(child);
                }
            }
        }
        if (file.exists() && !file.delete()) {
            throw new IOException("Failed to delete " + file);
        }
    }

    static MessageDigest newSha256() throws IOException {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException("SHA-256 unavailable", e);
        }
    }

    /** Feeds the whole file into digest (streaming, bounded memory). */
    static void updateDigest(MessageDigest digest, File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            updateDigest(digest, in);
        }
    }

    /** Feeds the rest of the stream into digest; the caller closes it. */
    static void updateDigest(MessageDigest digest, InputStream in) throws IOException {
        byte[] buffer = new byte[BUFFER_SIZE];
        int read;
        while ((read = in.read(buffer)) != -1) {
            digest.update(buffer, 0, read);
        }
    }

    static String toHex(byte[] digest) {
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            hex.append(Character.forDigit((b >> 4) & 0xf, 16));
            hex.append(Character.forDigit(b & 0xf, 16));
        }
        return hex.toString();
    }

    /** Streaming SHA-256 of a file, lowercase hex. */
    static String sha256Hex(File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            return sha256Hex(in);
        }
    }

    /** Streaming SHA-256 of the rest of the stream, lowercase hex; the caller closes it. */
    static String sha256Hex(InputStream in) throws IOException {
        MessageDigest md = newSha256();
        updateDigest(md, in);
        return toHex(md.digest());
    }

    static void copyFile(File from, File to) throws IOException {
        ensureParentDirectory(to);
        try (
            InputStream in = new FileInputStream(from);
            FileOutputStream out = new FileOutputStream(to)
        ) {
            copy(in, out);
        }
    }

    static void copyInputStreamToFile(InputStream input, File destination) throws IOException {
        ensureParentDirectory(destination);
        try (InputStream in = input; FileOutputStream out = new FileOutputStream(destination)) {
            copy(in, out);
        }
    }

    /** Copies the rest of the stream; the caller closes both ends. */
    static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[BUFFER_SIZE];
        int count;
        while ((count = in.read(buffer)) != -1) {
            out.write(buffer, 0, count);
        }
    }

    /**
     * Reads the whole stream (and closes it), failing once it exceeds
     * maxBytes: small server- or archive-provided documents must not be
     * able to exhaust memory.
     */
    static byte[] readBytes(InputStream input, long maxBytes) throws IOException {
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[BUFFER_SIZE];
            int count;
            long total = 0;
            while ((count = in.read(buffer)) != -1) {
                total += count;
                if (total > maxBytes) {
                    throw new IOException("content exceeds " + maxBytes + " bytes");
                }
                out.write(buffer, 0, count);
            }
            return out.toByteArray();
        }
    }

    /** A small UTF-8 text file (a record, a sidecar), at most maxBytes long. */
    static String readSmallUtf8(File file, long maxBytes) throws IOException {
        return new String(readBytes(new FileInputStream(file), maxBytes), StandardCharsets.UTF_8);
    }
}
