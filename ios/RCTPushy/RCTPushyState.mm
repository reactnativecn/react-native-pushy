// Persisted update state: the defaults keys, the state lock, the State <->
// defaults mapping, the string/error/JSON helpers every other file uses, and
// the embedded bundle's hash.
#import "RCTPushyInternal.h"

#include <exception>
#include "../../cpp/patch_core/digest.h"
#include "../../cpp/patch_core/native_texts.h"

#import <React/RCTConvert.h>
#import <os/lock.h>

PUSHY_HIDDEN NSString *const keyPushyInfo = @"REACTNATIVECN_PUSHY_INFO_KEY";
// Binary identity (SyncBinaryVersion input). Prefixed like every other key:
// the unprefixed names collided with generic host-app/SDK defaults, and a
// foreign value there made every launch look like a rebuilt binary and wipe
// the installed update.
static NSString *const paramPackageVersion = @"REACTNATIVECN_PUSHY_PACKAGEVERSION";
static NSString *const paramBuildTime = @"REACTNATIVECN_PUSHY_BUILDTIME";
// The unprefixed names earlier SDKs wrote. Read only as a fallback until the
// first state write migrates them (PushyStateFromDefaults /
// PushyApplyStateToDefaults).
static NSString *const legacyParamPackageVersion = @"packageVersion";
static NSString *const legacyParamBuildTime = @"buildTime";
static NSString *const paramLastVersion = @"lastVersion";
PUSHY_HIDDEN NSString *const paramCurrentVersion = @"currentVersion";
static NSString *const paramIsFirstTime = @"isFirstTime";
static NSString *const paramIsFirstLoadOk = @"isFirstLoadOK";
PUSHY_HIDDEN NSString *const keyUuid = @"REACTNATIVECN_PUSHY_UUID";
PUSHY_HIDDEN NSString *const keyHashInfo = @"REACTNATIVECN_PUSHY_HASH_";
PUSHY_HIDDEN NSString *const keyFirstLoadMarked = @"REACTNATIVECN_PUSHY_FIRSTLOADMARKED_KEY";
PUSHY_HIDDEN NSString *const keyRolledBackMarked = @"REACTNATIVECN_PUSHY_ROLLEDBACKMARKED_KEY";
// Encoded constants (native_texts.h) are decoded on first use, not by
// static initializers at image load.
PUSHY_HIDDEN NSString *KeyPackageUpdatedMarked(void) {
    static NSString *value = PushyFromStdString(pushy::texts::PackageUpdatedMarkedKey());
    return value;
}
// bundleHash cache: "<cacheKey>|<sha256hex>" where cacheKey identifies the
// installed binary (packageVersion + embedded bundle size + mtime). Recomputed
// only when the key changes, i.e. once per install.
static NSString *const keyBundleHashCache = @"REACTNATIVECN_PUSHY_BUNDLEHASH_KEY";
// Raw response cache written by the native cold-start check for the JS side
// to reuse (§10.3), scoped to the request and config that produced it.
PUSHY_HIDDEN NSString *const keyNativeCheckCache = @"REACTNATIVECN_PUSHY_NATIVE_CHECK_RESP_KEY";

// <generated:lifecycle> (scripts/contract.ts; bun scripts/generate-contract.ts)
// What a reset to the packaged bundle and a binary upgrade delete besides
// the state fields (scripts/contract.ts storedItems; every other item survives
// both: the uuid, the native config, the round breadcrumb, the bundle hash
// cache).
PUSHY_HIDDEN NSArray<NSString *> *PushyKeysClearedOnReset(void) {
    return @[keyFirstLoadMarked, KeyPackageUpdatedMarked(), keyNativeCheckCache];
}
PUSHY_HIDDEN NSArray<NSString *> *PushyKeyPrefixesClearedOnReset(void) {
    return @[keyHashInfo];
}
PUSHY_HIDDEN NSArray<NSString *> *PushyKeysClearedOnUpgrade(void) {
    return @[keyFirstLoadMarked, keyNativeCheckCache];
}
PUSHY_HIDDEN NSArray<NSString *> *PushyKeyPrefixesClearedOnUpgrade(void) {
    return @[keyHashInfo];
}
// </generated:lifecycle>

