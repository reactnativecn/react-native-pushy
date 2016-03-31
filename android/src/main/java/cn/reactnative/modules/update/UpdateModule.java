package cn.reactnative.modules.update;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.ReadableMap;

import java.util.HashMap;
import java.util.Map;

/**
 * Created by tdzl2003 on 3/31/16.
 */
public class UpdateModule extends ReactContextBaseJavaModule{
    UpdateContext updateContext;

    public UpdateModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.updateContext = new UpdateContext(reactContext.getApplicationContext());
    }

    @Override
    public Map<String, Object> getConstants() {
        final Map<String, Object> constants = new HashMap<>();
        constants.put("downloadRootDir", updateContext.getRootDir());
        return constants;
    }

    @Override
    public String getName() {
        return "RCTHotUpdate";
    }

    @ReactMethod
    public void downloadUpdate(ReadableMap options, final Promise promise){
        String url = options.getString("updateUrl");
        String hash = options.getString("hashName");
        updateContext.downloadFile(url, hash, new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted() {
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(error);
            }
        });
    }

    @ReactMethod
    public void downloadPatchFromApk(ReadableMap options, final Promise promise){
        String url = options.getString("updateUrl");
        String hash = options.getString("hashName");
        updateContext.downloadPatchFromApk(url, hash, new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted() {
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(error);
            }
        });
    }

    @ReactMethod
    public void downloadPatchFromPpk(ReadableMap options, final Promise promise){
        String url = options.getString("updateUrl");
        String hash = options.getString("hashName");
        String originHash = options.getString("originHashName");
        updateContext.downloadPatchFromPpk(url, hash, originHash, new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted() {
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(error);
            }
        });
    }
}
