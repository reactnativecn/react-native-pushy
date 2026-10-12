package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class SafeZipFileTest {
    @Rule
    public TemporaryFolder temp = new TemporaryFolder();

    private File zipOf(Map<String, byte[]> entries) throws IOException {
        File file = temp.newFile();
        try (ZipOutputStream out = new ZipOutputStream(new FileOutputStream(file))) {
            for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
                out.putNextEntry(new ZipEntry(entry.getKey()));
                if (entry.getValue() != null) {
                    out.write(entry.getValue());
                }
                out.closeEntry();
            }
        }
        return file;
    }

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static void drain(SafeZipFile zip) {
        Enumeration<? extends ZipEntry> entries = zip.entries();
        while (entries.hasMoreElements()) {
            entries.nextElement();
        }
    }

    @Test
    public void entriesRejectTraversalNames() throws IOException {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("ok.txt", utf8("ok"));
        entries.put("../evil.txt", utf8("evil"));
        try (SafeZipFile zip = new SafeZipFile(zipOf(entries))) {
            drain(zip);
            fail("traversal entry must be rejected");
        } catch (SecurityException expected) {
            assertTrue(expected.getMessage().contains("../evil.txt"));
        }
    }

    @Test
    public void unzipToPathRejectsTraversal() throws IOException {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("ok.txt", utf8("ok"));
        File target = temp.newFolder();
        try (SafeZipFile zip = new SafeZipFile(zipOf(entries))) {
            try {
                zip.unzipToPath(new ZipEntry("../escape.txt"), target);
                fail("traversal must be rejected before extraction");
            } catch (SecurityException expected) {
                // expected
            }
        }
        assertFalse(new File(temp.getRoot(), "escape.txt").exists());
    }

    @Test
    public void unzipToPathExtractsFilesAndDirectories() throws IOException {
        Map<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("assets/", null);
        entries.put("assets/logo.png", new byte[] {1, 2, 3});
        entries.put("index.bundlejs", utf8("console.log(1)"));
        File target = temp.newFolder();
        try (SafeZipFile zip = new SafeZipFile(zipOf(entries))) {
            Enumeration<? extends ZipEntry> it = zip.entries();
            while (it.hasMoreElements()) {
                zip.unzipToPath(it.nextElement(), target);
            }
        }
        assertTrue(new File(target, "assets").isDirectory());
        assertEquals(3, new File(target, "assets/logo.png").length());
        assertEquals("console.log(1)", new String(
            Files.readAllBytes(new File(target, "index.bundlejs").toPath()),
            StandardCharsets.UTF_8));
    }

    // The entry accounting (count, sizes, ratios, reserved names) is the
    // shared core's: ArchiveLimits.checkEntries over JNI, which the JVM
    // cannot load. cpp/patch_core/tests/archive-limits-vectors.json covers it.
}
