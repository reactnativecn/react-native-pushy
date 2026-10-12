#import "RCTPushyInternal.h"
#include "../../cpp/patch_core/error_codes.h"
#include "../../cpp/patch_core/hbc_transform_wire.h"
#include "../../cpp/update_flow_core/flow_json.h"
#include "../../cpp/update_flow_core/update_flow_core.h"

#include <atomic>
#if TARGET_OS_TV
#import <Network/Network.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#endif

// Version-info flags and the no-op status read by JS, stored encoded
// (RCTPushyRevealText) so they do not appear as plain binary strings.
static NSString *PushyInfoCrashHold(void) {
    static NSString *value;
    static dispatch_once_t once;
    return PushyRevealOnce(&value, &once, "3905f5c2a6b96d56212a19");
}
static NSString *PushyInfoForceBoot(void) {
    static NSString *value;
    static dispatch_once_t once;
    return PushyRevealOnce(&value, &once, "3c18e6d2aba9674a360d19ead5a695");
}
static NSString *PushyStatusNone(void) {
    static NSString *value;
    static dispatch_once_t once;
    return PushyRevealOnce(&value, &once, "3418c1c1aa8a7c40");
}

// cInfo.os label prefix; must match the JS side (core.ts) so the server
// buckets tvOS devices apart from iOS ones.
#if TARGET_OS_TV
static NSString * const PushyOsName = @"tvos";
#else
static NSString * const PushyOsName = @"ios";
#endif

// One round per process, whoever starts it first — the delayed cold-start
// path or the crash-rescue thread (§11.3). The semaphore lets the rescue
// wait out an in-flight round instead of racing it.
static std::atomic<bool> pushyRoundStarted{false};
static std::atomic<bool> pushyRoundCompleted{false};
// Flipped the moment a crash is being held. JS is dead from that point on,
// so there is no second decision maker: the round force-activates whatever
// it downloads (§11.3).
static std::atomic<bool> pushyCrashHoldActive{false};
static std::atomic<bool> pushyHoldAttempted{false};
// Set when this process's round is the tvOS purged-version restore.
static std::atomic<bool> pushyPurgeRestoreActive{false};
// True while +bundleURL waits for that restore. Only then may the round
// activate what it downloads on its own (JS has not started to decide), since
// the launch resolves the bundle again afterwards. Closed once the wait ends,
// timeout or not; guarded by the state lock that every activation commits
// under, so a commit lands either before the close (and launches) or after it
// (and is left to JS) — never selected behind the packaged bundle's back.
static bool pushyPurgeRestoreWindowOpen = false;
static dispatch_semaphore_t pushyRoundDone;
static NSString *pushyLaunchRolledBackForHold = nil;
// A version this process downloaded but left for JS to activate. If the
// process then crashes, JS will never activate it — the crash handler
// activates it directly (bounded local work, no network). The generation is
// the one the round committed under: a reset that lands afterwards bumps it,
// and the late activation must lose to that reset exactly like the round
// itself would. Guarded by @synchronized (RCTPushyOrchestrator class).
static NSString *pushyUnactivatedHash = nil;
static uint64_t pushyUnactivatedGeneration = 0;
static uint64_t pushyUnactivatedConfigGeneration = 0;
static NSUncaughtExceptionHandler *pushyPreviousExceptionHandler = NULL;
// ≈ process start: scheduleFromColdStart runs during the first bundleURL.
static NSTimeInterval pushyProcessAnchorUptime = 0;
// Config JSON for which JS reported a completed check in this process
// (markJsCheckCompleted). Process-scoped by design. Guarded by
// @synchronized (RCTPushyOrchestrator class).
static NSString *pushyJsCompletedConfig = nil;
// The group supplements (rather than consumes) the crash-rescue semaphore.
static dispatch_group_t pushyHostRoundGroup;
static std::atomic<bool> pushySyncReady{false};
static NSDictionary *pushyHostRoundResult = nil;
static NSString *pushyHostRoundConfig = nil;
static uint64_t pushyHostRoundGeneration = 0;
// Bumped by persistConfiguration when the config really changes (C1
// equivalence fails); resets keep pushyResetGeneration to themselves.
static std::atomic<uint64_t> pushyNativeConfigGeneration{0};
static uint64_t pushyHostRoundConfigGeneration = 0;

static const NSTimeInterval kPushyHoldTriggerUptime = 60;
static const NSTimeInterval kPushyHoldBudgetBackgroundThread = 10;
// A held main thread freezes UI teardown; stay well under the watchdog.
static const NSTimeInterval kPushyHoldBudgetMainThread = 3.5;
// The purged-version restore blocks +bundleURL, usually inside
// application:didFinishLaunching: — stay clear of the launch watchdog. The
// budget is measured from process start; with less than the minimum left the
// restore is not attempted.
#if TARGET_OS_TV && !DEBUG
static const NSTimeInterval kPushyPurgeRestoreBudget = 12;
static const NSTimeInterval kPushyPurgeRestoreMinimumBudget = 2;

// Seconds since the kernel started this process; 0 when unknown.
static NSTimeInterval PushyProcessElapsed(void) {
    struct kinfo_proc info;
    size_t size = sizeof(info);
    int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()};
    if (sysctl(mib, 4, &info, &size, NULL, 0) != 0 || size == 0) {
        return 0;
    }
    struct timeval now;
    gettimeofday(&now, NULL);
    const struct timeval start = info.kp_proc.p_starttime;
    NSTimeInterval elapsed = (now.tv_sec - start.tv_sec)
        + (now.tv_usec - start.tv_usec) / 1e6;
    return elapsed > 0 ? elapsed : 0;
}

// NO only when the system positively reports no usable network path; an
// unknown state (no answer within the short wait) lets the restore try.
static BOOL PushyHasNetworkPath(void) {
    dispatch_queue_t queue = dispatch_queue_create("cn.reactnative.pushy.path", DISPATCH_QUEUE_SERIAL);
    nw_path_monitor_t monitor = nw_path_monitor_create();
    dispatch_semaphore_t answered = dispatch_semaphore_create(0);
    __block nw_path_status_t status = nw_path_status_invalid;
    nw_path_monitor_set_queue(monitor, queue);
    nw_path_monitor_set_update_handler(monitor, ^(nw_path_t path) {
        BOOL first = status == nw_path_status_invalid;
        status = nw_path_get_status(path);
        if (first) {
            dispatch_semaphore_signal(answered);
        }
    });
    nw_path_monitor_start(monitor);
    dispatch_semaphore_wait(answered, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 2));
    nw_path_monitor_cancel(monitor);
    __block nw_path_status_t result;
    dispatch_sync(queue, ^{
        result = status;
    });
    return result != nw_path_status_unsatisfied;
}
#endif
// prepareBundleWithCompletion: (no explicit timeout) waits this long at most:
// past the longest round (8 query requests, then two 600s download phases).
static const NSTimeInterval kPushyHostPrepareDefaultTimeout = 1800;

