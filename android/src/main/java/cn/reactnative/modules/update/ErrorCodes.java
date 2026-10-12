package cn.reactnative.modules.update;

/**
 * Stable, machine-readable error codes used as the promise rejection code so
 * the JS layer and user loggers can aggregate errors across platforms.
 *
 * MUST stay in sync with cpp/patch_core/error_codes.h (the single source of
 * truth) and src/error.ts (UpdateErrorCode). Messages are free-form; only the
 * codes are part of the contract.
 */
final class ErrorCodes {
    static final String INVALID_OPTIONS = "INVALID_OPTIONS";
    static final String DOWNLOAD_FAILED = "DOWNLOAD_FAILED";
    // Encoded (see Texts.reveal): the value is "PATCH_FAILED".
    static final String DELTA_FAILED = Texts.reveal("0a36c0f286b44e640b1339dd");
    static final String FILE_OPERATION_FAILED = "FILE_OPERATION_FAILED";
    static final String SWITCH_VERSION_FAILED = "SWITCH_VERSION_FAILED";
    static final String MARK_SUCCESS_FAILED = "MARK_SUCCESS_FAILED";
    static final String RESTART_FAILED = "RESTART_FAILED";
    static final String RESET_FAILED = "RESET_FAILED";
    static final String INVALID_HASH_INFO = "INVALID_HASH_INFO";
    static final String UNSUPPORTED_PLATFORM = "UNSUPPORTED_PLATFORM";
    static final String APK_INSTALL_PERMISSION_REQUIRED = "APK_INSTALL_PERMISSION_REQUIRED";
    static final String APK_INSTALL_FAILED = "APK_INSTALL_FAILED";

    private ErrorCodes() {
    }

    /**
     * Rejection code of a failed download task, from DownloadTask's
     * classification: post-download failures (unzip / hdiff / resource copy,
     * incl. copiesCrc verification) are PATCH_FAILED so telemetry can
     * separate patch health from network health; a local refusal
     * (reinstalling the running version in place) is FILE_OPERATION_FAILED.
     */
    static String forDownloadFailure(Throwable error) {
        if (error instanceof PatchFailedException) {
            return DELTA_FAILED;
        }
        if (error instanceof FileOperationException) {
            return FILE_OPERATION_FAILED;
        }
        return DOWNLOAD_FAILED;
    }

    /**
     * Whether another mirror of the same artifact can change the outcome
     * (mirrors update_flow_core::IsMirrorRetryableCode and the JS
     * isMirrorRetryableCode). A patch failure cannot: the bytes arrived and
     * every mirror serves the same artifact.
     */
    static boolean isMirrorRetryable(String code) {
        return !DELTA_FAILED.equals(code);
    }
}
