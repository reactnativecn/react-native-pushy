package cn.reactnative.modules.update;

import android.os.Build;
import android.util.Log;
import androidx.annotation.Nullable;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.BufferedSource;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native cold-start update check (NATIVE_CHECKUPDATE_DESIGN §10): once per
 * process, a few seconds after getBundleUrl, entirely independent of the app
 * bundle — this is what lets a device bricked by a bad hot update pull the
 * fixed version on the next launch. All decisions come from
 * cpp/update_flow_core via FlowBridge; this class is IO glue only.
 * Failures are silent and bounded: one round per launch, no retry storms, no
 * version blacklisting.
 */
final class SyncCoordinator {
    // Version-info flag read by JS (metadata.ts), stored encoded.
    private static final String INFO_CRASH_HOLD = Texts.reveal("3905f5c2a6b96d56212a19");

    static final String KEY_CONFIG = "nativeConfig";
    // Raw response cache for the JS side to reuse (§10.3), scoped to the
    // exact logical request and native config that produced it. Stored in
    // its own SharedPreferences file (UpdateContext.getNativeCheckCache).
    static final String KEY_RESP_CACHE = "nativeCheckResp";
    // Set when a round starts, cleared when it ends (§11.4). Residue on the
    // next launch means the previous process died mid-round (a crash rescue
    // was truncated): that launch resumes immediately instead of waiting 5s.
    static final String KEY_ROUND_INCOMPLETE = "nativeCheckIncomplete";
    // The check response (and a remote queryUrls list) is a small JSON
    // document; anything bigger is a broken or hijacked endpoint.
    private static final long MAX_QUERY_RESPONSE_BYTES = 1024 * 1024;

    private static final AtomicBoolean scheduled = new AtomicBoolean(false);
    // One round per process, whoever starts it first — the delayed cold-start
    // thread or the crash-rescue thread (§11.3). roundDone lets the rescue
    // wait for an in-flight round instead of racing it.
    private static final AtomicBoolean roundStarted = new AtomicBoolean(false);
    private static final CountDownLatch roundDone = new CountDownLatch(1);
    private static volatile boolean roundCompleted = false;
    // Flipped the moment a crash is being held. JS is dead from that point
    // on, so there is no second decision maker: the round force-activates
    // whatever it downloads (§11.3).
    private static volatile boolean crashHoldActive = false;
    // A version this process downloaded but left for JS to activate. If the
    // process then crashes, JS will never activate it — the crash handler
    // activates it directly (bounded local work, no network). The generation
    // is the one the round committed under: a reset that lands afterwards
    // bumps it, and the late activation must lose to that reset exactly like
    // the round itself would. Written generation-first, read hash-first, so
    // a torn read can only see a stricter (newer) generation.
    static volatile String unactivatedHash;
    private static volatile long unactivatedGeneration;
    private static volatile UpdateContext sContext;
    private static volatile String sLaunchRolledBackVersion;
    // Config JSON for which JS reported a completed check in this process
    // (markJsCheckCompleted). Process-scoped by design: the next launch
    // starts with no signal and the cold-start round runs again.
    private static volatile String sJsCompletedConfig;
    // Published after the launch rollback snapshot, before host calls are accepted.
    private static volatile boolean nativeReady;
    static volatile BundlePreparationResult roundResult =
        BundlePreparationResult.of(BundlePreparationResult.FAILED, "check_failed");
    private static volatile long roundGeneration = -1;
    private static volatile long roundConfigGeneration = -1;
    private static volatile String roundConfigJson;

    // prepareBundle without an explicit timeout waits this long at most: past
    // the longest round (8 query requests, then two 600s download phases).
    // Same default as iOS (kPushyHostPrepareDefaultTimeout).
    static final long DEFAULT_PREPARE_TIMEOUT_MS = 30 * 60 * 1000L;