static void PushyMaybeHoldProcess(void) {
    // Once per process; a second crashing thread passes straight through
    // instead of waiting behind the first (§11.3: prefer under-rescuing over
    // wedging the teardown).
    bool expected = false;
    if (!pushyHoldAttempted.compare_exchange_strong(expected, true)) {
        return;
    }
    NSTimeInterval uptime = PushyMonotonicNow() - pushyProcessAnchorUptime;
    bool roundInFlight = pushyRoundStarted.load() && !pushyRoundCompleted.load();
    // Early crashes are the brick signature; a crash with an in-flight round
    // is worth finishing regardless of uptime. Everything else is an ordinary
    // crash whose UX must not be delayed.
    if (uptime >= kPushyHoldTriggerUptime && !roundInFlight) {
        return;
    }
    NSTimeInterval budget = [NSThread isMainThread]
        ? kPushyHoldBudgetMainThread
        : kPushyHoldBudgetBackgroundThread;
    NSTimeInterval deadline = PushyMonotonicNow() + budget;
    NSLog(@"RCTPushy -- crash hold: holding process for up to %.1fs "
          @"(uptime %.1fs)", budget, uptime);

    // The rescue runs on its own queue and the dying thread only waits with a
    // hard timeout: even a deadlocked rescue (a thread that died holding a
    // lock — uncaught ObjC exceptions skip @finally) can only delay the
    // process death, never prevent it.
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        @try {
            [RCTPushyOrchestrator runHoldRoundWithDeadline:deadline];
        } @catch (NSException *exception) {
            NSLog(@"RCTPushy -- crash hold failed: %@", exception.reason);
        }
        dispatch_semaphore_signal(done);
    });
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW,
            (int64_t)(budget * NSEC_PER_SEC))) != 0) {
        NSLog(@"RCTPushy -- crash hold: budget exhausted, letting go");
    }
}

// Crash-moment brick rescue (§11): when the app is dying of an uncaught
// exception during startup (RCTFatal raises NSException in release), the
// process is still alive and JS will never run again — a natural,
// false-positive-free window to finish the cold-start check. The previous
// handler (crash reporters chain the same way) always runs afterwards.
static void PushyCrashHoldExceptionHandler(NSException *exception) {
    @try {
        PushyMaybeHoldProcess();
    } @catch (NSException *inner) {
        // The dying process owes the previous handler its turn no matter
        // what the rescue did.
    }
    if (pushyPreviousExceptionHandler != NULL) {
        pushyPreviousExceptionHandler(exception);
    }
}

static void PushyInstallCrashHoldHandler(void) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        pushyPreviousExceptionHandler = NSGetUncaughtExceptionHandler();
        NSSetUncaughtExceptionHandler(&PushyCrashHoldExceptionHandler);
    });
}

#pragma mark - native cold-start check orchestration

// Refuses an https→http downgrade before the redirected request — and with
// it the POST body (appKey, uuid, versions) — leaves the device. The shared
// session would follow first and only the response could be rejected; ATS
// blocks plaintext by default, this covers apps that opted out with
// NSAllowsArbitraryLoads. Same rule as RCTPushyDownloader
// (RCTPushyIsHttpsDowngrade). Returning nil
// delivers the 3xx itself as the final response, which the status check in
// PushyHttpRequest then treats as a failed endpoint.
@interface PushyRequestRedirectGuard : NSObject <NSURLSessionTaskDelegate>
@end

@implementation PushyRequestRedirectGuard

- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task
willPerformHTTPRedirection:(NSHTTPURLResponse *)response
        newRequest:(NSURLRequest *)request
 completionHandler:(void (^)(NSURLRequest *))completionHandler
{
    completionHandler(RCTPushyIsHttpsDowngrade(task.originalRequest.URL, request.URL) ? nil : request);
}

@end

// One long-lived delegate session (not the shared one) so the redirect guard
// sees the 3xx before it is followed; completion handlers still receive the
// final response. Never invalidated: it lives as long as the process.
static NSURLSession *PushyRequestSession(void) {
    static NSURLSession *session;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        session = [NSURLSession
            sessionWithConfiguration:[NSURLSessionConfiguration defaultSessionConfiguration]
                            delegate:[PushyRequestRedirectGuard new]
                       delegateQueue:nil];
    });
    return session;
}

// Same shape as -[UIDevice systemVersion] ("17.4", "17.4.1"), which is
// main-thread-only UIKit; the round runs on a background queue.
static NSString *PushyOsVersion(void) {
    NSOperatingSystemVersion version = [NSProcessInfo processInfo].operatingSystemVersion;
    if (version.patchVersion > 0) {
        return [NSString stringWithFormat:@"%ld.%ld.%ld", (long)version.majorVersion,
                (long)version.minorVersion, (long)version.patchVersion];
    }
    return [NSString stringWithFormat:@"%ld.%ld", (long)version.majorVersion,
            (long)version.minorVersion];
}

// Blocking JSON HTTP round-trip on the orchestrator's utility thread. Returns
// the response body on 2xx, nil on any failure. The semaphore timeout is a
// backstop over the request's own timeoutInterval.
static NSString *PushyHttpRequest(NSString *urlString, NSString *method,
                                  NSString *body, NSTimeInterval timeout) {
    NSURL *url = [NSURL URLWithString:urlString];
    if (url == nil) {
        return nil;
    }
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = method;
    request.timeoutInterval = timeout;
    [request setValue:@"application/json" forHTTPHeaderField:@"Accept"];
    if (body != nil) {
        [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
        request.HTTPBody = [body dataUsingEncoding:NSUTF8StringEncoding];
    }
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block NSString *result = nil;
    NSURLSessionDataTask *task = [PushyRequestSession() dataTaskWithRequest:request
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            NSHTTPURLResponse *httpResponse =
                [response isKindOfClass:[NSHTTPURLResponse class]]
                    ? (NSHTTPURLResponse *)response
                    : nil;
            NSInteger status = httpResponse.statusCode;
            if (error == nil && httpResponse != nil && status >= 200 && status < 300
                && data != nil) {
                result = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            }
            dispatch_semaphore_signal(sem);
        }];
    [task resume];
    if (dispatch_semaphore_wait(
            sem, dispatch_time(DISPATCH_TIME_NOW,
                               (int64_t)((timeout + 5) * NSEC_PER_SEC))) != 0) {
        [task cancel];
        return nil;
    }
    return result;
}

static NSString *PushyNormalizeEndpointBase(NSString *base) {
    while ([base hasSuffix:@"/"]) {
        base = [base substringToIndex:base.length - 1];
    }
    return base;
}

