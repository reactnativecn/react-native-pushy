// Version directories and the completion record: where an install lands and
// how it is recorded as complete. The record itself (format, atomic write,
// presence and activation checks) is the shared core's
// (cpp/patch_core/install_record.h); every activation goes through its
// activation check (PushyVerifyActivation below).
#import "RCTPushyInternal.h"
#include "../../cpp/patch_core/error_codes.h"
#include "../../cpp/patch_core/install_record.h"

PUSHY_HIDDEN NSString *const BUNDLE_FILE_NAME = @"index.bundlejs";

PUSHY_HIDDEN NSString *PushyVersionDir(NSString *hash) {
    return [[RCTPushy downloadDir] stringByAppendingPathComponent:hash];
}

// Two-phase install: everything lands in <hash>.staging first.
PUSHY_HIDDEN NSString *PushyStagingDir(NSString *hash) {
    return [PushyVersionDir(hash) stringByAppendingString:@(pushy::install_record::kStagingSuffix)];
}

// Presence check (launch / dedup paths, no digest work): bundle present and
// the record is the legacy marker or names this version.
PUSHY_HIDDEN BOOL PushyHasCompletedVersionAtPath(NSString *versionDir, NSString *hash) {
    return pushy::install_record::IsComplete(PushyToStdString(versionDir), PushyToStdString(hash),
                                             PushyToStdString(BUNDLE_FILE_NAME));
}

// The record's bundleSha256 (crash attribution); @"" when there is none.
PUSHY_HIDDEN NSString *PushyRecordedBundleSha256(NSString *versionDir) {
    return PushyFromStdString(
        pushy::install_record::RecordedBundleSha256(PushyToStdString(versionDir))) ?: @"";
}

// Second phase of an install: seals <hash>.staging with the completion
// record (the final bundle's digest is mandatory: a version whose bundle
// could not be hashed is never recorded as installed) and renames it over
// <hash> in one atomic step. nil on success. Runs on the file queue. The
// caller drops the staging directory on failure.
PUSHY_HIDDEN NSError *PushyPromoteStagingDir(NSString *hash, NSString *artifactSha256) {
    std::string staging = PushyToStdString(PushyStagingDir(hash));
    pushy::install_record::SealResult sealed = pushy::install_record::Seal(
        staging, PushyToStdString(hash), PushyToStdString(BUNDLE_FILE_NAME),
        PushyToStdString(artifactSha256), std::string());
    if (!sealed.status.ok) {
        return PushyErrorWithCode(sealed.file_failure ? pushy::error_codes::kFileOperationFailed
                                                      : pushy::error_codes::kDeltaFailed,
                                  PushyFromStdString(sealed.status.message));
    }
    NSString *versionDir = PushyVersionDir(hash);
    NSFileManager *fileManager = [NSFileManager defaultManager];
    if ([fileManager fileExistsAtPath:versionDir]) {
        [fileManager removeItemAtPath:versionDir error:nil];
    }
    pushy::install_record::Status promoted =
        pushy::install_record::Promote(staging, PushyToStdString(versionDir));
    if (!promoted.ok) {
        return PushyErrorWithCode(pushy::error_codes::kFileOperationFailed,
                                  PushyFromStdString(promoted.message));
    }
    return nil;
}

// Versions activated before records existed are grandfathered through the
// persisted current/last state, but only while their directory has no record
// file (install_record::CheckActivation). Call under the state lock.
static BOOL PushyIsCurrentOrLastLocked(const std::string &hash) {
    pushy::state::State state = PushyStateFromDefaults(PushyDefaults());
    return state.current_version == hash || state.last_version == hash;
}

PUSHY_HIDDEN NSError *PushyVerifyActivation(NSString *hash, PushyVerifiedActivation *out) {
    if (!PushyIsSafePathComponent(hash)) {
        return PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS);
    }
    PushyVerifiedActivation verified;
    verified.versionDir = PushyToStdString(PushyVersionDir(hash));
    verified.hash = PushyToStdString(hash);
    __block BOOL grandfathered = NO;
    const std::string hashStd = verified.hash;
    PushyWithStateLock(^{
        grandfathered = PushyIsCurrentOrLastLocked(hashStd);
    });
    pushy::install_record::Status status = pushy::install_record::CheckActivation(
        verified.versionDir, verified.hash, PushyToStdString(BUNDLE_FILE_NAME), grandfathered,
        &verified.activation);
    if (!status.ok) {
        return PushyErrorWithCode(pushy::error_codes::kSwitchVersionFailed,
                                  PushyFromStdString(status.message));
    }
    if (out != NULL) {
        *out = verified;
    }
    return nil;
}

PUSHY_HIDDEN BOOL PushyVerifiedActivationUnchangedLocked(const PushyVerifiedActivation &verified) {
    return pushy::install_record::Unchanged(verified.versionDir,
                                            PushyToStdString(BUNDLE_FILE_NAME),
                                            PushyIsCurrentOrLastLocked(verified.hash),
                                            verified.activation);
}
