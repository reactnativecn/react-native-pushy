// Persisted update state: the defaults keys, the state lock, the State <->
// defaults mapping, the string/error/JSON helpers every other file uses, and
// the embedded bundle's hash.
#import "RCTPushyInternal.h"

#include <exception>
#include "../../cpp/patch_core/digest.h"
#include "../../cpp/patch_core/native_texts.h"
#include "../../cpp/patch_core/stored_items.h"

#import <React/RCTConvert.h>
#import <os/lock.h>

// The persisted layout every platform shares (scripts/contract.ts
// storeSchema): two NSUserDefaults suites of our own. Not
// standardUserDefaults: the host app shares that namespace, so a host key
// could collide with ours (the unprefixed packageVersion/buildTime once did,
// and wiped installed versions), and a host that clears its defaults domain
// (a common "log out" reset) would take the uuid and the update state along.
// <generated:store-schema> (scripts/contract.ts; bun scripts/generate-contract.ts)
static NSString *const PushyStateStoreName = @"pushy_state";
static NSString *const PushyCacheStoreName = @"pushy_cache";
// A boolean is stored as one of these; anything else (absent) reads as the
// field's fallback.
static NSString *const PushyBooleanTrue = @"1";
static NSString *const PushyBooleanFalse = @"0";
// Carried by hand when the migration itself cannot run.
static NSString *const legacyKeyUuid = @"REACTNATIVECN_PUSHY_UUID";
// Every legacy key starts with it: only those are snapshotted (the host app
// shares that store).
static NSString *const legacyKeyPrefix = @"REACTNATIVECN_PUSHY_";
PUSHY_HIDDEN NSString *const keySchemaVersion = @"schemaVersion";
PUSHY_HIDDEN NSString *const keyPackageVersion = @"packageVersion";
PUSHY_HIDDEN NSString *const keyBuildTime = @"buildTime";
PUSHY_HIDDEN NSString *const keyCurrentVersion = @"currentVersion";
PUSHY_HIDDEN NSString *const keyLastVersion = @"lastVersion";
PUSHY_HIDDEN NSString *const keyFirstTime = @"firstTime";
PUSHY_HIDDEN NSString *const keyFirstTimeOk = @"firstTimeOk";
PUSHY_HIDDEN NSString *const keyRolledBackVersion = @"rolledBackVersion";
// Per-version info: name, description, metaInfo and the rescue flags.
PUSHY_HIDDEN NSString *const keyHashInfo = @"hash_";
// Set when a launch consumes first_time; getConstants reports and clears it.
PUSHY_HIDDEN NSString *const keyFirstLoadMarker = @"firstLoadMarked";
// Set by a binary upgrade, consumed by getConstants (old version cleanup).
PUSHY_HIDDEN NSString *const keyBinaryUpgradedMarker = @"binaryUpgraded";
// The native round's raw response for the JS side to reuse (§10.3), scoped
// to the exact logical request and native config that produced it. It
// describes versions a reset or an upgrade removes.
PUSHY_HIDDEN NSString *const keyCheckCache = @"nativeCheckResp";
// Set when a round starts, cleared when it ends (§11.4). Residue on the
// next launch means the previous process died mid-round: that launch
// resumes immediately instead of waiting 5s.
PUSHY_HIDDEN NSString *const keyRoundBreadcrumb = @"nativeCheckIncomplete";
// Identifies the install for gray-release bucketing: must never change.
PUSHY_HIDDEN NSString *const keyUuid = @"uuid";
// The persisted native check config (JS syncNativeConfig or the host) the
// cold-start round and the crash hold run from.
PUSHY_HIDDEN NSString *const keyNativeConfig = @"nativeConfig";
// "<binary identity>|<sha256>" of the embedded bundle: keyed by the binary,
// so it invalidates itself on upgrade.
PUSHY_HIDDEN NSString *const keyBundleHashCache = @"bundleHashCache";
// </generated:store-schema>