// Same rule as Harmony (SyncCoordinator.ts isHttpsOnly, SR-1): when every
// configured endpoint is https, endpoints from a fetched remote list must be
// https and artifact URLs from the decision may not be plaintext http, so the
// network cannot downgrade the round. Redirects are guarded separately
// (RCTPushyIsHttpsDowngrade).
static BOOL PushyIsHttpsUrl(NSString *url) {
    return [[url lowercaseString] hasPrefix:@"https://"];
}

static BOOL PushyIsCleartextUrl(NSString *url) {
    return [[url lowercaseString] hasPrefix:@"http://"];
}

static BOOL PushyIsHttpsOnly(const flowjson::Value &endpoints) {
    if (endpoints.elements().empty()) {
        return NO;
    }
    for (const auto &endpoint : endpoints.elements()) {
        if (!endpoint.IsString() || !PushyIsHttpsUrl(PushyFromStdString(endpoint.AsString()))) {
            return NO;
        }
    }
    return YES;
}

static BOOL PushyIsValidResponse(NSString *responseText) {
    if (responseText == nil) {
        return NO;
    }
    // Shared schema rule (update_flow_core::IsValidResponse): a 200 with
    // `{"error": ...}` is a failed endpoint, not a verdict.
    return flowcore::IsValidResponse(PushyToStdString(responseText)) ? YES : NO;
}

// Canonical config equality, shared with the JS, Android and Harmony sides:
// two config JSON strings are equivalent iff their canonical forms deep-equal.
// Canonical form: the parsed object with absent keys defaulted
// (disabled:false, queryUrls:[], rnu:"", rn:"", afterDownload:"none") and the
// endpoints/queryUrls entries stripped of trailing '/' and deduplicated in
// first-occurrence order; key order is irrelevant. Unparseable is never
// equivalent. Lets a host-owned config (sorted keys) and the same config as JS
// serializes it count as one, instead of a "change" that cancels the round.
static BOOL PushyJsonIsBool(id value) {
    return [value isKindOfClass:NSNumber.class]
        && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID();
}

static BOOL PushyJsonEqual(id a, id b) {
    if (PushyJsonIsBool(a) != PushyJsonIsBool(b)) {
        return NO;  // false is not 0
    }
    if ([a isKindOfClass:NSDictionary.class] && [b isKindOfClass:NSDictionary.class]) {
        if ([a count] != [b count]) {
            return NO;
        }
        for (id key in (NSDictionary *)a) {
            id other = ((NSDictionary *)b)[key];
            if (other == nil || !PushyJsonEqual(((NSDictionary *)a)[key], other)) {
                return NO;
            }
        }
        return YES;
    }
    if ([a isKindOfClass:NSArray.class] && [b isKindOfClass:NSArray.class]) {
        if ([a count] != [b count]) {
            return NO;
        }
        for (NSUInteger i = 0; i < [a count]; i++) {
            if (!PushyJsonEqual(((NSArray *)a)[i], ((NSArray *)b)[i])) {
                return NO;
            }
        }
        return YES;
    }
    return [a isEqual:b];
}

static id PushyCanonicalUrlList(id value) {
    if (![value isKindOfClass:NSArray.class]) {
        return value;
    }
    NSMutableArray *result = [NSMutableArray array];
    for (id item in (NSArray *)value) {
        id entry = [item isKindOfClass:NSString.class] ? PushyNormalizeEndpointBase(item) : item;
        BOOL seen = NO;
        for (id existing in result) {
            if (PushyJsonEqual(existing, entry)) {
                seen = YES;
                break;
            }
        }
        if (!seen) {
            [result addObject:entry];
        }
    }
    return result;
}

static NSDictionary *PushyCanonicalConfig(NSString *json) {
    NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
    id object = data == nil ? nil
        : [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![object isKindOfClass:NSDictionary.class]) {
        return nil;
    }
    NSMutableDictionary *config = [object mutableCopy];
    NSDictionary *defaults = @{@"disabled": @NO, @"queryUrls": @[], @"rnu": @"",
                               @"rn": @"", @"afterDownload": @"none"};
    for (NSString *key in defaults) {
        if (config[key] == nil) {
            config[key] = defaults[key];
        }
    }
    for (NSString *key in @[@"endpoints", @"queryUrls"]) {
        if (config[key] != nil) {
            config[key] = PushyCanonicalUrlList(config[key]);
        }
    }
    return config;
}

static BOOL PushyConfigsEquivalent(NSString *a, NSString *b) {
    NSDictionary *left = a == nil ? nil : PushyCanonicalConfig(a);
    NSDictionary *right = b == nil ? nil : PushyCanonicalConfig(b);
    return left != nil && right != nil && PushyJsonEqual(left, right);
}

// The persisted config a round may run with. Every gate (crash-hold handler
// install, round start, prepareBundle, the round itself) reads it through
// PushyLoadRunnableConfig, so they agree on what "configured" and "disabled"
// mean. disabled follows JS truthiness, like the flow core; appKey is trimmed
// like Android and Harmony do.
struct PushyRunnableConfig {
    NSString *json;
    flowjson::Value value;
    NSString *appKey;
};

// YES when a round may run; otherwise *reason is not_configured, disabled or
// invalid_config.
static BOOL PushyLoadRunnableConfig(PushyRunnableConfig *config, NSString **reason) {
    NSString *failure = nil;
    NSString *json = [PushyDefaults() stringForKey:keyNativeConfig];
    config->json = [json copy];
    if (json.length == 0) {
        failure = @"not_configured";
    } else {
        bool ok = false;
        flowjson::Value value = flowjson::Parse(PushyToStdString(json), &ok);
        NSString *appKey = ok && value.IsObject()
            ? [PushyFromStdString(value.Get("appKey").AsString())
                  stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
            : nil;
        if (!ok || !value.IsObject()) {
            failure = @"invalid_config";
        } else if (value.Get("disabled").Truthy()) {
            failure = @"disabled";
        } else if (appKey.length == 0) {
            failure = @"invalid_config";
        } else {
            config->value = value;
            config->appKey = appKey;
        }
    }
    if (reason != NULL) {
        *reason = failure;
    }
    return failure == nil;
}

// Host-facing result for a config that cannot run: absent or disabled is a
// skip, a malformed one a failure.
static NSDictionary *PushyUnrunnableConfigResult(NSString *reason) {
    BOOL skip = [reason isEqualToString:@"not_configured"] || [reason isEqualToString:@"disabled"];
    return PushyHostResult(skip ? @"skipped" : @"failed", reason, nil, NO);
}

@implementation RCTPushyOrchestrator

+ (void)persistConfiguration:(NSString *)config {
    PushyWithStateLock(^{
        NSUserDefaults *defaults = PushyDefaults();
        if ([defaults stringForKey:keyUuid].length == 0) {
            [defaults setObject:[NSUUID UUID].UUIDString forKey:keyUuid];
        }
        if (PushyConfigsEquivalent([defaults stringForKey:keyNativeConfig], config)) {
            // The same config in another serialization (key order, trailing
            // slashes, defaulted keys). Not a change: the stored text, the
            // response cache and any in-flight round all stay valid.
            return;
        }
        // A different request identity/policy: rounds started under the old
        // one must not commit (pushyNativeConfigGeneration, checked by
        // commitRoundWithGeneration next to the reset generation), and the
        // cached response and JS-completed marker belong to the old one.
        pushyNativeConfigGeneration.fetch_add(1);
        [defaults setObject:config forKey:keyNativeConfig];
        [defaults removeObjectForKey:keyNativeCheckCache];
        [self recordJsRound:nil];
    });
    if (pushySyncReady.load() && [self hasRunnableConfig]) {
        PushyInstallCrashHoldHandler();
    }
}

+ (BOOL)hasRunnableConfig {
    PushyRunnableConfig config;
    return PushyLoadRunnableConfig(&config, NULL);
}

// Process-wide round state, set up by whichever launch path needs a round
// first: the delayed cold-start check or the tvOS purged-version restore.
+ (void)prepareProcess:(NSString *)launchRolledBackVersion {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        pushyRoundDone = dispatch_semaphore_create(0);
        pushyHostRoundGroup = dispatch_group_create();
        dispatch_group_enter(pushyHostRoundGroup);
        pushyProcessAnchorUptime = PushyMonotonicNow();
        pushyLaunchRolledBackForHold = [launchRolledBackVersion copy];
        pushySyncReady.store(true);
        // The crash-hold rescue shares the orchestrator's rollout gate: no
        // runnable config, no handler (§11.3). persistConfiguration installs
        // it once a runnable config arrives later in the process.
        if ([self hasRunnableConfig]) {
            PushyInstallCrashHoldHandler();
        }
    });
}