    /**
     * Blocking only on the host API's worker; never call on the UI thread.
     * Waits at most timeoutMs for this process's round: on expiry the result
     * is failed/timeout, and the round keeps running in the background (its
     * result still applies to the next launch), as on iOS.
     */
    static BundlePreparationResult prepareBundle(UpdateContext context, long timeoutMs)
        throws InterruptedException {
        if (BuildConfig.DEBUG) {
            return BundlePreparationResult.of(BundlePreparationResult.SKIPPED, "debug");
        }
        if (!nativeReady || sContext != context || !context.getIsUsingBundleUrl()) {
            return BundlePreparationResult.of(BundlePreparationResult.SKIPPED, "not_initialized");
        }
        String configJson = context.getKv(KEY_CONFIG);
        BundlePreparationResult rejection = configRejection(configJson);
        if (rejection != null) {
            return rejection;
        }
        // Run the round on its own thread rather than this caller's, so the
        // wait below can be bounded.
        if (claimRound()) {
            Threads.startDaemon("pushy-native-sync", () -> runClaimedRound(0));
        }
        if (!roundStarted.get()) {
            return BundlePreparationResult.of(BundlePreparationResult.SKIPPED, "config_changed");
        }
        if (!roundDone.await(Math.max(0, timeoutMs), TimeUnit.MILLISECONDS)) {
            return BundlePreparationResult.of(BundlePreparationResult.FAILED, "timeout");
        }
        if (roundConfigGeneration != UpdateContext.getNativeConfigGeneration()
            || !FlowBridge.configsEquivalent(configJson, roundConfigJson)
            || !FlowBridge.configsEquivalent(configJson, context.getKv(KEY_CONFIG))) {
            return BundlePreparationResult.of(BundlePreparationResult.CANCELLED, "config_changed");
        }
        if (roundGeneration != UpdateContext.getResetGeneration()) {
            return BundlePreparationResult.of(BundlePreparationResult.CANCELLED, "reset");
        }
        return roundResult;
    }


    static void recordJsRound(String config) {
        sJsCompletedConfig = config;
    }

    /**
     * True when JS already obtained a valid response in this process for a
     * config equivalent (FlowBridge.configsEquivalent, contract C1) to
     * the one the native round would use: the delayed round is then a
     * duplicate request. JS and a host may serialize the same config
     * differently, so exact string equality would almost never match. Only
     * the scheduled round consults this — the crash-rescue path still runs,
     * JS is dead by then.
     */
    private static boolean hasJsRound(UpdateContext context) {
        String jsConfig = sJsCompletedConfig;
        return jsConfig != null
            && FlowBridge.configsEquivalent(jsConfig, context.getKv(KEY_CONFIG));
    }

    /**
     * The shared gate (FlowBridge.runnableConfig, update_flow_core) every
     * entry point (prepareBundle, the automatic round's gate, the round
     * itself) applies to the persisted config, so they cannot disagree on
     * what is runnable: null when a round may run, otherwise the result —
     * absent is skipped/not_configured, a non-object failed/invalid_config, a
     * truthy disabled skipped/disabled, a blank appKey failed/invalid_config.
     */
    @Nullable
    static BundlePreparationResult configRejection(@Nullable String json) {
        try {
            String result = FlowBridge.runnableConfig(json);
            if (result == null) {
                return BundlePreparationResult.of(BundlePreparationResult.FAILED, "internal_error");
            }
            JSONObject verdict = new JSONObject(result);
            return verdict.has("status")
                ? BundlePreparationResult.of(verdict.getString("status"), verdict.getString("reason"))
                : null;
        } catch (JSONException e) {
            return BundlePreparationResult.of(BundlePreparationResult.FAILED, "invalid_config");
        }
    }

    private SyncCoordinator() {
    }

