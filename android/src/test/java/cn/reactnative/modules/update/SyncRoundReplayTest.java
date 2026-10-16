package cn.reactnative.modules.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

// The Android adapter of the shared round engine (SyncCoordinator.runOnce),
// run against the rounds in
// cpp/update_flow_core/tests/round-engine-vectors.json: the vector's commands
// stand in for the engine, and the IO those commands ask for is faked from
// the vector's next event. The adapter must answer each command with the
// event the vector expects, run each command with the arguments it carries,
// and map the finish to its result. Same idea as Harmony's
// src/__tests__/harmonySyncRound.test.ts.
@RunWith(Parameterized.class)
public class SyncRoundReplayTest {
    // What an adapter decides by itself, plus the clock it stamps (the fake
    // clock reads the vector's). crashHold is compared separately: the
    // vectors carry it once, Android repeats it on every later event.
    private static final List<String> ANSWER_FIELDS = Arrays.asList(
        "type", "text", "installed", "ok", "code", "timedOut", "reason", "error",
        "activated", "now");

    private static JSONObject vectors;

    private static JSONObject vectors() throws IOException, JSONException {
        if (vectors == null) {
            String path = "cpp/update_flow_core/tests/round-engine-vectors.json";
            File dir = new File(System.getProperty("user.dir")).getAbsoluteFile();
            while (dir != null && !new File(dir, path).isFile()) {
                dir = dir.getParentFile();
            }
            if (dir == null) {
                throw new IOException(path + " not found above " + System.getProperty("user.dir"));
            }
            vectors = new JSONObject(new String(
                Files.readAllBytes(new File(dir, path).toPath()), StandardCharsets.UTF_8));
        }
        return vectors;
    }