+ (void)scheduleFromColdStart:(NSString *)launchRolledBackVersion {
#if !DEBUG
    // Once per process; a few seconds of delay keeps the check away from the
    // cold-start critical path (§7 R5) — its result targets the NEXT launch.
    // Unless the previous process died mid-round (residual incomplete
    // marker), in which case every launch second counts (§11.4).
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        [self prepareProcess:launchRolledBackVersion];
        NSUserDefaults *defaults = PushyDefaults();
        int64_t delaySeconds =
            [defaults objectForKey:keyNativeCheckIncomplete] != nil ? 0 : 5;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delaySeconds * NSEC_PER_SEC),
                       dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            if ([self hasJsRound]) {
                // Not consuming the round: a later crash rescue may still
                // need it.
                NSLog(@"RCTPushy -- native sync skipped: JS already queried in this process");
                return;
            }
            [self startRoundWithDeadline:0];
        });
    });
#endif
}

#if TARGET_OS_TV && !DEBUG
// Runs this process's round before the first bundle loads, blocking the
// caller for at most what is left of kPushyPurgeRestoreBudget since process
// start. The state no longer has a
// current version, so the server answers with the latest version for the
// packaged bundle, and the round activates it while the restore window is
// open. Returns NO when no round can run; otherwise the caller must resolve
// the launch bundle again: it launches whatever was activated before the
// window closed, or the packaged bundle. The round stops at the same
// deadline, keeping a partial download for the next check to resume.
+ (BOOL)restorePurgedLaunch:(NSString *)purgedVersion
                 rolledBack:(NSString *)launchRolledBackVersion {
    [self prepareProcess:launchRolledBackVersion];
    if (![self hasRunnableConfig]) {
        RCTLogWarn(@"RCTPushy -- version %@ was purged and no native sync is "
                   @"configured; launching the packaged bundle", purgedVersion);
        return NO;
    }
    // Offline: the round could only burn the launch budget.
    if (!PushyHasNetworkPath()) {
        RCTLogWarn(@"RCTPushy -- version %@ was purged and there is no network; "
                   @"launching the packaged bundle", purgedVersion);
        return NO;
    }
    // The launch watchdog counts from process start, not from this call:
    // whatever the host did before resolving the bundle is already spent.
    NSTimeInterval budget = kPushyPurgeRestoreBudget - PushyProcessElapsed();
    if (budget < kPushyPurgeRestoreMinimumBudget) {
        RCTLogWarn(@"RCTPushy -- version %@ was purged and the launch budget is "
                   @"spent; launching the packaged bundle", purgedVersion);
        return NO;
    }
    PushyWithStateLock(^{
        pushyPurgeRestoreWindowOpen = true;
    });
    pushyPurgeRestoreActive.store(true);
    NSTimeInterval deadline = PushyMonotonicNow() + budget;
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        [self startRoundWithDeadline:deadline];
        dispatch_semaphore_signal(done);
    });
    BOOL timedOut = dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW,
        (int64_t)(budget * NSEC_PER_SEC))) != 0;
    // The round's deadline does not bound a slow response (the request
    // timeout is an idle timeout) nor a version already on disk, so the close
    // is what stops a late activation — not the deadline.
    PushyWithStateLock(^{
        pushyPurgeRestoreWindowOpen = false;
    });
    if (timedOut) {
        RCTLogWarn(@"RCTPushy -- purged version %@ restore timed out", purgedVersion);
    } else {
        NSDictionary *result = pushyHostRoundResult;
        RCTLogInfo(@"RCTPushy -- purged version %@ restore: %@ %@ %@", purgedVersion,
                   result[@"status"], result[@"reason"], result[@"hash"]);
    }
    return YES;
}
#endif

+ (NSDictionary *)prepareBundle {
    return [self prepareBundleWithin:kPushyHostPrepareDefaultTimeout];
}

// Waits at most `timeout` seconds for this process's round. The round itself
// is not cut short by the host's wait (its result still serves the next
// launch); the host gets failed/timeout instead of a result.
+ (NSDictionary *)prepareBundleWithin:(NSTimeInterval)timeout {
#if DEBUG
    return PushyHostResult(@"skipped", @"debug", nil, NO);
#else
    if (!pushySyncReady.load()) {
        return PushyHostResult(@"skipped", @"not_initialized", nil, NO);
    }
    PushyRunnableConfig runnable;
    NSString *reason = nil;
    if (!PushyLoadRunnableConfig(&runnable, &reason)) {
        return PushyUnrunnableConfigResult(reason);
    }
    NSString *configJson = runnable.json;
    // Run the round on its own queue rather than this caller's thread, so the
    // wait below can be bounded.
    if ([self claimRound]) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            [self runClaimedRoundWithDeadline:0];
        });
    }
    // A group is broadcast-style. Sharing the rescue semaphore would let one
    // waiter consume the only signal and leave the other waiting forever.
    if (!pushyRoundStarted.load()) {
        return PushyHostResult(@"skipped", @"config_changed", nil, NO);
    }
    if (!(timeout > 0)) {
        timeout = 0;  // also NaN
    }
    if (dispatch_group_wait(pushyHostRoundGroup, dispatch_time(DISPATCH_TIME_NOW,
            (int64_t)(MIN(timeout, (NSTimeInterval)(INT64_MAX / NSEC_PER_SEC)) * NSEC_PER_SEC))) != 0) {
        return PushyHostResult(@"failed", @"timeout", nil, NO);
    }
    if (pushyHostRoundConfigGeneration != pushyNativeConfigGeneration.load()
        || !PushyConfigsEquivalent(configJson, pushyHostRoundConfig)
        || !PushyConfigsEquivalent(configJson, [PushyDefaults() stringForKey:keyNativeConfig])) {
        return PushyHostResult(@"cancelled", @"config_changed", nil, NO);
    }
    if (pushyHostRoundGeneration != pushyResetGeneration.load()) {
        return PushyHostResult(@"cancelled", @"reset", nil, NO);
    }
    return pushyHostRoundResult ?: PushyHostResult(@"failed", @"internal_error", nil, NO);
