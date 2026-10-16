package cn.reactnative.modules.update;

/**
 * Encoded text helpers with no Android or native dependencies, so any class
 * (and the plain-JVM unit tests) can use them without triggering
 * UpdateContext's native library load.
 */
final class Texts {
    // <generated:texts> (scripts/contract.ts; bun scripts/generate-contract.ts)
    // Version-info flag of a version a crash hold installed (read by JS).
    static final String INFO_CRASH_HOLD = reveal("3905f5c2a6b96d56212a19");
    static final String PREFERENCES_NAME = reveal("2f07f0d0ba8e");
    static final String STORAGE_DIR_NAME = reveal("0502e4d5af9f6d");
    // The bundle patch entry inside a patch archive.
    static final String BUNDLE_DELTA_ENTRY = reveal("3319f0d4b6c56a502c3b10fcdca0de7d4b3307e9");
    static final String OPTION_URL_KEY = reveal("2f07f0d0ba8e5d572e");
    static final String PPK_DELTA_SUFFIX = reveal("7407e4dae09b69512137");
    // Archive suffix of a patch against the installed package.
    static final String PACKAGE_DELTA_SUFFIX = reveal("7416e4dae09b69512137");
    static final String LOG_TAG = reveal("2812f5d2bac6664436360afc9ba680694b3301");
    static final String LIBRARY_NAME = reveal("2819e4c4bd8371");
    static final String INSTALLER_SESSION_EXTRA = reveal("3919bac3ab8a6b512c3e08f0c0b6de60452311edfbc8f680624b2d1de38da5a58e65557f3ecaeb8ea3b859661f3dc3f98bab48646c042bd0e19ca546681c2939");
    static final String RELOAD_METHOD = reveal("2812f8deaf8f");
    // </generated:texts>

    private Texts() {
    }

    /**
     * Decodes text produced by scripts/encode-native-text.ts: byte i is XORed
     * with (0x5A + 0x1D * i) & 0xFF. Keeps service addresses and paths out of
     * static string scans of the binary; it is not a secret.
     */
    static String reveal(String hex) {
        char[] out = new char[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int b = Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
            out[i] = (char) (b ^ ((0x5A + 0x1D * i) & 0xFF));
        }
        return new String(out);
    }
}
