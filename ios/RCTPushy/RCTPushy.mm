#import "RCTPushyInternal.h"
#import "RCTPushyConfiguration.h"
#include "../../cpp/patch_core/error_codes.h"
#include "../../cpp/patch_core/hbc_transform_wire.h"
#include "../../cpp/patch_core/patch_core.h"

// use_frameworks! 构建里 React 头文件只有 <React/…> 框架形式可见,引号形式的
// __has_include 会探测失败;漏掉框架形式会让重启变成无声 no-op(切版本后不
// 重启),所以两种形式都探测不到时直接编译失败。
#if __has_include("RCTReloadCommand.h")
#import "RCTReloadCommand.h"
#elif __has_include(<React/RCTReloadCommand.h>)
#import <React/RCTReloadCommand.h>
#else
#error React Native 0.62 or newer is required: RCTReloadCommand.h was not found
#endif
#ifdef RCT_NEW_ARCH_ENABLED
#import "RCTPushySpec.h"
#endif

// event def
static NSString * const EVENT_PROGRESS_DOWNLOAD = @"RCTPushyDownloadProgress";
static NSString * const PARAM_PROGRESS_HASH = @"hash";
static NSString * const PARAM_PROGRESS_RECEIVED = @"received";
static NSString * const PARAM_PROGRESS_TOTAL = @"total";

// Whether the host asked +bundleURL for the bundle to load (the
// isUsingBundleUrl constant, mirroring Android/Harmony). NO means the app
// runs a bundle this SDK never resolved, so updates cannot take effect.
static std::atomic<bool> pushyIsUsingBundleUrl{false};

// Triggers a JS reload. React Native re-resolves the bundle URL itself on
// reload (RCTHost asks its bundleURLProvider, RCTBridge.setUp re-asks
// sourceURLForBridge:), so +bundleURL is deliberately NOT called here: it
// consumes one-shot launch state (first_time, the first-load mark,
// ignoreRollback), and consuming it for a reload that never happens would
// make the next cold start roll the freshly switched version back.
static void PushyTriggerReload(NSString *reason) {
    dispatch_async(dispatch_get_main_queue(), ^{
        RCTTriggerReloadCommandListeners(reason);
    });
}

// A promise rejection for an exception caught (`@catch (...)`) around a
// state transition.
static void PushyRejectCaught(RCTPromiseRejectBlock reject, const char *code,
                              NSString *fallback) {
    PushyRejectError(reject, PushyErrorWithCode(code, PushyCaughtReason(fallback)));
}

// Host preparation runs off the caller's thread; the completion is delivered
// on the main queue. Calls run concurrently so each timeout counts from its
// own call: a serial queue would hold a later prepareBundle(timeout:) behind an
// earlier call's whole wait. Nothing here needs serializing — claimRound is an
// atomic compare-exchange and the round group (entered once at setup) releases
// every waiter when the round ends.
static void PushyRunHostPreparation(NSDictionary *(^work)(void),
                                    RCTPushyBundlePreparationCompletion completion) {
    static dispatch_queue_t hostQueue =
        dispatch_queue_create("cn.reactnative.pushy.host-sync", DISPATCH_QUEUE_CONCURRENT);
    dispatch_async(hostQueue, ^{
        NSDictionary *result;
        @try {
            result = work();
        } @catch (...) {
            RCTLogWarn(@"RCTPushy -- native host sync failed: %@",
                       PushyCaughtReason(@"unknown exception"));
            result = PushyHostResult(@"failed", @"internal_error");
        }
        if (completion != nil) {
            NSDictionary *snapshot = [result copy];
            dispatch_async(dispatch_get_main_queue(), ^{
                completion(snapshot);
            });
        }
    });
}

@implementation RCTPushy {
    bool hasListeners;
}

RCT_EXPORT_MODULE(RCTPushy);

