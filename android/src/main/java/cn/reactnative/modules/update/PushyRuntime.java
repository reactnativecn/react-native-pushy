package cn.reactnative.modules.update;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.Nullable;
import org.json.JSONObject;
import java.util.concurrent.Executor;

/** Bridge-free native configuration and update APIs. */
public final class PushyRuntime {
    public interface Callback {
        /** Always called on the main thread, including skipped and failed checks. */
        void onComplete(BundlePreparationResult result);
    }

    // Waiting threads, reused while idle. Not a single worker: each caller's
    // wait is bounded by its own timeout, which a queue behind another
    // caller's longer wait would break (iOS waits on a concurrent queue too).
    // The actual round is shared with cold start and crash rescue by
    // SyncCoordinator, on its own thread.
    private static final Executor WORKER = Threads.cached("pushy-host-sync");

    public interface ConfigurationCallback {
        /** Main thread; null means configuration was persisted successfully. */
        void onComplete(@Nullable Exception error);
    }

    // Configuration must not wait behind a network round that it invalidates.
    private static final Executor CONFIG_WORKER = Threads.single("pushy-host-config", true);

    /**
     * Validate and persist a complete configuration, even before JS or bundle
     * resolution. This starts no network work and never resolves a bundle.
     * Await the callback before continuing startup/prepareBundle. Unless JS
     * uses nativeConfigSource: 'native', later JS config writes can replace it.
     */
    public static void configure(Context context, JSONObject options, final ConfigurationCallback callback) {
        if (context == null || options == null || callback == null) {
            throw new IllegalArgumentException("context, options and callback are required");
        }
        final Context applicationContext = context.getApplicationContext();
        // Snapshot caller-owned JSON before dispatch, not minutes later on a worker.
        final String snapshot = options.toString();
        CONFIG_WORKER.execute(() -> {
            Exception failure = null;
            try {
                NativeCore.ensureLoaded();
                String config = FlowBridge.normalizeConfiguration(snapshot);
                if (config == null) {
                    throw new IllegalStateException("Native configuration failed");
                }
                UpdateContext.getInstance(applicationContext).setNativeConfig(config);
            } catch (Exception e) {
                failure = e;
            } catch (LinkageError e) {
                failure = new IllegalStateException("Native configuration failed", e);
            }
            final Exception error = failure;
            new Handler(Looper.getMainLooper()).post(() -> callback.onComplete(error));
        });
    }

    private PushyRuntime() {
    }

    /**
     * Start the process's native check now, join its in-flight round, or return
     * its completed result. This does not reload React Native or show UI.
     *
     * Call after the host has resolved its real launch bundle with
     * UpdateContext.getBundleUrl. Do not resolve the bundle again just to call
     * this method: bundle resolution consumes first-load/rollback markers.
     * Missing persisted configuration and debug builds are reported as skipped.
     *
     * Waits at most 30 minutes for the round (longer than any round takes).
     */
    public static void prepareBundle(Context context, final Callback callback) {
        prepareBundle(context, SyncCoordinator.DEFAULT_PREPARE_TIMEOUT_MS, callback);
    }

    /**
     * Same as prepareBundle(Context, Callback), but the callback runs after at
     * most timeoutMillis. On expiry the result is status failed, reason
     * timeout; the round keeps running in the background and its result still
     * applies to the next launch.
     */
    public static void prepareBundle(
        Context context,
        final long timeoutMillis,
        final Callback callback
    ) {
        if (context == null || callback == null) {
            throw new IllegalArgumentException("context and callback are required");
        }
        final Context applicationContext = context.getApplicationContext();
        WORKER.execute(() -> {
            BundlePreparationResult outcome;
            try {
                if (BuildConfig.DEBUG) {
                    outcome = BundlePreparationResult.of(BundlePreparationResult.SKIPPED, "debug");
                } else {
                    outcome = SyncCoordinator.prepareBundle(
                        UpdateContext.getInstance(applicationContext), timeoutMillis);
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                outcome = BundlePreparationResult.of(BundlePreparationResult.CANCELLED, "interrupted");
            } catch (Exception | LinkageError e) {
                Log.w(Texts.LOG_TAG, "native host sync failed", e);
                outcome = BundlePreparationResult.of(BundlePreparationResult.FAILED, "internal_error");
            }
            final BundlePreparationResult result = outcome;
            new Handler(Looper.getMainLooper()).post(() -> callback.onComplete(result));
        });
    }
}
