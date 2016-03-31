package cn.reactnative.modules.update;

import android.content.Context;
import android.os.AsyncTask;
import android.util.Log;

import com.squareup.okhttp.OkHttpClient;
import com.squareup.okhttp.Request;
import com.squareup.okhttp.Response;
import com.squareup.okhttp.ResponseBody;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
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

    Context context;

    DownloadTask(Context context) {
        this.context = context;
    }

    static {
        System.loadLibrary("rnupdate");
    }

    private void removeDirectory(File file) {
        if (UpdateContext.DEBUG) {
            Log.d("RNUpdate", "Removing " + file);
        }
        if (file.isDirectory()) {
            File[] files = file.listFiles();
            for (File f : files) {
                String name = f.getName();
                if (name.equals(".") || name.equals("..")) {
                    continue;
                }
                removeDirectory(f);
            }
        }
        file.delete();
    }

    private void downloadFile(String url, File writePath) throws IOException {
        OkHttpClient client = new OkHttpClient();
        Request request = new Request.Builder().url(url)
                .build();
        Response response = client.newCall(request).execute();
        ResponseBody body = response.body();
        long contentLength = body.contentLength();
        BufferedSource source = body.source();

        if (writePath.exists()) {
            writePath.delete();
        }

        BufferedSink sink = Okio.buffer(Okio.sink(writePath));

        if (UpdateContext.DEBUG) {
            Log.d("RNUpdate", "Downloading " + url);
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
    }

    byte[] buffer = new byte[1024];

    private static native byte[] bsdiffPatch(byte[] origin, byte[] patch);

    private void unzipToFile(ZipInputStream zis, File fmd) throws IOException {
        int count;

        FileOutputStream fout = new FileOutputStream(fmd);

        while ((count = zis.read(buffer)) != -1)
        {
            fout.write(buffer, 0, count);
        }

        fout.close();
        zis.closeEntry();
    }

    private byte[] readBytes(ZipInputStream zis) throws IOException {
        int count;

        ByteArrayOutputStream fout = new ByteArrayOutputStream();
        while ((count = zis.read(buffer)) != -1)
        {
            fout.write(buffer, 0, count);
        }

        fout.close();
        zis.closeEntry();
        return fout.toByteArray();
    }

    private byte[] readOriginBundle()  throws IOException {
        InputStream in = context.getAssets().open("index.android.bundle");
        int count;

        ByteArrayOutputStream fout = new ByteArrayOutputStream();
        while ((count = in.read(buffer)) != -1)
        {
            fout.write(buffer, 0, count);
        }

        fout.close();
        in.close();
        return fout.toByteArray();
    }

    private void doDownload(DownloadTaskParams param) {
        try {
            downloadFile(param.url, param.zipFilePath);

            ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(param.zipFilePath)));
            ZipEntry ze;
            String filename;

            removeDirectory(param.unzipDirectory);
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

                unzipToFile(zis, fmd);
            }

            zis.close();

            if (UpdateContext.DEBUG) {
                Log.d("RNUpdate", "Unzip finished");
            }

        } catch (Throwable e) {
            if (UpdateContext.DEBUG) {
                e.printStackTrace();
            }
            param.listener.onDownloadFailed(e);
        }
    }

    private void copyFromResource(String assets, File output) throws IOException {
        ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(context.getPackageResourcePath())));
        ZipEntry ze;
        while ((ze = zis.getNextEntry()) != null) {
            String fn = ze.getName();
            if (fn.equals(assets)) {
                if (UpdateContext.DEBUG) {
                    Log.d("RNUpdate", "Copying from resource " + assets + " to " + output);
                }
                unzipToFile(zis, output);
            }
        }
    }

    private void doPatchFromApk(DownloadTaskParams param) {
        try {
            downloadFile(param.url, param.zipFilePath);

            ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(param.zipFilePath)));
            ZipEntry ze;
            int count;
            String filename;

            removeDirectory(param.unzipDirectory);
            param.unzipDirectory.mkdirs();

            while ((ze = zis.getNextEntry()) != null)
            {
                String fn = ze.getName();

                if (fn.equals("__diff.json")) {
                    // copy files from assets
                    byte[] bytes = readBytes(zis);
                    String json = new String(bytes, "UTF-8");
                    JSONObject obj = (JSONObject)new JSONTokener(json).nextValue();

                    JSONObject copies = obj.getJSONObject("copies");
                    Iterator<?> keys = copies.keys();
                    while( keys.hasNext() ) {
                        String to = (String)keys.next();
                        String from = copies.getString(to);
                        copyFromResource(from, new File(param.unzipDirectory, to));
                    }
                    continue;
                }
                if (fn.equals("index.bundlejs.patch")) {
                    // do bsdiff patch
                    byte[] patched = bsdiffPatch(readOriginBundle(), readBytes(zis));

                    FileOutputStream fout = new FileOutputStream(new File(param.unzipDirectory, "index.bundlejs"));
                    fout.write(patched);
                    fout.close();
                    continue;
                }
                File fmd = new File(param.unzipDirectory, fn);

                if (UpdateContext.DEBUG) {
                    Log.d("RNUpdate", "Unzipping " + fn);
                }

                if (ze.isDirectory()) {
                    fmd.mkdirs();
                    continue;
                }

                unzipToFile(zis, fmd);
            }

            zis.close();

            if (UpdateContext.DEBUG) {
                Log.d("RNUpdate", "Unzip finished");
            }

        } catch (Throwable e) {
            if (UpdateContext.DEBUG) {
                e.printStackTrace();
            }
            param.listener.onDownloadFailed(e);
        }
    }

    @Override
    protected Void doInBackground(DownloadTaskParams... params) {
        switch (params[0].type) {
            case DownloadTaskParams.TASK_TYPE_FULL_DOWNLOAD:
                doDownload(params[0]);
                break;
            case DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK:
                doPatchFromApk(params[0]);
                break;
        }
        return null;
    }

}
