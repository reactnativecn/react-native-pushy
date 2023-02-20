package cn.reactnative.modules.update;

import android.app.Activity;
import android.app.Application;
import android.util.Log;
import com.facebook.react.ReactApplication;
import com.facebook.react.ReactInstanceManager;
import com.facebook.react.bridge.JSBundleLoader;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.UiThreadUtil;
import java.io.File;
import java.lang.reflect.Field;
public class UpdateModuleImpl {

    public static final String NAME = "Pushy";

    public static void downloadFullUpdate(UpdateContext updateContext, ReadableMap options, Promise promise) {
        String url = options.getString("updateUrl");
        String hash = options.getString("hash");
        updateContext.downloadFullUpdate(url, hash, new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted(DownloadTaskParams params) {
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(error);
            }
        });
    }

    public static void downloadAndInstallApk(UpdateContext updateContext, ReadableMap options, Promise promise) {
        String url = options.getString("url");
        String hash = options.getString("hash");
        String target = options.getString("target");
        updateContext.downloadFile(url, hash, target, new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted(DownloadTaskParams params) {
               UpdateModule.installApk(params.targetFile);
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(error);
            }
        });
    }

    public static void installApk(String url) {
        File toInstall = new File(url);
        UpdateModule.installApk(toInstall);
    }

    public static void downloadPatchFromPackage(UpdateContext updateContext, ReadableMap options, Promise promise) {
        String url = options.getString("updateUrl");
        String hash = options.getString("hash");
        updateContext.downloadPatchFromApk(url, hash, new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted(DownloadTaskParams params) {
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(error);
            }
        });
    }

    public static void downloadPatchFromPpk(UpdateContext updateContext, ReadableMap options, Promise promise) {
        String url = options.getString("updateUrl");
        String hash = options.getString("hash");

        String originHash = options.getString("originHash");

        updateContext.downloadPatchFromPpk(url, hash, originHash, new UpdateContext.DownloadFileListener() {
            @Override
            public void onDownloadCompleted(DownloadTaskParams params) {
                promise.resolve(null);
            }

            @Override
            public void onDownloadFailed(Throwable error) {
                promise.reject(error);
            }
        });
    }

    public static void reloadUpdate(UpdateContext updateContext, ReactApplicationContext mContext, ReadableMap options) {
        final String hash = options.getString("hash");

        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    updateContext.switchVersion(hash);
                    Activity activity = mContext.getCurrentActivity();
                    Application application = activity.getApplication();
                    ReactInstanceManager instanceManager = updateContext.getCustomReactInstanceManager();

                    if (instanceManager == null) {
                        instanceManager = ((ReactApplication) application).getReactNativeHost().getReactInstanceManager();
                    }

                    try {
                        JSBundleLoader loader = JSBundleLoader.createFileLoader(UpdateContext.getBundleUrl(application));
                        Field loadField = instanceManager.getClass().getDeclaredField("mBundleLoader");
                        loadField.setAccessible(true);
                        loadField.set(instanceManager, loader);
                    } catch (Throwable err) {
                        Field jsBundleField = instanceManager.getClass().getDeclaredField("mJSBundleFile");
                        jsBundleField.setAccessible(true);
                        jsBundleField.set(instanceManager, UpdateContext.getBundleUrl(application));
                    }

                    try {
                        instanceManager.recreateReactContextInBackground();
                    } catch (Throwable err) {
                        activity.recreate();
                    }

                } catch (Throwable err) {
                    Log.e("pushy", "switchVersion failed", err);
                }
            }
        });
    }


    public static void setNeedUpdate(UpdateContext updateContext, ReadableMap options) {
        final String hash = options.getString("hash");

        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    updateContext.switchVersion(hash);
                } catch (Throwable err) {
                    Log.e("pushy", "switchVersionLater failed", err);
                }
            }
        });
    }

    public static void markSuccess(UpdateContext updateContext) {
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                updateContext.markSuccess();
            }
        });
    }

    public static void setBlockUpdate(UpdateContext updateContext, ReadableMap options) {
        final int until = options.getInt("until");
        final String reason = options.getString("reason");
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                updateContext.setBlockUpdate(until, reason);
            }
        });
    }

    public static void setUuid(UpdateContext updateContext, String uuid) {
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                updateContext.setKv("uuid", uuid);
            }
        });
    }

    public static void setLocalHashInfo(UpdateContext updateContext, final String hash, final String info) {
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                updateContext.setKv("hash_" + hash, info);
            }
        });
    }

    public static void getLocalHashInfo(UpdateContext updateContext, final String hash, Promise promise) {
        promise.resolve(updateContext.getKv("hash_" + hash));
    }

}