+ (NSURL *)bundleURL
{
    pushyIsUsingBundleUrl = true;
    NSString *launchRolledBackVersion = nil;
    @try {
        NSString *purgedVersion = nil;
        NSURL *resolvedURL = [RCTPushy resolveLaunchBundleURL:&launchRolledBackVersion
                                                purgedVersion:&purgedVersion];
#if TARGET_OS_TV && !DEBUG
        // tvOS deleted the installed version while the app was not running.
        // The app is expected to be online: block the launch on a native
        // round that reinstalls the latest version, instead of showing the
        // packaged bundle and jumping forward again on a later launch.
        if (purgedVersion != nil &&
            [RCTPushyOrchestrator restorePurgedLaunch:purgedVersion
                                           rolledBack:launchRolledBackVersion]) {
            resolvedURL = [RCTPushy resolveLaunchBundleURL:&launchRolledBackVersion
                                             purgedVersion:&purgedVersion];
        }
#endif
        return resolvedURL ?: [RCTPushy binaryBundleURL];
    } @catch (...) {
        // An exception here would end every launch the same way; the
        // packaged bundle always loads, and the round scheduled below can
        // still repair the state.
        RCTLogError(@"RCTPushy -- cannot resolve the launch bundle: %@",
                    PushyCaughtReason(@"unknown exception"));
        return [RCTPushy binaryBundleURL];
    } @finally {
        // State corruption is exactly when the rescue path matters most. If
        // resolution throws before a snapshot exists, nil safely omits only
        // this launch's rollback guard instead of disabling the check.
        PushyGuard(@"native sync schedule", ^{
            [RCTPushyOrchestrator scheduleFromColdStart:launchRolledBackVersion];
        });
    }
}

+ (void)configure:(NSDictionary<NSString *, id> *)options
       completion:(RCTPushyConfigurationCompletion)completion
{
    NSError *validationError = nil;
    // Snapshot nested mutable caller values before crossing a queue boundary.
    NSString *config = RCTPushyNormalizeConfiguration(options, &validationError);
    static dispatch_queue_t configQueue =
        dispatch_queue_create("cn.reactnative.pushy.host-config", DISPATCH_QUEUE_SERIAL);
    dispatch_async(configQueue, ^{
        NSError *failure = validationError;
        if (config != nil) {
            @try {
                [RCTPushyOrchestrator persistConfiguration:config];
            } @catch (...) {
                failure = PushyErrorWithCode(pushy::error_codes::kFileOperationFailed,
                    PushyCaughtReason(@"Native configuration failed"));
            }
        }
        if (completion != nil) {
            dispatch_async(dispatch_get_main_queue(), ^{
                completion(failure);
            });
        }
    });
}

+ (void)prepareBundleWithCompletion:(RCTPushyBundlePreparationCompletion)completion
{
    PushyRunHostPreparation(^NSDictionary * {
        return [RCTPushyOrchestrator prepareBundle];
    }, completion);
}

+ (void)prepareBundleWithTimeout:(NSTimeInterval)timeout
                      completion:(RCTPushyBundlePreparationCompletion)completion
{
    PushyRunHostPreparation(^NSDictionary * {
        return [RCTPushyOrchestrator prepareBundleWithin:timeout];
    }, completion);
}

+ (BOOL)requiresMainQueueSetup
{
    return NO;
}

