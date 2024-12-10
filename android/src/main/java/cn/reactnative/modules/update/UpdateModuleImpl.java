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
import com.fasterxml.jackson.databind.ObjectMapper;

import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.lang.reflect.Field;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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
        try {
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
        }catch (Exception e){
            promise.reject("执行报错:"+e.getMessage());
        }
    }

    public static void reloadUpdate(UpdateContext updateContext, ReactApplicationContext mContext, ReadableMap options,Promise promise) {
        final String hash = options.getString("hash");

        if(hash==null || hash.isEmpty()){
            promise.reject("hash不能为空");
            return;
        }
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    updateContext.switchVersion(hash);
                    final Application application = (Application) getReactApplicationContext().getApplicationContext();
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
                        promise.reject("pushy:"+err.getMessage());
                        Field jsBundleField = instanceManager.getClass().getDeclaredField("mJSBundleFile");
                        jsBundleField.setAccessible(true);
                        jsBundleField.set(instanceManager, UpdateContext.getBundleUrl(application));
                    }

                    try {
                        instanceManager.recreateReactContextInBackground();
                        promise.resolve(true);
                    } catch (Throwable err) {
                        promise.reject("pushy:"+err.getMessage());
                        if (activity != null) {
                            activity.recreate();
                        }
                    }

                } catch (Throwable err) {
                    promise.reject("pushy:switchVersion failed"+err.getMessage());
                    Log.e("pushy", "switchVersion failed", err);
                }
            }
        });
    }


    public static void setNeedUpdate(UpdateContext updateContext, ReadableMap options,Promise promise) {
        try {
            final String hash = options.getString("hash");
            if(hash==null || hash.isEmpty()){
                promise.reject("hash不能为空");
                return;
            }
            UiThreadUtil.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        updateContext.switchVersion(hash);
                        promise.resolve(true);
                    } catch (Throwable err) {
                        promise.reject("switchVersionLater failed:"+err.getMessage());
                        Log.e("pushy", "switchVersionLater failed", err);
                    }
                }
            });
        }catch (Exception e){
            promise.reject("执行报错:"+e.getMessage());
        }
    }

    public static void markSuccess(UpdateContext updateContext,Promise promise) {
        try {
            UiThreadUtil.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    updateContext.markSuccess();
                    promise.resolve(true);
                }
            });
        }catch (Exception e){
            promise.reject("执行报错:"+e.getMessage());
        }
    }

    public static void setUuid(UpdateContext updateContext, String uuid, Promise promise) {
        try {
            UiThreadUtil.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    updateContext.setKv("uuid", uuid);
                    promise.resolve(true);
                }
            });
        }catch (Exception e){
            promise.reject("执行报错:"+e.getMessage());
        }

    }

    public static boolean check(String json) {
        ObjectMapper mapper = new ObjectMapper();
        try {
            mapper.readValue(json, Map.class);
            System.out.println("String can be converted to Map");
            return  true;
        } catch (IOException e) {
            System.out.println("String cannot be converted to Map");
            return  false;
        }
    }


    public static void setLocalHashInfo(UpdateContext updateContext, final String hash, final String info, Promise promise) {
        UiThreadUtil.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if(!check(info)){
                    updateContext.setKv("hash_" + hash, info);
                    promise.reject("校验报错:json字符串格式错误");
                }else {
                    updateContext.setKv("hash_" + hash, info);
                    promise.resolve(true);
                }
            }
        });
    }

    public static void getLocalHashInfo(UpdateContext updateContext, final String hash, Promise promise) {
        String value = updateContext.getKv("hash_" + hash);
        if(check(value)){
            promise.resolve(value);
        }else {
            promise.reject("校验报错:json字符串格式错误");
        }

    }

}
