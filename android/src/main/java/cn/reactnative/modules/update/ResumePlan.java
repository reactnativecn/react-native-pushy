package cn.reactnative.modules.update;

/**
 * The resumable-download decisions (cpp/patch_core/resume_plan.h): what to
 * request for a partial archive and its sidecar, what to do with the
 * response, and the sidecar text to persist. JSON text out; null only when
 * the native core failed (memory ran out). DownloadTask keeps the IO.
 */
final class ResumePlan {
    static {
        NativeCore.ensureLoaded();
    }

    private ResumePlan() {
    }

    static native String planRequest(String sidecar, String url, long partialSize);

    static native String classifyResponse(
        int status,
        long resumeOffset,
        String contentRange,
        String contentEncoding,
        long contentLength,
        String sidecar,
        String url,
        long partialSize);

    static native String sidecar(
        String url, String etag, String lastModified, String previousSidecar, long total);
}
