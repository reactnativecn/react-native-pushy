#import "RCTPushyInternal.h"
#include "../../cpp/patch_core/error_codes.h"
#include "../../cpp/patch_core/native_texts.h"
#include "../../cpp/update_flow_core/flow_json.h"
#include "../../cpp/update_flow_core/native_config.h"
#include "../../cpp/update_flow_core/round_engine.h"

#if TARGET_OS_TV
#import <Network/Network.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#endif

// Raw JSON persisted by JS (syncNativeConfig) or the host (configure) for the
// native round; parsed on read (PushyLoadRunnableConfig). Absent = no round.
static NSString *const keyNativeConfig = @"REACTNATIVECN_PUSHY_NATIVE_CONFIG_KEY";
// Set when a native check round starts, cleared when it ends (§11.4). Residue
// on the next launch means the previous process died mid-round (a crash
// rescue was truncated): that launch resumes immediately instead of waiting.
static NSString *const keyNativeCheckIncomplete = @"REACTNATIVECN_PUSHY_NATIVE_CHECK_INCOMPLETE_KEY";

// The crash-hold version-info flag read by JS, stored encoded
// (cpp/patch_core/native_texts.h) so it does not appear as a plain binary
// string.
static NSString *PushyInfoCrashHold(void) {
    static NSString *value = PushyFromStdString(pushy::texts::InfoCrashHold());
    return value;
}

// YES when `semaphore` was signalled within `seconds`.
static BOOL PushyWaitSeconds(dispatch_semaphore_t semaphore, NSTimeInterval seconds) {
    return dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW,
        (int64_t)(seconds * NSEC_PER_SEC))) == 0;
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
    PushyWaitSeconds(answered, 0.5);
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

@interface RCTPushyOrchestrator ()
+ (void)runHoldRoundWithDeadline:(NSTimeInterval)deadlineUptime;
@end

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
        } @catch (...) {
            NSLog(@"RCTPushy -- crash hold failed: %@", PushyCaughtReason(@"unknown exception"));
        }
        dispatch_semaphore_signal(done);
    });
    if (!PushyWaitSeconds(done, budget)) {
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
    } @catch (...) {
        // The dying process owes the previous handler its turn no matter
        // what the rescue did.
    }
    if (pushyPreviousExceptionHandler != NULL) {
        pushyPreviousExceptionHandler(exception);
    }
}

