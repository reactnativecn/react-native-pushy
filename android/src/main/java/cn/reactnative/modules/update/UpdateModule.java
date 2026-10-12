package cn.reactnative.modules.update;

import static cn.reactnative.modules.update.StateSerialRunner.STATE_SERIAL;
import static cn.reactnative.modules.update.StateSerialRunner.UI_THREAD;

import android.util.Log;
import androidx.annotation.Nullable;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * The "Pushy" native module for both architectures. NativePushySpec is the
 * codegen spec under the new architecture and the hand-written stand-in in
 * src/oldarch otherwise; the old bridge discovers methods through the
 * @ReactMethod annotations here, so every spec method carries one. Each
 * state-changing method takes a trailing Promise, so a failed persistence
 * rejects instead of resolving early (CODE_AUDIT 2.3).
 */
public class UpdateModule extends NativePushySpec {
    // Download URL option key, stored encoded.
    private static final String OPTION_URL = Texts.reveal("2f07f0d0ba8e5d572e");

    private final ReactApplicationContext reactContext;
    private final UpdateContext updateContext;

    public UpdateModule(ReactApplicationContext reactContext) {
        this(reactContext, UpdateContext.getInstance(reactContext));
    }

    public UpdateModule(ReactApplicationContext reactContext, UpdateContext updateContext) {
        super(reactContext);
        this.reactContext = reactContext;
        this.updateContext = updateContext;
        UpdateEventEmitter.register(reactContext);
    }

    @Override
    protected Map<String, Object> getTypedExportedConstants() {
        final Map<String, Object> constants = new HashMap<String, Object>();
        constants.put("downloadRootDir", updateContext.getRootDir());
        constants.put("packageVersion", updateContext.getPackageVersion());

        String currentVersion = updateContext.getCurrentVersion();
        constants.put("currentVersion", currentVersion);
        constants.put("currentVersionInfo", updateContext.getKv("hash_" + currentVersion));
        // Served from the value cached at launch resolution (no file read on
        // the JS thread) when currentVersion is the launched version.
        constants.put("currentBundleSha256", updateContext.currentBundleSha256(currentVersion));
        constants.put("buildTime", updateContext.getBuildTime());
        constants.put("isUsingBundleUrl", updateContext.getIsUsingBundleUrl());

        // Both one-shot markers are consumed in a single commit: under
        // TurboModules this runs synchronously on the JS thread.
        UpdateContext.LaunchMarkers markers = updateContext.consumeLaunchMarkers();
        constants.put("isFirstTime", markers.isFirstTime);
        constants.put("rolledBackVersion", markers.rolledBackVersion);

        constants.put("uuid", updateContext.getKv("uuid"));
        int supportedDiffVersion = 0;
        try {
            supportedDiffVersion = NativeCore.supportedDiffVersion();
        } catch (UnsatisfiedLinkError e) {
            // A mismatched librnpushy.so (stale manual copy / build cache)
            // must not crash startup via getConstants; 0 simply means "no v2
            // diff track" and the server degrades gracefully.
            Log.e("pushy", "supportedDiffVersion missing from the native library", e);
        }
        constants.put("supportedDiffVersion", supportedDiffVersion);
        return constants;
    }

    /**
     * Reads a required string option. A module call runs on the native
     * modules thread, where anything thrown (a missing key, a wrong type)
     * reaches the bridge's exception handler and kills the app, so a bad
     * argument has to come back as an INVALID_OPTIONS rejection instead
     * (CODE_AUDIT 2.11). Returns null after rejecting.
     */
    @Nullable
    private static String readRequiredString(
        @Nullable ReadableMap options,
        String key,
        Promise promise
    ) {
        String value = null;
        try {
            if (options != null && options.hasKey(key) && !options.isNull(key)) {
                value = options.getString(key);
            }
        } catch (RuntimeException e) {
            // Wrong type: treated like a missing key below.
        }
        return requireNonEmpty(value, "options." + key, promise);
    }

    /** Same contract for a plain string argument. */
    @Nullable
    private static String requireNonEmpty(
        @Nullable String value,
        String name,
        Promise promise
    ) {
        if (value == null || value.isEmpty()) {
            promise.reject(ErrorCodes.INVALID_OPTIONS, name + " must be a non-empty string");
            return null;
        }
        return value;
    }

    private static boolean isValidHashInfo(@Nullable String json) {
        if (json == null) {
            return false;
        }
        try {
            return new JSONTokener(json).nextValue() instanceof JSONObject;
        } catch (JSONException e) {
            return false;
        }
    }

