package cn.reactnative.modules.update;

import android.content.Context;

import java.io.File;

/**
 * Created by tdzl2003 on 3/31/16.
 */
public class UpdateContext {
    private Context context;
    private File rootDir;

    public static boolean DEBUG = false;


    private static UpdateContext currentInstance = null;

    static UpdateContext instance() {
        return currentInstance;
    }

    public UpdateContext(Context context) {
        this.context = context;

        this.rootDir = new File(context.getFilesDir(), "_update");

        if (!rootDir.exists()) {
            rootDir.mkdir();
        }
    }

    public String getRootDir() {
        return rootDir.toString();
    }

    public interface DownloadFileListener {
        void onDownloadCompleted();
        void onDownloadFailed(Throwable error);
    }

    public void downloadFile(String url, String hashName, DownloadFileListener listener) {
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_FULL_DOWNLOAD;
        params.url = url;
        params.hash = hashName;
        params.listener = listener;
        params.zipFilePath = new File(rootDir, hashName + ".ppk");
        params.unzipDirectory = new File(rootDir, hashName);
        new DownloadTask(context).execute(params);
    }

    public void downloadPatchFromApk(String url, String hashName, DownloadFileListener listener) {
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK;
        params.url = url;
        params.hash = hashName;
        params.listener = listener;
        params.zipFilePath = new File(rootDir, hashName + ".apk.patch");
        params.unzipDirectory = new File(rootDir, hashName);
        new DownloadTask(context).execute(params);
    }

    public void downloadPatchFromPpk(String url, String hashName, String originHashName, DownloadFileListener listener) {
        DownloadTaskParams params = new DownloadTaskParams();
        params.type = DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK;
        params.url = url;
        params.hash = hashName;
        params.originHash = originHashName;
        params.listener = listener;
        params.zipFilePath = new File(rootDir, originHashName + "-" + hashName + ".ppk.patch");
        params.unzipDirectory = new File(rootDir, hashName);
        params.originDirectory = new File(rootDir, originHashName);
        new DownloadTask(context).execute(params);
    }
}
