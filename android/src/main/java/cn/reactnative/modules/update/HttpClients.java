package cn.reactnative.modules.update;

import java.io.IOException;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Response;

/**
 * The one OkHttpClient the SDK owns. Callers derive their timeout variants
 * with newBuilder(), which shares the connection pool and dispatcher threads
 * instead of each client growing its own.
 */
final class HttpClients {
    private HttpClients() {
    }

    private static final class Holder {
        static final OkHttpClient BASE = new OkHttpClient();
    }

    static OkHttpClient base() {
        return Holder.BASE;
    }

    /**
     * {@code client} with its call timeout capped to the time left until the
     * absolute System.nanoTime {@code deadlineNanos} (0: no deadline, the
     * client as is), so an orchestrated request never outlives its budget.
     * Throws when the deadline already passed.
     */
    static OkHttpClient withDeadline(OkHttpClient client, long deadlineNanos)
        throws IOException {
        if (deadlineNanos <= 0) {
            return client;
        }
        long remainingNanos = deadlineNanos - System.nanoTime();
        if (remainingNanos <= 0) {
            throw new IOException("Request deadline expired before start");
        }
        long remainingMillis = Math.max(1L, TimeUnit.NANOSECONDS.toMillis(remainingNanos));
        int callTimeoutMillis = client.callTimeoutMillis();
        if (callTimeoutMillis > 0 && callTimeoutMillis <= remainingMillis) {
            return client;
        }
        return client.newBuilder()
            .callTimeout(remainingMillis, TimeUnit.MILLISECONDS)
            .build();
    }

    /**
     * An https URL must stay on https through every redirect: TLS is what
     * authenticates the package and the check response. OkHttp follows
     * cross-scheme redirects by default, so the final request is checked
     * here (the redirected bytes are discarded).
     */
    static void rejectProtocolDowngrade(String requestedUrl, Response response)
        throws IOException {
        if (HttpUtils.isHttpsUrl(requestedUrl) && !response.request().url().isHttps()) {
            throw new IOException(
                "https request redirected to plaintext http: " + response.request().url());
        }
    }
}
