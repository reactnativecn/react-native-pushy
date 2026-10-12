package cn.reactnative.modules.update;

import android.os.Build;
import android.util.Log;
import androidx.annotation.Nullable;
import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
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
    // Version-info flags read by JS (metadata.ts), stored encoded.
    private static final String INFO_CRASH_HOLD = Texts.reveal("3905f5c2a6b96d56212a19");
    private static final String INFO_FORCE_BOOT = Texts.reveal("3c18e6d2aba9674a360d19ead5a695");

    static final String KEY_CONFIG = "nativeConfig";
    // Raw response cache for the JS side to reuse (§10.3), scoped to the
    // exact logical request and native config that produced it. Stored in
    // its own SharedPreferences file (UpdateContext.getNativeCheckCache).
    static final String KEY_RESP_CACHE = "nativeCheckResp";
    // Set when a round starts, cleared when it ends (§11.4). Residue on the
    // next launch means the previous process died mid-round (a crash rescue
    // was truncated): that launch resumes immediately instead of waiting 5s.
    static final String KEY_ROUND_INCOMPLETE = "nativeCheckIncomplete";
    private static final int MAX_QUERY_HTTP_ATTEMPTS = 8;
    private static final long DOWNLOAD_PHASE_TIMEOUT_SECONDS = 600;
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
    private static volatile String unactivatedHash;
    private static volatile long unactivatedGeneration;
    private static volatile UpdateContext sContext;
    private static volatile String sLaunchRolledBackVersion;
    // Config JSON for which JS reported a completed check in this process
    // (markJsCheckCompleted). Process-scoped by design: the next launch
    // starts with no signal and the cold-start round runs again.
    private static volatile String sJsCompletedConfig;
    // Published after the launch rollback snapshot, before host calls are accepted.
    private static volatile boolean nativeReady;
    private static volatile BundlePreparationResult roundResult =
        BundlePreparationResult.of(BundlePreparationResult.FAILED, "check_failed");
    private static volatile long roundGeneration = -1;
    private static volatile long roundConfigGeneration = -1;
    private static volatile String roundConfigJson;

    /** Blocking only on the host API's worker; never call on the UI thread. */
    static BundlePreparationResult prepareBundle(UpdateContext context) throws InterruptedException {
        if (UpdateContext.DEBUG) {
            return BundlePreparationResult.of(BundlePreparationResult.SKIPPED, "debug");
        }
        if (!nativeReady || sContext != context || !context.getIsUsingBundleUrl()) {
            return BundlePreparationResult.of(BundlePreparationResult.SKIPPED, "not_initialized");
        }
        RunnableConfig parsed = parseRunnableConfig(context.getKv(KEY_CONFIG));
        if (parsed.rejection != null) {
            return parsed.rejection;
        }
        String configJson = parsed.json;
        startRound(0);
        if (!roundStarted.get()) {
            return BundlePreparationResult.of(BundlePreparationResult.SKIPPED, "config_changed");
        }
        roundDone.await();
        if (roundConfigGeneration != UpdateContext.getNativeConfigGeneration()
            || !ConfigEquivalence.equivalent(configJson, roundConfigJson)
            || !ConfigEquivalence.equivalent(configJson, context.getKv(KEY_CONFIG))) {
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
     * config equivalent (ConfigEquivalence, the cross-platform contract) to
     * the one the native round would use: the delayed round is then a
     * duplicate request. JS and a host may serialize the same config
     * differently, so exact string equality would almost never match. Only
     * the scheduled round consults this — the crash-rescue path still runs,
     * JS is dead by then.
     */
    private static boolean hasJsRound(UpdateContext context) {
        String jsConfig = sJsCompletedConfig;
        return jsConfig != null
            && ConfigEquivalence.equivalent(jsConfig, context.getKv(KEY_CONFIG));
    }

    /**
     * The persisted config, parsed and checked once for every entry point
     * (prepareBundle, the automatic round's gate, the round itself), so they
     * cannot disagree on what is runnable. Exactly one of {config, rejection}
     * is set.
     */
    static final class RunnableConfig {
        @Nullable final String json;
        @Nullable final JSONObject config;
        // Trimmed, non-empty.
        @Nullable final String appKey;
        @Nullable final BundlePreparationResult rejection;

        private RunnableConfig(String json, JSONObject config, String appKey,
                               BundlePreparationResult rejection) {
            this.json = json;
            this.config = config;
            this.appKey = appKey;
            this.rejection = rejection;
        }

        static RunnableConfig rejected(String status, String reason) {
            return new RunnableConfig(
                null, null, null, BundlePreparationResult.of(status, reason));
        }
    }

    static RunnableConfig parseRunnableConfig(@Nullable String json) {
        if (json == null || json.isEmpty()) {
            return RunnableConfig.rejected(BundlePreparationResult.SKIPPED, "not_configured");
        }
        JSONObject config;
        try {
            config = new JSONObject(json);
        } catch (JSONException e) {
            return RunnableConfig.rejected(BundlePreparationResult.FAILED, "invalid_config");
        }
        if (config.optBoolean("disabled", false)) {
            return RunnableConfig.rejected(BundlePreparationResult.SKIPPED, "disabled");
        }
        Object appKey = config.opt("appKey");
        String trimmed = appKey instanceof String ? ((String) appKey).trim() : "";
        if (trimmed.isEmpty()) {
            return RunnableConfig.rejected(BundlePreparationResult.FAILED, "invalid_config");
        }
        return new RunnableConfig(json, config, trimmed, null);
    }

    private SyncCoordinator() {
    }

    static void schedule(final UpdateContext context, final String launchRolledBackVersion) {
        if (UpdateContext.DEBUG) {
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

    /**
     * Runs the process's single round on the calling thread if nobody has
     * started it yet. deadlineNanos > 0 (crash rescue) caps every HTTP call
     * and download phase to the remaining budget.
     */
    private static boolean hasRunnableConfig(UpdateContext context) {
        return context != null
            && parseRunnableConfig(context.getKv(KEY_CONFIG)).rejection == null;
    }

    static void onConfigured(UpdateContext context) {
        if (nativeReady && sContext == context && hasRunnableConfig(context)) {
            CrashHold.install();
        }
    }

    private static void startRound(long deadlineNanos) {
        // An automatic check before first-run provisioning must not consume
        // the process's only round. Hosts may configure later in this launch.
        if (!hasRunnableConfig(sContext)) {
            return;
        }
        if (!roundStarted.compareAndSet(false, true)) {
            return;
        }
        try {
            runOnce(sContext, sLaunchRolledBackVersion, deadlineNanos);
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

    private static void runOnce(
        UpdateContext context,
        String launchRolledBackVersion,
        long deadlineNanos
    ) throws JSONException {
        final long resetGeneration = UpdateContext.getResetGeneration();
        roundGeneration = resetGeneration;
        roundConfigGeneration = UpdateContext.getNativeConfigGeneration();
        roundResult = BundlePreparationResult.of(BundlePreparationResult.FAILED, "check_failed");
        String configJson = context.getKv(KEY_CONFIG);
        roundConfigJson = configJson;
        RunnableConfig parsed = parseRunnableConfig(configJson);
        if (parsed.rejection != null) {
            roundResult = parsed.rejection;
            return;
        }
        JSONObject config = parsed.config;
        String appKey = parsed.appKey;
        // Keep the existing interrupted-round breadcrumb and reset generation.
        try {
            context.setKv(KEY_ROUND_INCOMPLETE, "1");
        } catch (IllegalStateException ignored) {
        }
        try {
            runConfiguredRound(
                context, launchRolledBackVersion, deadlineNanos,
                resetGeneration, configJson, config, appKey);
        } finally {
            // A committed round already cleared the breadcrumb in its own
            // commit (UpdateContext.commitSyncResult); only rounds that ended
            // without committing need the extra write.
            try {
                if (context.getKv(KEY_ROUND_INCOMPLETE) != null) {
                    context.removeKv(KEY_ROUND_INCOMPLETE);
                }
            } catch (IllegalStateException ignored) {
            }
        }
    }

    private static void runConfiguredRound(
        UpdateContext context,
        String launchRolledBackVersion,
        long deadlineNanos,
        long resetGeneration,
        String configJson,
        JSONObject config,
        String appKey
    ) throws JSONException {
        String packageVersion = config.optString(
            "packageVersion", context.getPackageVersion());
        if (packageVersion.isEmpty()) {
            packageVersion = context.getPackageVersion();
        }

        String currentVersion = context.getCurrentVersion();
        // Snapshot captured on the launch path before getConstants consumes
        // the one-shot rollback marker. Reading SharedPreferences here, five
        // seconds later, would lose the guard and could forceBoot the version
        // that this very launch just rolled back.
        String rolledBackVersion = launchRolledBackVersion;
        String uuid = context.getKv("uuid");
        if (uuid == null) {
            uuid = "";
        }

        JSONObject identity = new JSONObject();
        identity.put("packageVersion", packageVersion);
        identity.put(
            "currentVersion",
            currentVersion == null ? JSONObject.NULL : currentVersion
        );
        identity.put("uuid", uuid);
        if (rolledBackVersion != null) {
            identity.put("rolledBackVersion", rolledBackVersion);
        }

        JSONObject cInfo = new JSONObject();
        cInfo.put("rnu", config.optString("rnu", ""));
        cInfo.put("rn", config.optString("rn", ""));
        // React Native's Platform.Version is the Android SDK integer; use the
        // same value so this request can be fingerprinted against the JS one.
        cInfo.put("os", "android " + Build.VERSION.SDK_INT);
        cInfo.put("uuid", uuid);

        JSONObject input = new JSONObject();
        input.put("packageVersion", packageVersion);
        input.put(
            "currentVersion",
            currentVersion == null ? JSONObject.NULL : currentVersion
        );
        input.put("buildTime", context.getBuildTime());
        input.put("cInfo", cInfo);
        input.put("supportedDiffVersion", NativeCore.supportedDiffVersion());
        input.put("bundleHash", context.computeBundleHash());

        String body = FlowBridge.buildRequestBody(input.toString());
        if (body == null) {
            roundResult = BundlePreparationResult.of(BundlePreparationResult.FAILED, "invalid_request");
            return;
        }

        boolean httpsOnly = isHttpsOnly(config.optJSONArray("endpoints"));
        String responseText = runQueryRequest(config, appKey, body, httpsOnly, deadlineNanos);
        if (responseText == null) {
            Log.i(Texts.LOG_TAG,
                "native sync: no endpoint reachable, giving up until next launch");
            return;
        }
        // Cache freshness is anchored to when the server response arrived,
        // not to when a potentially long download/patch/activation finished.
        final long responseAtSeconds = System.currentTimeMillis() / 1000;

        String decisionJson = FlowBridge.handleResponse(
            responseText, identity.toString(), config.optString("afterDownload", ""));
        if (decisionJson == null) {
            roundResult = BundlePreparationResult.of(BundlePreparationResult.FAILED, "invalid_response");
            return;
        }
        JSONObject decision = new JSONObject(decisionJson);
        if (!"download".equals(decision.optString("action"))) {
            boolean committed = context.commitSyncResult(
                resetGeneration, null, null, false,
                buildResponseCacheJson(configJson, body, responseText, responseAtSeconds));
            roundResult = committed
                ? BundlePreparationResult.of(BundlePreparationResult.NO_UPDATE, decision.optString("reason"))
                : BundlePreparationResult.of(BundlePreparationResult.CANCELLED, "reset");
            Log.i(Texts.LOG_TAG,
                "native sync: nothing to do (" + decision.optString("reason") + ")");
            return;
        }
        String hash = decision.optString("hash", "");
        if (!UpdateFileUtils.isSafePathComponent(hash)) {
            roundResult = BundlePreparationResult.of(BundlePreparationResult.FAILED, "invalid_response");
            return;
        }

        boolean downloaded = context.hasCompletedVersion(hash);
        if (!downloaded) {
            downloaded = performAttempts(
                decision.optJSONArray("attempts"), currentVersion, httpsOnly, deadlineNanos,
                downloadStarter(context, hash, currentVersion));
        }
        if (!downloaded) {
            // The native attempt has finished, so JS may safely reuse the
            // response and retry through its own strategy chain.
            boolean committed = context.commitSyncResult(
                resetGeneration, null, null, false,
                buildResponseCacheJson(configJson, body, responseText, responseAtSeconds));
            roundResult = BundlePreparationResult.of(
                committed ? BundlePreparationResult.FAILED : BundlePreparationResult.CANCELLED,
                committed ? "download_failed" : "reset");
            return;
        }

        // Version info (mirroring the JS side's setLocalHashInfo), the
        // activation and the response cache all land in one atomic commit —
        // see UpdateContext.commitSyncResult.
        String hashInfoJson = null;
        JSONObject info = decision.optJSONObject("info");
        if (info != null) {
            JSONObject hashInfo = new JSONObject();
            for (String key : new String[] {"name", "description", "metaInfo"}) {
                Object value = info.opt(key);
                if (value instanceof String) {
                    hashInfo.put(key, value);
                }
            }
            // A forceBoot activation is the brick-rescue path: mark it in the
            // persisted info so JS can report force_boot_rescue when this
            // version survives to markSuccess. Only the server-sent directive
            // counts — a silent-strategy activation is ordinary delivery.
            JSONObject infoConfig = info.optJSONObject("config");
            if (infoConfig != null && infoConfig.optBoolean("forceBoot", false)) {
                hashInfo.put(INFO_FORCE_BOOT, true);
            }
            if (crashHoldActive) {
                hashInfo.put(INFO_CRASH_HOLD, true);
            }
            hashInfoJson = hashInfo.toString();
        }
        // Silent strategies or a server-marked forceBoot version (per-version
        // remote override — the brick rescue) activate for the next launch;
        // otherwise activation stays with the JS side. Unless a crash is
        // being held: JS is dead, deferring to it would leave the fix on
        // disk forever (§11.3).
        boolean activate = decision.optBoolean("activate", false) || crashHoldActive;
        boolean committed;
        try {
            committed = context.commitSyncResult(
                resetGeneration,
                hash,
                hashInfoJson,
                activate,
                buildResponseCacheJson(configJson, body, responseText, responseAtSeconds));
        } catch (Exception e) {
            Log.w(Texts.LOG_TAG, "native sync: commit failed: " + e);
            roundResult = BundlePreparationResult.of(BundlePreparationResult.FAILED, "commit_failed");
            return;
        }
        if (!committed) {
            Log.i(Texts.LOG_TAG, "native sync: reset during round, dropping result");
        } else if (activate) {
            unactivatedHash = null;
            Log.i(Texts.LOG_TAG,
                "native sync: downloaded " + hash + " and set for next launch");
        } else {
            // Remembered so a crash later in this process can still activate
            // it (activatePendingVersion) — JS never will.
            unactivatedGeneration = resetGeneration;
            unactivatedHash = hash;
            Log.i(Texts.LOG_TAG,
                "native sync: downloaded " + hash + ", activation left to JS");
        }
        roundResult = committed
            ? BundlePreparationResult.downloaded(hash, activate)
            : BundlePreparationResult.of(BundlePreparationResult.CANCELLED, "reset");
    }

    private static String buildResponseCacheJson(
        String configJson,
        String requestBody,
        String responseText,
        long responseAtSeconds
    ) throws JSONException {
        JSONObject cacheEntry = new JSONObject();
        cacheEntry.put("ts", responseAtSeconds);
        cacheEntry.put("body", responseText);
        cacheEntry.put("request", requestBody);
        cacheEntry.put("config", configJson);
        return cacheEntry.toString();
    }

    private static final OkHttpClient httpClient = HttpClients.base().newBuilder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS)
        .build();

    private static String httpRequest(String url, String postBody, long deadlineNanos) {
        try {
            Request.Builder builder =
                new Request.Builder().url(url).header("Accept", "application/json");
            if (postBody != null) {
                builder.post(RequestBody.create(
                    postBody, MediaType.parse("application/json; charset=utf-8")));
            }
            // Crash-rescue budget: never let a single request outlive the
            // handler's hold window.
            OkHttpClient client = HttpClients.withDeadline(httpClient, deadlineNanos);
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

    // Shared schema rule (update_flow_core::IsValidResponse): a 200 with
    // `{"error": ...}` is a failed endpoint, not a verdict, and must not stop
    // the endpoint fallback.
    private static boolean isValidResponse(String responseText) {
        return responseText != null && FlowBridge.isValidResponse(responseText);
    }

    /**
     * Sequential fallback over the ordered candidates (§5.1): one request at
     * a time with its own timeout; after the configured round fails,
     * queryUrls discovery merges remote candidates (excluding the
     * already-tried) for one more round. No hedged race on purpose — this
     * path is latency-insensitive.
     */
    private static String runQueryRequest(
        JSONObject config, String appKey, String body, boolean httpsOnly, long deadlineNanos
    ) {
        JSONArray endpoints = config.optJSONArray("endpoints");
        String orderedJson = FlowBridge.orderEndpointCandidates(
            endpoints == null ? "[]" : endpoints.toString(), Math.random());
        JSONArray ordered;
        try {
            ordered = orderedJson == null ? new JSONArray() : new JSONArray(orderedJson);
        } catch (JSONException e) {
            return null;
        }
        HashSet<String> tried = new HashSet<>();
        int httpAttempts = 0;
        for (int i = 0; i < ordered.length(); i++) {
            String base = HttpUtils.normalizeEndpointBase(ordered.optString(i, ""));
            if (base.isEmpty() || !tried.add(base)) {
                continue;
            }
            if (httpAttempts++ >= MAX_QUERY_HTTP_ATTEMPTS) {
                return null;
            }
            String response = httpRequest(
                base + HttpUtils.QUERY_PATH + appKey, body, deadlineNanos);
            if (isValidResponse(response)) {
                return response;
            }
        }
        JSONArray queryUrls = config.optJSONArray("queryUrls");
        if (queryUrls == null) {
            return null;
        }
        for (int i = 0; i < queryUrls.length(); i++) {
            String listUrl = queryUrls.optString(i, "");
            if (listUrl.isEmpty()) {
                continue;
            }
            if (httpAttempts++ >= MAX_QUERY_HTTP_ATTEMPTS) {
                return null;
            }
            String listText = httpRequest(listUrl, null, deadlineNanos);
            if (listText == null) {
                continue;
            }
            JSONArray remote;
            try {
                remote = new JSONArray(listText);
            } catch (JSONException e) {
                continue;
            }
            for (int j = 0; j < remote.length(); j++) {
                String base = HttpUtils.normalizeEndpointBase(remote.optString(j, ""));
                if (base.isEmpty() || tried.contains(base)) {
                    continue;
                }
                if (httpsOnly && !HttpUtils.isHttpsUrl(base)) {
                    // A remotely injected endpoint must not downgrade an
                    // https configuration to plaintext.
                    Log.w(Texts.LOG_TAG, "native sync: ignoring non-https remote endpoint " + base);
                    continue;
                }
                if (httpAttempts++ >= MAX_QUERY_HTTP_ATTEMPTS) {
                    return null;
                }
                tried.add(base);
                String response = httpRequest(
                    base + HttpUtils.QUERY_PATH + appKey, body, deadlineNanos);
                if (isValidResponse(response)) {
                    return response;
                }
            }
            // One successfully fetched remote list is enough.
            break;
        }
        return null;
    }

    private static long capToHoldBudget(long phaseDeadlineNanos, long holdDeadlineNanos) {
        if (holdDeadlineNanos <= 0) {
            return phaseDeadlineNanos;
        }
        return Math.min(phaseDeadlineNanos, holdDeadlineNanos);
    }

    /** Queues one download attempt; null when it was rejected up front (the listener was told). */
    interface DownloadStarter {
        @Nullable
        DownloadTaskParams start(
            String type, String url, UpdateContext.DownloadFileListener listener, long deadlineNanos);
    }

    private static DownloadStarter downloadStarter(
        final UpdateContext context, final String hash, final String originHash
    ) {
        return (type, url, listener, deadlineNanos) -> {
            if ("diff".equals(type)) {
                return context.downloadPatchFromPpk(url, hash, originHash, listener, deadlineNanos);
            }
            if ("pdiff".equals(type)) {
                return context.downloadPatchFromApk(url, hash, listener, deadlineNanos);
            }
            return context.downloadFullUpdate(url, hash, listener, deadlineNanos);
        };
    }

    /**
     * Shared https rule (SyncCoordinator.ts isHttpsOnly): when every
     * configured endpoint is https, server-provided endpoints and artifact
     * URLs must not downgrade the round to plaintext.
     */
    static boolean isHttpsOnly(@Nullable JSONArray endpoints) {
        if (endpoints == null || endpoints.length() == 0) {
            return false;
        }
        for (int i = 0; i < endpoints.length(); i++) {
            Object endpoint = endpoints.opt(i);
            if (!(endpoint instanceof String) || !HttpUtils.isHttpsUrl((String) endpoint)) {
                return false;
            }
        }
        return true;
    }

    static boolean performAttempts(
        @Nullable JSONArray attempts, @Nullable String originHash, boolean httpsOnly,
        long holdDeadlineNanos, DownloadStarter starter
    ) {
        if (attempts == null) {
            return false;
        }
        final long incrementalDeadlineNanos = capToHoldBudget(
            System.nanoTime() + TimeUnit.SECONDS.toNanos(DOWNLOAD_PHASE_TIMEOUT_SECONDS),
            holdDeadlineNanos);
        long fullDeadlineNanos = 0;
        for (int i = 0; i < attempts.length(); i++) {
            JSONObject attempt = attempts.optJSONObject(i);
            if (attempt == null) {
                continue;
            }
            String type = attempt.optString("type");
            if ("diff".equals(type) && (originHash == null || originHash.isEmpty())) {
                // diff patches from the running version; none is running.
                continue;
            }
            final boolean isFullAttempt = !"diff".equals(type) && !"pdiff".equals(type);
            if (isFullAttempt && fullDeadlineNanos == 0) {
                // Incremental failures must not consume the last-resort full
                // download's budget. Each phase gets one bounded 10min window.
                fullDeadlineNanos = capToHoldBudget(
                    System.nanoTime()
                        + TimeUnit.SECONDS.toNanos(DOWNLOAD_PHASE_TIMEOUT_SECONDS),
                    holdDeadlineNanos);
            }
            final long deadlineNanos = isFullAttempt
                ? fullDeadlineNanos : incrementalDeadlineNanos;
            JSONArray urls = attempt.optJSONArray("urls");
            if (urls == null) {
                continue;
            }
            for (int j = 0; j < urls.length(); j++) {
                String url = urls.optString(j, "");
                if (url.isEmpty()) {
                    continue;
                }
                if (httpsOnly && HttpUtils.isCleartextUrl(url)) {
                    Log.w(Texts.LOG_TAG, "native sync: ignoring cleartext " + type + " url " + url);
                    continue;
                }
                // Check before enqueueing: once the phase budget is gone we
                // must not launch an orphan download that outlives the round.
                long remainingNanos = deadlineNanos - System.nanoTime();
                if (remainingNanos <= 0) {
                    if (isFullAttempt) {
                        return false;
                    }
                    break;
                }
                final CountDownLatch latch = new CountDownLatch(1);
                final AtomicBoolean succeeded = new AtomicBoolean(false);
                final AtomicReference<Throwable> failure = new AtomicReference<>();
                final String attemptType = type;
                UpdateContext.DownloadFileListener listener =
                    new UpdateContext.DownloadFileListener() {
                        @Override
                        public void onDownloadCompleted(DownloadTaskParams params) {
                            succeeded.set(true);
                            latch.countDown();
                        }

                        @Override
                        public void onDownloadFailed(Throwable error) {
                            Log.i(Texts.LOG_TAG, "native sync: " + attemptType
                                + " attempt failed: " + error);
                            failure.set(error);
                            latch.countDown();
                        }
                    };
                DownloadTaskParams task = starter.start(type, url, listener, deadlineNanos);
                try {
                    if (!latch.await(remainingNanos, TimeUnit.NANOSECONDS)) {
                        Log.w(Texts.LOG_TAG,
                            "native sync: download phase timed out during " + type);
                        // The task shares one download thread with the next
                        // attempt: cancel its transfer (or keep it from
                        // starting) instead of queueing behind it
                        // (CODE_AUDIT 2.12).
                        if (task != null) {
                            task.cancel();
                        }
                        if (isFullAttempt) {
                            return false;
                        }
                        break;
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    if (task != null) {
                        task.cancel();
                    }
                    return false;
                }
                if (succeeded.get()) {
                    return true;
                }
                Throwable error = failure.get();
                if (error != null
                    && !ErrorCodes.isMirrorRetryable(ErrorCodes.forDownloadFailure(error))) {
                    // The bytes arrived but could not be applied: every
                    // mirror serves the same artifact, so move on to the
                    // next strategy instead of downloading it again.
                    break;
                }
            }
        }
        return false;
    }
}
