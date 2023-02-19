package cn.reactnative.modules.update;

import static androidx.core.content.FileProvider.getUriForFile;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import java.io.File;
import java.util.HashMap;
import java.util.Map;

public class UpdateModule extends NativeUpdateSpec {
    UpdateContext updateContext;
    public static ReactApplicationContext mContext;
    public UpdateModule(ReactApplicationContext reactContext, UpdateContext updateContext) {
        super(reactContext);
        this.updateContext = updateContext;
        mContext = reactContext;
    }

    public UpdateModule(ReactApplicationContext reactContext) {
        this(reactContext, new UpdateContext(reactContext.getApplicationContext()));
    }

    @Override
    protected Map<String, Object> getTypedExportedConstants() {
        final Map<String, Object> constants = new HashMap<>();
        constants.put("downloadRootDir", updateContext.getRootDir());
        constants.put("packageVersion", updateContext.getPackageVersion());
        constants.put("currentVersion", updateContext.getCurrentVersion());
        constants.put("buildTime", updateContext.getBuildTime());
        constants.put("isUsingBundleUrl", updateContext.getIsUsingBundleUrl());
        boolean isFirstTime = updateContext.isFirstTime();
        constants.put("isFirstTime", isFirstTime);
        if (isFirstTime) {
            updateContext.clearFirstTime();
        }
        String rolledBackVersion = updateContext.rolledBackVersion();
        constants.put("rolledBackVersion", rolledBackVersion);
        if (rolledBackVersion != null) {
            updateContext.clearRollbackMark();
        }
        constants.put("blockUpdate", updateContext.getBlockUpdate());
        constants.put("uuid", updateContext.getKv("uuid"));
        return constants;
    }

    @Override
    public String getName() {
        return UpdateModuleImpl.NAME;
    }

    @Override
    public void downloadFullUpdate(ReadableMap options, final Promise promise) {
    UpdateModuleImpl.downloadFullUpdate(this.updateContext,options,promise);
    }

    @Override
    public void downloadAndInstallApk(ReadableMap options, final Promise promise) {
        UpdateModuleImpl.downloadAndInstallApk(this.updateContext,options,promise);
    }

    public static void installApk(File toInstall) {
        Uri apkUri;
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            apkUri = getUriForFile(mContext, mContext.getPackageName() + ".pushy.fileprovider", toInstall);
            intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
            intent.setData(apkUri);
            intent.setFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        } else {
            apkUri = Uri.fromFile(toInstall);
            intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        }
        mContext.startActivity(intent);
    }

    @Override
    public void downloadPatchFromPackage(ReadableMap options, final Promise promise) {
        UpdateModuleImpl.downloadPatchFromPackage(updateContext,options,promise);
    }

    @Override
    public void downloadPatchFromPpk(ReadableMap options, final Promise promise) {
        UpdateModuleImpl.downloadPatchFromPpk(updateContext,options,promise);
    }

    @Override
    public void reloadUpdate(ReadableMap options) {
        UpdateModuleImpl.reloadUpdate(updateContext, mContext, options);
    }

    @Override
    public void setNeedUpdate(ReadableMap options) {
        UpdateModuleImpl.setNeedUpdate(updateContext, options);
    }

    @Override
    public void markSuccess() {
        UpdateModuleImpl.markSuccess(updateContext);
    }

    @Override
    public void setBlockUpdate(ReadableMap options) {
        UpdateModuleImpl.setBlockUpdate(updateContext,options);
    }

    @Override
    public void setUuid(final String uuid) {
        UpdateModuleImpl.setUuid(updateContext,uuid);
    }

    @Override
    public void setLocalHashInfo(final String hash, final String info) {
        UpdateModuleImpl.setLocalHashInfo(updateContext,hash,info);
    }

    @Override
    public void getLocalHashInfo(final String hash, final Promise promise) {
        UpdateModuleImpl.getLocalHashInfo(updateContext,hash,promise);
    }
    
    /* 发送事件*/
    public static void sendEvent(String eventName, WritableMap params) {
        ((ReactContext) mContext).getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(eventName,
                params);
    }
}
