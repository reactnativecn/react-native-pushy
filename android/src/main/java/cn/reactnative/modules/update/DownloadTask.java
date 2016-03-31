package cn.reactnative.modules.update;

import android.os.AsyncTask;
import android.util.Log;

import com.squareup.okhttp.OkHttpClient;
import com.squareup.okhttp.Request;
import com.squareup.okhttp.Response;
import com.squareup.okhttp.ResponseBody;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import okio.BufferedSink;
import okio.BufferedSource;
import okio.Okio;

/**
 * Created by tdzl2003 on 3/31/16.
 */
class DownloadTask extends AsyncTask<DownloadTaskParams, Void, Void> {
    final int DOWNLOAD_CHUNK_SIZE = 4096;

    @Override
    protected Void doInBackground(DownloadTaskParams... params) {
        DownloadTaskParams param = params[0];
        try {
            OkHttpClient client = new OkHttpClient();
            Request request = new Request.Builder().url(param.url)
                    .build();
            Response response = client.newCall(request).execute();
            ResponseBody body = response.body();
            long contentLength = body.contentLength();
            BufferedSource source = body.source();

            if (param.zipFilePath.exists()) {
                param.zipFilePath.delete();
            }

            BufferedSink sink = Okio.buffer(Okio.sink(param.zipFilePath));

            if (UpdateContext.DEBUG) {
                Log.d("RNUpdate", "Downloading " + param.url);
            }

            long bytesRead = 0;
            long totalRead = 0;
            while ((bytesRead = source.read(sink.buffer(), DOWNLOAD_CHUNK_SIZE)) != -1) {
                totalRead += bytesRead;
                if (UpdateContext.DEBUG) {
                    Log.d("RNUpdate", "Progress " + totalRead + "/" + contentLength);
                }
            }
            if (totalRead != contentLength) {
                throw new Error("Unexpected eof while reading ppk");
            }
            sink.writeAll(source);
            sink.close();

            if (UpdateContext.DEBUG) {
                Log.d("RNUpdate", "Download finished");
            }

            ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(param.zipFilePath)));
            ZipEntry ze;
            byte[] buffer = new byte[1024];
            int count;
            String filename;

            param.unzipDirectory.mkdirs();

            while ((ze = zis.getNextEntry()) != null)
            {
                String fn = ze.getName();
                File fmd = new File(param.unzipDirectory, fn);

                if (UpdateContext.DEBUG) {
                    Log.d("RNUpdate", "Unzipping " + fn);
                }

                if (ze.isDirectory()) {
                    fmd.mkdirs();
                    continue;
                }

                FileOutputStream fout = new FileOutputStream(fmd);

                while ((count = zis.read(buffer)) != -1)
                {
                    fout.write(buffer, 0, count);
                }

                fout.close();
                zis.closeEntry();
            }

            zis.close();

            if (UpdateContext.DEBUG) {
                Log.d("RNUpdate", "Unzip finished");
            }

        } catch (Throwable e) {
            param.listener.onDownloadFailed(e);
        }

        return null;
    }

}