PUSHY_HIDDEN void PushyRemoveKeys(NSUserDefaults *defaults, NSArray<NSString *> *keys,
                                  NSArray<NSString *> *prefixes) {
    for (NSString *key in keys) {
        [defaults removeObjectForKey:key];
    }
    if (prefixes.count == 0) {
        return;
    }
    for (NSString *key in [defaults dictionaryRepresentation].allKeys) {
        for (NSString *prefix in prefixes) {
            if ([key hasPrefix:prefix]) {
                [defaults removeObjectForKey:key];
                break;
            }
        }
    }
}

// error def — messages are human-readable; the stable cross-platform codes
// live in cpp/patch_core/error_codes.h and travel in RCTPushyErrorCodeKey.
PUSHY_HIDDEN NSString *const ERROR_OPTIONS = @"options error";

PUSHY_HIDDEN std::atomic<bool> ignoreRollback{false};
// Bumped by resetToPackagedBundle only (config replacement has its own
// pushyNativeConfigGeneration). The cold-start check runs for minutes and
// may already hold a decision when the app resets to the packaged bundle; it
// samples this counter and abandons activation (and its response cache) when
// the value moved, so an in-flight rescue can never resurrect the version the
// app just reset away from.
PUSHY_HIDDEN std::atomic<uint64_t> pushyResetGeneration{0};

PUSHY_HIDDEN NSDictionary *PushyHostResult(NSString *status, NSString *reason,
                                           NSString *hash, BOOL activated) {
    return @{@"status": status, @"reason": reason ?: @"",
             @"hash": hash ?: @"", @"activated": @(activated)};
}

PUSHY_HIDDEN NSTimeInterval PushyMonotonicNow(void) {
    return [NSProcessInfo processInfo].systemUptime;
}

// Serializes every read-modify-write of the persisted update state. The state
// machine itself is a pure function (state_core), but callers run on different
// threads (main thread bundleURL, module method queue, the file queue), so the
// read→transform→write sequence must be atomic to avoid e.g. markSuccess being
// overwritten by a concurrent bundleURL and the version being rolled back.
static os_unfair_lock pushyStateLock = OS_UNFAIR_LOCK_INIT;

PUSHY_HIDDEN void PushyWithStateLock(void (NS_NOESCAPE ^block)(void)) {
#if DEBUG
    // Not re-entrant: a nested acquisition deadlocks in release, so catch it
    // where it is written.
    os_unfair_lock_assert_not_owner(&pushyStateLock);
#endif
    os_unfair_lock_lock(&pushyStateLock);
    @try {
        block();
    } @finally {
        os_unfair_lock_unlock(&pushyStateLock);
    }
}

PUSHY_HIDDEN NSString *PushyCaughtReason(NSString *fallback) {
    std::exception_ptr caught = std::current_exception();
    if (caught == nullptr) {
        return fallback;
    }
    try {
        @try {
            std::rethrow_exception(caught);
        } @catch (NSException *exception) {
            return exception.reason ?: fallback;
        }
    } catch (const std::exception &error) {
        return [NSString stringWithUTF8String:error.what()] ?: fallback;
    } catch (...) {
    }
    return fallback;
}

PUSHY_HIDDEN BOOL PushyGuard(NSString *where, void (NS_NOESCAPE ^block)(void)) {
    @try {
        block();
        return YES;
    } @catch (...) {
        NSLog(@"RCTPushy -- %@ failed: %@", where, PushyCaughtReason(@"unknown exception"));
        return NO;
    }
}

PUSHY_HIDDEN std::string PushyToStdString(NSString *value) {
    if (value == nil) {
        return std::string();
    }
    return std::string([value UTF8String]);
}

PUSHY_HIDDEN NSUserDefaults *PushyDefaults(void) {
    return [NSUserDefaults standardUserDefaults];
}

PUSHY_HIDDEN NSString *PushyFromStdString(const std::string &value) {
    if (value.empty()) {
        return nil;
    }
    return [NSString stringWithUTF8String:value.c_str()];
}

static void PushySetNullableString(NSUserDefaults *defaults, NSString *key, NSString *value) {
    if (value != nil) {
        [defaults setObject:value forKey:key];
    } else {
        [defaults removeObjectForKey:key];
    }
}

PUSHY_HIDDEN NSString *PushyHashInfoKey(NSString *hash) {
    return [keyHashInfo stringByAppendingString:hash ?: @""];
}

PUSHY_HIDDEN NSString *PushyOptionString(NSDictionary *options, NSString *key) {
    return [RCTConvert NSString:options[key]];
}

