package cn.reactnative.modules.update;

import android.content.Context;
import android.os.AsyncTask;
import android.util.Log;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

import org.json.JSONException;
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
import java.util.HashMap;

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

    private void removeDirectory(File file) throws IOException {
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
        if (file.exists() && !file.delete()) {
            throw new IOException("Failed to delete directory");
        }
    }

    private void downloadFile(String url, File writePath) throws IOException {
        OkHttpClient client = new OkHttpClient();
        Request request = new Request.Builder().url(url)
                .build();
        Response response = client.newCall(request).execute();
        if (response.code() > 299) {
            throw new Error("Server return code " + response.code());
        }
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

    private void copyFile(File from, File fmd) throws IOException {
        int count;

        InputStream in = new FileInputStream(from);
        FileOutputStream fout = new FileOutputStream(fmd);

        while ((count = in.read(buffer)) != -1)
        {
            fout.write(buffer, 0, count);
        }

        fout.close();
        in.close();
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
        InputStream in;
        try {
            in = context.getAssets().open("index.android.bundle");
        } catch (Exception e) {
            return new byte[0];
        }
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

    private byte[] readFile(File file)  throws IOException {
        InputStream in = new FileInputStream(file);
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

    private void copyFilesWithBlacklist(String current, File from, File to, JSONObject blackList) throws IOException {
        File[] files = from.listFiles();
        for (File file : files) {
            if (file.isDirectory()) {
                String subName = current + file.getName() + '/';
                if (blackList.has(subName)) {
                    continue;
                }
                File toFile = new File(to, file.getName());
                if (!toFile.exists()) {
                    toFile.mkdir();
                }
                copyFilesWithBlacklist(subName, file, toFile, blackList);
            } else if (!blackList.has(current + file.getName())) {
                // Copy file.
                File toFile = new File(to, file.getName());
                if (!toFile.exists()) {
                    copyFile(file, toFile);
                }
            }
        }
    }

    private void copyFilesWithBlacklist(File from, File to, JSONObject blackList) throws IOException {
        copyFilesWithBlacklist("", from, to, blackList);
    }

    private void doDownload(DownloadTaskParams param) throws IOException {
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
    }

    private void copyFromResource(HashMap<String, File> map) throws IOException {
        ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(context.getPackageResourcePath())));
        ZipEntry ze;
        while ((ze = zis.getNextEntry()) != null) {
            String fn = ze.getName();
            File target = map.get(fn);
            if (target != null) {
                if (UpdateContext.DEBUG) {
                    Log.d("RNUpdate", "Copying from resource " + fn + " to " + target);
                }
                unzipToFile(zis, target);
            }
        }
    }

    private void doPatchFromApk(DownloadTaskParams param) throws IOException, JSONException {
        downloadFile(param.url, param.zipFilePath);

        ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(param.zipFilePath)));
        ZipEntry ze;
        int count;
        String filename;

        removeDirectory(param.unzipDirectory);
        param.unzipDirectory.mkdirs();

        HashMap<String, File> copyList = new HashMap<String, File>();

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
                    if (from.isEmpty()) {
                        from = to;
                    }
                    copyList.put(from, new File(param.unzipDirectory, to));
                    //copyFromResource(from, new File(param.unzipDirectory, to));
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

        copyFromResource(copyList);

        if (UpdateContext.DEBUG) {
            Log.d("RNUpdate", "Unzip finished");
        }

    }

    private void doPatchFromPpk(DownloadTaskParams param) throws IOException, JSONException {
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
                    if (from.isEmpty()) {
                        from = to;
                    }
                    copyFile(new File(param.originDirectory, from), new File(param.unzipDirectory, to));
                }
                JSONObject blackList = obj.getJSONObject("deletes");
                copyFilesWithBlacklist(param.originDirectory, param.unzipDirectory, blackList);
                continue;
            }
            if (fn.equals("index.bundlejs.patch")) {
                // do bsdiff patch
                byte[] patched = bsdiffPatch(readFile(new File(param.originDirectory, "index.bundlejs")), readBytes(zis));

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
    }
    private void doCleanUp(DownloadTaskParams param) throws IOException {
        if (UpdateContext.DEBUG) {
            Log.d("RNUpdate", "Start cleaning up");
        }
        File root = param.unzipDirectory;
        for (File sub : root.listFiles()) {
            if (sub.getName().charAt(0) == '.') {
                continue;
            }
            if (sub.isFile()) {
                sub.delete();
            } else {
                if (sub.getName().equals(param.hash) || sub.getName().equals(param.originHash)) {
                    continue;
                }
                removeDirectory(sub);
            }
        }
    }

    @Override
    protected Void doInBackground(DownloadTaskParams... params) {
        try {
            switch (params[0].type) {
                case DownloadTaskParams.TASK_TYPE_FULL_DOWNLOAD:
                    doDownload(params[0]);
                    break;
                case DownloadTaskParams.TASK_TYPE_PATCH_FROM_APK:
                    doPatchFromApk(params[0]);
                    break;
                case DownloadTaskParams.TASK_TYPE_PATCH_FROM_PPK:
                    doPatchFromPpk(params[0]);
                    break;
                case DownloadTaskParams.TASK_TYPE_CLEARUP:
                    doCleanUp(params[0]);
                    break;
            }
            params[0].listener.onDownloadCompleted();
        } catch (Throwable e) {
            if (UpdateContext.DEBUG) {
                e.printStackTrace();
            }
            params[0].listener.onDownloadFailed(e);
        }
        return null;
    }

}
