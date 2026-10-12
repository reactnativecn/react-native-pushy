// Version directories and the completion record
// (cpp/patch_core/install_record.h): where an install lands, how it is
// recorded as complete, and how a recorded version is verified before it
// may be activated.
#import "RCTPushyInternal.h"
#include "../../cpp/patch_core/digest.h"
#include "../../cpp/patch_core/error_codes.h"
#include "../../cpp/patch_core/install_record.h"

PUSHY_HIDDEN NSString *const BUNDLE_FILE_NAME = @"index.bundlejs";

static NSString *PushyInstallRecordFileName(void) {
    static NSString *name = @(pushy::install_record::kFileName);
    return name;
}

PUSHY_HIDDEN NSString *PushyVersionDir(NSString *hash) {
    return [[RCTPushy downloadDir] stringByAppendingPathComponent:hash];
}

// Two-phase install: everything lands in <hash>.staging first.
PUSHY_HIDDEN NSString *PushyStagingDir(NSString *hash) {
    return [PushyVersionDir(hash) stringByAppendingString:@(pushy::install_record::kStagingSuffix)];
}

// Parsed completion record: nil when the file is absent or malformed; an
// empty dictionary for the legacy empty marker written by SDK < 10.53.
PUSHY_HIDDEN NSDictionary *PushyReadInstallRecord(NSString *versionDir) {
    NSString *path = [versionDir stringByAppendingPathComponent:PushyInstallRecordFileName()];
    NSData *data = [NSData dataWithContentsOfFile:path];
    if (data == nil) {
        return nil;
    }
    if (data.length == 0) {
        return @{};
    }
    if (data.length > 64 * 1024) {
        return nil;
    }
    return PushyJsonDictionary(data, NULL);
}

// Whether a non-empty record names this version under the current schema.
static BOOL PushyInstallRecordMatches(NSDictionary *record, NSString *hash) {
    return [record[@"schema"] isKindOfClass:[NSNumber class]]
        && [record[@"schema"] intValue] == pushy::install_record::kSchema
        && [record[@"versionHash"] isKindOfClass:[NSString class]]
        && [record[@"versionHash"] isEqualToString:hash];
}

// Whether the directory carries a completion record file at all (the legacy
// empty marker included). Only directories WITHOUT one are grandfathered by
// current/last state in switchVersion; a present record is always verified.
PUSHY_HIDDEN BOOL PushyHasInstallRecordFile(NSString *versionDir) {
    return [[NSFileManager defaultManager] fileExistsAtPath:
        [versionDir stringByAppendingPathComponent:PushyInstallRecordFileName()]];
}

// Presence check (launch / dedup paths, no digest work): bundle present and
// the record exists and, unless legacy-empty, names this version.
PUSHY_HIDDEN BOOL PushyHasCompletedVersionAtPath(NSString *versionDir, NSString *hash) {
    NSString *bundlePath = [versionDir stringByAppendingPathComponent:BUNDLE_FILE_NAME];
    if (![[NSFileManager defaultManager] fileExistsAtPath:bundlePath]) {
        return NO;
    }
    NSDictionary *record = PushyReadInstallRecord(versionDir);
    if (record == nil) {
        return NO;
    }
    return record.count == 0 || PushyInstallRecordMatches(record, hash);
}

PUSHY_HIDDEN PushyFileStamp PushyStampFile(NSString *path) {
    PushyFileStamp stamp;
    struct stat info;
    if (path != nil && stat(path.fileSystemRepresentation, &info) == 0) {
        stamp.exists = true;
        stamp.device = info.st_dev;
        stamp.inode = info.st_ino;
        stamp.size = info.st_size;
        stamp.modified = info.st_mtimespec;
    }
    return stamp;
}

