package cn.reactnative.modules.update;

/**
 * Pure string helpers for the HTTP paths (no Android or OkHttp types), kept
 * apart from DownloadTask / SyncCoordinator so they stay testable on
 * a plain JVM: DownloadTask loads librnpushy.so in its static initializer
 * and both pull in OkHttp.
 */
final class HttpUtils {
    private HttpUtils() {
    }

    /** True for an "https:" URL, case-insensitively; false for anything else (incl. null). */
    static boolean isHttpsUrl(String url) {
        return url != null && url.regionMatches(true, 0, "https://", 0, 8);
    }
}