// <generated:lifecycle> (scripts/contract.ts; bun scripts/generate-contract.ts)
// What a reset to the packaged bundle and a binary upgrade delete from the
// state store besides the state fields (scripts/contract.ts storedItems;
// the cache store is cleared on both, every other item survives both: the
// uuid, the native config, the round breadcrumb, the bundle hash cache).
PUSHY_HIDDEN NSArray<NSString *> *PushyKeysClearedOnReset(void) {
    return @[keyFirstLoadMarker, keyBinaryUpgradedMarker];
}
PUSHY_HIDDEN NSArray<NSString *> *PushyKeyPrefixesClearedOnReset(void) {
    return @[keyHashInfo];
}
PUSHY_HIDDEN NSArray<NSString *> *PushyKeysClearedOnUpgrade(void) {
    return @[keyFirstLoadMarker];
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

PUSHY_HIDDEN NSString *PushyFromStdString(const std::string &value) {
    if (value.empty()) {
        return nil;
    }
    return [NSString stringWithUTF8String:value.c_str()];
}

PUSHY_HIDDEN NSString *PushyReadString(NSUserDefaults *defaults, NSString *key) {
    NSString *value = [defaults stringForKey:key];
    return value.length > 0 ? value : nil;
}

PUSHY_HIDDEN void PushyWriteString(NSUserDefaults *defaults, NSString *key, NSString *value) {
    if (value.length > 0) {
        [defaults setObject:value forKey:key];
    } else {
        [defaults removeObjectForKey:key];
    }
}

PUSHY_HIDDEN BOOL PushyReadBool(NSUserDefaults *defaults, NSString *key, BOOL fallback) {
    NSString *value = [defaults stringForKey:key];
    if ([value isEqualToString:PushyBooleanTrue]) {
        return YES;
    }
    if ([value isEqualToString:PushyBooleanFalse]) {
        return NO;
    }
    return fallback;
}

PUSHY_HIDDEN void PushyWriteBool(NSUserDefaults *defaults, NSString *key, BOOL value) {
    [defaults setObject:value ? PushyBooleanTrue : PushyBooleanFalse forKey:key];
}

PUSHY_HIDDEN BOOL PushyReadMarker(NSUserDefaults *defaults, NSString *key) {
    return PushyReadBool(defaults, key, NO);
}

PUSHY_HIDDEN void PushyWriteMarker(NSUserDefaults *defaults, NSString *key, BOOL set) {
    if (set) {
        [defaults setObject:PushyBooleanTrue forKey:key];
    } else {
        [defaults removeObjectForKey:key];
    }
}

// A stored value as the migration core reads it: text as is, a number or a
// boolean as its text ("1" for YES, like the layout's own booleans), anything
// else (the legacy info dictionary) as "" — a key to delete, never a value.
static std::string PushyDefaultsText(id value) {
    if ([value isKindOfClass:[NSString class]]) {
        return PushyToStdString(value);
    }
    if ([value isKindOfClass:[NSNumber class]]) {
        return PushyToStdString([(NSNumber *)value stringValue]);
    }
    return std::string();
}

// The one-time move from the legacy layout (SDKs up to 10.61:
// standardUserDefaults, REACTNATIVECN_PUSHY_* keys) into the state suite, by
// the shared core's plan (cpp/patch_core/stored_items.h). The puts end with
// the schema, so a process killed between two of them migrates again on its
// next launch (the core never overwrites what the suite already holds); the
// legacy keys are deleted only after every put. A write reaches cfprefsd
// before setObject:forKey: returns, so dying here loses nothing already put.
// Never throws: a failure leaves a fresh suite (as a new install) that still
// carries the install's uuid, and writes no schema, so the next launch tries
// again.
PUSHY_HIDDEN NSString *PushyMigrateStores(NSUserDefaults *state, NSUserDefaults *legacy) {
    @try {
        pushy::stored::Entries legacyItems;
        NSDictionary<NSString *, id> *legacyAll = [legacy dictionaryRepresentation];
        for (NSString *key in legacyAll) {
            // The host app shares that store: only our prefix is looked at.
            if ([key hasPrefix:legacyKeyPrefix]) {
                legacyItems.emplace_back(PushyToStdString(key), PushyDefaultsText(legacyAll[key]));
            }
        }
        pushy::stored::Entries currentItems;
        NSDictionary<NSString *, id> *currentAll = [state dictionaryRepresentation];
        for (NSString *key in currentAll) {
            currentItems.emplace_back(PushyToStdString(key), PushyDefaultsText(currentAll[key]));
        }
        pushy::stored::MigrationPlan plan = pushy::stored::MigrateStoredItems(
            pushy::stored::kLegacyIos, legacyItems, currentItems);
        if (!plan.valid) {
            [NSException raise:NSInternalInconsistencyException format:@"no migration plan"];
        }
        for (const auto &put : plan.puts) {
            [state setObject:PushyFromStdString(put.second) forKey:PushyFromStdString(put.first)];
        }
        for (const std::string &key : plan.removes) {
            [legacy removeObjectForKey:PushyFromStdString(key)];
        }
        return plan.migrated ? @"migrated" : @"current";
    } @catch (...) {
        NSLog(@"RCTPushy -- state store migration failed: %@",
              PushyCaughtReason(@"unknown exception"));
    }
    PushyGuard(@"uuid carry", ^{
        NSString *uuid = [legacy stringForKey:legacyKeyUuid];
        if (PushyReadString(state, keyUuid) == nil && uuid.length > 0) {
            [state setObject:uuid forKey:keyUuid];
        }
    });
    return @"fallback";
}

PUSHY_HIDDEN NSUserDefaults *PushyDefaults(void) {
    static NSUserDefaults *defaults;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        defaults = [[NSUserDefaults alloc] initWithSuiteName:PushyStateStoreName];
        // Before anything reads the suite; a no-op once done.
        NSString *migration = PushyMigrateStores(defaults, [NSUserDefaults standardUserDefaults]);
        if (![migration isEqualToString:@"current"]) {
            NSLog(@"RCTPushy -- state store migration: %@", migration);
        }
    });
    return defaults;
}