// Activation check: re-hashes the bundle against the record's digest, which
// schema 1 makes mandatory (only the legacy empty marker has none).
// Returns nil when the directory may be activated, the reason otherwise.
// Slow (a full read of the bundle): never call it under the state lock. On
// success *recordOut and *stampOut describe exactly what was verified, so the
// caller can confirm under the lock that nothing changed since.
PUSHY_HIDDEN NSString *PushyVerifyInstallForActivation(NSString *versionDir, NSString *hash,
                                                       NSDictionary **recordOut,
                                                       PushyFileStamp *stampOut) {
    NSString *bundlePath = [versionDir stringByAppendingPathComponent:BUNDLE_FILE_NAME];
    PushyFileStamp before = PushyStampFile(bundlePath);
    NSDictionary *record = PushyReadInstallRecord(versionDir);
    if (record == nil) {
        return [NSString stringWithFormat:@"Bundle version %@ has no valid completion record.", hash];
    }
    *recordOut = record;
    *stampOut = before;
    if (record.count == 0) {
        return nil;
    }
    if (!PushyInstallRecordMatches(record, hash)) {
        return [NSString stringWithFormat:@"Bundle version %@ completion record mismatch.", hash];
    }
    NSString *expected = record[@"bundleSha256"];
    if (![expected isKindOfClass:[NSString class]] || expected.length == 0) {
        return [NSString stringWithFormat:@"Bundle version %@ completion record mismatch.", hash];
    }
    std::string actual = pushy::digest::Sha256File(PushyToStdString(bundlePath));
    if (PushyStampFile(bundlePath) != before) {
        return [NSString stringWithFormat:@"Bundle version %@ changed while being verified.", hash];
    }
    if ([[expected lowercaseString] isEqualToString:[NSString stringWithUTF8String:actual.c_str()]]) {
        return nil;
    }
    return [NSString stringWithFormat:@"Bundle version %@ bundle digest mismatch.", hash];
}

// Second phase of an install: writes the completion record, with the final
// bundle's digest, into <hash>.staging and renames the staging directory over
// <hash> in one atomic step. nil on success. Runs on the file queue. The
// digest is mandatory: a version whose bundle could not be hashed is never
// recorded as installed. The caller drops the staging directory on failure.
PUSHY_HIDDEN NSError *PushyPromoteStagingDir(NSString *hash, NSString *artifactSha256) {
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSString *staging = PushyStagingDir(hash);
    NSString *bundlePath = [staging stringByAppendingPathComponent:BUNDLE_FILE_NAME];
    if (![fileManager fileExistsAtPath:bundlePath]) {
        return PushyErrorWithCode(pushy::error_codes::kDeltaFailed, @"bundle missing after install");
    }
    std::string bundleSha256 = pushy::digest::Sha256File(PushyToStdString(bundlePath));
    if (bundleSha256.empty()) {
        return PushyErrorWithCode(pushy::error_codes::kDeltaFailed,
                                  @"bundle digest failed after install");
    }
    NSMutableDictionary *record = [NSMutableDictionary dictionary];
    record[@"schema"] = @(pushy::install_record::kSchema);
    record[@"versionHash"] = hash;
    record[@"bundleSha256"] = @(bundleSha256.c_str());
    if (artifactSha256.length > 0) {
        record[@"artifactSha256"] = artifactSha256;
    }
    NSError *recordError = nil;
    NSData *recordData = [NSJSONSerialization dataWithJSONObject:record options:0 error:&recordError];
    NSString *marker = [staging stringByAppendingPathComponent:PushyInstallRecordFileName()];
    if (recordData == nil || ![recordData writeToFile:marker
                                              options:NSDataWritingAtomic
                                                error:&recordError]) {
        return recordError ?: PushyErrorWithCode(pushy::error_codes::kFileOperationFailed,
                                                 @"failed to write completion record");
    }
    NSString *versionDir = PushyVersionDir(hash);
    if ([fileManager fileExistsAtPath:versionDir]) {
        [fileManager removeItemAtPath:versionDir error:nil];
    }
    NSError *moveError = nil;
    if (![fileManager moveItemAtPath:staging toPath:versionDir error:&moveError]) {
        return moveError ?: PushyErrorWithCode(pushy::error_codes::kFileOperationFailed,
                                               @"failed to promote staging directory");
    }
    return nil;
}
