package cn.reactnative.modules.update;

import android.content.Context;

import java.io.File;

/**
 * Created by tdzl2003 on 3/31/16.
 */
class DownloadTaskParams {
    static final int TASK_TYPE_FULL_DOWNLOAD = 1;
    static final int TASK_TYPE_PATCH_FROM_APK = 2;
    static final int TASK_TYPE_PATCH_FROM_PPK = 3;

    static final int TASK_TYPE_CLEARUP = 0; //Keep hash & originHash

    int         type;
    String      url;
    String      hash;
    String      originHash;
    File        zipFilePath;
    File        unzipDirectory;
    File        originDirectory;
    UpdateContext.DownloadFileListener listener;
}
