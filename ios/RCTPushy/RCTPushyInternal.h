// Internal to the RCTPushy pod: what the module's translation units share.
// Not a public header; it pulls in C++ headers, so it must stay out of the
// module umbrella.
//
//   RCTPushy.mm              RN exports, constants, host API entry points
//   RCTPushy+Launch.mm       launch bundle resolution, paths, binary identity
//   RCTPushyState.mm         persisted keys, state lock, State <-> defaults,
//                            string/error/JSON helpers, bundle hash
//   RCTPushyInstallRecord.mm version directories, completion record
//                            (over cpp/patch_core/install_record.h)
//   RCTPushyInstaller.mm     download/unzip/patch pipeline, switchVersion,
//                            cleanup (owns the process-wide file queue)
//   RCTPushyOrchestrator.mm  the native round
#pragma once

#import "RCTPushy.h"
#import "RCTPushyCommon.h"
#import <React/RCTBridgeModule.h>
#import <React/RCTLog.h>

#include <atomic>
#include <string>

#include "../../cpp/patch_core/install_record.h"
#include "../../cpp/patch_core/state_core.h"

// RN's log macros pass __FILE__, which would embed this file's absolute build
// path in the binary; log with the bare file name instead.
#if RCTLOG_ENABLED
#undef _RCTLog
#define _RCTLog(lvl, ...) _RCTLogNativeInternal(lvl, __FILE_NAME__, __LINE__, __VA_ARGS__)
#endif

typedef NS_ENUM(NSInteger, PushyType) {
    // <generated:archive-patch-types> (scripts/contract.ts; bun scripts/generate-contract.ts)
    PushyTypeFullDownload = 1,
    PushyTypePatchFromPackage = 2,
    PushyTypePatchFromPpk = 3,
    // </generated:archive-patch-types>
};

#pragma mark - RCTPushyState.mm

extern PUSHY_HIDDEN NSString *const keyPushyInfo;
extern PUSHY_HIDDEN NSString *const paramCurrentVersion;
extern PUSHY_HIDDEN NSString *const keyUuid;
extern PUSHY_HIDDEN NSString *const keyHashInfo;
extern PUSHY_HIDDEN NSString *const keyFirstLoadMarked;
extern PUSHY_HIDDEN NSString *const keyRolledBackMarked;
extern PUSHY_HIDDEN NSString *const keyNativeCheckCache;
extern PUSHY_HIDDEN NSString *const ERROR_OPTIONS;
// Consumed by the first +bundleURL of a process; re-armed by a version switch.
extern PUSHY_HIDDEN std::atomic<bool> ignoreRollback;
// Bumped by resetToPackagedBundle only; see RCTPushyState.mm.
extern PUSHY_HIDDEN std::atomic<uint64_t> pushyResetGeneration;

PUSHY_HIDDEN NSString *KeyPackageUpdatedMarked(void);
PUSHY_HIDDEN NSString *PushyHashInfoKey(NSString *hash);
// Immutable host-facing snapshot; activated always means NEXT launch.
PUSHY_HIDDEN NSDictionary *PushyHostResult(NSString *status, NSString *reason,
                                           NSString *hash = nil, BOOL activated = NO);
PUSHY_HIDDEN NSTimeInterval PushyMonotonicNow(void);
PUSHY_HIDDEN NSUserDefaults *PushyDefaults(void);
PUSHY_HIDDEN void PushyWithStateLock(void (NS_NOESCAPE ^block)(void));
// Inside `@catch (...)`: the reason of what was caught — an NSException's
// reason or a C++ exception's what() — or `fallback` when it has none. The
// shared cores can throw std::bad_alloc / std::length_error, which
// `@catch (NSException *)` lets through; an entry point (RN method, host
// API, GCD block, launch path) therefore catches `...` (CODE_AUDIT 4.4).
PUSHY_HIDDEN NSString *PushyCaughtReason(NSString *fallback);
// Runs `block` for an entry point that has nobody to report to: whatever it
// throws is logged under `where` and swallowed. NO when it threw.
PUSHY_HIDDEN BOOL PushyGuard(NSString *where, void (NS_NOESCAPE ^block)(void));
PUSHY_HIDDEN std::string PushyToStdString(NSString *value);
PUSHY_HIDDEN NSString *PushyFromStdString(const std::string &value);
PUSHY_HIDDEN NSString *PushyOptionString(NSDictionary *options, NSString *key);
PUSHY_HIDDEN BOOL PushyStringIsBlank(NSString *value);
PUSHY_HIDDEN BOOL PushyIsSafePathComponent(NSString *value);
PUSHY_HIDDEN NSError *PushyErrorWithCode(const char *code, NSString *message);
PUSHY_HIDDEN void PushyRejectError(RCTPromiseRejectBlock reject, NSError *error);
// The parsed JSON object in `json` (NSString or NSData); nil when it does not
// parse or is not an object. *error carries the parse error, if any.
PUSHY_HIDDEN NSDictionary *PushyJsonDictionary(id json, NSError **error);
// `object` serialized as a JSON string; nil when it cannot be.
PUSHY_HIDDEN NSString *PushyJsonString(id object);
PUSHY_HIDDEN pushy::state::State PushyStateFromDefaults(NSUserDefaults *defaults);
PUSHY_HIDDEN void PushyApplyStateToDefaults(NSUserDefaults *defaults,
                                            const pushy::state::State &state);
