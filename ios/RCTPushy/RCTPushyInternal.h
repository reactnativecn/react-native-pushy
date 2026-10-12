// Internal to the RCTPushy pod: what RCTPushy.mm (module, install pipeline,
// launch resolution) and RCTPushyOrchestrator.mm (native round) share. Not a
// public header.
#pragma once

#import "RCTPushy.h"
#import <React/RCTBridgeModule.h>
#import <React/RCTLog.h>

#include <atomic>
#include <string>

#include "../../cpp/patch_core/state_core.h"

// RN's log macros pass __FILE__, which would embed this file's absolute build
// path in the binary; log with the bare file name instead.
#if RCTLOG_ENABLED
#undef _RCTLog
#define _RCTLog(lvl, ...) _RCTLogNativeInternal(lvl, __FILE_NAME__, __LINE__, __VA_ARGS__)
#endif

// Shared across the pod's translation units, never exported from a dynamic
// framework.
#define PUSHY_HIDDEN __attribute__((visibility("hidden")))

typedef NS_ENUM(NSInteger, PushyType) {
    PushyTypeFullDownload = 1,
    PushyTypePatchFromPackage = 2,
    PushyTypePatchFromPpk = 3,
};

@interface RCTPushy ()
- (void)fetchPackage:(PushyType)type
               options:(NSDictionary *)options
              resolver:(RCTPromiseResolveBlock)resolve
              rejecter:(RCTPromiseRejectBlock)reject;
- (void)performFetch:(PushyType)type
              options:(NSDictionary *)options
             callback:(void (^)(NSError *error))callback;
- (NSError *)restartBridgeWithReason:(NSString *)reason;
- (void)unzipDownloadedPackage:(NSString *)zipFilePath
                          hash:(NSString *)hash
                          type:(PushyType)type
                    originHash:(NSString *)originHash
                      callback:(void (^)(NSError *error))callback;
- (void)finishDownloadedPackage:(NSString *)hash
                           type:(PushyType)type
                     originHash:(NSString *)originHash
                       callback:(void (^)(NSError *error))callback;
- (void)applyDeltaForHash:(NSString *)hash
                     type:(PushyType)type
               fromBundle:(NSString *)bundleOrigin
                   source:(NSString *)sourceOrigin
                 callback:(void (^)(NSError *error))callback;
- (BOOL)switchVersion:(NSString *)hash error:(NSError **)error;
- (BOOL)ensureDirectoryExistsAtPath:(NSString *)path;
+ (void)excludeFromBackup:(NSString *)path;
- (void)unzipFileAtPath:(NSString *)path
          toDestination:(NSString *)destination
      completionHandler:(void (^)(NSError *error))completionHandler;
+ (NSString *)downloadDir;
+ (NSURL *)binaryBundleURL;
+ (NSString *)packageVersion;
+ (NSString *)buildTime;
@end

// Native cold-start update check (NATIVE_CHECKUPDATE_DESIGN §10): runs once
// per process, a few seconds after launch, entirely independent of the app
// bundle — this is what lets a bricked hot update be replaced on the next
// launch. Decisions come from cpp/update_flow_core; this class is IO glue.
@interface RCTPushyOrchestrator : NSObject
+ (void)persistConfiguration:(NSString *)config;
+ (BOOL)hasRunnableConfig;
+ (NSDictionary *)prepareBundle;
+ (NSDictionary *)prepareBundleWithin:(NSTimeInterval)timeout;
+ (void)scheduleFromColdStart:(NSString *)launchRolledBackVersion;
#if TARGET_OS_TV && !DEBUG
+ (BOOL)restorePurgedLaunch:(NSString *)purgedVersion
                 rolledBack:(NSString *)launchRolledBackVersion;
#endif
+ (void)recordJsRound:(NSString *)config;
+ (void)startRoundWithDeadline:(NSTimeInterval)deadlineUptime;
+ (BOOL)claimRound;
+ (void)runClaimedRoundWithDeadline:(NSTimeInterval)deadlineUptime;
+ (void)runOnce:(NSString *)launchRolledBackVersion deadline:(NSTimeInterval)deadlineUptime;
+ (void)runHoldRoundWithDeadline:(NSTimeInterval)deadlineUptime;
+ (BOOL)commitRoundWithGeneration:(uint64_t)generation
                 configGeneration:(uint64_t)configGeneration
                         hashInfo:(NSDictionary *)hashInfoEntry
                         activate:(NSString *)hashToActivate
                     responseText:(NSString *)responseText
                          request:(NSString *)requestBody
                           config:(NSString *)configJson
                       responseAt:(long long)responseAtSeconds
                        activated:(BOOL *)activatedOut;
@end

extern PUSHY_HIDDEN NSString *const keyUuid;
extern PUSHY_HIDDEN NSString *const keyNativeConfig;
extern PUSHY_HIDDEN NSString *const keyNativeCheckCache;
extern PUSHY_HIDDEN NSString *const keyNativeCheckIncomplete;
extern PUSHY_HIDDEN std::atomic<uint64_t> pushyResetGeneration;
PUSHY_HIDDEN NSDictionary *PushyHostResult(NSString *status, NSString *reason, NSString *hash, BOOL activated);
PUSHY_HIDDEN NSTimeInterval PushyMonotonicNow(void);
PUSHY_HIDDEN std::string PushyToStdString(NSString *value);
PUSHY_HIDDEN NSString *PushyFromStdString(const std::string &value);
PUSHY_HIDDEN NSUserDefaults *PushyDefaults(void);
PUSHY_HIDDEN void PushyWithStateLock(void (NS_NOESCAPE ^block)(void));
PUSHY_HIDDEN NSString *PushyHashInfoKey(NSString *hash);
PUSHY_HIDDEN BOOL PushyIsSafePathComponent(NSString *value);
PUSHY_HIDDEN BOOL PushyHasCompletedVersionAtPath(NSString *versionDir, NSString *hash);
PUSHY_HIDDEN void PushySwitchVersionLocked(NSString *hash);
PUSHY_HIDDEN NSString *PushyBundleHashSync(BOOL computeIfMissing);
PUSHY_HIDDEN NSString *PushyOptionUrlKey(void);
PUSHY_HIDDEN NSString *PushyRevealOnce(NSString *__strong *slot, dispatch_once_t *once, const char *hex);

PUSHY_HIDDEN pushy::state::State PushyStateFromDefaults(NSUserDefaults *defaults);
