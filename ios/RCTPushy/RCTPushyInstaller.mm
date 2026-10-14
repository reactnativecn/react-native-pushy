// The install pipeline shared by JS calls and the native round: download
// (RCTPushyDownloader) → unzip (archive guard) → patch (cpp/patch_core) →
// promote (RCTPushyInstallRecord.mm), plus version activation and cleanup.
#import "RCTPushyInternal.h"
#import "RCTPushyDownloader.h"
#import <SSZipArchive/SSZipArchive.h>
#include "../../cpp/patch_core/archive_limits.h"
#include "../../cpp/patch_core/archive_patch_core.h"
#include "../../cpp/patch_core/digest.h"
#include "../../cpp/patch_core/error_codes.h"
#include "../../cpp/patch_core/install_record.h"
#include "../../cpp/patch_core/patch_core.h"

#include <memory>

// file def
static NSString *const SOURCE_PATCH_NAME = @"__diff.json";
static NSString *const ERROR_FILE_OPERATION = @"file operation error";

// Protocol strings stored encoded (RCTPushyRevealText) so they do not appear
// as plain binary strings; decoded on first use.
static NSString *BUNDLE_PATCH_NAME(void) {
    static NSString *value = RCTPushyRevealText("3319f0d4b6c56a502c3b10fcdca0de7d4b3307e9");
    return value;
}
PUSHY_HIDDEN NSString *PushyOptionUrlKey(void) {
    static NSString *value = RCTPushyRevealText("2f07f0d0ba8e5d572e");
    return value;
}
static NSString *PushyIpaDeltaSuffix(void) {
    static NSString *value = RCTPushyRevealText("741ee4d0e09b69512137");
    return value;
}
static NSString *PushyPpkDeltaSuffix(void) {
    static NSString *value = RCTPushyRevealText("7407e4dae09b69512137");
    return value;
}

static NSString *PushyArchiveExtension(PushyType type) {
    switch (type) {
        case PushyTypePatchFromPackage:
            return PushyIpaDeltaSuffix();
        case PushyTypePatchFromPpk:
            return PushyPpkDeltaSuffix();
        case PushyTypeFullDownload:
            break;
    }
    return @".ppk";
}

PUSHY_HIDDEN dispatch_queue_t PushyFileQueue(void) {
    // One process-wide serial queue: JS calls (from any bridge instance; a
    // reload can briefly keep two alive) and the native round share it, so
    // destructive file work (resetToPackagedBundle's full cleanup) stays
    // serialized with every unzip/patch job.
    static dispatch_queue_t queue =
        dispatch_queue_create("cn.reactnative.pushy.file", DISPATCH_QUEUE_SERIAL);
    return queue;
}

// nil when the volume holding `path` can take `bytesToWrite` plus the safety
// margin (or the free space is unknown); a PATCH_FAILED error otherwise. The
// probe is the downloader's (RCTPushyFreeSpaceShortfall), which applies the
// same rule to the announced Content-Length before the first byte lands.
static NSError *PushyEnsureFreeSpace(NSString *path, long long bytesToWrite) {
    NSString *shortfall = RCTPushyFreeSpaceShortfall(path, bytesToWrite);
    if (shortfall == nil) {
        return nil;
    }
    return PushyErrorWithCode(pushy::error_codes::kDeltaFailed, shortfall);
}

// SSZipArchive delegate feeding cpp/patch_core/archive_limits.h's
// EntryAccumulator while the archive is walked (entry count, sizes, ratios,
// symlinks: SSZipArchive materialises them with any target regardless of
// preserveAttributes, so `assets -> ../../Documents` followed by `assets/x`
// would write outside the version directory). The entry name is only exposed
// once the entry is on disk, so the reserved `.pushy-` names (the completion
// record is the SDK's alone) are checked in the did-unzip callback.
// A NO from zipArchiveShouldUnzipFileAtIndex: cancels the whole unzip (the
// 2.x contract the podspec pins), and the completion handler turns the
// recorded violation into a hard PATCH_FAILED; the caller then discards the
// staging directory.
@interface PushyUnzipGuard : NSObject <SSZipArchiveDelegate>
@property (nonatomic, copy) NSString *violation;
- (instancetype)initWithArchiveBytes:(long long)archiveBytes destination:(NSString *)destination;
@end