- (NSDictionary *)constantsToExport
{
    NSMutableDictionary *ret = [NSMutableDictionary new];
    // Whatever was gathered before a failure is still returned: throwing out
    // of getConstants takes the app down.
    PushyGuard(@"constants", ^{ PushyWithStateLock(^{
        NSUserDefaults *defaults = PushyDefaults();

        ret[@"downloadRootDir"] = [RCTPushy downloadDir];
        ret[@"packageVersion"] = [RCTPushy packageVersion];
        ret[@"buildTime"] = [RCTPushy buildTime];
        ret[@"rolledBackVersion"] = [defaults objectForKey:keyRolledBackMarked];
        ret[@"isFirstTime"] = [defaults objectForKey:keyFirstLoadMarked];
        ret[@"uuid"] = [defaults objectForKey:keyUuid];
        ret[@"isUsingBundleUrl"] = @(pushyIsUsingBundleUrl.load());
        // 原生 patch 内核可消费的 diff 轨道版本(2 = hdiffv2 轨道),
        // JS 随 checkUpdate 以 diffV 上报,服务端按能力门控下发
        ret[@"supportedDiffVersion"] = @(pushy::hbc::kSupportedDiffVersion);
        NSDictionary *pushyInfo = [defaults dictionaryForKey:keyPushyInfo];
        NSString *currentVersion = [pushyInfo objectForKey:paramCurrentVersion];
        ret[@"currentVersion"] = currentVersion;
        if (currentVersion != nil) {
            ret[@"currentVersionInfo"] = [defaults objectForKey:PushyHashInfoKey(currentVersion)];
            // bundleSha256 from the install record, for crash-report attribution.
            ret[@"currentBundleSha256"] = PushyIsSafePathComponent(currentVersion)
                ? PushyRecordedBundleSha256(PushyVersionDir(currentVersion)) : @"";
        }

        if (ret[@"isFirstTime"]) {
            [defaults removeObjectForKey:keyFirstLoadMarked];
        }

        if (ret[@"rolledBackVersion"] != nil) {
            [defaults removeObjectForKey:keyRolledBackMarked];
            [RCTPushyInstaller clearInvalidFiles];
        }

        if ([[defaults objectForKey:KeyPackageUpdatedMarked()] boolValue]) {
            [defaults removeObjectForKey:KeyPackageUpdatedMarked()];
            [RCTPushyInstaller clearInvalidFiles];
        }
    }); });

    return ret;
}

RCT_EXPORT_METHOD(setUuid:(NSString *)uuid  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    if (PushyStringIsBlank(uuid)) {
        PushyRejectError(reject, PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS));
        return;
    }

    NSUserDefaults *defaults = PushyDefaults();
    [defaults setObject:uuid forKey:keyUuid];
    resolve(@true);
}

RCT_EXPORT_METHOD(syncNativeConfig:(NSString *)config
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    // Provisioning for the native cold-start check (NATIVE_CHECKUPDATE_DESIGN
    // §10.1). Validate at write time: a corrupt config would otherwise
    // silently disable the native check forever with no signal.
    if (PushyStringIsBlank(config)) {
        PushyRejectError(reject, PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS));
        return;
    }
    NSError *error = nil;
    if (PushyJsonDictionary(config, &error) == nil) {
        PushyRejectError(reject, PushyErrorWithCode(
            pushy::error_codes::kInvalidOptions,
            error != nil ? error.localizedDescription : ERROR_OPTIONS));
        return;
    }
    @try {
        [RCTPushyOrchestrator persistConfiguration:config];
        resolve(@true);
    } @catch (...) {
        PushyRejectCaught(reject, pushy::error_codes::kFileOperationFailed,
                          @"Native configuration failed");
    }
}

RCT_EXPORT_METHOD(getNativeCheckCache:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    resolve([PushyDefaults() stringForKey:keyNativeCheckCache] ?: @"");
}

RCT_EXPORT_METHOD(markJsCheckCompleted:(NSString *)config
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    if (PushyStringIsBlank(config)) {
        PushyRejectError(reject, PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS));
        return;
    }
    [RCTPushyOrchestrator recordJsRound:config];
    resolve(@true);
}

RCT_EXPORT_METHOD(setLocalHashInfo:(NSString *)hash
                  value:(NSString *)value resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    if (PushyStringIsBlank(hash) || PushyStringIsBlank(value)) {
        PushyRejectError(reject, PushyErrorWithCode(pushy::error_codes::kInvalidOptions, ERROR_OPTIONS));
        return;
    }

    NSError *error = nil;
    if (PushyJsonDictionary(value, &error) != nil) {
        [PushyDefaults() setObject:value forKey:PushyHashInfoKey(hash)];
        resolve(@true);
    } else {
        PushyRejectError(reject, PushyErrorWithCode(
            pushy::error_codes::kInvalidHashInfo,
            error != nil ? error.localizedDescription : @"invalid json string"));
    }
}