static void PushyInstallCrashHoldHandler(void) {
    static const bool installed = [] {
        pushyPreviousExceptionHandler = NSGetUncaughtExceptionHandler();
        NSSetUncaughtExceptionHandler(&PushyCrashHoldExceptionHandler);
        return true;
    }();
    (void)installed;
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
    static NSURLSession *session = [NSURLSession
        sessionWithConfiguration:[NSURLSessionConfiguration defaultSessionConfiguration]
                        delegate:[PushyRequestRedirectGuard new]
                   delegateQueue:nil];
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
// the response body on 2xx, nil on any failure. `timeout` is the request's
// idle timeout, `callTimeout` bounds the whole call.
static NSString *PushyHttpRequest(NSString *urlString, NSString *method,
                                  NSString *body, NSTimeInterval timeout,
                                  NSTimeInterval callTimeout) {
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
    if (!PushyWaitSeconds(sem, callTimeout)) {
        [task cancel];
        return nil;
    }
    return result;
}

// Contract C1 (flowcore::ConfigsEquivalent, shared with Android and Harmony;
// JS has its own copy): the same config in another serialization — key order,
// trailing slashes, defaulted keys — is not a change. Lets a host-owned
// config and the same config as JS serializes it count as one, instead of a
// "change" that cancels the round. nil (no stored config) never matches.
static BOOL PushyConfigsEquivalent(NSString *a, NSString *b) {
    return a != nil && b != nil
        && flowcore::ConfigsEquivalent(PushyToStdString(a), PushyToStdString(b));
}

// The persisted config a round may run with. Every gate (crash-hold handler
// install, round start, prepareBundle, the round itself) reads it through
// PushyLoadRunnableConfig, which applies the shared gate
// (flowcore::ParseRunnableConfig), so they agree on what "configured" and
// "disabled" mean. YES when a round may run (*json is the config text);
// otherwise *rejection is the host-facing result (skipped:
// not_configured/disabled, failed: invalid_config).
static BOOL PushyLoadRunnableConfig(NSString **json, NSDictionary **rejection) {
    NSString *text = [PushyDefaults() stringForKey:keyNativeConfig];
    if (json != NULL) {
        *json = [text copy];
    }
    flowcore::RunnableConfig gate = flowcore::ParseRunnableConfig(PushyToStdString(text));
    if (!gate.runnable() && rejection != NULL) {
        *rejection = PushyHostResult(PushyFromStdString(gate.status),
                                     PushyFromStdString(gate.reason));
    }
    return gate.runnable();
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
    return PushyLoadRunnableConfig(NULL, NULL);
}

// Process-wide round state, set up by whichever launch path needs a round
// first: the delayed cold-start check or the tvOS purged-version restore.
+ (void)prepareProcess:(NSString *)launchRolledBackVersion {
    static const bool prepared = [launchRolledBackVersion] {
        pushyRoundDone = dispatch_semaphore_create(0);
        pushyHostRoundGroup = dispatch_group_create();
        dispatch_group_enter(pushyHostRoundGroup);
        pushyProcessAnchorUptime = PushyMonotonicNow();
        pushyLaunchRolledBackForHold = [launchRolledBackVersion copy];
        pushySyncReady.store(true);
        // The crash-hold rescue shares the orchestrator's rollout gate: no
        // runnable config, no handler (§11.3). persistConfiguration installs
        // it once a runnable config arrives later in the process.
        if ([RCTPushyOrchestrator hasRunnableConfig]) {
            PushyInstallCrashHoldHandler();
        }
        return true;
    }();
    (void)prepared;
}

+ (void)scheduleFromColdStart:(NSString *)launchRolledBackVersion {
#if !DEBUG
    // Once per process; a few seconds of delay keeps the check away from the
    // cold-start critical path (§7 R5) — its result targets the NEXT launch.
    // Unless the previous process died mid-round (residual incomplete
    // marker), in which case every launch second counts (§11.4).
    // No `self` inside the once-lambdas: a block created in a lambda that
    // captured `self` by reference keeps that (dangling) reference.
    static const bool scheduled = [launchRolledBackVersion] {
        [RCTPushyOrchestrator prepareProcess:launchRolledBackVersion];
        NSUserDefaults *defaults = PushyDefaults();
        int64_t delaySeconds =
            [defaults objectForKey:keyNativeCheckIncomplete] != nil ? 0 : 5;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, delaySeconds * NSEC_PER_SEC),
                       dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{ PushyGuard(@"native sync", ^{
            if ([RCTPushyOrchestrator hasJsRound]) {
                // Not consuming the round: a later crash rescue may still
                // need it.
                NSLog(@"RCTPushy -- native sync skipped: JS already queried in this process");
                return;
            }
            [RCTPushyOrchestrator startRoundWithDeadline:0];
        }); });
        return true;
    }();
    (void)scheduled;
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
        PushyGuard(@"purge restore", ^{
            [self startRoundWithDeadline:deadline];
        });
        dispatch_semaphore_signal(done);
    });
    BOOL timedOut = !PushyWaitSeconds(done, budget);
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
    return PushyHostResult(@"skipped", @"debug");