@implementation PushyUnzipGuard {
    std::unique_ptr<pushy::archive_limits::EntryAccumulator> _accumulator;
    NSArray<NSString *> *_destinationComponents;
}

- (instancetype)initWithArchiveBytes:(long long)archiveBytes destination:(NSString *)destination {
    if ((self = [super init])) {
        _accumulator.reset(new pushy::archive_limits::EntryAccumulator(archiveBytes));
        // Joined the way SSZipArchive builds each unpacked path
        // (stringByAppendingPathComponent:), so a trailing slash compares equal.
        NSArray<NSString *> *probe =
            [destination stringByAppendingPathComponent:@"x"].pathComponents;
        _destinationComponents = [probe subarrayWithRange:NSMakeRange(0, probe.count - 1)];
    }
    return self;
}

- (void)recordStatus:(const pushy::delta::Status &)status {
    if (!status.ok && self.violation == nil) {
        self.violation = @(status.message.c_str());
    }
}

- (void)zipArchiveWillUnzipArchiveAtPath:(NSString *)path zipInfo:(unz_global_info)zipInfo {
    [self recordStatus:pushy::archive_limits::CheckEntryCount((long long)zipInfo.number_entry)];
}

- (BOOL)zipArchiveShouldUnzipFileAtIndex:(NSInteger)fileIndex
                              totalFiles:(NSInteger)totalFiles
                             archivePath:(NSString *)archivePath
                                fileInfo:(unz_file_info)fileInfo {
    if (self.violation != nil) {
        return NO;
    }
    // Unix mode bits travel in the high 16 bits of the external attributes
    // (the same field SSZipArchive keys its own symlink branch on).
    BOOL symlink = ((fileInfo.external_fa >> 16) & S_IFMT) == S_IFLNK;
    [self recordStatus:_accumulator->Accept((long long)fileInfo.uncompressed_size,
                                            (long long)fileInfo.compressed_size,
                                            symlink, std::string())];
    return self.violation == nil;
}

// A reserved name is flagged here (any component of the path below the
// destination); the next shouldUnzip refuses (cancelling the unzip) or, for
// the last entry, the completion handler picks the violation up. Either way
// the caller drops the whole staging directory, so the written file never
// survives.
- (void)zipArchiveDidUnzipFileAtIndex:(NSInteger)fileIndex
                           totalFiles:(NSInteger)totalFiles
                          archivePath:(NSString *)archivePath
                     unzippedFilePath:(NSString *)unzippedFilePath {
    if (self.violation != nil) {
        return;
    }
    NSArray<NSString *> *components = unzippedFilePath.pathComponents;
    NSUInteger base = _destinationComponents.count;
    if (components.count <= base
        || ![[components subarrayWithRange:NSMakeRange(0, base)]
               isEqualToArray:_destinationComponents]) {
        self.violation = [NSString stringWithFormat:@"archive entry #%ld outside the destination",
                          (long)fileIndex];
        return;
    }
    NSString *name = [[components subarrayWithRange:NSMakeRange(base, components.count - base)]
                      componentsJoinedByString:@"/"];
    if (pushy::archive_limits::IsReservedEntryName(PushyToStdString(name))) {
        self.violation = [NSString stringWithFormat:@"archive contains reserved entry %@", name];
    }
}

@end

// JS (any bridge instance) and the native round share one download per target
// hash. Without this process-wide registry two transfers race over the same
// archive path and the later unzip can delete the first task's valid output.
static NSMutableDictionary<NSString *, NSMutableDictionary *> *PushyInFlightDownloads(void) {
    static NSMutableDictionary<NSString *, NSMutableDictionary *> *downloads =
        [NSMutableDictionary dictionary];
    return downloads;
}

