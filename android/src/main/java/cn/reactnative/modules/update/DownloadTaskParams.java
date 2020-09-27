package cn.reactnative.modules.update;

import android.content.Context;

import java.io.File;

/**
 * Created by tdzl2003 on 3/31/16.
 */
class DownloadTaskParams {
    static final int TASK_TYPE_PATCH_FULL = 1;
    static final int TASK_TYPE_PATCH_FROM_APK = 2;
    static final int TASK_TYPE_PATCH_FROM_PPK = 3;
    static final int TASK_TYPE_PLAIN_DOWNLOAD = 4;

    static final int TASK_TYPE_CLEANUP = 0; //Keep hash & originHash

    int         type;
    String      url;
    String      hash;
    String      originHash;
    File        targetFile;
    File        unzipDirectory;
    File        originDirectory;
    UpdateContext.DownloadFileListener listener;
}