#else
    if (!pushySyncReady.load()) {
        return PushyHostResult(@"skipped", @"not_initialized");
    }
    NSString *configJson = nil;
    NSDictionary *rejection = nil;
    if (!PushyLoadRunnableConfig(&configJson, &rejection)) {
        return rejection;
    }
    // Run the round on its own queue rather than this caller's thread, so the
    // wait below can be bounded.
    if ([self claimRound]) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            PushyGuard(@"native sync", ^{
                [self runClaimedRoundWithDeadline:0];
            });
        });
    }
    // A group is broadcast-style. Sharing the rescue semaphore would let one
    // waiter consume the only signal and leave the other waiting forever.
    if (!pushyRoundStarted.load()) {
        return PushyHostResult(@"skipped", @"config_changed");
    }
    if (!(timeout > 0)) {
        timeout = 0;  // also NaN
    }
    if (dispatch_group_wait(pushyHostRoundGroup, dispatch_time(DISPATCH_TIME_NOW,
            (int64_t)(MIN(timeout, (NSTimeInterval)(INT64_MAX / NSEC_PER_SEC)) * NSEC_PER_SEC))) != 0) {
        return PushyHostResult(@"failed", @"timeout");
    }
    NSString *cancellation = PushyFromStdString(flowcore::HostCancellation(
        PushyToStdString(configJson), PushyToStdString(pushyHostRoundConfig),
        PushyToStdString([PushyDefaults() stringForKey:keyNativeConfig]),
        pushyHostRoundConfigGeneration, pushyNativeConfigGeneration.load(),
        pushyHostRoundGeneration, pushyResetGeneration.load()));
    if (cancellation != nil) {
        return PushyHostResult(@"cancelled", cancellation);
    }
    return pushyHostRoundResult ?: PushyHostResult(@"failed", @"internal_error");
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
    } @catch (...) {
        // The rescue path must never take the app down with it.
        RCTLogWarn(@"RCTPushy -- native sync crashed: %@", PushyCaughtReason(@"unknown exception"));
        pushyHostRoundResult = PushyHostResult(@"failed", @"internal_error");
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
            PushyWaitSeconds(pushyRoundDone, remaining);
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
    // Cheap early out for bytes that are gone (e.g. wiped by a reset whose
    // generation bump the commit would catch anyway, or by cleanup); the
    // commit itself runs the full activation gate (PushyVerifyActivation).
    if (!PushyHasCompletedVersionAtPath(PushyVersionDir(hash), hash)) {
        NSLog(@"RCTPushy -- crash hold: version %@ no longer on disk, dropping activation", hash);
        return;
    }
    NSDictionary *hashInfoEntry = nil;
    NSDictionary *parsed =
        PushyJsonDictionary([PushyDefaults() stringForKey:PushyHashInfoKey(hash)], NULL);
    if (parsed != nil) {
        NSMutableDictionary *merged = [parsed mutableCopy];
        merged[PushyInfoCrashHold()] = @YES;
        hashInfoEntry = @{@"hash": hash, @"info": merged};
    }
    NSError *verifyError = nil;
    BOOL committed = [self commitRoundWithGeneration:generation
                                    configGeneration:configGeneration
                                            hashInfo:hashInfoEntry
                                            activate:hash
                                               cache:nil
                                           activated:NULL
                                         verifyError:&verifyError];
    if (committed) {
        @synchronized (self) {
            pushyUnactivatedHash = nil;
        }
        NSLog(@"RCTPushy -- crash hold: activated downloaded version %@", hash);
    } else if (verifyError != nil) {
        NSLog(@"RCTPushy -- crash hold: version %@ failed verification, dropping activation: %@",
              hash, verifyError.localizedDescription);
    } else {
        NSLog(@"RCTPushy -- crash hold: reset or new config since download, dropping activation");
    }
}

