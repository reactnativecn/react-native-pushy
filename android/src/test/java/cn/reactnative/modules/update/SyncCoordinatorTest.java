package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.Test;

// The round's policy (order, mirror retry, budgets, commit and result
// mapping) is the shared engine's, pinned by
// cpp/update_flow_core/tests/round-engine-vectors.json. These cover what the
// Android adapter adds: running one download command and reporting it back.
public class SyncCoordinatorTest {
    /** Settles (or, with no outcome, never settles) each attempt synchronously. */
    private static final class ScriptedStarter implements SyncCoordinator.DownloadStarter {
        final List<String> started = new ArrayList<>();
        private final Throwable error;
        private final boolean settles;
        boolean cancelled;

        ScriptedStarter(Throwable error, boolean settles) {
            this.error = error;
            this.settles = settles;
        }

        @Override
        public DownloadTaskParams start(
            String strategy, String url, String hash, String originHash,
            UpdateContext.DownloadFileListener listener, long deadlineNanos
        ) {
            started.add(strategy + " " + url + " " + hash + " " + originHash);
            if (!settles) {
                return new DownloadTaskParams() {
                    @Override
                    void cancel() {
                        cancelled = true;
                    }
                };
            }
            if (error != null) {
                listener.onDownloadFailed(error);
            } else {
                listener.onDownloadCompleted(new DownloadTaskParams());
            }
            return null;
        }
    }

    private static JSONObject command(String strategy, long budgetMillis) throws Exception {
        JSONObject command = new JSONObject()
            .put("type", "download")
            .put("strategy", strategy)
            .put("url", "https://a/" + strategy)
            .put("hash", "h2")
            .put("deadline", SyncCoordinator.engineMillis(
                System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(budgetMillis)));
        if ("diff".equals(strategy)) {
            command.put("originHash", "cur");
        }
        return command;
    }

    @Test
    public void aSettledAttemptReportsOk() throws Exception {
        ScriptedStarter starter = new ScriptedStarter(null, true);
        JSONObject event = SyncCoordinator.download(command("diff", 10_000), starter);

        assertTrue(event.getBoolean("ok"));
        assertFalse(event.has("code"));
        assertEquals("diff https://a/diff h2 cur", starter.started.get(0));
    }

    @Test
    public void aFailureReportsItsErrorCode() throws Exception {
        JSONObject patch = SyncCoordinator.download(command("pdiff", 10_000),
            new ScriptedStarter(new PatchFailedException("hpatch failed", null), true));
        JSONObject network = SyncCoordinator.download(command("full", 10_000),
            new ScriptedStarter(new IOException("reset"), true));

        assertFalse(patch.getBoolean("ok"));
        assertEquals("PATCH_FAILED", patch.getString("code"));
        assertEquals("DOWNLOAD_FAILED", network.getString("code"));
    }

    @Test
    public void anAttemptPastItsDeadlineIsCancelledAndTimedOut() throws Exception {
        ScriptedStarter starter = new ScriptedStarter(null, false);
        JSONObject event = SyncCoordinator.download(command("full", 50), starter);

        assertTrue(event.getBoolean("timedOut"));
        assertTrue(starter.cancelled);
        assertEquals("full https://a/full h2 null", starter.started.get(0));
    }

    @Test
    public void onlyPatchFailuresAreNotMirrorRetryable() {
        assertEquals("PATCH_FAILED",
            ErrorCodes.forDownloadFailure(new PatchFailedException("x", null)));
        assertEquals("FILE_OPERATION_FAILED",
            ErrorCodes.forDownloadFailure(new FileOperationException("x")));
        assertEquals("DOWNLOAD_FAILED", ErrorCodes.forDownloadFailure(new IOException("x")));
        assertFalse(ErrorCodes.isMirrorRetryable("PATCH_FAILED"));
        assertTrue(ErrorCodes.isMirrorRetryable("DOWNLOAD_FAILED"));
        assertTrue(ErrorCodes.isMirrorRetryable("FILE_OPERATION_FAILED"));
    }
}
