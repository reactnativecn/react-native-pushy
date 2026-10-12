package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class SyncCoordinatorTest {
    /** Settles every attempt synchronously from a per-url script. */
    private static final class ScriptedStarter implements SyncCoordinator.DownloadStarter {
        final List<String> started = new ArrayList<>();
        private final java.util.Map<String, Throwable> failures = new java.util.HashMap<>();

        ScriptedStarter fail(String url, Throwable error) {
            failures.put(url, error);
            return this;
        }

        @Override
        public DownloadTaskParams start(
            String type, String url, UpdateContext.DownloadFileListener listener, long deadlineNanos
        ) {
            started.add(type + " " + url);
            Throwable error = failures.get(url);
            if (error != null) {
                listener.onDownloadFailed(error);
            } else {
                listener.onDownloadCompleted(new DownloadTaskParams());
            }
            return null;
        }
    }

    private static JSONArray attempts(Object[]... attempts) throws Exception {
        JSONArray result = new JSONArray();
        for (Object[] attempt : attempts) {
            JSONObject entry = new JSONObject();
            entry.put("type", attempt[0]);
            entry.put("urls", new JSONArray(Arrays.asList(attempt).subList(1, attempt.length)));
            result.put(entry);
        }
        return result;
    }

    private static PatchFailedException patchFailed() {
        return new PatchFailedException("hpatch failed", null);
    }

    @Test
    public void patchFailureSkipsTheStrategysRemainingMirrors() throws Exception {
        ScriptedStarter starter = new ScriptedStarter()
            .fail("https://a/diff", patchFailed())
            .fail("https://a/full", new IOException("reset"));
        boolean downloaded = SyncCoordinator.performAttempts(
            attempts(
                new Object[] {"diff", "https://a/diff", "https://b/diff"},
                new Object[] {"full", "https://a/full", "https://b/full"}),
            "origin", true, 0, starter);

        assertTrue(downloaded);
        assertEquals(
            Arrays.asList("diff https://a/diff", "full https://a/full", "full https://b/full"),
            starter.started);
    }

    @Test
    public void retryableFailuresTryEveryMirror() throws Exception {
        ScriptedStarter starter = new ScriptedStarter()
            .fail("https://a/full", new IOException("timeout"))
            .fail("https://b/full", new FileOperationException("refused"));
        boolean downloaded = SyncCoordinator.performAttempts(
            attempts(new Object[] {"full", "https://a/full", "https://b/full"}),
            "", true, 0, starter);

        assertFalse(downloaded);
        assertEquals(
            Arrays.asList("full https://a/full", "full https://b/full"), starter.started);
    }

    @Test
    public void httpsOnlyRoundsSkipCleartextArtifactUrls() throws Exception {
        ScriptedStarter starter = new ScriptedStarter();
        assertTrue(SyncCoordinator.performAttempts(
            attempts(new Object[] {"full", "http://a/full", "HTTP://b/full", "https://c/full"}),
            "", true, 0, starter));
        assertEquals(Arrays.asList("full https://c/full"), starter.started);

        ScriptedStarter plain = new ScriptedStarter();
        assertTrue(SyncCoordinator.performAttempts(
            attempts(new Object[] {"full", "http://a/full"}), "", false, 0, plain));
        assertEquals(Arrays.asList("full http://a/full"), plain.started);
    }

    @Test
    public void diffNeedsARunningVersion() throws Exception {
        ScriptedStarter starter = new ScriptedStarter();
        assertTrue(SyncCoordinator.performAttempts(
            attempts(
                new Object[] {"diff", "https://a/diff"},
                new Object[] {"pdiff", "https://a/pdiff"}),
            "", true, 0, starter));
        assertEquals(Arrays.asList("pdiff https://a/pdiff"), starter.started);
    }

    @Test
    public void httpsOnlyRequiresEveryConfiguredEndpointToBeHttps() {
        assertTrue(SyncCoordinator.isHttpsOnly(new JSONArray(Arrays.asList("https://a", "HTTPS://b"))));
        assertFalse(SyncCoordinator.isHttpsOnly(new JSONArray(Arrays.asList("https://a", "http://b"))));
        assertFalse(SyncCoordinator.isHttpsOnly(new JSONArray()));
        assertFalse(SyncCoordinator.isHttpsOnly(null));
        assertFalse(SyncCoordinator.isHttpsOnly(new JSONArray(Arrays.asList(1))));
    }

    @Test
    public void onlyPatchFailuresAreNotMirrorRetryable() {
        assertEquals("PATCH_FAILED", ErrorCodes.forDownloadFailure(patchFailed()));
        assertEquals("FILE_OPERATION_FAILED",
            ErrorCodes.forDownloadFailure(new FileOperationException("x")));
        assertEquals("DOWNLOAD_FAILED", ErrorCodes.forDownloadFailure(new IOException("x")));
        assertFalse(ErrorCodes.isMirrorRetryable("PATCH_FAILED"));
        assertTrue(ErrorCodes.isMirrorRetryable("DOWNLOAD_FAILED"));
        assertTrue(ErrorCodes.isMirrorRetryable("FILE_OPERATION_FAILED"));
    }
}