    private static UpdateContext.DownloadFileListener downloadListener(final Promise promise) {
        return new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted(DownloadTaskParams params) {
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(ErrorCodes.forDownloadFailure(error), error);
            }
        };
    }

    @ReactMethod
    @Override
    public void downloadFullUpdate(final ReadableMap options, final Promise promise) {
        String url = readRequiredString(options, OPTION_URL, promise);
        if (url == null) {
            return;
        }
        String hash = readRequiredString(options, "hash", promise);
        if (hash == null) {
            return;
        }
        updateContext.downloadFullUpdate(url, hash, downloadListener(promise), 0);
    }

    @ReactMethod
    @Override
    public void downloadAndInstallApk(final ReadableMap options, final Promise promise) {
        // Every failure of this path — a missing REQUEST_INSTALL_PACKAGES
        // declaration above all — has to come back as a promise rejection,
        // never as an exception on the native modules thread.
        try {
            final String url = readRequiredString(options, "url", promise);
            if (url == null) {
                return;
            }
            String hash = readRequiredString(options, "hash", promise);
            if (hash == null) {
                return;
            }
            String target = readRequiredString(options, "target", promise);
            if (target == null) {
                return;
            }
            if (!HttpUtils.isHttpsUrl(url)) {
                // Installing an APK is code execution and nothing verifies
                // its bytes yet (CODE_AUDIT 2.6): TLS is the only thing
                // standing between the server and the device, so a plaintext
                // URL is refused outright.
                promise.reject(ErrorCodes.INVALID_OPTIONS, "APK url must use https: " + url);
                return;
            }
            if (!ApkInstaller.ensureInstallPermission(reactContext, promise)) {
                return;
            }
            updateContext.downloadFile(url, hash, target, new UpdateContext.DownloadFileListener() {
                @Override
                public void onDownloadCompleted(DownloadTaskParams params) {
                    ApkInstaller.install(reactContext, params.targetFile, url, promise);
                }

                @Override
                public void onDownloadFailed(Throwable error) {
                    promise.reject(ErrorCodes.DOWNLOAD_FAILED, error);
                }
            });
        } catch (Throwable error) {
            promise.reject(ErrorCodes.APK_INSTALL_FAILED, error);
        }
    }

    @ReactMethod
    @Override
    public void downloadPatchFromPackage(final ReadableMap options, final Promise promise) {
        String url = readRequiredString(options, OPTION_URL, promise);
        if (url == null) {
            return;
        }
        String hash = readRequiredString(options, "hash", promise);
        if (hash == null) {
            return;
        }
        updateContext.downloadPatchFromApk(url, hash, downloadListener(promise), 0);
    }

    @ReactMethod
    @Override
    public void downloadPatchFromPpk(final ReadableMap options, final Promise promise) {
        String url = readRequiredString(options, OPTION_URL, promise);
        if (url == null) {
            return;
        }
        String hash = readRequiredString(options, "hash", promise);
        if (hash == null) {
            return;
        }
        String originHash = readRequiredString(options, "originHash", promise);
        if (originHash == null) {
            return;
        }
        updateContext.downloadPatchFromPpk(url, hash, originHash, downloadListener(promise), 0);
    }

    @ReactMethod
    @Override
    public void reloadUpdate(final ReadableMap options, final Promise promise) {
        String hash = readRequiredString(options, "hash", promise);
        if (hash == null) {
            return;
        }
        restart(hash, promise);
    }

    @ReactMethod
    @Override
    public void restartApp(Promise promise) {
        restart(null, promise);
    }

    private void restart(@Nullable final String hash, final Promise promise) {
        // Two hops (CODE_AUDIT 2.2): the switch (bundle digest + commit) and
        // the launch resolution run on the state serial thread like every
        // other state write; only the React reload itself is posted to the
        // UI thread. A failure at either hop rejects with RESTART_FAILED.
        StateSerialRunner.run(STATE_SERIAL, promise, ErrorCodes.RESTART_FAILED, "restartApp", () -> {
            final String bundlePath = ReactReloadManager.prepareRestart(updateContext, hash);
            StateSerialRunner.run(UI_THREAD, promise, ErrorCodes.RESTART_FAILED, "restartApp", () -> {
                ReactReloadManager.reload(updateContext, reactContext, bundlePath);
                promise.resolve(true);
            });
        });
    }

    @ReactMethod
    @Override
    public void setNeedUpdate(final ReadableMap options, final Promise promise) {
        final String hash = readRequiredString(options, "hash", promise);
        if (hash == null) {
            return;
        }
        StateSerialRunner.run(STATE_SERIAL, promise, ErrorCodes.SWITCH_VERSION_FAILED, "switchVersionLater", () -> {
            updateContext.switchVersion(hash);
            promise.resolve(true);
        });
    }

    @ReactMethod
    @Override
    public void markSuccess(final Promise promise) {
        StateSerialRunner.run(STATE_SERIAL, promise, ErrorCodes.MARK_SUCCESS_FAILED, "markSuccess", () -> {
            updateContext.markSuccess();
            promise.resolve(true);
        });
    }

    @ReactMethod
    @Override
    public void getBundleHash(final Promise promise) {
        // Threading lives in UpdateContext (its bundle-hash thread); resolve is
        // thread-safe. Never rejects — empty string means "unknown".
        updateContext.getBundleHash(promise::resolve);
    }

    @ReactMethod
    @Override
    public void resetToPackagedBundle(final Promise promise) {
        StateSerialRunner.run(STATE_SERIAL, promise, ErrorCodes.RESET_FAILED, "resetToPackagedBundle", () -> {
            updateContext.resetToPackagedBundle();
            promise.resolve(true);
        });
    }

    /**
     * Raw response cached by the native cold-start check, for the JS side to
     * reuse instead of re-checking (§10.3). Empty string when absent; never
     * rejects.
     */
    @ReactMethod
    @Override
    public void getNativeCheckCache(final Promise promise) {
        String cached = updateContext.getNativeCheckCache();
        promise.resolve(cached == null ? "" : cached);
    }

    /**
     * JS obtained a valid check response for this config in this process; the
     * delayed native round then skips its duplicate request (§10.3).
     */
    @ReactMethod
    @Override
    public void markJsCheckCompleted(final String config, final Promise promise) {
        if (requireNonEmpty(config, "config", promise) == null) {
            return;
        }
        SyncCoordinator.recordJsRound(config);
        promise.resolve(true);
    }

    /**
     * Provisioning for the native cold-start update check
     * (NATIVE_CHECKUPDATE_DESIGN §10.1): the raw JSON persists as-is and is
     * parsed on read by the orchestrator; absent config = check disabled.
     * Validated at write time — a corrupt config would otherwise silently
     * disable the native check forever with no signal.
     */
    @ReactMethod
    @Override
    public void syncNativeConfig(final String config, final Promise promise) {
        if (requireNonEmpty(config, "config", promise) == null) {
            return;
        }
        try {
            new JSONObject(config);
        } catch (JSONException e) {
            promise.reject(ErrorCodes.INVALID_OPTIONS, "config must be a JSON object string", e);
            return;
        }
        StateSerialRunner.run(STATE_SERIAL, promise, ErrorCodes.FILE_OPERATION_FAILED, "syncNativeConfig", () -> {
            updateContext.setNativeConfig(config);
            promise.resolve(true);
        });
    }

    @ReactMethod
    @Override
    public void setUuid(final String uuid, final Promise promise) {
        if (requireNonEmpty(uuid, "uuid", promise) == null) {
            return;
        }
        StateSerialRunner.run(STATE_SERIAL, promise, ErrorCodes.FILE_OPERATION_FAILED, "setUuid", () -> {
            updateContext.setKv("uuid", uuid);
            promise.resolve(true);
        });
    }

    @ReactMethod
    @Override
    public void setLocalHashInfo(final String hash, final String info, final Promise promise) {
        if (requireNonEmpty(hash, "hash", promise) == null) {
            return;
        }
        if (!isValidHashInfo(info)) {
            promise.reject(ErrorCodes.INVALID_HASH_INFO, "setLocalHashInfo failed: invalid json string");
            return;
        }
        // A state write that did not reach disk (SharedPreferences commit
        // false) is FILE_OPERATION_FAILED, distinct from malformed input.
        StateSerialRunner.run(STATE_SERIAL, promise, ErrorCodes.FILE_OPERATION_FAILED, "setLocalHashInfo", () -> {
            updateContext.setKv("hash_" + hash, info);
            promise.resolve(true);
        });
    }

    @ReactMethod
    @Override
    public void getLocalHashInfo(final String hash, final Promise promise) {
        if (requireNonEmpty(hash, "hash", promise) == null) {
            return;
        }
        String value = updateContext.getKv("hash_" + hash);
        if (value == null || value.isEmpty()) {
            // No record (iOS resolves nil the same way): JS treats it as {}.
            // Only a record that exists and is not a JSON object is invalid.
            promise.resolve(null);
            return;
        }
        if (!isValidHashInfo(value)) {
            promise.reject(ErrorCodes.INVALID_HASH_INFO, "getLocalHashInfo failed: invalid json string");
            return;
        }

        promise.resolve(value);
    }

    @ReactMethod
    @Override
    public void addListener(String eventName) {
    }

    @ReactMethod
    @Override
    public void removeListeners(double count) {
    }
}
