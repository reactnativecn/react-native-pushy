// Launch bundle resolution and the identity of the running binary: which
// bundle this launch loads, where downloaded versions live, and the
// packageVersion/buildTime pair that detects a rebuilt binary.
#import "RCTPushyInternal.h"

// The version whose bundle this process actually loaded (resolved in
// +bundleURL). resetToPackagedBundle must not delete its directory: update
// assets (images/fonts) are read from it on demand at runtime, so wiping it
// under a silent (no-restart) reset would break every image the running app
// has not loaded yet. Guarded by the state lock.
PUSHY_HIDDEN NSString *pushyLaunchVersion = nil;

#if !DEBUG
static NSString *PushyReadBuildTime(void) {
    // The podspec's s.resource lands in the app bundle for a static
    // library but inside this pod's own framework bundle under
    // use_frameworks!; look in both.
    NSString *stampPath =
        [[NSBundle mainBundle] pathForResource:@"pushy_build_time" ofType:@"txt"]
        ?: [[NSBundle bundleForClass:[RCTPushy class]] pathForResource:@"pushy_build_time"
                                                               ofType:@"txt"];
    NSString *stamp = stampPath == nil ? nil
        : [[NSString stringWithContentsOfFile:stampPath encoding:NSUTF8StringEncoding error:nil]
              stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (stamp.length == 0) {
        // Never empty: with "" SyncBinaryVersion would miss a rebuilt
        // binary that kept its CFBundleShortVersionString, and a stale
        // hot update would outlive an App Store update. Every build
        // rewrites Info.plist, so its mtime (integer seconds) stands in.
        RCTLogWarn(@"RCTPushy -- pushy_build_time.txt %@; using the Info.plist mtime as buildTime",
                   stampPath == nil ? @"not found in the main or framework bundle" : @"is empty");
        NSString *infoPlist =
            [[NSBundle mainBundle].bundlePath stringByAppendingPathComponent:@"Info.plist"];
        NSDate *modified = [[NSFileManager defaultManager] attributesOfItemAtPath:infoPlist
                                                                            error:nil].fileModificationDate;
        stamp = [NSString stringWithFormat:@"%lld", (long long)[modified timeIntervalSince1970]];
    }
    return stamp;
}
#endif

@implementation RCTPushy (Launch)

// Resolves the bundle to launch from the persisted state; nil means the
// packaged bundle. Consumes the launch's one-shot state (first_time), so a
// second call is only valid after something re-armed it (a switchVersion).
// purgedVersion is set on tvOS when the installed version's files are gone.
+ (NSURL *)resolveLaunchBundleURL:(NSString **)launchRolledBackVersionOut
                    purgedVersion:(NSString **)purgedVersionOut
{
    __block NSURL *resolvedURL = nil;
    __block NSString *launchRolledBackVersion = nil;
    __block NSString *purgedVersion = nil;
    @try {
        PushyWithStateLock(^{
            NSUserDefaults *defaults = PushyDefaults();

            NSString *curPackageVersion = [RCTPushy packageVersion];
            NSString *curBuildTime = [RCTPushy buildTime];

            pushy::state::State state = PushyStateFromDefaults(defaults);
            pushy::state::BinaryVersionSyncResult sync = pushy::state::SyncBinaryVersion(
                state,
                PushyToStdString(curPackageVersion),
                PushyToStdString(curBuildTime)
            );
            if (sync.changed) {
                // The old binary's versions are gone from the state: drop
                // their info, the first-load marker and the response cache,
                // as every platform does (scripts/contract.ts storedItems).
                PushyRemoveKeys(defaults, PushyKeysClearedOnUpgrade(),
                                PushyKeyPrefixesClearedOnUpgrade());
                [PushyCacheDefaults() removeObjectForKey:keyCheckCache];
                PushyWriteMarker(defaults, keyBinaryUpgradedMarker, YES);
                state = sync.state;
                PushyApplyStateToDefaults(defaults, state);
            }

            if (!state.current_version.empty()) {
                std::string const versionBeforeLaunch = state.current_version;
                pushy::state::LaunchDecision decision = pushy::state::ResolveLaunchState(
                    state,
                    ignoreRollback.load(),
                    true
                );
                state = decision.state;

                if (decision.did_rollback) {
                    // The crash-protection rollback: the new version never called
                    // markSuccess. Keep this visible in release logs.
                    RCTLogWarn(@"RCTPushy -- version %@ was not marked as successful, rolled back to %@",
                        PushyFromStdString(versionBeforeLaunch),
                        PushyFromStdString(state.current_version));
                }
                if (decision.did_rollback || decision.consumed_first_time) {
                    PushyApplyStateToDefaults(defaults, state);
                }
                if (decision.consumed_first_time) {
                    // bundleURL may be called many times, ignore rollbacks before process restarted again.
                    ignoreRollback = true;
                    PushyWriteMarker(defaults, keyFirstLoadMarker, YES);
                }

                NSString *loadVersion = PushyFromStdString(decision.load_version);
                // Guard the rollback chain against cycles: a corrupted state
                // returning an already-visited version would otherwise spin this
                // loop forever during startup (Android has the same guard).
                NSMutableSet<NSString *> *visitedVersions = [NSMutableSet set];
                while (loadVersion.length && ![visitedVersions containsObject:loadVersion]) {
                    [visitedVersions addObject:loadVersion];
                    NSString *bundlePath = [PushyVersionDir(loadVersion) stringByAppendingPathComponent:BUNDLE_FILE_NAME];
                    if ([[NSFileManager defaultManager] fileExistsAtPath:bundlePath isDirectory:NULL]) {
                        pushyLaunchVersion = loadVersion;
                        resolvedURL = [NSURL fileURLWithPath:bundlePath];
                        break;
                    } else {
#if TARGET_OS_TV
                        // Caches is purgeable on tvOS: a missing bundle is the OS
                        // reclaiming space, not a bad release. Everything under
                        // rctpushy went with it, so walking back to last_version
                        // is pointless, and a rollback mark would make this
                        // launch's check refuse to reinstall the version.
                        RCTLogWarn(@"RCTPushy -- bundle version %@ was purged by the system", loadVersion);
                        purgedVersion = loadVersion;
                        state = pushy::state::ForgetPurgedVersions(state);
                        PushyApplyStateToDefaults(defaults, state);
                        if (decision.consumed_first_time) {
                            // The first load being consumed never happens: the
                            // packaged bundle must not report isFirstTime.
                            ignoreRollback = false;
                            PushyWriteMarker(defaults, keyFirstLoadMarker, NO);
                        }
                        break;
#else
                        RCTLogError(@"RCTPushy -- bundle version %@ not found, rolling back", loadVersion);
                        state = pushy::state::Rollback(state);
                        PushyApplyStateToDefaults(defaults, state);
                        loadVersion = PushyFromStdString(state.current_version);
#endif
                    }
                }
            }
            // Capture before constantsToExport consumes this one-shot marker.
            // The delayed native check must never forceBoot the version that this
            // launch just rolled back.
            launchRolledBackVersion = PushyFromStdString(state.rolled_back_version);
        });
    } @finally {
        *launchRolledBackVersionOut = launchRolledBackVersion;
        *purgedVersionOut = purgedVersion;
    }
    return resolvedURL;
}

+ (NSString *)downloadDir
{
#if TARGET_OS_TV
    // tvOS apps cannot write Application Support; Caches is the only
    // writable, non-temporary location, and the system may purge it while
    // the app is not running (see the purged-version path in +bundleURL).
    NSSearchPathDirectory base = NSCachesDirectory;
#else
    NSSearchPathDirectory base = NSApplicationSupportDirectory;
#endif
    NSString *directory = [NSSearchPathForDirectoriesInDomains(base, NSUserDomainMask, YES) firstObject];
    return [directory stringByAppendingPathComponent:@"rctpushy"];
}

+ (NSURL *)binaryBundleURL
{
    return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
}

+ (NSString *)packageVersion
{
    static NSString *version =
        [[[NSBundle mainBundle] infoDictionary] objectForKey:@"CFBundleShortVersionString"];
    return version;
}

+ (NSString *)buildTime
{
#if DEBUG
    return @"0";
#else
    static NSString *buildTime = PushyReadBuildTime();
    return buildTime;
#endif
}

@end