#endif
}

+ (void)recordJsRound:(NSString *)config {
    @synchronized (RCTPushyOrchestrator.class) {
        pushyJsCompletedConfig = [config copy];
    }
}

// True when JS already obtained a valid response in this process for a config
// equivalent to the one the native round would use (§10.3): the delayed round is
// then a duplicate request. Only the scheduled round asks — the crash-rescue
// path still runs, JS is dead by then.
+ (BOOL)hasJsRound {
    NSString *jsConfig;
    @synchronized (RCTPushyOrchestrator.class) {
        jsConfig = pushyJsCompletedConfig;
    }
    if (jsConfig == nil) {
        return NO;
    }
    return PushyConfigsEquivalent([PushyDefaults() stringForKey:keyNativeConfig], jsConfig);
}

// Runs the process's single round on the calling thread if nobody has
// started it yet. deadlineUptime > 0 (crash rescue) caps every HTTP call and
// download phase to the remaining budget.
+ (void)startRoundWithDeadline:(NSTimeInterval)deadlineUptime {
    if ([self claimRound]) {
        [self runClaimedRoundWithDeadline:deadlineUptime];
    }
}

// Claims this process's single round. Missing/disabled configuration is a
// preflight skip, not a used round. A YES must be followed by exactly one
// runClaimedRoundWithDeadline:.
+ (BOOL)claimRound {
    if (![self hasRunnableConfig]) {
        return NO;
    }
    bool expected = false;
    return pushyRoundStarted.compare_exchange_strong(expected, true);
}

+ (void)runClaimedRoundWithDeadline:(NSTimeInterval)deadlineUptime {
    @try {
        [self runOnce:pushyLaunchRolledBackForHold deadline:deadlineUptime];
    } @catch (NSException *exception) {
        // The rescue path must never take the app down with it.
        RCTLogWarn(@"RCTPushy -- native sync crashed: %@", exception.reason);
        pushyHostRoundResult = PushyHostResult(@"failed", @"internal_error", nil, NO);
    } @finally {
        pushyRoundCompleted.store(true);
        dispatch_semaphore_signal(pushyRoundDone);
        dispatch_group_leave(pushyHostRoundGroup);
    }
}

// Crash-rescue entry (§11.3), called from the handler's worker queue while
// the uncaught-exception handler holds the dying process. Ensures this
// process's round runs to completion within the budget, then activates a
// downloaded-but-unactivated version if one exists — the last chance before
// the process is gone.
+ (void)runHoldRoundWithDeadline:(NSTimeInterval)deadlineUptime {
    pushyCrashHoldActive.store(true);
    [self startRoundWithDeadline:deadlineUptime];
    if (pushyRoundStarted.load() && !pushyRoundCompleted.load()) {
        NSTimeInterval remaining = deadlineUptime - PushyMonotonicNow();
        if (remaining > 0) {
            dispatch_semaphore_wait(pushyRoundDone, dispatch_time(DISPATCH_TIME_NOW,
                (int64_t)(remaining * NSEC_PER_SEC)));
        }
    }
    [self activatePendingVersion];
}

// The alert-strategy variant of the §10.7 hole: the round downloaded a fix
// but deferred activation to JS, and JS is now dead. Activation is local and
// bounded (a state switch under the commit lock).
+ (void)activatePendingVersion {
    NSString *hash = nil;
    uint64_t generation = 0;
    uint64_t configGeneration = 0;
    @synchronized (self) {
        hash = pushyUnactivatedHash;
        generation = pushyUnactivatedGeneration;
        configGeneration = pushyUnactivatedConfigGeneration;
    }
    if (hash == nil) {
        return;
    }
    // Unlike Android's switchVersion, PushySwitchVersionLocked does not
    // validate the version directory; never point the next launch at bytes
    // that are gone (e.g. wiped by a reset whose generation bump we would
    // catch below anyway, or by cleanup).
    NSString *versionDir = [[RCTPushy downloadDir] stringByAppendingPathComponent:hash];
    if (!PushyHasCompletedVersionAtPath(versionDir, hash)) {
        NSLog(@"RCTPushy -- crash hold: version %@ no longer on disk, dropping activation", hash);
        return;
    }
    NSDictionary *hashInfoEntry = nil;
    NSString *existingInfo = [PushyDefaults() stringForKey:PushyHashInfoKey(hash)];
    NSData *existingData = [existingInfo dataUsingEncoding:NSUTF8StringEncoding];
    id parsed = existingData == nil ? nil :
        [NSJSONSerialization JSONObjectWithData:existingData options:0 error:nil];
    if ([parsed isKindOfClass:[NSDictionary class]]) {
        NSMutableDictionary *merged = [parsed mutableCopy];
        merged[PushyInfoCrashHold()] = @YES;
        hashInfoEntry = @{@"hash": hash, @"info": merged};
    }
    BOOL committed = [self commitRoundWithGeneration:generation
                                    configGeneration:configGeneration
                                            hashInfo:hashInfoEntry
                                            activate:hash
                                        responseText:nil
                                             request:nil
                                              config:nil
                                          responseAt:0
                                           activated:NULL];
    if (committed) {
        @synchronized (self) {
            pushyUnactivatedHash = nil;
        }
        NSLog(@"RCTPushy -- crash hold: activated downloaded version %@", hash);
    } else {
        NSLog(@"RCTPushy -- crash hold: reset or new config since download, dropping activation");
    }
}

// A bare module instance drives the existing download/patch pipeline without
// a bridge: the file queue is process-global and progress events are gated on
// hasListeners (never set without a bridge).
+ (RCTPushy *)engine {
    static RCTPushy *engine;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        engine = [[RCTPushy alloc] init];
    });
    return engine;
}