// The round itself is the shared engine's (cpp/update_flow_core
// round_engine.h, NATIVE_CHECKUPDATE_DESIGN §12): this drives it on the
// calling thread and runs what it asks for — the breadcrumb, the launch
// facts, the requests, the downloads and the commit.
+ (void)runOnce:(NSString *)launchRolledBackVersion deadline:(NSTimeInterval)deadlineUptime {
    // Generations first, config second: a config replaced in between is
    // caught by the commit's generation check.
    const uint64_t resetGeneration = pushyResetGeneration.load();
    const uint64_t configGeneration = pushyNativeConfigGeneration.load();
    pushyHostRoundGeneration = resetGeneration;
    pushyHostRoundConfigGeneration = configGeneration;
    pushyHostRoundResult = PushyHostResult(@"failed", @"check_failed");
    NSUserDefaults *defaults = PushyDefaults();
    NSString *configJson = [defaults stringForKey:keyNativeConfig];
    pushyHostRoundConfig = configJson;

    flowjson::Value event = flowjson::Value::Object();
    event.Set("type", flowjson::Value::String("start"));
    event.Set("config", flowjson::Value::String(PushyToStdString(configJson)));
    event.Set("resetGeneration", flowjson::Value::Number(resetGeneration));
    event.Set("configGeneration", flowjson::Value::Number(configGeneration));
    event.Set("sample", flowjson::Value::Number(arc4random() / 4294967296.0));
    event.Set("deadline", flowjson::Value::Number(deadlineUptime > 0 ? deadlineUptime * 1000 : 0));
    flowjson::Value state;
    BOOL marked = NO;
    @try {
        for (;;) {
            event.Set("now", flowjson::Value::Number(PushyMonotonicNow() * 1000));
            event.Set("crashHold", flowjson::Value::Bool(pushyCrashHoldActive.load()));
            event.Set("forceActivate", flowjson::Value::Bool(pushyPurgeRestoreActive.load()));
            flowjson::Value step = flowcore::StepRound(state, event);
            state = step.Get("state");
            event = flowjson::Value::Object();
            for (const flowjson::Value &command : step.Get("commands").elements()) {
                const std::string &type = command.Get("type").AsString();
                if (type == "markIncomplete") {
                    [defaults setObject:@YES forKey:keyNativeCheckIncomplete];
                    marked = YES;
                } else if (type == "finish") {
                    [self finishRound:command
                      resetGeneration:resetGeneration
                     configGeneration:configGeneration];
                    return;
                } else {
                    event = [self perform:command
                                     type:type
                  launchRolledBackVersion:launchRolledBackVersion
                         configGeneration:configGeneration];
                }
            }
        }
    } @finally {
        if (marked) {
            [defaults removeObjectForKey:keyNativeCheckIncomplete];
        }
    }
}

// Runs one engine command and returns the event that answers it.
+ (flowjson::Value)perform:(const flowjson::Value &)command
                      type:(const std::string &)type
   launchRolledBackVersion:(NSString *)launchRolledBackVersion
          configGeneration:(uint64_t)configGeneration {
    flowjson::Value event = flowjson::Value::Object();
    if (type == "collectEnv") {
        event.Set("type", flowjson::Value::String("env"));
        event.Set("env", [self launchEnv:launchRolledBackVersion]);
    } else if (type == "http") {
        BOOL post = command.Get("post").Truthy();
        NSString *text = PushyHttpRequest(
            PushyFromStdString(command.Get("url").AsString()), post ? @"POST" : @"GET",
            post ? PushyFromStdString(command.Get("body").AsString()) : nil,
            command.Get("timeoutMs").AsNumber() / 1000,
            command.Get("callTimeoutMs").AsNumber() / 1000);
        event.Set("type", flowjson::Value::String("http"));
        if (text != nil) {
            event.Set("text", flowjson::Value::String(PushyToStdString(text)));
            event.Set("at", flowjson::Value::Number([[NSDate date] timeIntervalSince1970]));
        }
    } else if (type == "checkInstalled") {
        NSString *hash = PushyFromStdString(command.Get("hash").AsString());
        event.Set("type", flowjson::Value::String("installed"));
        event.Set("installed", flowjson::Value::Bool(
            PushyHasCompletedVersionAtPath(PushyVersionDir(hash), hash)));
    } else if (type == "download") {
        event = [self download:command];
    } else if (type == "commit") {
        event = [self commit:command configGeneration:configGeneration];
    }
    return event;
}

// This launch as the shared core sees it (native_round.h); nil values are
// left out — a version-less launch has no currentVersion, as the JS constant
// does not.
+ (flowjson::Value)launchEnv:(NSString *)launchRolledBackVersion {
    __block NSString *currentVersion = nil;
    PushyWithStateLock(^{
        pushy::state::State state = PushyStateFromDefaults(PushyDefaults());
        currentVersion = PushyFromStdString(state.current_version);
    });
    flowjson::Value env = flowjson::Value::Object();
    const auto put = [&env](const char *key, NSString *value) {
        if (value != nil) {
            env.Set(key, flowjson::Value::String(PushyToStdString(value)));
        }
    };
    put("packageVersion", [RCTPushy packageVersion]);
    put("currentVersion", currentVersion);
    put("uuid", [PushyDefaults() stringForKey:keyUuid]);
    put("rolledBackVersion", launchRolledBackVersion);
    put("buildTime", [RCTPushy buildTime]);
    put("os", [NSString stringWithFormat:@"%@ %@", PushyOsName, PushyOsVersion()]);
    // Cache-only while a crash is being held (§11.3 budget) or the launch is
    // blocked on the tvOS purged-version restore; computed (and shared with JS
    // getBundleHash) on the ordinary delayed round.
    put("bundleHash", PushyBundleHashSync(
        !(pushyCrashHoldActive.load() || pushyPurgeRestoreActive.load())));
    return env;
}