PUSHY_HIDDEN BOOL PushyStringIsBlank(NSString *value) {
    if (value == nil || [value isKindOfClass:[NSNull class]]) {
        return YES;
    }
    return [[value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] length] == 0;
}

// Server-provided identifiers (hash/originHash) are used as child names under
// the download root; anything that could resolve outside of it (path
// separators, "..", ".") must be rejected before touching the filesystem.
PUSHY_HIDDEN BOOL PushyIsSafePathComponent(NSString *value) {
    if (PushyStringIsBlank(value)) {
        return NO;
    }
    if ([value isEqualToString:@"."] || [value isEqualToString:@".."]) {
        return NO;
    }
    if ([value containsString:@"/"] || [value containsString:@"\\"]) {
        return NO;
    }
    if ([value rangeOfString:@"\0"].location != NSNotFound) {
        return NO;
    }
    return YES;
}

PUSHY_HIDDEN NSError *PushyErrorWithCode(const char *code, NSString *message) {
    return [NSError errorWithDomain:RCTPushyErrorDomain
                               code:-1
                           userInfo:@{
                               NSLocalizedDescriptionKey: message ?: @"unknown error",
                               RCTPushyErrorCodeKey: @(code),
                           }];
}

PUSHY_HIDDEN void PushyRejectError(RCTPromiseRejectBlock reject, NSError *error) {
    // Prefer the stable cross-platform code (error_codes.h); fall back to the
    // numeric NSError code for system errors that were not classified.
    NSString *code = error.userInfo[RCTPushyErrorCodeKey];
    if (code == nil) {
        code = [NSString stringWithFormat:@"%ld", (long)error.code];
    }
    reject(code, error.localizedDescription, error);
}

PUSHY_HIDDEN NSDictionary *PushyJsonDictionary(id json, NSError **error) {
    NSData *data = [json isKindOfClass:[NSString class]]
        ? [(NSString *)json dataUsingEncoding:NSUTF8StringEncoding]
        : ([json isKindOfClass:[NSData class]] ? (NSData *)json : nil);
    id object = data == nil ? nil
        : [NSJSONSerialization JSONObjectWithData:data options:0 error:error];
    return [object isKindOfClass:[NSDictionary class]] ? (NSDictionary *)object : nil;
}