+ (void)runOnce:(NSString *)launchRolledBackVersion deadline:(NSTimeInterval)deadlineUptime {
    // Generations first, config second: a config replaced in between is
    // caught by the commit's generation check.
    const uint64_t resetGeneration = pushyResetGeneration.load();
    const uint64_t configGeneration = pushyNativeConfigGeneration.load();
    pushyHostRoundGeneration = resetGeneration;
    pushyHostRoundConfigGeneration = configGeneration;
    pushyHostRoundResult = PushyHostResult(@"failed", @"check_failed", nil, NO);
    NSUserDefaults *defaults = PushyDefaults();
    PushyRunnableConfig config;
    NSString *reason = nil;
    BOOL runnable = PushyLoadRunnableConfig(&config, &reason);
    pushyHostRoundConfig = config.json;
    if (!runnable) {
        pushyHostRoundResult = PushyUnrunnableConfigResult(reason);
        return;
    }
    // Preserve the interrupted-round breadcrumb and reset-safe atomic commit.
    [defaults setObject:@YES forKey:keyNativeCheckIncomplete];
    @try {
        [self runConfiguredRound:config.value
                      configJson:config.json
                          appKey:config.appKey
        launchRolledBackVersion:launchRolledBackVersion
                 resetGeneration:resetGeneration
                configGeneration:configGeneration
                        deadline:deadlineUptime];
    } @finally {
        [defaults removeObjectForKey:keyNativeCheckIncomplete];
    }
}

+ (void)runConfiguredRound:(const flowjson::Value &)config
                configJson:(NSString *)configJson
                    appKey:(NSString *)appKey
   launchRolledBackVersion:(NSString *)launchRolledBackVersion
           resetGeneration:(uint64_t)resetGeneration
          configGeneration:(uint64_t)configGeneration
                  deadline:(NSTimeInterval)deadlineUptime {
    NSUserDefaults *defaults = PushyDefaults();
    NSString *packageVersion =
        PushyFromStdString(config.Get("packageVersion").AsString());
    if (packageVersion.length == 0) {
        packageVersion = [RCTPushy packageVersion];
    }

    __block NSString *currentVersion = nil;
    PushyWithStateLock(^{
        pushy::state::State state = PushyStateFromDefaults(PushyDefaults());
        currentVersion = PushyFromStdString(state.current_version);
    });
    NSString *rolledBackVersion = launchRolledBackVersion;
    NSString *uuid = [defaults stringForKey:keyUuid] ?: @"";

    flowjson::Value identity = flowjson::Value::Object();
    identity.Set("packageVersion",
                 flowjson::Value::String(PushyToStdString(packageVersion)));
    if (currentVersion != nil) {
        identity.Set("currentVersion",
                     flowjson::Value::String(PushyToStdString(currentVersion)));
    }
    identity.Set("uuid", flowjson::Value::String(PushyToStdString(uuid)));
    if (rolledBackVersion != nil) {
        identity.Set("rolledBackVersion",
                     flowjson::Value::String(PushyToStdString(rolledBackVersion)));
    }

    flowjson::Value cInfo = flowjson::Value::Object();
    cInfo.Set("rnu", config.Get("rnu"));
    cInfo.Set("rn", config.Get("rn"));
    cInfo.Set("os", flowjson::Value::String(PushyToStdString([NSString
        stringWithFormat:@"%@ %@", PushyOsName, PushyOsVersion()])));
    cInfo.Set("uuid", flowjson::Value::String(PushyToStdString(uuid)));

    flowjson::Value input = flowjson::Value::Object();
    input.Set("packageVersion", identity.Get("packageVersion"));
    if (currentVersion != nil) {
        input.Set("currentVersion", identity.Get("currentVersion"));
    }
    input.Set("buildTime",
              flowjson::Value::String(PushyToStdString([RCTPushy buildTime])));
    input.Set("cInfo", cInfo);
    input.Set("supportedDiffVersion",
              flowjson::Value::Number(pushy::hbc::kSupportedDiffVersion));
    // Cache-only while a crash is being held (§11.3 budget) or the launch is
    // blocked on the tvOS purged-version restore; computed (and shared with JS
    // getBundleHash) on the ordinary delayed round.
    input.Set("bundleHash",
              flowjson::Value::String(PushyToStdString(PushyBundleHashSync(
                  !(pushyCrashHoldActive.load() || pushyPurgeRestoreActive.load())))));

    std::string bodyJson =
        flowjson::Stringify(flowcore::BuildRequestBody(input));
    NSString *body = [NSString stringWithUTF8String:bodyJson.c_str()];
    if (body == nil) {
        RCTLogWarn(@"RCTPushy -- native sync: request body is not valid UTF-8");
        pushyHostRoundResult = PushyHostResult(@"failed", @"invalid_request", nil, NO);
        return;
    }

    BOOL httpsOnly = PushyIsHttpsOnly(config.Get("endpoints"));
    NSString *responseText = [self runQueryRequest:config
                                            appKey:appKey
                                              body:body
                                         httpsOnly:httpsOnly
                                          deadline:deadlineUptime];
    if (responseText == nil) {
        RCTLogInfo(@"RCTPushy -- native sync: no endpoint reachable, giving up until next launch");
        return;
    }
    long long responseAtSeconds = (long long)[[NSDate date] timeIntervalSince1970];

    flowjson::Value decision = flowcore::HandleResponse(
        PushyToStdString(responseText), identity, false,
        config.Get("afterDownload").AsString());
    if (decision.Get("action").AsString() != "download") {
        BOOL committed = [self commitRoundWithGeneration:resetGeneration
                               configGeneration:configGeneration
                               hashInfo:nil
                               activate:nil
                           responseText:responseText
                                request:body
                                 config:configJson
                             responseAt:responseAtSeconds
                              activated:NULL];
        pushyHostRoundResult = committed
            ? PushyHostResult(PushyStatusNone(), PushyFromStdString(decision.Get("reason").AsString()), nil, NO)
            : PushyHostResult(@"cancelled", @"reset", nil, NO);
        RCTLogInfo(@"RCTPushy -- native sync: nothing to do (%s)",
                   decision.Get("reason").AsString().c_str());
        return;
    }
    NSString *hash = PushyFromStdString(decision.Get("hash").AsString());
    if (!PushyIsSafePathComponent(hash)) {
        pushyHostRoundResult = PushyHostResult(@"failed", @"invalid_response", nil, NO);
        return;
    }

    NSString *versionDir = [[RCTPushy downloadDir] stringByAppendingPathComponent:hash];
    BOOL downloaded = PushyHasCompletedVersionAtPath(versionDir, hash);
    if (!downloaded) {
        downloaded = [self performAttempts:decision.Get("attempts")
                                      hash:hash
                                originHash:currentVersion
                                 httpsOnly:httpsOnly
                                  deadline:deadlineUptime];
    }
    if (!downloaded) {
        BOOL committed = [self commitRoundWithGeneration:resetGeneration
                               configGeneration:configGeneration
                               hashInfo:nil
                               activate:nil
                           responseText:responseText
                                request:body
                                 config:configJson
                             responseAt:responseAtSeconds
                              activated:NULL];
        pushyHostRoundResult = committed
            ? PushyHostResult(@"failed", @"download_failed", nil, NO)
            : PushyHostResult(@"cancelled", @"reset", nil, NO);
        return;
    }

    // Persist name/description/metaInfo alongside the version, mirroring the
    // JS side's setLocalHashInfo after a successful download.
    const flowjson::Value &info = decision.Get("info");
    NSMutableDictionary *versionInfo = [NSMutableDictionary dictionary];
    for (const char *key : {"name", "description", "metaInfo"}) {
        if (info.Get(key).IsString()) {
            versionInfo[@(key)] = PushyFromStdString(info.Get(key).AsString()) ?: @"";
        }
    }
    // A forceBoot activation is the brick-rescue path: mark it in the
    // persisted info so JS can report force_boot_rescue when this version
    // survives to markSuccess. Only the server-sent directive counts — a
    // silent-strategy activation is ordinary delivery.
    if (info.Get("config").Get("forceBoot").Truthy()) {
        versionInfo[PushyInfoForceBoot()] = @YES;
    }
    if (pushyCrashHoldActive.load()) {
        versionInfo[PushyInfoCrashHold()] = @YES;
    }
    // Silent strategies or a server-marked forceBoot version (per-version
    // remote override — the brick rescue) activate for the next launch;
    // otherwise activation stays with the JS side (§6/§10.1). Unless a crash
    // is being held: JS is dead, deferring to it would leave the fix on disk
    // forever (§11.3). Or the launch is blocked on reinstalling a version
    // tvOS purged: JS has not started, and the whole point is to boot it —
    // commitRoundWithGeneration drops that one once the restore window closed.
    BOOL activate = decision.Get("activate").Truthy() || pushyCrashHoldActive.load()
        || pushyPurgeRestoreActive.load();
    BOOL activated = NO;
    BOOL committed = [self commitRoundWithGeneration:resetGeneration
                                    configGeneration:configGeneration
                                            hashInfo:@{@"hash": hash, @"info": versionInfo}
                                            activate:activate ? hash : nil
                                        responseText:responseText
                                             request:body
                                              config:configJson
                                          responseAt:responseAtSeconds
                                           activated:&activated];
    activate = activated;
    if (!committed) {
        RCTLogInfo(@"RCTPushy -- native sync: reset during round, dropping result");
    } else if (activate) {
        @synchronized (self) {
            pushyUnactivatedHash = nil;
        }
        RCTLogInfo(@"RCTPushy -- native sync: downloaded %@ and set for next launch", hash);
    } else {
        // Remembered so a crash later in this process can still activate it
        // (activatePendingVersion) — JS never will.
        @synchronized (self) {
            pushyUnactivatedHash = [hash copy];
            pushyUnactivatedGeneration = resetGeneration;
            pushyUnactivatedConfigGeneration = configGeneration;
        }
        RCTLogInfo(@"RCTPushy -- native sync: downloaded %@, activation left to JS", hash);
    }
    pushyHostRoundResult = committed
        ? PushyHostResult(@"downloaded", @"", hash, activate)
        : PushyHostResult(@"cancelled", @"reset", nil, NO);
}

