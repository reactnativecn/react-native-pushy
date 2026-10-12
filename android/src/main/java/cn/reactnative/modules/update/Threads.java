package cn.reactnative.modules.update;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** The SDK's named worker threads, so they are identifiable in thread dumps / ANR traces. */
final class Threads {
    private Threads() {
    }

    /** A single-thread executor: tasks run serialized in submission order. */
    static ExecutorService single(final String name, final boolean daemon) {
        return Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, name);
            thread.setDaemon(daemon);
            return thread;
        });
    }

    /** Starts a one-off daemon thread: it never keeps a dying process alive. */
    static Thread startDaemon(String name, Runnable task) {
        return startDaemon(name, -1, task);
    }

    /** As above, with an explicit priority (negative keeps the inherited one). */
    static Thread startDaemon(String name, int priority, Runnable task) {
        Thread thread = new Thread(task, name);
        if (priority >= 0) {
            thread.setPriority(priority);
        }
        thread.setDaemon(true);
        thread.start();
        return thread;
    }
}