PUSHY_HIDDEN NSUserDefaults *PushyCacheDefaults(void) {
    static NSUserDefaults *defaults;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        defaults = [[NSUserDefaults alloc] initWithSuiteName:PushyCacheStoreName];
    });
    return defaults;
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

PUSHY_HIDDEN pushy::state::State PushyStateFromDefaults(NSUserDefaults *defaults) {
    pushy::state::State state;
    // <generated:read-state> (scripts/contract.ts; bun scripts/generate-contract.ts)
    state.package_version = PushyToStdString(PushyReadString(defaults, keyPackageVersion));
    state.build_time = PushyToStdString(PushyReadString(defaults, keyBuildTime));
    state.current_version = PushyToStdString(PushyReadString(defaults, keyCurrentVersion));
    state.last_version = PushyToStdString(PushyReadString(defaults, keyLastVersion));
    state.first_time = PushyReadBool(defaults, keyFirstTime, false);
    state.first_time_ok = PushyReadBool(defaults, keyFirstTimeOk, true);
    state.rolled_back_version = PushyToStdString(PushyReadString(defaults, keyRolledBackVersion));
    // </generated:read-state>
    return state;
}

PUSHY_HIDDEN void PushyApplyStateToDefaults(NSUserDefaults *defaults, const pushy::state::State &state) {
    // <generated:write-state> (scripts/contract.ts; bun scripts/generate-contract.ts)
    PushyWriteString(defaults, keyPackageVersion, PushyFromStdString(state.package_version));
    PushyWriteString(defaults, keyBuildTime, PushyFromStdString(state.build_time));
    PushyWriteString(defaults, keyCurrentVersion, PushyFromStdString(state.current_version));
    PushyWriteString(defaults, keyLastVersion, PushyFromStdString(state.last_version));
    PushyWriteBool(defaults, keyFirstTime, state.first_time);
    PushyWriteBool(defaults, keyFirstTimeOk, state.first_time_ok);
    PushyWriteString(defaults, keyRolledBackVersion, PushyFromStdString(state.rolled_back_version));
    // </generated:write-state>
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
    NSString *cached = PushyReadString(defaults, keyBundleHashCache);
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
