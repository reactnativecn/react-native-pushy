package cn.reactnative.modules.update;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReadableMap;
import java.util.Map;

/**
 * Old-architecture stand-in for the NativePushySpec that codegen generates
 * from src/NativePushy.ts under the new architecture: same name, methods and
 * constants hook, so a single UpdateModule serves both. The bridge reads the
 * @ReactMethod annotations from UpdateModule itself.
 */
public abstract class NativePushySpec extends ReactContextBaseJavaModule {
    public static final String NAME = "Pushy";

    public NativePushySpec(ReactApplicationContext reactContext) {
        super(reactContext);
    }

    @Override
    public String getName() {
        return NAME;
    }

    protected abstract Map<String, Object> getTypedExportedConstants();

    @Override
    public final Map<String, Object> getConstants() {
        return getTypedExportedConstants();
    }

    public abstract void setLocalHashInfo(String hash, String info, Promise promise);

    public abstract void getLocalHashInfo(String hash, Promise promise);

    public abstract void setUuid(String uuid, Promise promise);

    public abstract void syncNativeConfig(String config, Promise promise);

    public abstract void getNativeCheckCache(Promise promise);

    public abstract void markJsCheckCompleted(String config, Promise promise);

    public abstract void reloadUpdate(ReadableMap options, Promise promise);

    public abstract void restartApp(Promise promise);

    public abstract void setNeedUpdate(ReadableMap options, Promise promise);

    public abstract void markSuccess(Promise promise);

    public abstract void getBundleHash(Promise promise);

    public abstract void resetToPackagedBundle(Promise promise);

    public abstract void downloadPatchFromPpk(ReadableMap options, Promise promise);

    public abstract void downloadPatchFromPackage(ReadableMap options, Promise promise);

    public abstract void downloadFullUpdate(ReadableMap options, Promise promise);

    public abstract void downloadAndInstallApk(ReadableMap options, Promise promise);

    public abstract void addListener(String eventName);

    public abstract void removeListeners(double count);
}