typedef NS_ENUM(NSInteger, PushyDownloadRegistration) {
    PushyDownloadRegistrationOwner,
    PushyDownloadRegistrationJoined,
    PushyDownloadRegistrationDeferred,
};

static PushyDownloadRegistration PushyRegisterDownload(
    NSString *hash,
    NSInteger type,
    NSTimeInterval deadlineUptime,
    void (^callback)(NSError *),
    void (^progress)(long long, long long),
    void (^deferredStart)(void)
) {
    NSMutableDictionary *downloads = PushyInFlightDownloads();
    @synchronized (downloads) {
        NSMutableDictionary *entry = downloads[hash];
        if (entry != nil) {
            if ([entry[@"type"] integerValue] == type) {
                NSTimeInterval ownerDeadline = [entry[@"deadlineUptime"] doubleValue];
                // A caller with substantially more time must not inherit an
                // owner's nearly-exhausted timeout: it observes the current
                // transfer and restarts after the owner settles (the
                // completion-marker preflight makes a successful owner free).
                // The comparison is on remaining budget, not on the absolute
                // deadline: a JS caller always computes now+600 a few seconds
                // after the owner did, so a strict `>` would defer every
                // second caller and turn the shared download back into
                // serialized re-downloads. Only a genuinely starved owner
                // (less than half the newcomer's budget left) defers.
                const NSTimeInterval now = PushyMonotonicNow();
                if (2 * (ownerDeadline - now) < (deadlineUptime - now)) {
                    if (progress != nil) {
                        [entry[@"progress"] addObject:[progress copy]];
                    }
                    [entry[@"deferred"] addObject:[deferredStart copy]];
                    return PushyDownloadRegistrationDeferred;
                }
                [entry[@"callbacks"] addObject:[callback copy]];
                if (progress != nil) {
                    [entry[@"progress"] addObject:[progress copy]];
                }
                return PushyDownloadRegistrationJoined;
            }
            // A diff failure must not settle a joined full request. Queue the
            // different artifact type behind the owner; once restarted it
            // registers normally (and re-checks the completion marker).
            if (progress != nil) {
                // The artifact type differs, but it still installs the same
                // target hash. Keep the waiting JS UI moving while its own
                // transfer is queued behind the current owner.
                [entry[@"progress"] addObject:[progress copy]];
            }
            [entry[@"deferred"] addObject:[deferredStart copy]];
            return PushyDownloadRegistrationDeferred;
        }
        NSMutableArray *progressHandlers = [NSMutableArray array];
        if (progress != nil) {
            [progressHandlers addObject:[progress copy]];
        }
        downloads[hash] = [@{
            @"type": @(type),
            @"deadlineUptime": @(deadlineUptime),
            @"callbacks": [NSMutableArray arrayWithObject:[callback copy]],
            @"progress": progressHandlers,
            @"deferred": [NSMutableArray array],
        } mutableCopy];
        return PushyDownloadRegistrationOwner;
    }
}

static void PushyReportDownloadProgress(
    NSString *hash, long long received, long long total
) {
    NSMutableDictionary *downloads = PushyInFlightDownloads();
    NSArray *handlers = nil;
    @synchronized (downloads) {
        handlers = [downloads[hash][@"progress"] copy];
    }
    for (id value in handlers) {
        void (^handler)(long long, long long) =
            (void (^)(long long, long long))value;
        handler(received, total);
    }
}

static void PushyFinishDownload(NSString *hash, NSError *error) {
    NSMutableDictionary *downloads = PushyInFlightDownloads();
    NSArray *callbacks = nil;
    NSArray *deferred = nil;
    @synchronized (downloads) {
        callbacks = [downloads[hash][@"callbacks"] copy];
        deferred = [downloads[hash][@"deferred"] copy];
        [downloads removeObjectForKey:hash];
    }
    // Establish the next (different-type) owner before waking the completed
    // owner's callbacks; otherwise its strategy loop could race the waiter.
    for (id value in deferred) {
        void (^start)(void) = (void (^)(void))value;
        start();
    }
    for (id value in callbacks) {
        void (^callback)(NSError *) = (void (^)(NSError *))value;
        callback(error);
    }
}

