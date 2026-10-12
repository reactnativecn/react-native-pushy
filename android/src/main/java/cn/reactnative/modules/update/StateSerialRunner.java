package cn.reactnative.modules.update;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.UiThreadUtil;
import java.util.concurrent.Executor;

/**
 * Runs a module operation on a given executor and rejects its promise with
 * the operation's error code when it throws; the operation resolves the
 * promise itself.
 *
 * State-persistence operations (switchVersion / markSuccess / setUuid /
 * setLocalHashInfo / reset / config) go to {@link #STATE_SERIAL}, a single
 * background thread: they only read/modify SharedPreferences via a
 * synchronous commit(), and were once dispatched to the UI thread purely to
 * serialize them. markSuccess runs on every cold start, so its blocking disk
 * write on the main thread caused jank/ANR on low-end devices; one worker
 * keeps the serialization in submission order without that. Only the React
 * reload itself still hops to {@link #UI_THREAD}.
 */
final class StateSerialRunner {
    interface Operation {
        void run() throws Throwable;
    }

    // Named so it is identifiable in thread dumps / ANR traces.
    static final Executor STATE_SERIAL = Threads.single("pushy-state-serial", false);
    static final Executor UI_THREAD = UiThreadUtil::runOnUiThread;

    private StateSerialRunner() {
    }

    static void run(
        Executor executor,
        final Promise promise,
        final String errorCode,
        final String operationName,
        final Operation operation
    ) {
        executor.execute(() -> {
            try {
                operation.run();
            } catch (Throwable error) {
                promise.reject(errorCode, operationName + " failed", error);
            }
        });
    }
}