    static void schedule(final UpdateContext context, final String launchRolledBackVersion) {
        if (BuildConfig.DEBUG) {
            return;
        }
        if (!scheduled.compareAndSet(false, true)) {
            return;
        }
        sContext = context;
        sLaunchRolledBackVersion = launchRolledBackVersion;
        nativeReady = true;
        // The crash-hold rescue shares the orchestrator's rollout gate: no
        // persisted config, no handler (§11.3).
        if (context.getKv(KEY_CONFIG) != null) {
            CrashHold.install();
        }
        Threads.startDaemon("pushy-native-sync", Thread.MIN_PRIORITY + 1, () -> {
            try {
                // Keep the check away from the cold-start critical path
                // (§7 R5) — unless the previous process died mid-round,
                // in which case every launch second counts (§11.4).
                if (context.getKv(KEY_ROUND_INCOMPLETE) == null) {
                    Thread.sleep(5000);
                }
                if (hasJsRound(context)) {
                    // Not consuming the round: a later crash rescue may
                    // still need it.
                    Log.i(Texts.LOG_TAG,
                        "native sync skipped: JS already queried in this process");
                    return;
                }
                startRound(0);
            } catch (Throwable e) {
                // The rescue path must never take the app down with it.
                Log.w(Texts.LOG_TAG, "native sync failed: " + e);
            }
        });
    }

    static boolean isRoundInFlight() {
        return roundStarted.get() && !roundCompleted;
    }

    private static boolean hasRunnableConfig(UpdateContext context) {
        return context != null && configRejection(context.getKv(KEY_CONFIG)) == null;
    }

    static void onConfigured(UpdateContext context) {
        if (nativeReady && sContext == context && hasRunnableConfig(context)) {
            CrashHold.install();
        }
    }

    /**
     * Runs the process's single round on the calling thread if nobody has
     * started it yet. deadlineNanos > 0 (crash rescue) caps every HTTP call
     * and download phase to the remaining budget.
     */
    private static void startRound(long deadlineNanos) {
        if (claimRound()) {
            runClaimedRound(deadlineNanos);
        }
    }

    // Claims the process's only round. An automatic check before first-run
    // provisioning must not consume it: hosts may configure later in this
    // launch.
    private static boolean claimRound() {
        return hasRunnableConfig(sContext) && roundStarted.compareAndSet(false, true);
    }

    private static void runClaimedRound(long deadlineNanos) {
        try {
            runOnce(new DeviceRound(sContext, sLaunchRolledBackVersion), deadlineNanos);
        } catch (Throwable e) {
            Log.w(Texts.LOG_TAG, "native sync failed: " + e);
            roundResult = BundlePreparationResult.of(BundlePreparationResult.FAILED, "internal_error");
        } finally {
            roundCompleted = true;
            roundDone.countDown();
        }
    }

