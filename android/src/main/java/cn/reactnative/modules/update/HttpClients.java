package cn.reactnative.modules.update;

import okhttp3.OkHttpClient;

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
}