// One download attempt, bounded by the deadline the engine gave it.
+ (flowjson::Value)download:(const flowjson::Value &)command {
    const std::string &strategy = command.Get("strategy").AsString();
    PushyType pushyType = strategy == "diff" ? PushyTypePatchFromPpk
                        : strategy == "pdiff" ? PushyTypePatchFromPackage
                                              : PushyTypeFullDownload;
    NSTimeInterval deadline = command.Get("deadline").AsNumber() / 1000;
    NSMutableDictionary *options = [@{
        PushyOptionUrlKey(): PushyFromStdString(command.Get("url").AsString()) ?: @"",
        @"hash": PushyFromStdString(command.Get("hash").AsString()) ?: @"",
        @"deadlineUptime": @(deadline),
    } mutableCopy];
    if (command.Get("originHash").IsString()) {
        options[@"originHash"] = PushyFromStdString(command.Get("originHash").AsString());
    }
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block NSError *resultError = nil;
    [RCTPushyInstaller fetch:pushyType options:options progress:nil callback:^(NSError *error) {
        resultError = error;
        dispatch_semaphore_signal(sem);
    }];
    flowjson::Value event = flowjson::Value::Object();
    event.Set("type", flowjson::Value::String("download"));
    if (!PushyWaitSeconds(sem, MAX(0, deadline - PushyMonotonicNow()))) {
        RCTLogWarn(@"RCTPushy -- native sync: %s attempt timed out", strategy.c_str());
        event.Set("timedOut", flowjson::Value::Bool(true));
        return event;
    }
    event.Set("ok", flowjson::Value::Bool(resultError == nil));
    if (resultError != nil) {
        RCTLogInfo(@"RCTPushy -- native sync: %s attempt failed: %@",
                   strategy.c_str(), resultError.localizedDescription);
        event.Set("code", flowjson::Value::String(
            PushyToStdString(resultError.userInfo[RCTPushyErrorCodeKey])));
    }
    return event;
}

+ (flowjson::Value)commit:(const flowjson::Value &)command
         configGeneration:(uint64_t)configGeneration {
    NSString *hash = PushyFromStdString(command.Get("hash").AsString());
    NSDictionary *hashInfo = nil;
    if (hash != nil) {
        hashInfo = @{
            @"hash": hash,
            @"info": PushyJsonDictionary(
                PushyFromStdString(command.Get("hashInfo").AsString()), NULL) ?: @{},
        };
    }
    BOOL activated = NO;
    NSError *verifyError = nil;
    BOOL committed = [self commitRoundWithGeneration:(uint64_t)command.Get("resetGeneration").AsNumber()
                                    configGeneration:configGeneration
                                            hashInfo:hashInfo
                                            activate:command.Get("activate").Truthy() ? hash : nil
                                               cache:PushyFromStdString(command.Get("cache").AsString())
                                           activated:&activated
                                         verifyError:&verifyError];
    flowjson::Value event = flowjson::Value::Object();
    event.Set("type", flowjson::Value::String("committed"));
    event.Set("ok", flowjson::Value::Bool(committed));
    event.Set("activated", flowjson::Value::Bool(activated));
    if (verifyError != nil) {
        // Android parity (UpdateContext.commitSyncResult): a version that
        // fails the activation gate commits nothing, not even the cache.
        RCTLogWarn(@"RCTPushy -- native sync: %@ failed verification: %@", hash,
                   verifyError.localizedDescription);
        event.Set("error", flowjson::Value::Bool(true));
    } else if (!committed && pushyNativeConfigGeneration.load() != configGeneration) {
        event.Set("reason", flowjson::Value::String("config_changed"));
    }
    return event;
}