// Everything under rctpushy is re-downloadable, and Application Support is
// backed up to iCloud by default — Apple requires such content to be
// excluded from backups.
static void PushyExcludeFromBackup(NSString *path) {
#if !TARGET_OS_TV  // tvOS stores under Caches, which is never backed up.
    NSURL *url = [NSURL fileURLWithPath:path isDirectory:YES];
    NSError *error = nil;
    if (![url setResourceValue:@YES
                        forKey:NSURLIsExcludedFromBackupKey
                         error:&error]) {
        RCTLogWarn(@"Pushy exclude from backup error: %@", error.localizedDescription);
    }
#endif
}

static BOOL PushyEnsureDirectoryExists(NSString *path) {
    // No file-queue hop here: that queue also runs multi-second unzip/patch
    // work, and a dispatch_sync onto it would block the whole module method
    // queue for the duration. createDirectoryAtPath is idempotent and
    // thread-safe, so checking inline is fine.
    NSFileManager *fileManager = [NSFileManager defaultManager];
    BOOL isDirectory = NO;
    if ([fileManager fileExistsAtPath:path isDirectory:&isDirectory]) {
        if (isDirectory) {
            // Directories created by older versions never got the flag.
            PushyExcludeFromBackup(path);
        }
        return isDirectory;
    }

    NSError *error = nil;
    BOOL success = [fileManager createDirectoryAtPath:path
                          withIntermediateDirectories:YES
                                           attributes:nil
                                                error:&error];
    if (!success && error != nil) {
        RCTLogWarn(@"Pushy create directory error: %@", error.localizedDescription);
    }
    if (success) {
        PushyExcludeFromBackup(path);
    }

    return success;
}

@implementation RCTPushyInstaller