// Everything a round persists — version info, the activation, the response
// cache — is written inside ONE state-lock acquisition that first re-checks the
// reset and config generations. resetToPackagedBundle bumps that generation under the same
// lock, so there is no compare-and-act window: either the whole round commits,
// or the reset wins and none of it does.
+ (BOOL)commitRoundWithGeneration:(uint64_t)generation
                 configGeneration:(uint64_t)configGeneration
                         hashInfo:(NSDictionary *)hashInfoEntry
                         activate:(NSString *)hashToActivate
                     responseText:(NSString *)responseText
                          request:(NSString *)requestBody
                           config:(NSString *)configJson
                       responseAt:(long long)responseAtSeconds
                        activated:(BOOL *)activatedOut {
    // responseText is nil for the crash handler's activation-only commit
    // (activatePendingVersion): no round ran, so there is no cache to write.
    NSData *cacheData = nil;
    if (responseText != nil) {
        NSDictionary *cacheEntry = @{
            @"ts": @(responseAtSeconds),
            @"body": responseText,
            @"request": requestBody,
            @"config": configJson,
        };
        cacheData = [NSJSONSerialization dataWithJSONObject:cacheEntry options:0 error:nil];
    }
    __block BOOL committed = NO;
    __block BOOL activated = NO;
    PushyWithStateLock(^{
        if (pushyResetGeneration.load() != generation) {
            return;
        }
        // The config the round ran with was replaced (persistConfiguration
        // bumps this under the same lock).
        if (pushyNativeConfigGeneration.load() != configGeneration) {
            return;
        }
        NSString *activation = hashToActivate;
        NSDictionary *info = hashInfoEntry[@"info"];
        // The tvOS purged-version restore round (a round commit, not the
        // crash handler's activation-only one): it may take over this launch
        // only while +bundleURL still waits for it; after that the version is
        // left to JS unless a crash is being held (JS is dead then).
        if (responseText != nil && pushyPurgeRestoreActive.load()) {
            if (pushyPurgeRestoreWindowOpen) {
                if (activation != nil && info != nil) {
                    NSMutableDictionary *marked = [info mutableCopy];
                    marked[@"purgeRestore"] = @YES;
                    info = marked;
                }
            } else if (!pushyCrashHoldActive.load()) {
                activation = nil;
            }
        }
        NSUserDefaults *defaults = PushyDefaults();
        if (hashInfoEntry != nil) {
            NSData *infoData = [NSJSONSerialization dataWithJSONObject:info
                                                              options:0
                                                                error:nil];
            if (infoData != nil) {
                [defaults setObject:[[NSString alloc] initWithData:infoData encoding:NSUTF8StringEncoding]
                             forKey:PushyHashInfoKey(hashInfoEntry[@"hash"])];
            }
        }
        if (activation != nil) {
            PushySwitchVersionLocked(activation);
            activated = YES;
        }
        if (cacheData != nil) {
            [defaults setObject:[[NSString alloc] initWithData:cacheData encoding:NSUTF8StringEncoding]
                         forKey:keyNativeCheckCache];
        }
        committed = YES;
    });
    if (activatedOut != NULL) {
        *activatedOut = activated;
    }
    return committed;
}

// Per-request timeout, capped to the crash-rescue budget when one is active.
// <= 0 means the budget is gone and the round must stop issuing requests.
static NSTimeInterval PushyQueryRequestTimeout(NSTimeInterval deadlineUptime) {
    if (deadlineUptime <= 0) {
        return 10;
    }
    return MIN(10, deadlineUptime - PushyMonotonicNow());
}