RCT_EXPORT_METHOD(getLocalHashInfo:(NSString *)hash
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    
    NSUserDefaults *defaults = PushyDefaults();
    resolve([defaults stringForKey:PushyHashInfoKey(hash)]);
}

RCT_EXPORT_METHOD(downloadFullUpdate:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    [self fetchPackage:PushyTypeFullDownload options:options resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(downloadPatchFromPackage:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    [self fetchPackage:PushyTypePatchFromPackage options:options resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(downloadPatchFromPpk:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    [self fetchPackage:PushyTypePatchFromPpk options:options resolver:resolve rejecter:reject];
}

RCT_EXPORT_METHOD(downloadAndInstallApk:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    PushyRejectError(reject, PushyErrorWithCode(
        pushy::error_codes::kUnsupportedPlatform,
        @"downloadAndInstallApk is only supported on Android"));
}

RCT_EXPORT_METHOD(setNeedUpdate:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    NSError *error = nil;
    if (![RCTPushyInstaller switchVersion:PushyOptionString(options, @"hash") error:&error]) {
        PushyRejectError(reject, error);
        return;
    }

    resolve(@true);
}

RCT_EXPORT_METHOD(reloadUpdate:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    NSError *error = nil;
    if (![RCTPushyInstaller switchVersion:PushyOptionString(options, @"hash") error:&error]) {
        PushyRejectError(reject, error);
        return;
    }

    PushyTriggerReload(@"pushy restart");
    resolve(@true);
}

RCT_EXPORT_METHOD(restartApp:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    PushyTriggerReload(@"pushy restartApp");
    resolve(@true);
}

RCT_EXPORT_METHOD(getBundleHash:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    // bundleHash = sha256 of the bundle embedded in the binary — the identity
    // of the binary itself, not of whatever hot update is currently running.
    // It must hash exactly the bytes pdiff patches from (binaryBundleURL, the
    // pdiff fromBundle). Lazily computed once per install, cached in defaults.
    // Never rejects: an empty string means "unknown" and the server falls back
    // to the buildTime heuristic.
#if DEBUG
    // Metro serves the bundle in debug; the embedded file (if any) is not what
    // is running. Mirrors the dev behaviour of buildTime.
    resolve(@"");
#else
    dispatch_async(PushyFileQueue(), ^{
        __block NSString *hash = @"";
        PushyGuard(@"bundle hash", ^{
            hash = PushyBundleHashSync(YES);
        });
        resolve(hash);
    });
#endif
}

RCT_EXPORT_METHOD(markSuccess:(RCTPromiseResolveBlock)resolve
                                    rejecter:(RCTPromiseRejectBlock)reject)
{
    #if DEBUG
    resolve(@true);
    #else

    // Failures surface as MARK_SUCCESS_FAILED like on Android, so per-code
    // telemetry is not blind to this transition on iOS.
    @try {
        PushyWithStateLock(^{
            NSUserDefaults *defaults = PushyDefaults();
            pushy::state::MarkSuccessResult result =
                pushy::state::MarkSuccess(PushyStateFromDefaults(defaults));
            if (!result.stale_version_to_delete.empty()) {
                [defaults removeObjectForKey:PushyHashInfoKey(PushyFromStdString(result.stale_version_to_delete))];
            }
            PushyApplyStateToDefaults(defaults, result.state);
        });
    } @catch (...) {
        PushyRejectCaught(reject, pushy::error_codes::kMarkSuccessFailed, @"markSuccess failed");
        return;
    }

    [RCTPushyInstaller clearInvalidFiles];
    resolve(@true);
    #endif
}

RCT_EXPORT_METHOD(resetToPackagedBundle:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
    // Reset to the bundle packaged in the binary: wipe the whole update state
    // (so the next launch resolves to the built-in bundle) and delete the
    // downloaded versions, keeping only the directory of the version this
    // process is running from (a silent reset must not break its on-demand
    // asset loads). Only the client uuid survives — it identifies the install
    // for gray release bucketing and must not change on reset.
    __block NSString *keepVersion = nil;
    @try {
        PushyWithStateLock(^{
            // Invalidate any in-flight cold-start round before clearing state, so
            // a round that commits under this same lock afterwards always sees the
            // new generation and drops its result.
            pushyResetGeneration.fetch_add(1);
            NSUserDefaults *defaults = PushyDefaults();
            keepVersion = pushyLaunchVersion;

            // A default-constructed State is exactly the reset state (no current /
            // last version, first_time=false, first_time_ok=true); keep the binary
            // identity so the next launch does not re-trigger the package-updated
            // sync path.
            pushy::state::State state;
            state.package_version = PushyToStdString([RCTPushy packageVersion]);
            state.build_time = PushyToStdString([RCTPushy buildTime]);
            PushyApplyStateToDefaults(defaults, state);

            for (NSString *key in [defaults dictionaryRepresentation].allKeys) {
                if ([key hasPrefix:keyHashInfo]) {
                    [defaults removeObjectForKey:key];
                }
            }
            [defaults removeObjectForKey:keyFirstLoadMarked];
            [defaults removeObjectForKey:KeyPackageUpdatedMarked()];
            // A cached response still advertises the version this reset just
            // removed; dropping it stops the JS side from reusing that answer.
            [defaults removeObjectForKey:keyNativeCheckCache];
            ignoreRollback = false;
        });
    } @catch (...) {
        PushyRejectCaught(reject, pushy::error_codes::kResetFailed, @"reset failed");
        return;
    }

    // The reset is done once the state is: the next launch resolves to the
    // packaged bundle. Settle now, as Android and Harmony do; deleting the
    // downloaded versions is best-effort below and never delays the caller
    // (it queues behind any unzip/patch on the file queue). A directory a
    // failed delete leaves behind is no longer referenced by any state, so
    // the regular cleanup removes it later.
    resolve(@true);

    dispatch_async(PushyFileQueue(), ^{
        // maxAgeDays=0: remove every downloaded entry except the running
        // version's directory (cleaned up by the next regular cleanup). The
        // state was just wiped, so that is the only name left to keep.
        pushy::delta::Status status = pushy::delta::Status::Ok();
        try {
            status = pushy::delta::CleanupOldEntries(
                PushyToStdString([RCTPushy downloadDir]),
                std::vector<std::string>{PushyToStdString(keepVersion)},
                0
            );
        } catch (const std::exception &error) {
            status = pushy::delta::Status::Error(error.what());
        }
        if (!status.ok) {
            RCTLogWarn(@"Pushy reset cleanup error: %s", status.message.c_str());
        }
    });
}


#pragma mark - private
- (NSArray<NSString *> *)supportedEvents
{
  return @[
      EVENT_PROGRESS_DOWNLOAD,
  ];
}

-(void)startObserving {
    hasListeners = YES;
}

-(void)stopObserving {
    hasListeners = NO;
}

- (void)fetchPackage:(PushyType)type
               options:(NSDictionary *)options
              resolver:(RCTPromiseResolveBlock)resolve
              rejecter:(RCTPromiseRejectBlock)reject
{
    NSString *hash = PushyOptionString(options, @"hash") ?: @"";
    void (^progress)(long long, long long) = ^(long long receivedBytes, long long totalBytes) {
        if (self->hasListeners) {
            [self sendEventWithName:EVENT_PROGRESS_DOWNLOAD body:@{
                PARAM_PROGRESS_HASH: hash,
                PARAM_PROGRESS_RECEIVED: @(receivedBytes),
                PARAM_PROGRESS_TOTAL: @(totalBytes),
            }];
        }
    };
    [RCTPushyInstaller fetch:type options:options progress:progress callback:^(NSError *error) {
        if (error != nil) {
            if (error.userInfo[RCTPushyErrorCodeKey] == nil) {
                // Unclassified (system/network) errors from the download
                // pipeline; keep the original message.
                error = PushyErrorWithCode(pushy::error_codes::kDownloadFailed,
                                           error.localizedDescription);
            }
            PushyRejectError(reject, error);
            return;
        }
        resolve(nil);
    }];
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativePushySpecJSI>(params);
}
#endif

@end