+ (void)fetch:(PushyType)type
      options:(NSDictionary *)options
     progress:(void (^)(long long, long long))progress
     callback:(void (^)(NSError *error))callback
{
    NSString *updateUrl = PushyOptionString(options, PushyOptionUrlKey());
    NSString *hash = PushyOptionString(options, @"hash");

    if (PushyStringIsBlank(updateUrl) || !PushyIsSafePathComponent(hash)) {
        callback(PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS));
        return;
    }
    NSString *originHash = PushyOptionString(options, @"originHash");
    if (type == PushyTypePatchFromPpk && !PushyIsSafePathComponent(originHash)) {
        callback(PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS));
        return;
    }

    NSString *dir = [RCTPushy downloadDir];
    if (!PushyEnsureDirectoryExists(dir)) {
        callback(PushyErrorWithCode(pushy::error_codes::kFileOperationFailed, ERROR_FILE_OPERATION));
        return;
    }

    if (PushyHasCompletedVersionAtPath(PushyVersionDir(hash), hash)) {
        callback(nil);
        return;
    }

    NSTimeInterval deadlineUptime = PushyMonotonicNow() + 600;
    NSNumber *configuredDeadline = options[@"deadlineUptime"];
    if ([configuredDeadline isKindOfClass:[NSNumber class]]) {
        deadlineUptime = configuredDeadline.doubleValue;
    }
    NSError *(^deadlineExpired)(void) = ^NSError * {
        return PushyErrorWithCode(pushy::error_codes::kDownloadFailed,
                                  @"download deadline expired before start");
    };
    if (deadlineUptime <= PushyMonotonicNow()) {
        callback(deadlineExpired());
        return;
    }

    void (^deferredStart)(void) = ^{
        [self fetch:type options:options progress:progress callback:callback];
    };
    PushyDownloadRegistration registration = PushyRegisterDownload(
        hash, type, deadlineUptime, callback, progress, deferredStart);
    if (registration != PushyDownloadRegistrationOwner) {
        RCTLogInfo(
            @"RCTPushy -- %@ in-flight download for %@",
            registration == PushyDownloadRegistrationJoined ? @"join" : @"defer",
            hash);
        return;
    }

    NSString *zipFilePath = [dir stringByAppendingPathComponent:
        [hash stringByAppendingString:PushyArchiveExtension(type)]];
    // SHA-256 of the downloaded archive for the completion record. Written and
    // read on the serial file queue only: taken before the unzip consumes the
    // file, consumed by the completion block after it.
    __block NSString *artifactSha256 = nil;

    // Settles every JS/native waiter only after the staging directory was
    // promoted (or dropped) on the process-wide file queue. On failure only
    // the staging directory is removed, like Android/Harmony: a half-unzipped
    // or half-patched dir leaks disk and could later be mistaken for a
    // complete version, while the final version directory is never touched
    // by a failed install. hash is validated above, so this can never resolve
    // to the download root itself.
    void (^completion)(NSError *) = ^(NSError *error) {
        dispatch_async(PushyFileQueue(), ^{
            NSError *finalError = error ?: PushyPromoteStagingDir(hash, artifactSha256);
            if (finalError != nil) {
                [[NSFileManager defaultManager] removeItemAtPath:PushyStagingDir(hash) error:nil];
            }
            PushyFinishDownload(hash, finalError);
        });
    };

    RCTLogInfo(@"RCTPushy -- download file %@", updateUrl);
    NSTimeInterval timeoutSeconds = deadlineUptime - PushyMonotonicNow();
    if (timeoutSeconds <= 0) {
        completion(deadlineExpired());
        return;
    }
    [RCTPushyDownloader download:updateUrl
                        savePath:zipFilePath
                 timeoutInterval:timeoutSeconds
                 progressHandler:^(long long receivedBytes, long long totalBytes) {
        PushyReportDownloadProgress(hash, receivedBytes, totalBytes);
    } completionHandler:^(NSString *path, NSError *error) {
        if (error != nil) {
            completion(error);
            return;
        }
        dispatch_async(PushyFileQueue(), ^{
            artifactSha256 = PushyFromStdString(
                pushy::digest::Sha256File(PushyToStdString(zipFilePath)));
        });
        [self unzipDownloadedPackage:zipFilePath
                                hash:hash
                                type:type
                          originHash:originHash
                            callback:completion];
    }];
}

+ (void)unzipDownloadedPackage:(NSString *)zipFilePath
                          hash:(NSString *)hash
                          type:(PushyType)type
                    originHash:(NSString *)originHash
                      callback:(void (^)(NSError *error))callback
{
    RCTLogInfo(@"RCTPushy -- unzip file %@", zipFilePath);
    // Everything lands in <hash>.staging; the completion block promotes it.
    [self unzipFileAtPath:zipFilePath
            toDestination:PushyStagingDir(hash)
        completionHandler:^(NSError *error) {
        dispatch_async(PushyFileQueue(), ^{
            if (error != nil) {
                callback(error);
                return;
            }
            @try {
                [self finishDownloadedPackage:hash type:type originHash:originHash callback:callback];
            } @catch (NSException *exception) {
                // An uncaught exception in a GCD block is fatal (and would
                // trip the crash rescue); a bad package is a PATCH_FAILED.
                callback(PushyErrorWithCode(pushy::error_codes::kDeltaFailed,
                                            exception.reason ?: @"delta failed"));
            }
        });
    }];
}

+ (void)finishDownloadedPackage:(NSString *)hash
                           type:(PushyType)type
                     originHash:(NSString *)originHash
                       callback:(void (^)(NSError *error))callback
{
    switch (type) {
        case PushyTypePatchFromPackage:
            callback([self applyDeltaForHash:hash
                                        type:type
                                  fromBundle:[[RCTPushy binaryBundleURL] path]
                                      source:[[NSBundle mainBundle] resourcePath]]);
            return;
        case PushyTypePatchFromPpk: {
            NSString *lastVersionDir = PushyVersionDir(originHash);
            callback([self applyDeltaForHash:hash
                                        type:type
                                  fromBundle:[lastVersionDir stringByAppendingPathComponent:BUNDLE_FILE_NAME]
                                      source:lastVersionDir]);
            return;
        }
        case PushyTypeFullDownload:
            callback(nil);
            return;
    }
}