    /**
     * Crash-rescue entry (§11.3), called from the handler's worker thread
     * while the uncaught-exception handler holds the dying process. Ensures
     * this process's round runs to completion within the budget, then
     * activates a downloaded-but-unactivated version if one exists — the
     * last chance before the process is gone.
     */
    static void runHoldRound(long deadlineNanos) {
        UpdateContext context = sContext;
        if (context == null) {
            return;
        }
        crashHoldActive = true;
        startRound(deadlineNanos);
        if (roundStarted.get() && !roundCompleted) {
            long remainingNanos = deadlineNanos - System.nanoTime();
            if (remainingNanos > 0) {
                try {
                    roundDone.await(remainingNanos, TimeUnit.NANOSECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
        }
        activatePendingVersion(context);
    }

    // The alert-strategy variant of the §10.7 hole: the round downloaded a
    // fix but deferred activation to JS, and JS is now dead. Activation is
    // local and bounded (the bundle digest, then a state switch under the
    // commit lock).
    private static void activatePendingVersion(UpdateContext context) {
        String hash = unactivatedHash;
        if (hash == null) {
            return;
        }
        String hashInfoJson = null;
        String existingInfo = context.getKv("hash_" + hash);
        if (existingInfo != null) {
            try {
                JSONObject info = new JSONObject(existingInfo);
                info.put(INFO_CRASH_HOLD, true);
                hashInfoJson = info.toString();
            } catch (JSONException ignored) {
            }
        }
        try {
            if (context.commitSyncResult(
                    unactivatedGeneration, hash, hashInfoJson, true, null)) {
                unactivatedHash = null;
                Log.i(Texts.LOG_TAG,
                    "crash hold: activated downloaded version " + hash);
            } else {
                Log.i(Texts.LOG_TAG,
                    "crash hold: reset since download, dropping activation");
            }
        } catch (Exception e) {
            Log.w(Texts.LOG_TAG, "crash hold: activation failed: " + e);
        }
    }

    // The engine's clock: milliseconds on System.nanoTime, offset from this
    // class's load so every value is positive (0 means "no deadline"). The
    // nanoTime origin is arbitrary, so a hold deadline in nanos may be
    // negative: only 0 means none on this side too.
    private static final long CLOCK_ORIGIN_NANOS = System.nanoTime() - TimeUnit.SECONDS.toNanos(1);

    static double engineMillis(long nanos) {
        return (nanos - CLOCK_ORIGIN_NANOS) / 1e6;
    }

    static long engineNanos(double millis) {
        return CLOCK_ORIGIN_NANOS + (long) (millis * 1e6);
    }

    /** A monotonic clock in nanoseconds (System.nanoTime on the device). */
    interface Clock {
        long nanoTime();
    }

    /**
     * Everything a round does besides deciding: the engine step, the clock,
     * the persisted state and the IO the engine's commands ask for.
     * DeviceRound is the device's; the JVM tests replay the engine vectors
     * through a scripted one (SyncRoundReplayTest).
     */
    interface RoundHost extends DownloadStarter, Clock {
        /** FlowBridge.stepRound; null when the engine is unavailable. */
        @Nullable
        String stepRound(@Nullable String state, String event);

        /** Whether a crash is being held right now (crashHoldActive). */
        boolean crashHold();

        long resetGeneration();

        long configGeneration();

        @Nullable
        String getKv(String key);

        void setKv(String key, String value);

        void removeKv(String key);

        /** This launch as the shared core sees it (native_round.h). */
        JSONObject launchEnv() throws JSONException;

        /** The response body; null when the request failed. */
        @Nullable
        String httpRequest(String url, @Nullable String postBody, long timeoutMs, long callTimeoutMs);

        /** Wall-clock seconds, stamped on each response. */
        double wallSeconds();

        boolean hasCompletedVersion(String hash);

        /** UpdateContext.commitSyncResult: whether the commit landed. */
        boolean commitSyncResult(
            long expectedGeneration, @Nullable String hash, @Nullable String hashInfoJson,
            boolean activate, String responseCacheJson) throws Exception;
    }

    /** The round on the device: the JNI engine, UpdateContext, OkHttp. */
    private static final class DeviceRound implements RoundHost {
        private final UpdateContext context;
        private final String launchRolledBackVersion;

        DeviceRound(UpdateContext context, String launchRolledBackVersion) {
            this.context = context;
            this.launchRolledBackVersion = launchRolledBackVersion;
        }

        @Override
        public long nanoTime() {
            return System.nanoTime();
        }

        @Override
        public String stepRound(String state, String event) {
            return FlowBridge.stepRound(state, event);
        }

        @Override
        public boolean crashHold() {
            return crashHoldActive;
        }

        @Override
        public long resetGeneration() {
            return UpdateContext.getResetGeneration();
        }

        @Override
        public long configGeneration() {
            return UpdateContext.getNativeConfigGeneration();
        }

        @Override
        public String getKv(String key) {
            return context.getKv(key);
        }

        @Override
        public void setKv(String key, String value) {
            context.setKv(key, value);
        }

        @Override
        public void removeKv(String key) {
            context.removeKv(key);
        }

        @Override
        public JSONObject launchEnv() throws JSONException {
            return SyncCoordinator.launchEnv(context, launchRolledBackVersion);
        }

        @Override
        public String httpRequest(String url, String postBody, long timeoutMs, long callTimeoutMs) {
            return SyncCoordinator.httpRequest(url, postBody, timeoutMs, callTimeoutMs);
        }

        @Override
        public double wallSeconds() {
            return System.currentTimeMillis() / 1000.0;
        }

        @Override
        public boolean hasCompletedVersion(String hash) {
            return context.hasCompletedVersion(hash);
        }

        @Override
        public boolean commitSyncResult(
            long expectedGeneration, String hash, String hashInfoJson,
            boolean activate, String responseCacheJson) {
            return context.commitSyncResult(
                expectedGeneration, hash, hashInfoJson, activate, responseCacheJson);
        }

        @Override
        public DownloadTaskParams start(
            String strategy, String url, String hash, String originHash,
            UpdateContext.DownloadFileListener listener, long deadlineNanos) {
            if ("diff".equals(strategy)) {
                return context.downloadPatchFromPpk(url, hash, originHash, listener, deadlineNanos);
            }
            if ("pdiff".equals(strategy)) {
                return context.downloadPatchFromApk(url, hash, listener, deadlineNanos);
            }
            return context.downloadFullUpdate(url, hash, listener, deadlineNanos);
        }
    }

    /**
     * The round itself is the shared engine's (cpp/update_flow_core
     * round_engine.h, NATIVE_CHECKUPDATE_DESIGN §12): this drives it on the
     * calling thread and runs what it asks for — the breadcrumb, the launch
     * facts, the requests, the downloads and the commit.
     */
    static void runOnce(RoundHost host, long deadlineNanos) throws JSONException {
        final long resetGeneration = host.resetGeneration();
        final long configGeneration = host.configGeneration();
        roundGeneration = resetGeneration;
        roundConfigGeneration = configGeneration;
        roundResult = BundlePreparationResult.of(BundlePreparationResult.FAILED, "check_failed");
        String configJson = host.getKv(KEY_CONFIG);
        roundConfigJson = configJson;

        JSONObject event = new JSONObject()
            .put("type", "start")
            .put("config", configJson == null ? "" : configJson)
            .put("resetGeneration", resetGeneration)
            .put("configGeneration", configGeneration)
            .put("sample", Math.random())
            .put("deadline", deadlineNanos != 0 ? engineMillis(deadlineNanos) : 0);
        String state = null;
        boolean marked = false;
        try {
            while (true) {
                event.put("now", engineMillis(host.nanoTime()))
                    .put("crashHold", host.crashHold());
                String step = host.stepRound(state, event.toString());
                if (step == null) {
                    roundResult = BundlePreparationResult.of(
                        BundlePreparationResult.FAILED, "internal_error");
                    return;
                }
                JSONObject result = new JSONObject(step);
                state = result.getJSONObject("state").toString();
                JSONArray commands = result.getJSONArray("commands");
                event = new JSONObject();
                for (int i = 0; i < commands.length(); i++) {
                    JSONObject command = commands.getJSONObject(i);
                    String type = command.getString("type");
                    if ("markIncomplete".equals(type)) {
                        marked = true;
                        try {
                            host.setKv(KEY_ROUND_INCOMPLETE, "1");
                        } catch (IllegalStateException ignored) {
                        }
                    } else if ("finish".equals(type)) {
                        finishRound(command, resetGeneration);
                        return;
                    } else {
                        event = perform(host, command, configGeneration);
                    }
                }
            }
        } finally {
            // A committed round already cleared the breadcrumb in its own
            // commit (UpdateContext.commitSyncResult); only rounds that ended
            // without committing need the extra write.
            if (marked) {
                try {
                    if (host.getKv(KEY_ROUND_INCOMPLETE) != null) {
                        host.removeKv(KEY_ROUND_INCOMPLETE);
                    }
                } catch (IllegalStateException ignored) {
                }
            }
        }
    }

    /** Runs one engine command and returns the event that answers it. */
    private static JSONObject perform(RoundHost host, JSONObject command, long configGeneration)
        throws JSONException {
        String type = command.getString("type");
        switch (type) {
            case "collectEnv":
                return new JSONObject()
                    .put("type", "env")
                    .put("env", host.launchEnv());
            case "http": {
                boolean post = command.optBoolean("post");
                String text = host.httpRequest(
                    command.getString("url"),
                    post ? command.getString("body") : null,
                    (long) command.getDouble("timeoutMs"),
                    (long) command.getDouble("callTimeoutMs"));
                JSONObject event = new JSONObject().put("type", "http");
                if (text != null) {
                    event.put("text", text).put("at", host.wallSeconds());
                }
                return event;
            }
            case "checkInstalled":
                return new JSONObject()
                    .put("type", "installed")
                    .put("installed", host.hasCompletedVersion(command.getString("hash")));
            case "download":
                return download(command, host, host);
            case "commit":
                return commit(host, command, configGeneration);
            default:
                // Unknown to this adapter: the engine finishes the round.
                return new JSONObject().put("type", type);
        }
    }

    // This launch as the shared core sees it (native_round.h). Absent values
    // (null) are left out.
    private static JSONObject launchEnv(UpdateContext context, String launchRolledBackVersion)
        throws JSONException {
        String currentVersion = context.getCurrentVersion();
        JSONObject env = new JSONObject();
        env.put("packageVersion", context.getPackageVersion());
        // The JS constant's form, so JS can reuse the response cache.
        env.put("currentVersion", currentVersion == null ? JSONObject.NULL : currentVersion);
        env.put("uuid", context.getKv("uuid"));
        // Snapshot captured on the launch path before getConstants consumes
        // the one-shot rollback marker. Reading SharedPreferences here, five
        // seconds later, would lose the guard and could forceBoot the version
        // that this very launch just rolled back.
        env.put("rolledBackVersion", launchRolledBackVersion);
        env.put("buildTime", context.getBuildTime());
        // React Native's Platform.Version is the Android SDK integer; use the
        // same value so this request can be fingerprinted against the JS one.
        env.put("os", "android " + Build.VERSION.SDK_INT);
        env.put("bundleHash", context.computeBundleHash());
        return env;
    }

    // Version info, the activation and the response cache land in one atomic
    // commit (UpdateContext.commitSyncResult). A config change bumps the
    // reset generation too, so the commit refuses either; the config
    // generation tells the two apart.
    private static JSONObject commit(RoundHost host, JSONObject command, long configGeneration)
        throws JSONException {
        String hash = command.getString("hash");
        String hashInfo = command.getString("hashInfo");
        JSONObject event = new JSONObject().put("type", "committed");
        try {
            boolean committed = host.commitSyncResult(
                (long) command.getDouble("resetGeneration"),
                hash.isEmpty() ? null : hash,
                hashInfo.isEmpty() ? null : hashInfo,
                command.getBoolean("activate"),
                command.getString("cache"));
            event.put("ok", committed);
            if (!committed && host.configGeneration() != configGeneration) {
                event.put("reason", "config_changed");
            }
        } catch (Exception e) {
            Log.w(Texts.LOG_TAG, "native sync: commit failed: " + e);
            event.put("error", true);
        }
        return event;
    }

    private static void finishRound(JSONObject finish, long resetGeneration) {
        String status = finish.optString("status");
        String reason = finish.optString("reason");
        if (!BundlePreparationResult.DOWNLOADED.equals(status)) {
            Log.i(Texts.LOG_TAG, "native sync: " + status + " (" + reason + ")");
            roundResult = BundlePreparationResult.of(status, reason);
            return;
        }
        String hash = finish.optString("hash");
        boolean activated = finish.optBoolean("activated");
        if (activated) {
            unactivatedHash = null;
            Log.i(Texts.LOG_TAG, "native sync: downloaded " + hash + " and set for next launch");
        } else {
            // Remembered so a crash later in this process can still activate
            // it (activatePendingVersion) — JS never will.
            unactivatedGeneration = resetGeneration;
            unactivatedHash = hash;
            Log.i(Texts.LOG_TAG, "native sync: downloaded " + hash + ", activation left to JS");
        }
        roundResult = BundlePreparationResult.downloaded(hash, activated);
    }

    private static final OkHttpClient httpClient = HttpClients.base().newBuilder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS)
        .build();

    // The engine's per-request bounds, already capped by the round deadline.
    private static String httpRequest(
        String url, String postBody, long timeoutMs, long callTimeoutMs
    ) {
        try {
            Request.Builder builder =
                new Request.Builder().url(url).header("Accept", "application/json");
            if (postBody != null) {
                builder.post(RequestBody.create(
                    postBody, MediaType.parse("application/json; charset=utf-8")));
            }
            OkHttpClient client = httpClient.newBuilder()
                .connectTimeout(Math.max(1, timeoutMs), TimeUnit.MILLISECONDS)
                .readTimeout(Math.max(1, timeoutMs), TimeUnit.MILLISECONDS)
                .callTimeout(Math.max(1, callTimeoutMs), TimeUnit.MILLISECONDS)
                .build();
            try (Response response = client.newCall(builder.build()).execute()) {
                // Same rule as the artifact download: an https endpoint that
                // redirects to plaintext http is a failed endpoint.
                HttpClients.rejectProtocolDowngrade(url, response);
                ResponseBody body = response.body();
                if (!response.isSuccessful() || body == null) {
                    return null;
                }
                return readBoundedBody(body);
            }
        } catch (Exception e) {
            // One line per failed endpoint; the fallback chain is otherwise
            // invisible in the field.
            Log.w(Texts.LOG_TAG, "native sync: request failed with "
                + e.getClass().getName() + ": " + e.getMessage());
            return null;
        }
    }

    /**
     * Reads the body with a hard cap (CODE_AUDIT 2.7): a hijacked endpoint
     * must not be able to OOM this thread with an unbounded string. Over the
     * cap counts as a failed endpoint (null), like any other bad response.
     */
    @Nullable
    private static String readBoundedBody(ResponseBody body) throws IOException {
        if (body.contentLength() > MAX_QUERY_RESPONSE_BYTES) {
            return null;
        }
        BufferedSource source = body.source();
        if (source.request(MAX_QUERY_RESPONSE_BYTES + 1)) {
            Log.w(Texts.LOG_TAG, "native sync: response exceeds "
                + MAX_QUERY_RESPONSE_BYTES + " bytes, ignoring endpoint");
            return null;
        }
        MediaType contentType = body.contentType();
        Charset charset = contentType == null
            ? null : contentType.charset(StandardCharsets.UTF_8);
        return source.readString(charset == null ? StandardCharsets.UTF_8 : charset);
    }

    /** Queues one download attempt; null when it was rejected up front (the listener was told). */
    interface DownloadStarter {
        @Nullable
        DownloadTaskParams start(
            String strategy, String url, String hash, @Nullable String originHash,
            UpdateContext.DownloadFileListener listener, long deadlineNanos);
    }

    /**
     * One download attempt the engine asked for, waited on up to its
     * deadline: {"type": "download", ok, code?, timedOut?}.
     */
    static JSONObject download(JSONObject command, DownloadStarter starter) throws JSONException {
        return download(command, starter, System::nanoTime);
    }

    static JSONObject download(JSONObject command, DownloadStarter starter, Clock clock)
        throws JSONException {
        final String strategy = command.getString("strategy");
        final long deadlineNanos = engineNanos(command.getDouble("deadline"));
        final CountDownLatch latch = new CountDownLatch(1);
        final AtomicBoolean succeeded = new AtomicBoolean(false);
        final AtomicReference<Throwable> failure = new AtomicReference<>();
        UpdateContext.DownloadFileListener listener = new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted(DownloadTaskParams params) {
                succeeded.set(true);
                latch.countDown();
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                Log.i(Texts.LOG_TAG, "native sync: " + strategy + " attempt failed: " + error);
                failure.set(error);
                latch.countDown();
            }
        };
        DownloadTaskParams task = starter.start(
            strategy, command.getString("url"), command.getString("hash"),
            command.has("originHash") ? command.getString("originHash") : null,
            listener, deadlineNanos);
        JSONObject event = new JSONObject().put("type", "download");
        boolean settled;
        try {
            settled = latch.await(deadlineNanos - clock.nanoTime(), TimeUnit.NANOSECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            settled = false;
        }
        if (!settled) {
            Log.w(Texts.LOG_TAG, "native sync: download phase timed out during " + strategy);
            // The task shares one download thread with the next attempt:
            // cancel its transfer (or keep it from starting) instead of
            // queueing behind it (CODE_AUDIT 2.12).
            if (task != null) {
                task.cancel();
            }
            return event.put("timedOut", true);
        }
        event.put("ok", succeeded.get());
        Throwable error = failure.get();
        if (error != null) {
            event.put("code", ErrorCodes.forDownloadFailure(error));
        }
        return event;
    }
}
