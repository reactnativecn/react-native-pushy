package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class HttpUtilsTest {
    @Test
    public void isHttpsUrlIsCaseInsensitiveAndStrict() {
        assertTrue(HttpUtils.isHttpsUrl("https://example.com/app.apk"));
        assertTrue(HttpUtils.isHttpsUrl("HTTPS://example.com/app.apk"));
        assertFalse(HttpUtils.isHttpsUrl("http://example.com/app.apk"));
        assertFalse(HttpUtils.isHttpsUrl("https:/example.com"));
        assertFalse(HttpUtils.isHttpsUrl("ftp://example.com"));
        assertFalse(HttpUtils.isHttpsUrl(""));
        assertFalse(HttpUtils.isHttpsUrl(null));
    }

    @Test
    public void revealDecodesEncodedText() {
        // Encoded with scripts/encode-native-text.ts.
        assertEquals("/checkUpdate/", Texts.reveal("7514fcd4ad805d55263e08fc99"));
        assertEquals("https://update.react-native.cn/api",
            Texts.reveal("3203e0c1bdd1270a372f18f8c2b6de7f4f2607f5b3d5b9817b592947e5cdefbc8a7e"));
        assertEquals("", Texts.reveal(""));
    }
}