// Applies the unpacked patch in the staging directory (two-phase install);
// nil on success, a PATCH_FAILED error otherwise. __diff.json is handed to
// the patch core as text (cpp/patch_core/patch_manifest.h parses it).
+ (NSError *)applyDeltaForHash:(NSString *)hash
                          type:(PushyType)type
                    fromBundle:(NSString *)bundleOrigin
                        source:(NSString *)sourceOrigin
{
    NSString *unzipDir = PushyStagingDir(hash);
    NSString *sourcePatch = [unzipDir stringByAppendingPathComponent:SOURCE_PATCH_NAME];
    NSString *bundlePatch = [unzipDir stringByAppendingPathComponent:BUNDLE_PATCH_NAME()];
    NSFileManager *fileManager = [NSFileManager defaultManager];

    pushy::archive_patch::ArchivePatchRequest request;
    request.archive.type = type == PushyTypePatchFromPackage
        ? pushy::archive_patch::ArchivePatchType::kPatchFromPackage
        : pushy::archive_patch::ArchivePatchType::kPatchFromPpk;
    if ([fileManager fileExistsAtPath:sourcePatch isDirectory:NULL]) {
        long long manifestBytes = RCTPushyFileSize(sourcePatch);
        if (manifestBytes > pushy::archive_limits::kMaxManifestBytes) {
            return PushyErrorWithCode(pushy::error_codes::kDeltaFailed,
                [NSString stringWithFormat:@"delta manifest too large: %lld bytes", manifestBytes]);
        }
        NSData *data = [NSData dataWithContentsOfFile:sourcePatch];
        if (data == nil) {
            return PushyErrorWithCode(pushy::error_codes::kDeltaFailed, @"unreadable delta manifest");
        }
        request.archive.entry_names.push_back(PushyToStdString(SOURCE_PATCH_NAME));
        request.archive.manifest_json.assign(static_cast<const char *>(data.bytes), data.length);
    }
    if ([fileManager fileExistsAtPath:bundlePatch isDirectory:NULL]) {
        request.archive.entry_names.push_back(PushyToStdString(BUNDLE_PATCH_NAME()));
    }
    request.source_root = PushyToStdString(sourceOrigin);
    request.target_root = PushyToStdString(unzipDir);
    request.origin_bundle_path = PushyToStdString(bundleOrigin);
    request.bundle_patch_path = PushyToStdString(bundlePatch);
    request.bundle_output_path = PushyToStdString(
        [unzipDir stringByAppendingPathComponent:BUNDLE_FILE_NAME]);

    pushy::delta::Status status = pushy::archive_patch::ApplyArchivePatch(request, nullptr);
    if (!status.ok) {
        return PushyErrorWithCode(pushy::error_codes::kDeltaFailed, @(status.message.c_str()));
    }
    return nil;
}