    // A string "@name" anywhere in a round stands for fixtures[name].
    private static Object withFixtures(Object value, JSONObject fixtures) throws JSONException {
        if (value instanceof String && ((String) value).startsWith("@")) {
            return fixtures.get(((String) value).substring(1));
        }
        if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            JSONArray out = new JSONArray();
            for (int i = 0; i < array.length(); i++) {
                out.put(withFixtures(array.get(i), fixtures));
            }
            return out;
        }
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            JSONObject out = new JSONObject();
            for (Iterator<String> keys = object.keys(); keys.hasNext(); ) {
                String key = keys.next();
                out.put(key, withFixtures(object.get(key), fixtures));
            }
            return out;
        }
        return value;
    }

    // Rounds whose events carry what Android never produces (a launch that
    // waits on the round, an activation the commit dropped — both the tvOS
    // purge restore's; a failed download without an error code) or that feed
    // the engine protocol errors on purpose.
    private static boolean replayable(String name, JSONArray steps) throws JSONException {
        if (name.contains("internal_error")) {
            return false;
        }
        for (int i = 0; i < steps.length(); i++) {
            JSONObject event = steps.getJSONObject(i).getJSONObject("event");
            String type = event.optString("type");
            if ((i == 0) != "start".equals(type)
                || event.optBoolean("forceActivate")
                || event.has("activated")
                || ("download".equals(type) && !event.optBoolean("ok")
                    && !event.optBoolean("timedOut") && !event.has("code"))) {
                return false;
            }
        }
        return true;
    }

    @Parameterized.Parameters(name = "{0}")
    public static Collection<Object[]> rounds() throws IOException, JSONException {
        JSONObject file = vectors();
        JSONObject fixtures = file.getJSONObject("fixtures");
        JSONArray rounds = file.getJSONArray("rounds");
        List<Object[]> out = new ArrayList<>();
        for (int i = 0; i < rounds.length(); i++) {
            JSONObject round = rounds.getJSONObject(i);
            JSONArray steps = (JSONArray) withFixtures(round.getJSONArray("steps"), fixtures);
            if (replayable(round.getString("name"), steps)) {
                out.add(new Object[] {round.getString("name"), steps});
            }
        }
        return out;
    }

    private final JSONArray steps;

    public SyncRoundReplayTest(String name, JSONArray steps) {
        this.steps = steps;
    }

    private static String canonical(Object value) {
        if (value instanceof Number) {
            return new BigDecimal(value.toString()).stripTrailingZeros().toPlainString();
        }
        return String.valueOf(value);
    }

    private static Map<String, String> answer(JSONObject event) throws JSONException {
        Map<String, String> out = new TreeMap<>();
        for (String key : ANSWER_FIELDS) {
            if (event.has(key)) {
                out.put(key, canonical(event.get(key)));
            }
        }
        // The engine reads ok as truthy: absent is false.
        String type = event.optString("type");
        if ("download".equals(type) || "committed".equals(type)) {
            out.put("ok", String.valueOf(event.optBoolean("ok")));
        }
        return out;
    }

    private interface JsonCall<T> {
        T call() throws JSONException;
    }

    private static <T> T unchecked(JsonCall<T> call) {
        try {
            return call.call();
        } catch (JSONException e) {
            throw new AssertionError(e);
        }
    }

    private static Throwable failureFor(String code) {
        Throwable error;
        if ("PATCH_FAILED".equals(code)) {
            error = new PatchFailedException("hpatch failed", null);
        } else if ("FILE_OPERATION_FAILED".equals(code)) {
            error = new FileOperationException("disk full");
        } else {
            error = new IOException("connection reset");
        }
        assertEquals(code, ErrorCodes.forDownloadFailure(error));
        return error;
    }

    /** Plays the vector's engine and fakes the IO from its next event. */
    private final class ScriptedRound implements SyncCoordinator.RoundHost {
        final List<JSONObject> sent = new ArrayList<>();
        final Map<String, String> kv = new HashMap<>();
        final List<String> io = new ArrayList<>();
        final List<String> expectedIo = new ArrayList<>();
        final List<DownloadTaskParams> unsettled = new ArrayList<>();
        int next;

        // The event that answers the command being run: the vector's next one.
        JSONObject expected() {
            return next < steps.length()
                ? steps.optJSONObject(next).optJSONObject("event")
                : new JSONObject();
        }

        JSONObject start() {
            return steps.optJSONObject(0).optJSONObject("event");
        }

        @Override
        public String stepRound(String state, String event) {
            sent.add(unchecked(() -> new JSONObject(event)));
            JSONArray commands = steps.optJSONObject(next++).optJSONArray("commands");
            for (int i = 0; i < commands.length(); i++) {
                JSONObject command = commands.optJSONObject(i);
                switch (command.optString("type")) {
                    case "http":
                        expectedIo.add("http " + command.optString("url") + " "
                            + (command.optBoolean("post") ? command.optString("body") : null) + " "
                            + canonical(command.opt("timeoutMs")) + " "
                            + canonical(command.opt("callTimeoutMs")));
                        break;
                    case "download":
                        expectedIo.add("download " + command.optString("strategy") + " "
                            + command.optString("url") + " " + command.optString("hash") + " "
                            + command.optString("originHash", null) + " "
                            + SyncCoordinator.engineNanos(command.optDouble("deadline")));
                        break;
                    case "commit": {
                        String hash = command.optString("hash");
                        String hashInfo = command.optString("hashInfo");
                        expectedIo.add("commit " + canonical(command.opt("resetGeneration")) + " "
                            + (hash.isEmpty() ? null : hash) + " "
                            + (hashInfo.isEmpty() ? null : hashInfo) + " "
                            + command.optBoolean("activate") + " " + command.optString("cache"));
                        break;
                    }
                    default:
                        break;
                }
            }
            return unchecked(() -> new JSONObject()
                .put("state", new JSONObject().put("step", next))
                .put("commands", commands).toString());
        }

        @Override
        public long nanoTime() {
            return SyncCoordinator.engineNanos(expected().optDouble("now", 0));
        }

        // A crash hold is sticky: it holds from the first event that carries it.
        @Override
        public boolean crashHold() {
            for (int i = 0; i <= next && i < steps.length(); i++) {
                if (steps.optJSONObject(i).optJSONObject("event").optBoolean("crashHold")) {
                    return true;
                }
            }
            return false;
        }

        @Override
        public long resetGeneration() {
            return start().optLong("resetGeneration");
        }

        // A commit lost to a config change: the config generation moved.
        @Override
        public long configGeneration() {
            long generation = start().optLong("configGeneration");
            return "config_changed".equals(expected().optString("reason"))
                ? generation + 1 : generation;
        }

        @Override
        public String getKv(String key) {
            return kv.get(key);
        }

        @Override
        public void setKv(String key, String value) {
            kv.put(key, value);
        }

        @Override
        public void removeKv(String key) {
            kv.remove(key);
        }

        @Override
        public JSONObject launchEnv() throws JSONException {
            return new JSONObject().put("packageVersion", "1.0.0");
        }

        @Override
        public String httpRequest(String url, String postBody, long timeoutMs, long callTimeoutMs) {
            io.add("http " + url + " " + postBody + " " + timeoutMs + " " + callTimeoutMs);
            return expected().has("text") ? expected().optString("text") : null;
        }

        @Override
        public double wallSeconds() {
            return 1700000000.9;
        }

        @Override
        public boolean hasCompletedVersion(String hash) {
            return expected().optBoolean("installed");
        }

        @Override
        public boolean commitSyncResult(
            long expectedGeneration, String hash, String hashInfoJson,
            boolean activate, String responseCacheJson) {
            io.add("commit " + expectedGeneration + " " + hash + " " + hashInfoJson + " "
                + activate + " " + responseCacheJson);
            JSONObject event = expected();
            if (event.optBoolean("error")) {
                throw new IllegalStateException("commit failed");
            }
            return event.optBoolean("ok");
        }

        @Override
        public DownloadTaskParams start(
            String strategy, String url, String hash, String originHash,
            UpdateContext.DownloadFileListener listener, long deadlineNanos) {
            io.add("download " + strategy + " " + url + " " + hash + " " + originHash + " "
                + deadlineNanos);
            JSONObject event = expected();
            if (event.optBoolean("timedOut")) {
                // Never settles; the clock already reads the deadline.
                DownloadTaskParams task = new DownloadTaskParams();
                unsettled.add(task);
                return task;
            }
            if (event.optBoolean("ok")) {
                listener.onDownloadCompleted(new DownloadTaskParams());
            } else {
                listener.onDownloadFailed(failureFor(event.optString("code")));
            }
            return null;
        }
    }

    @Test
    public void replaysTheRound() throws Exception {
        ScriptedRound round = new ScriptedRound();
        JSONObject start = round.start();
        String config = start.getString("config");
        if (!config.isEmpty()) {
            round.kv.put(SyncCoordinator.KEY_CONFIG, config);
        }
        double deadline = start.getDouble("deadline");

        SyncCoordinator.runOnce(round, deadline == 0 ? 0 : SyncCoordinator.engineNanos(deadline));

        List<Map<String, String>> expected = new ArrayList<>();
        List<Map<String, String>> actual = new ArrayList<>();
        boolean held = false;
        for (int i = 0; i < steps.length(); i++) {
            JSONObject event = steps.getJSONObject(i).getJSONObject("event");
            expected.add(answer(event));
            held |= event.optBoolean("crashHold");
            if (i < round.sent.size()) {
                assertEquals("crashHold of event " + i, held,
                    round.sent.get(i).optBoolean("crashHold"));
            }
        }
        for (JSONObject event : round.sent) {
            actual.add(answer(event));
        }
        assertEquals(expected, actual);
        // Each command ran with the arguments it carried.
        assertEquals(round.expectedIo, round.io);
        // An attempt past its deadline is cancelled, not left queued.
        for (DownloadTaskParams task : round.unsettled) {
            assertTrue(task.isCancelled());
        }

        // The start carries the round's facts as the adapter sampled them.
        JSONObject sentStart = round.sent.get(0);
        assertEquals(config, sentStart.getString("config"));
        assertEquals(start.getLong("resetGeneration"), sentStart.getLong("resetGeneration"));
        assertEquals(start.getLong("configGeneration"), sentStart.getLong("configGeneration"));
        assertEquals(canonical(start.get("deadline")), canonical(sentStart.get("deadline")));
        double sample = sentStart.getDouble("sample");
        assertTrue(sample >= 0 && sample < 1);

        JSONArray last = steps.getJSONObject(steps.length() - 1).getJSONArray("commands");
        JSONObject finish = null;
        for (int i = 0; i < last.length(); i++) {
            if ("finish".equals(last.getJSONObject(i).getString("type"))) {
                finish = last.getJSONObject(i);
            }
        }
        if (finish == null) {
            fail("the round never finishes");
        }
        BundlePreparationResult result = SyncCoordinator.roundResult;
        String status = finish.getString("status");
        assertEquals(status, result.getStatus());
        assertEquals(finish.getString("reason"), result.getReason());
        if (BundlePreparationResult.DOWNLOADED.equals(status)) {
            boolean activated = finish.getBoolean("activated");
            assertEquals(finish.getString("hash"), result.getHash());
            assertEquals(activated, result.isActivated());
            // Left for JS, it is the version a later crash hold activates.
            if (activated) {
                assertNull(SyncCoordinator.unactivatedHash);
            } else {
                assertEquals(finish.getString("hash"), SyncCoordinator.unactivatedHash);
            }
        } else {
            assertEquals("", result.getHash());
            assertFalse(result.isActivated());
        }
        // However the round ends, the breadcrumb does not survive it.
        assertFalse(round.kv.containsKey(SyncCoordinator.KEY_ROUND_INCOMPLETE));
    }

    @Test
    public void replaysMostOfTheVectors() throws Exception {
        assertTrue(rounds().size() >= 25);
    }
}