// Sequential fallback over the ordered candidates (§5.1): one request at a
// time with its own timeout; after the configured round fails, queryUrls
// discovery merges remote candidates (excluding the already-tried) for one
// more round. No hedged race on purpose — this path is latency-insensitive.
+ (NSString *)runQueryRequest:(const flowjson::Value &)config
                       appKey:(NSString *)appKey
                         body:(NSString *)body
                    httpsOnly:(BOOL)httpsOnly
                     deadline:(NSTimeInterval)deadlineUptime {
    NSMutableSet<NSString *> *tried = [NSMutableSet set];
    const NSUInteger maxHttpAttempts = 8;
    __block NSUInteger httpAttempts = 0;
    // Spends one attempt of the shared budget. NO once the attempt cap or the
    // deadline is exhausted (the round must stop issuing requests); the
    // per-request timeout lands in *timeout otherwise.
    BOOL (^takeAttempt)(NSTimeInterval *) = ^BOOL(NSTimeInterval *timeout) {
        if (httpAttempts++ >= maxHttpAttempts) {
            return NO;
        }
        *timeout = PushyQueryRequestTimeout(deadlineUptime);
        return *timeout > 0;
    };
    // Tries each not-yet-tried endpoint base in order and returns the first
    // valid response; *stop is set when the budget ran out. A remote list
    // (fetched from queryUrls) may not downgrade an https-only config.
    NSString *(^queryEndpoints)(const flowjson::Value &, BOOL, BOOL *) =
        ^NSString *(const flowjson::Value &endpoints, BOOL remote, BOOL *stop) {
        for (const auto &endpoint : endpoints.elements()) {
            NSString *base = PushyNormalizeEndpointBase(
                PushyFromStdString(endpoint.AsString()));
            if (base.length == 0 || [tried containsObject:base]) {
                continue;
            }
            if (remote && httpsOnly && !PushyIsHttpsUrl(base)) {
                RCTLogWarn(@"RCTPushy -- native sync: ignoring non-https remote endpoint %@", base);
                continue;
            }
            NSTimeInterval timeout = 0;
            if (!takeAttempt(&timeout)) {
                *stop = YES;
                return nil;
            }
            [tried addObject:base];
            NSString *response = PushyHttpRequest(
                [NSString stringWithFormat:@"%@%@%@", base, RCTPushyQueryPath(), appKey],
                @"POST", body, timeout);
            if (PushyIsValidResponse(response)) {
                return response;
            }
        }
        return nil;
    };

    BOOL stop = NO;
    double sample = arc4random() / 4294967296.0;
    NSString *response = queryEndpoints(
        flowcore::OrderEndpointCandidates(config.Get("endpoints"), sample), NO, &stop);
    if (response != nil || stop) {
        return response;
    }
    for (const auto &queryUrl : config.Get("queryUrls").elements()) {
        NSString *listUrl = PushyFromStdString(queryUrl.AsString());
        if (listUrl == nil) {
            continue;
        }
        NSTimeInterval listTimeout = 0;
        if (!takeAttempt(&listTimeout)) {
            return nil;
        }
        NSString *listText = PushyHttpRequest(listUrl, @"GET", nil, listTimeout);
        if (listText == nil) {
            continue;
        }
        bool ok = false;
        flowjson::Value remote = flowjson::Parse(PushyToStdString(listText), &ok);
        if (!ok || !remote.IsArray()) {
            continue;
        }
        // One successfully fetched remote list is enough.
        return queryEndpoints(remote, YES, &stop);
    }
    return nil;
}

// Strategies in order (diff, pdiff, full), each over its mirrors. A failure
// that is not mirror-retryable (PATCH_FAILED: the bytes arrived but could not
// be applied, and every mirror serves the same bytes) moves on to the next
// strategy instead of downloading the same artifact again, like the JS side.
+ (BOOL)performAttempts:(const flowjson::Value &)attempts
                   hash:(NSString *)hash
             originHash:(NSString *)originHash
              httpsOnly:(BOOL)httpsOnly
               deadline:(NSTimeInterval)holdDeadline {
    RCTPushy *engine = [self engine];
    // Crash-rescue budget caps every phase; 0 keeps the normal 10min windows.
    NSTimeInterval incrementalDeadline = PushyMonotonicNow() + 600;
    if (holdDeadline > 0) {
        incrementalDeadline = MIN(incrementalDeadline, holdDeadline);
    }
    NSTimeInterval fullDeadline = 0;
    for (const auto &attempt : attempts.elements()) {
        const std::string &type = attempt.Get("type").AsString();
        PushyType pushyType = type == "diff" ? PushyTypePatchFromPpk
                            : type == "pdiff" ? PushyTypePatchFromPackage
                                              : PushyTypeFullDownload;
        if (pushyType == PushyTypePatchFromPpk && originHash.length == 0) {
            continue;  // diff patches from the running version; none running
        }
        BOOL isFullAttempt = pushyType == PushyTypeFullDownload;
        if (isFullAttempt && fullDeadline == 0) {
            // diff/pdiff cannot starve the last-resort full download.
            fullDeadline = PushyMonotonicNow() + 600;
            if (holdDeadline > 0) {
                fullDeadline = MIN(fullDeadline, holdDeadline);
            }
        }
        NSTimeInterval deadline = isFullAttempt ? fullDeadline : incrementalDeadline;
        for (const auto &urlValue : attempt.Get("urls").elements()) {
            NSString *url = PushyFromStdString(urlValue.AsString());
            if (url == nil) {
                continue;
            }
            if (httpsOnly && PushyIsCleartextUrl(url)) {
                RCTLogWarn(@"RCTPushy -- native sync: ignoring cleartext %s url %@", type.c_str(), url);
                continue;
            }
            NSTimeInterval remaining = deadline - PushyMonotonicNow();
            if (remaining <= 0) {
                if (isFullAttempt) {
                    return NO;
                }
                break;
            }
            NSMutableDictionary *options =
                [@{
                    PushyOptionUrlKey(): url,
                    @"hash": hash,
                    @"deadlineUptime": @(deadline),
                } mutableCopy];
            if (pushyType == PushyTypePatchFromPpk) {
                options[@"originHash"] = originHash;
            }
            dispatch_semaphore_t sem = dispatch_semaphore_create(0);
            __block NSError *resultError = nil;
            [engine performFetch:pushyType options:options callback:^(NSError *error) {
                resultError = error;
                dispatch_semaphore_signal(sem);
            }];
            if (dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW,
                    (int64_t)(remaining * NSEC_PER_SEC))) != 0) {
                RCTLogWarn(@"RCTPushy -- native sync: %s attempt timed out", type.c_str());
                if (isFullAttempt) {
                    return NO;
                }
                break;
            }
            if (resultError == nil) {
                return YES;
            }
            RCTLogInfo(@"RCTPushy -- native sync: %s attempt failed: %@",
                       type.c_str(), resultError.localizedDescription);
            if (!flowcore::IsMirrorRetryableCode(
                    PushyToStdString(resultError.userInfo[RCTPushyErrorCodeKey]))) {
                break;
            }
        }
    }
    return NO;
}

@end