+ (void)unzipFileAtPath:(NSString *)path
          toDestination:(NSString *)destination
      completionHandler:(void (^)(NSError *error))completionHandler
{
    dispatch_async(PushyFileQueue(), ^{
        NSFileManager *fileManager = [NSFileManager defaultManager];
        if ([fileManager fileExistsAtPath:destination]) {
            [fileManager removeItemAtPath:destination error:nil];
        }

        // Resource caps before the first byte is extracted
        // (cpp/patch_core/archive_limits.h). SSZipArchive only exposes the
        // entry count up front (zipArchiveWillUnzipArchiveAtPath:zipInfo:),
        // not the uncompressed total, so the disk check uses a 2x-archive
        // heuristic; the guard enforces the exact caps entry by entry.
        long long archiveBytes = RCTPushyFileSize(path);
        NSError *preflight = nil;
        if (archiveBytes > pushy::archive_limits::kMaxArchiveBytes) {
            preflight = PushyErrorWithCode(pushy::error_codes::kDeltaFailed,
                [NSString stringWithFormat:@"archive too large: %lld bytes", archiveBytes]);
        } else {
            preflight = PushyEnsureFreeSpace(destination, MAX(0LL, archiveBytes) * 2);
        }
        if (preflight != nil) {
            RCTPushyDiscardArchive(path);
            completionHandler(preflight);
            return;
        }

        PushyUnzipGuard *guard = [[PushyUnzipGuard alloc] initWithArchiveBytes:archiveBytes
                                                                    destination:destination];
        // preserveAttributes:NO — the archive's mode/mtime bits have no use
        // here and are one less thing a hostile package controls.
        [SSZipArchive unzipFileAtPath:path
                        toDestination:destination
                   preserveAttributes:NO
                            overwrite:YES
                       nestedZipLevel:0
                             password:nil
                                error:nil
                             delegate:guard
                      progressHandler:nil
                    completionHandler:^(NSString *archivePath, BOOL succeeded, NSError *error) {
            // The resume sidecar dies with its archive (§11.4): whether the
            // unzip consumed it or classified it as poisoned, nothing must
            // survive to vouch for bytes that are gone.
            RCTPushyDiscardArchive(archivePath);

            NSError *unzipError = error;
            if (guard.violation != nil) {
                unzipError = PushyErrorWithCode(pushy::error_codes::kDeltaFailed, guard.violation);
            } else if (!succeeded && unzipError == nil) {
                unzipError = PushyErrorWithCode(pushy::error_codes::kDeltaFailed, @"unzip failed");
            } else if (unzipError != nil && unzipError.userInfo[RCTPushyErrorCodeKey] == nil) {
                // SSZipArchive's own NSError (corrupt zip, bad magic, ...) has
                // no stable code; without one, fetchPackage's fallback would
                // classify it as DOWNLOAD_FAILED even though the download
                // succeeded — keep the classification deterministic.
                unzipError = PushyErrorWithCode(pushy::error_codes::kDeltaFailed,
                                                unzipError.localizedDescription ?: @"unzip failed");
            }
            completionHandler(unzipError);
        }];
    });
}

+ (BOOL)switchVersion:(NSString *)hash error:(NSError **)error
{
    // Same gate as Android and Harmony (install_record::CheckActivation); see
    // PushyVerifyActivation.
    PushyVerifiedActivation verified;
    __block NSError *switchError = PushyVerifyActivation(hash, &verified);
    if (switchError == nil) {
        PushyWithStateLock(^{
            if (!PushyVerifiedActivationUnchangedLocked(verified)) {
                switchError = PushyErrorWithCode(
                    pushy::error_codes::kSwitchVersionFailed,
                    [NSString stringWithFormat:@"Bundle version %@ changed while switching.", hash]);
                return;
            }
            PushySwitchVersionLocked(hash);
        });
    }
    if (switchError != nil) {
        if (error != NULL) {
            *error = switchError;
        }
        return NO;
    }
    return YES;
}

+ (void)clearInvalidFiles
{
    dispatch_async(PushyFileQueue(), ^{
        // Snapshot the state under the lock, but run the (slow) filesystem
        // cleanup outside of it so state operations are not blocked.
        __block pushy::state::State state;
        __block NSString *launchVersion = nil;
        PushyWithStateLock(^{
            state = PushyStateFromDefaults(PushyDefaults());
            launchVersion = pushyLaunchVersion;
        });
        // Keep the persisted current/last versions AND the version this
        // process booted from: two switches without a restart would otherwise
        // evict the running bundle while its on-demand assets are still
        // being served.
        pushy::delta::Status status = pushy::delta::CleanupOldEntries(
            PushyToStdString([RCTPushy downloadDir]),
            std::vector<std::string>{
                state.current_version,
                state.last_version,
                PushyToStdString(launchVersion),
            },
            3
        );
        if (!status.ok) {
            RCTLogWarn(@"Pushy cleanup error: %s", status.message.c_str());
        }
    });
}

@end