PUSHY_HIDDEN void PushySwitchVersionLocked(NSString *hash);
PUSHY_HIDDEN NSString *PushyBundleHashSync(BOOL computeIfMissing);

#pragma mark - RCTPushyInstallRecord.mm

extern PUSHY_HIDDEN NSString *const BUNDLE_FILE_NAME;

PUSHY_HIDDEN NSString *PushyVersionDir(NSString *hash);
PUSHY_HIDDEN NSString *PushyStagingDir(NSString *hash);
PUSHY_HIDDEN BOOL PushyHasCompletedVersionAtPath(NSString *versionDir, NSString *hash);
PUSHY_HIDDEN NSString *PushyRecordedBundleSha256(NSString *versionDir);
PUSHY_HIDDEN NSError *PushyPromoteStagingDir(NSString *hash, NSString *artifactSha256);

// The activation gate every path that points the next launch at a version
// goes through (switchVersion:error:, the native round's commit and the crash
// hold's pending activation), as Android and Harmony do: only a version
// recorded as completely installed, whose record's bundle digest matches the
// bytes on disk, may be activated (install_record::CheckActivation). Split in
// two because the digest reads the whole bundle and must not run under the
// state lock (+bundleURL takes it on the main thread at launch).
struct PushyVerifiedActivation {
    std::string versionDir;
    std::string hash;
    pushy::install_record::Activation activation;
};
// Outside the state lock. nil when `hash` may be activated (and *out holds
// what was verified), else a SWITCH_VERSION_FAILED error.
PUSHY_HIDDEN NSError *PushyVerifyActivation(NSString *hash, PushyVerifiedActivation *out);
// Under the state lock, right before PushySwitchVersionLocked: whether the
// directory is still the one verified (same grandfathering, same record, same
// bundle file). No hashing.
PUSHY_HIDDEN BOOL PushyVerifiedActivationUnchangedLocked(const PushyVerifiedActivation &verified);

#pragma mark - RCTPushyInstaller.mm

// Protocol key of the artifact URL in download options.
PUSHY_HIDDEN NSString *PushyOptionUrlKey(void);
// Process-wide serial queue for every destructive file operation (unzip,
// patch, promote, cleanup), shared by JS calls and the native round.
PUSHY_HIDDEN dispatch_queue_t PushyFileQueue(void);

// The download → unzip → patch → install pipeline and version activation. No
// bridge needed: JS calls and the native round share it.
@interface RCTPushyInstaller : NSObject
// options: url (PushyOptionUrlKey), hash, originHash (diff only), optional
// deadlineUptime. progress may be nil. callback runs on the file queue, or
// synchronously when nothing has to be downloaded (invalid options, version
// already installed, deadline already passed).
+ (void)fetch:(PushyType)type
      options:(NSDictionary *)options
     progress:(void (^)(long long received, long long total))progress
     callback:(void (^)(NSError *error))callback;
+ (BOOL)switchVersion:(NSString *)hash error:(NSError **)error;
+ (void)clearInvalidFiles;
@end

#pragma mark - RCTPushy+Launch.mm

// The version whose bundle this process actually loaded; guarded by the state
// lock. See RCTPushy+Launch.mm.
extern PUSHY_HIDDEN NSString *pushyLaunchVersion;

@interface RCTPushy (Launch)
+ (NSURL *)resolveLaunchBundleURL:(NSString **)launchRolledBackVersionOut
                    purgedVersion:(NSString **)purgedVersionOut;
+ (NSString *)downloadDir;
+ (NSURL *)binaryBundleURL;
+ (NSString *)packageVersion;
+ (NSString *)buildTime;
@end

#pragma mark - RCTPushyOrchestrator.mm

// Native cold-start update check (NATIVE_CHECKUPDATE_DESIGN §10): runs once
// per process, a few seconds after launch, entirely independent of the app
// bundle — this is what lets a bricked hot update be replaced on the next
// launch. Decisions come from cpp/update_flow_core; this class is IO glue.
@interface RCTPushyOrchestrator : NSObject
+ (void)persistConfiguration:(NSString *)config;
+ (NSDictionary *)prepareBundle;
+ (NSDictionary *)prepareBundleWithin:(NSTimeInterval)timeout;
+ (void)scheduleFromColdStart:(NSString *)launchRolledBackVersion;
#if TARGET_OS_TV && !DEBUG
+ (BOOL)restorePurgedLaunch:(NSString *)purgedVersion
                 rolledBack:(NSString *)launchRolledBackVersion;
#endif
+ (void)recordJsRound:(NSString *)config;
@end