PUSHY_HIDDEN NSString *PushyJsonString(id object) {
    NSData *data = object == nil ? nil
        : [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
    return data == nil ? nil : [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

// Binary identity under the prefixed key, or — until the first state write
// migrates it — the value an earlier SDK left under the unprefixed one, so an
// installed update survives the SDK upgrade instead of reading as a rebuilt
// binary.
static NSString *PushyBinaryIdentityValue(NSUserDefaults *defaults, NSString *key, NSString *legacyKey) {
    return [defaults stringForKey:key] ?: [defaults stringForKey:legacyKey];
}

PUSHY_HIDDEN pushy::state::State PushyStateFromDefaults(NSUserDefaults *defaults) {
    pushy::state::State state;
    state.package_version = PushyToStdString(
        PushyBinaryIdentityValue(defaults, paramPackageVersion, legacyParamPackageVersion));
    state.build_time = PushyToStdString(
        PushyBinaryIdentityValue(defaults, paramBuildTime, legacyParamBuildTime));
    NSDictionary *pushyInfo = [defaults dictionaryForKey:keyPushyInfo];
    if (pushyInfo != nil) {
        state.current_version = PushyToStdString(pushyInfo[paramCurrentVersion]);
        state.last_version = PushyToStdString(pushyInfo[paramLastVersion]);
        state.first_time = [pushyInfo[paramIsFirstTime] boolValue];
        id firstLoadOk = pushyInfo[paramIsFirstLoadOk];
        state.first_time_ok = firstLoadOk == nil ? true : [firstLoadOk boolValue];
    }
    state.rolled_back_version = PushyToStdString([defaults stringForKey:keyRolledBackMarked]);
    return state;
}

PUSHY_HIDDEN void PushyApplyStateToDefaults(NSUserDefaults *defaults, const pushy::state::State &state) {
    PushySetNullableString(defaults, paramPackageVersion, PushyFromStdString(state.package_version));
    PushySetNullableString(defaults, paramBuildTime, PushyFromStdString(state.build_time));
    // One-time migration: once the prefixed keys hold the identity, the
    // legacy ones are retired so a host-app write there is never read again.
    [defaults removeObjectForKey:legacyParamPackageVersion];
    [defaults removeObjectForKey:legacyParamBuildTime];

    BOOL hasPushyInfo = !state.current_version.empty() || !state.last_version.empty() || state.first_time || !state.first_time_ok;
    if (hasPushyInfo) {
        NSMutableDictionary *newInfo = [[NSMutableDictionary alloc] init];
        if (!state.current_version.empty()) {
            newInfo[paramCurrentVersion] = PushyFromStdString(state.current_version);
        }
        if (!state.last_version.empty()) {
            newInfo[paramLastVersion] = PushyFromStdString(state.last_version);
        }
        newInfo[paramIsFirstTime] = @(state.first_time);
        newInfo[paramIsFirstLoadOk] = @(state.first_time_ok);
        [defaults setObject:newInfo forKey:keyPushyInfo];
    } else {
        [defaults removeObjectForKey:keyPushyInfo];
    }

    PushySetNullableString(
        defaults,
        keyRolledBackMarked,
        PushyFromStdString(state.rolled_back_version));
}

// Version switch without acquiring the state lock: the caller must already
// hold it. Lets the cold-start check commit its whole result (version info,
// switch, response cache) inside one lock acquisition, so resetToPackagedBundle
// can never interleave between the generation check and the writes.
PUSHY_HIDDEN void PushySwitchVersionLocked(NSString *hash) {
    NSUserDefaults *defaults = PushyDefaults();
    pushy::state::State next = pushy::state::SwitchVersion(
        PushyStateFromDefaults(defaults),
        PushyToStdString(hash)
    );
    PushyApplyStateToDefaults(defaults, next);
    // Re-enable first-load consumption and rollback checks for the newly selected bundle.
    ignoreRollback = false;
}

static NSString *PushyCachedBundleHash(NSUserDefaults *defaults, NSString *cachedPrefix) {
    NSString *cached = [defaults stringForKey:keyBundleHashCache];
    if ([cached hasPrefix:cachedPrefix]) {
        return [cached substringFromIndex:cachedPrefix.length];
    }
    return nil;
}

// Shared by the getBundleHash RCT method and the native cold-start check.
// Returns @"" when unknown. With computeIfMissing the sha256 of the embedded
// bundle is taken on a cache miss (once per install; blocking — call off the
// main thread). Without it only the cache is consulted: a crash rescue on
// the main thread has a 3.5s budget in total, and hashing a large bundle on
// a fresh install would spend all of it before the first request.
PUSHY_HIDDEN NSString *PushyBundleHashSync(BOOL computeIfMissing) {
    NSString *path = [[RCTPushy binaryBundleURL] path];
    if (path == nil) {
        return @"";
    }
    NSDictionary *attributes =
        [[NSFileManager defaultManager] attributesOfItemAtPath:path error:nil];
    if (attributes == nil) {
        return @"";
    }
    NSString *cacheKey = [NSString stringWithFormat:@"%@|%llu|%.0f",
        [RCTPushy packageVersion],
        attributes.fileSize,
        [attributes.fileModificationDate timeIntervalSince1970]];

    NSUserDefaults *defaults = PushyDefaults();
    NSString *cachedPrefix = [cacheKey stringByAppendingString:@"|"];
    NSString *cached = PushyCachedBundleHash(defaults, cachedPrefix);
    if (cached != nil) {
        return cached;
    }
    if (!computeIfMissing) {
        return @"";
    }

    // Single-flight for the digest: the delayed cold-start round (utility
    // queue) and JS getBundleHash (file queue) can both miss the cache right
    // after an install; the second caller waits for the first and then reads
    // its cache entry instead of hashing the same multi-MB file twice.
    static NSLock *lock = [NSLock new];
    [lock lock];
    @try {
        // The previous holder may have filled the cache while we waited.
        cached = PushyCachedBundleHash(defaults, cachedPrefix);
        if (cached != nil) {
            return cached;
        }
        NSString *hash = PushyFromStdString(
            pushy::digest::Sha256File(PushyToStdString(path))) ?: @"";
        if (hash.length > 0) {
            [defaults setObject:[cachedPrefix stringByAppendingString:hash]
                         forKey:keyBundleHashCache];
        }
        return hash;
    } @finally {
        [lock unlock];
    }
}
