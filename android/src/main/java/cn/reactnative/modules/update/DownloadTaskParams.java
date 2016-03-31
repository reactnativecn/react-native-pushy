package cn.reactnative.modules.update;

import java.io.File;

/**
 * Created by tdzl2003 on 3/31/16.
 */
class DownloadTaskParams {
    String      url;
    String      hash;
    File zipFilePath;
    File unzipDirectory;
    UpdateContext.DownloadFileListener listener;
}
