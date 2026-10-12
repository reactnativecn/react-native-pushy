// Version directories and the completion record: where an install lands and
// how it is recorded as complete. The record itself (format, atomic write,
// presence and activation checks) is the shared core's
// (cpp/patch_core/install_record.h); switchVersion:error: calls its
// activation check directly.
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
