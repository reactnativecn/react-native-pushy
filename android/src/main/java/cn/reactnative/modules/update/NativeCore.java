package cn.reactnative.modules.update;

/**
 * Loads librnpushy.so. Its JNI_OnLoad registers the natives of every class
 * (cpp/android_jni/jni_registration.cpp), so the library only has to be
 * loaded before the first native call: UpdateContext's static initializer
 * does that, and DownloadTask, FlowBridge and supportedDiffVersion are only
 * ever reached through an UpdateContext instance.
 */
final class NativeCore {
    private static boolean loaded = false;

    private NativeCore() {
    }

    static synchronized void ensureLoaded() {
        if (loaded) {
            return;
        }

        try {
            System.loadLibrary(Texts.reveal("2819e4c4bd8371"));
        } catch (UnsatisfiedLinkError error) {
            UnsatisfiedLinkError wrapped = new UnsatisfiedLinkError(
                "Failed to load the native library. Original error: "
                    + error.getMessage());
            wrapped.initCause(error);
            throw wrapped;
        }

        loaded = true;
    }

    /**
     * 原生 patch 内核可消费的 diff 轨道版本(2 = hdiffv2 轨道)。
     * 经 getConstants 暴露给 JS,再随 checkUpdate 以 diffV 上报,
     * 服务端按能力门控下发。
     */
    static int supportedDiffVersion() {
        return getSupportedDiffVersion();
    }

    private static native int getSupportedDiffVersion();
}