+ (void)finishRound:(const flowjson::Value &)finish
    resetGeneration:(uint64_t)resetGeneration
   configGeneration:(uint64_t)configGeneration {
    NSString *status = PushyFromStdString(finish.Get("status").AsString());
    NSString *reason = PushyFromStdString(finish.Get("reason").AsString()) ?: @"";
    NSString *hash = PushyFromStdString(finish.Get("hash").AsString());
    BOOL activated = finish.Get("activated").Truthy();
    if (hash != nil && activated) {
        @synchronized (self) {
            pushyUnactivatedHash = nil;
        }
        RCTLogInfo(@"RCTPushy -- native sync: downloaded %@ and set for next launch", hash);
    } else if (hash != nil) {
        // Remembered so a crash later in this process can still activate it
        // (activatePendingVersion) — JS never will.
        @synchronized (self) {
            pushyUnactivatedHash = [hash copy];
            pushyUnactivatedGeneration = resetGeneration;
            pushyUnactivatedConfigGeneration = configGeneration;
        }
        RCTLogInfo(@"RCTPushy -- native sync: downloaded %@, activation left to JS", hash);
    } else {
        RCTLogInfo(@"RCTPushy -- native sync: %@ (%@)", status, reason);
    }
    pushyHostRoundResult = PushyHostResult(status, reason, hash, activated);
}

// Everything a round persists — version info, the activation, the response
// cache — is written inside ONE state-lock acquisition that first re-checks the
// reset and config generations. resetToPackagedBundle bumps that generation under the same
// lock, so there is no compare-and-act window: either the whole round commits,
// or the reset wins and none of it does.
//
// A version to activate first passes the same gate as switchVersion:error:
// (PushyVerifyActivation, outside the lock) and is re-checked unchanged under
// it. A version that fails it commits nothing: NO with *verifyError set.
+ (BOOL)commitRoundWithGeneration:(uint64_t)generation
                 configGeneration:(uint64_t)configGeneration
                         hashInfo:(NSDictionary *)hashInfoEntry
                         activate:(NSString *)hashToActivate
                            cache:(NSString *)cache
                        activated:(BOOL *)activatedOut
                      verifyError:(NSError **)verifyErrorOut {
    // cache is nil for the crash handler's activation-only commit
    // (activatePendingVersion): no round ran, so there is no cache to write.
    PushyVerifiedActivation verified;
    __block NSError *verifyError = nil;
    if (hashToActivate != nil) {
        verifyError = PushyVerifyActivation(hashToActivate, &verified);
    }
    __block BOOL committed = NO;
    __block BOOL activated = NO;
    if (verifyError != nil) {
        if (verifyErrorOut != NULL) {
            *verifyErrorOut = verifyError;
        }
        if (activatedOut != NULL) {
            *activatedOut = NO;
        }
        return NO;
    }
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
        if (cache != nil && pushyPurgeRestoreActive.load()) {
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
        if (activation != nil && !PushyVerifiedActivationUnchangedLocked(verified)) {
            verifyError = PushyErrorWithCode(
                pushy::error_codes::kSwitchVersionFailed,
                [NSString stringWithFormat:@"Bundle version %@ changed while switching.", activation]);
            return;
        }
        NSUserDefaults *defaults = PushyDefaults();
        NSString *infoJson = hashInfoEntry == nil ? nil : PushyJsonString(info);
        if (infoJson != nil) {
            [defaults setObject:infoJson forKey:PushyHashInfoKey(hashInfoEntry[@"hash"])];
        }
        if (activation != nil) {
            PushySwitchVersionLocked(activation);
            activated = YES;
        }
        if (cache != nil) {
            [defaults setObject:cache forKey:keyNativeCheckCache];
        }
        committed = YES;
    });
    if (activatedOut != NULL) {
        *activatedOut = activated;
    }
    if (verifyErrorOut != NULL) {
        *verifyErrorOut = verifyError;
    }
    return committed;
}

@end
