// Foundation-only host for the UNMODIFIED round adapter extracted at build time
// (RCTPushyOrchestrator runOnce / perform: / download: / commit: / finishRound:),
// run against the rounds in cpp/update_flow_core/tests/round-engine-vectors.json:
// the vector's commands stand in for the engine, and the IO those commands ask
// for is faked from the vector's next event. The adapter must answer each
// command with the event the vector expects, run each command with the
// arguments it carries, and map the finish to its result. Same idea as
// Harmony's src/__tests__/harmonySyncRound.test.ts and Android's
// SyncRoundReplayTest; see README.md.
#import <Foundation/Foundation.h>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>
#include "cpp/update_flow_core/flow_json.h"
#include "cpp/update_flow_core/round_engine.h"
#include "ios/RCTPushy/RCTPushyCommon.h"

static void TestLog(NSString *, ...) {}
#define RCTLogInfo TestLog
#define RCTLogWarn TestLog

// Pod-internal linkage (RCTPushyCommon.h); one translation unit here.
#undef PUSHY_HIDDEN
#define PUSHY_HIDDEN

// RCTPushyInternal.h's, which pulls in React Native.
typedef NS_ENUM(NSInteger, PushyType) {
    PushyTypeFullDownload = 1,
    PushyTypePatchFromPackage = 2,
    PushyTypePatchFromPpk = 3,
};

// The three accessors the round uses, over a dictionary (never a real
// preferences domain).
@interface TestDefaults : NSObject {
    NSMutableDictionary<NSString *, id> *_values;
}
- (void)setObject:(id)value forKey:(NSString *)key;
- (void)removeObjectForKey:(NSString *)key;
- (id)objectForKey:(NSString *)key;
- (NSString *)stringForKey:(NSString *)key;
@end

@implementation TestDefaults
- (instancetype)init {
    self = [super init];
    if (self) { _values = [NSMutableDictionary new]; }
    return self;
}
- (void)setObject:(id)value forKey:(NSString *)key { _values[key] = value; }
- (void)removeObjectForKey:(NSString *)key { [_values removeObjectForKey:key]; }
- (id)objectForKey:(NSString *)key { return _values[key]; }
- (NSString *)stringForKey:(NSString *)key {
    id value = _values[key];
    return [value isKindOfClass:NSString.class] ? value : nil;
}
@end

#define NSUserDefaults TestDefaults

#include "round_globals.inc"
NSDictionary *PushyHostResult(NSString *status, NSString *reason,
                              NSString *hash = nil, BOOL activated = NO);
#include "round_helpers.inc"

using flowjson::Value;

// The round being replayed: each step's event and the commands answering it.
static std::vector<Value> events, commandLists;
static size_t next;
static std::vector<Value> sent;
static std::vector<std::string> io, expectedIo;

// The event that answers the command being run: the vector's next one.
static const Value &Expected() {
    static const Value empty = Value::Object();
    return next < events.size() ? events[next] : empty;
}

// crashHold / forceActivate are sticky: they hold from the first event that
// carries them.
static bool Sticky(const char *flag, size_t upto) {
    for (size_t i = 0; i <= upto && i < events.size(); ++i) {
        if (events[i].Get(flag).Truthy()) {
            return true;
        }
    }
    return false;
}

static std::string Text(NSString *value) {
    return value == nil ? "nil" : std::string(value.UTF8String);
}

static std::string Num(double value) {
    char buffer[64];
    std::snprintf(buffer, sizeof buffer, "%.6f", value);
    return buffer;
}

// Key-order-independent text of a JSON object.
static std::string SortedJson(NSDictionary *object) {
    if (object == nil) {
        return "nil";
    }
    NSData *data = [NSJSONSerialization dataWithJSONObject:object
                                                   options:NSJSONWritingSortedKeys
                                                     error:nil];
    return std::string((const char *)data.bytes, data.length);
}

static TestDefaults *testDefaults;
static NSUserDefaults *PushyDefaults(void) { return testDefaults; }
// The vector's clock, in seconds like the system uptime.
PUSHY_HIDDEN NSTimeInterval PushyMonotonicNow(void) {
    return Expected().Get("now").AsNumber() / 1000;
}
static NSString *PushyOptionUrlKey(void) { return @"updateUrl"; }
static NSString *PushyVersionDir(NSString *hash) {
    return [@"/versions" stringByAppendingPathComponent:hash];
}
static BOOL PushyHasCompletedVersionAtPath(NSString *versionDir, NSString *hash) {
    io.push_back("installed " + Text(versionDir) + " " + Text(hash));
    return Expected().Get("installed").Truthy();
}
static NSString *PushyHttpRequest(NSString *url, NSString *method, NSString *body,
                                  NSTimeInterval timeout, NSTimeInterval callTimeout) {
    io.push_back("http " + Text(url) + " " + Text(method) + " " + Text(body) + " " +
                 Num(timeout) + " " + Num(callTimeout));
    const Value &text = Expected().Get("text");
    return text.IsString() ? @(text.AsString().c_str()) : nil;
}

@interface RCTPushyInstaller : NSObject
+ (void)fetch:(PushyType)type
      options:(NSDictionary *)options
     progress:(void (^)(long long received, long long total))progress
     callback:(void (^)(NSError *error))callback;
@end

@implementation RCTPushyInstaller
// Settles synchronously, or never: a timed-out attempt's clock already reads
// its deadline.
+ (void)fetch:(PushyType)type
      options:(NSDictionary *)options
     progress:(void (^)(long long received, long long total))progress
     callback:(void (^)(NSError *error))callback {
    io.push_back("download " + std::to_string((long)type) + " " +
                 Text(options[PushyOptionUrlKey()]) + " " + Text(options[@"hash"]) + " " +
                 Text(options[@"originHash"]) + " " +
                 Num([options[@"deadlineUptime"] doubleValue]));
    const Value &event = Expected();
    if (event.Get("timedOut").Truthy()) {
        return;
    }
    if (event.Get("ok").Truthy()) {
        callback(nil);
        return;
    }
    const Value &code = event.Get("code");
    callback([NSError errorWithDomain:@"test" code:1 userInfo:code.IsString()
        ? @{RCTPushyErrorCodeKey: @(code.AsString().c_str())} : @{}]);
}
@end

@interface RCTPushyOrchestrator : NSObject
+ (void)runOnce:(NSString *)launchRolledBackVersion deadline:(NSTimeInterval)deadlineUptime;
@end

@implementation RCTPushyOrchestrator
+ (flowjson::Value)launchEnv:(NSString *)launchRolledBackVersion {
    Value env = Value::Object();
    env.Set("packageVersion", Value::String("1.0.0"));
    return env;
}

// The commit's outcome as the vector reports it: a lost commit moved the
// generation it names, a failed one is the activation gate's verdict.
+ (BOOL)commitRoundWithGeneration:(uint64_t)generation
                 configGeneration:(uint64_t)configGeneration
                         hashInfo:(NSDictionary *)hashInfo
                         activate:(NSString *)hashToActivate
                            cache:(NSString *)cache
                        activated:(BOOL *)activatedOut
                      verifyError:(NSError **)verifyErrorOut {
    io.push_back("commit " + std::to_string(generation) + " " +
                 std::to_string(configGeneration) + " " + Text(hashInfo[@"hash"]) + " " +
                 SortedJson(hashInfo[@"info"]) + " " + Text(hashToActivate) + " " + Text(cache));
    const Value &event = Expected();
    *activatedOut = NO;
    if (event.Get("error").Truthy()) {
        *verifyErrorOut = [NSError errorWithDomain:@"test" code:1 userInfo:nil];
        return NO;
    }
    if (!event.Get("ok").Truthy()) {
        if (event.Get("reason").AsString() == "config_changed") {
            pushyNativeConfigGeneration.fetch_add(1);
        } else {
            pushyResetGeneration.fetch_add(1);
        }
        return NO;
    }
    const Value &activated = event.Get("activated");
    *activatedOut = activated.IsBool() ? activated.AsBool() : hashToActivate != nil;
    return YES;
}

#include "round.inc"
@end

// The scripted engine: the vector's next commands, whatever the state.
Value flowcore::StepRound(const Value &, const Value &event) {
    sent.push_back(event);
    Value result = Value::Object();
    result.Set("state", Value::Object());
    if (next >= commandLists.size()) {
        Value finish = Value::Object();
        finish.Set("type", Value::String("finish"));
        finish.Set("status", Value::String("failed"));
        finish.Set("reason", Value::String("unexpected_event"));
        Value commands = Value::Array();
        commands.Push(finish);
        result.Set("commands", commands);
        return result;
    }
    const Value &commands = commandLists[next];
    for (const Value &command : commands.elements()) {
        const std::string &type = command.Get("type").AsString();
        const auto text = [&command](const char *key) {
            const Value &value = command.Get(key);
            return value.IsString() && !value.AsString().empty() ? value.AsString()
                                                                 : std::string("nil");
        };
        if (type == "http") {
            const bool post = command.Get("post").Truthy();
            expectedIo.push_back("http " + text("url") + " " + (post ? "POST" : "GET") + " " +
                                 (post ? text("body") : "nil") + " " +
                                 Num(command.Get("timeoutMs").AsNumber() / 1000) + " " +
                                 Num(command.Get("callTimeoutMs").AsNumber() / 1000));
        } else if (type == "checkInstalled") {
            expectedIo.push_back("installed /versions/" + text("hash") + " " + text("hash"));
        } else if (type == "download") {
            const std::string &strategy = command.Get("strategy").AsString();
            expectedIo.push_back(
                "download " + std::string(strategy == "diff" ? "3" : strategy == "pdiff" ? "2" : "1") +
                " " + text("url") + " " + text("hash") + " " + text("originHash") + " " +
                Num(command.Get("deadline").AsNumber() / 1000));
        } else if (type == "commit") {
            const std::string hash = text("hash");
            NSDictionary *info = nil;
            if (hash != "nil") {
                NSData *data = [@(command.Get("hashInfo").AsString().c_str())
                    dataUsingEncoding:NSUTF8StringEncoding];
                info = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] ?: @{};
            }
            expectedIo.push_back(
                "commit " + std::to_string((uint64_t)command.Get("resetGeneration").AsNumber()) +
                " " + std::to_string((uint64_t)events[0].Get("configGeneration").AsNumber()) +
                " " + hash + " " + SortedJson(info) + " " +
                (command.Get("activate").Truthy() ? hash : "nil") + " " + text("cache"));
        }
    }
    result.Set("commands", commands);
    ++next;
    pushyCrashHoldActive.store(Sticky("crashHold", next));
    return result;
}

static std::string Show(const Value &value) {
    if (value.IsString()) {
        return value.AsString();
    }
    if (value.IsBool()) {
        return value.AsBool() ? "true" : "false";
    }
    if (value.IsNumber()) {
        return Num(value.AsNumber());
    }
    return flowjson::Stringify(value);
}

// What an adapter decides by itself, plus the clock it stamps (the host's
// clock reads the vector's). activated, crashHold and forceActivate are
// compared separately.
static std::map<std::string, std::string> Answer(const Value &event) {
    std::map<std::string, std::string> out;
    for (const char *key : {"type", "text", "installed", "ok", "code", "timedOut", "reason",
                            "error", "now"}) {
        if (!event.Get(key).IsUndefined()) {
            out[key] = Show(event.Get(key));
        }
    }
    const std::string &type = event.Get("type").AsString();
    // The engine reads ok as truthy and code as a string: absent is false
    // and "".
    if (type == "download" || type == "committed") {
        out["ok"] = event.Get("ok").Truthy() ? "true" : "false";
    }
    if (out.count("code") && out["code"].empty()) {
        out.erase("code");
    }
    return out;
}

static std::string Describe(const std::map<std::string, std::string> &answer) {
    std::string text = "{";
    for (const auto &entry : answer) {
        text += entry.first + "=" + entry.second + ", ";
    }
    return text + "}";
}

static Value WithFixtures(const Value &value, const Value &fixtures) {
    if (value.IsString() && !value.AsString().empty() && value.AsString()[0] == '@') {
        return fixtures.Get(value.AsString().substr(1));
    }
    if (value.IsArray()) {
        Value out = Value::Array();
        for (const Value &element : value.elements()) {
            out.Push(WithFixtures(element, fixtures));
        }
        return out;
    }
    if (value.IsObject()) {
        Value out = Value::Object();
        for (const auto &member : value.members()) {
            out.Set(member.first, WithFixtures(member.second, fixtures));
        }
        return out;
    }
    return value;
}

// Rounds that feed the engine protocol errors on purpose; everything else
// (crash hold, forceActivate, deadlines, timeouts) is iOS behaviour.
static bool Replayable(const std::string &name, const Value &steps) {
    if (name.find("internal_error") != std::string::npos) {
        return false;
    }
    for (size_t i = 0; i < steps.Size(); ++i) {
        if ((i == 0) != (steps.At(i).Get("event").Get("type").AsString() == "start")) {
            return false;
        }
    }
    return true;
}

static std::vector<std::string> failures;
static std::string roundName;
static void Expect(bool condition, const std::string &message) {
    if (!condition) {
        failures.push_back(roundName + ": " + message);
        std::fprintf(stderr, "[FAIL] %s: %s\n", roundName.c_str(), message.c_str());
    }
}

static void Replay(const Value &steps) {
    events.clear();
    commandLists.clear();
    sent.clear();
    io.clear();
    expectedIo.clear();
    next = 0;
    for (const Value &step : steps.elements()) {
        events.push_back(step.Get("event"));
        commandLists.push_back(step.Get("commands"));
    }
    const Value &start = events[0];
    testDefaults = [TestDefaults new];
    const std::string &config = start.Get("config").AsString();
    if (!config.empty()) {
        [testDefaults setObject:@(config.c_str()) forKey:keyNativeConfig];
    }
    pushyResetGeneration.store((uint64_t)start.Get("resetGeneration").AsNumber());
    pushyNativeConfigGeneration.store((uint64_t)start.Get("configGeneration").AsNumber());
    pushyCrashHoldActive.store(Sticky("crashHold", 0));
    pushyPurgeRestoreActive.store(start.Get("forceActivate").Truthy());
    pushyUnactivatedHash = nil;
    pushyHostRoundResult = nil;

    [RCTPushyOrchestrator runOnce:nil deadline:start.Get("deadline").AsNumber() / 1000];

    Expect(sent.size() == events.size(), "the adapter sent " + std::to_string(sent.size()) +
           " events, the vector has " + std::to_string(events.size()));
    bool activate = false;
    for (size_t i = 0; i < events.size() && i < sent.size(); ++i) {
        const std::string at = "event " + std::to_string(i);
        const auto expected = Answer(events[i]);
        const auto actual = Answer(sent[i]);
        Expect(expected == actual, at + ": expected " + Describe(expected) + " but was " +
               Describe(actual));
        for (const char *flag : {"crashHold", "forceActivate"}) {
            Expect(sent[i].Get(flag).Truthy() == Sticky(flag, i), at + ": " + flag);
        }
        // A landed commit reports what it really activated; absent in the
        // vector means as asked.
        if (events[i].Get("type").AsString() == "committed" && events[i].Get("ok").Truthy()) {
            const Value &activated = events[i].Get("activated");
            Expect(sent[i].Get("activated").Truthy() ==
                   (activated.IsBool() ? activated.AsBool() : activate), at + ": activated");
        }
        for (const Value &command : commandLists[i].elements()) {
            if (command.Get("type").AsString() == "commit") {
                activate = command.Get("activate").Truthy();
            }
        }
    }
    // Each command ran with the arguments it carried.
    Expect(io == expectedIo, "IO differs from the commands");
    for (size_t i = 0; i < io.size() || i < expectedIo.size(); ++i) {
        const std::string a = i < io.size() ? io[i] : "(none)";
        const std::string e = i < expectedIo.size() ? expectedIo[i] : "(none)";
        if (a != e) {
            std::fprintf(stderr, "  io %zu\n    expected %s\n    actual   %s\n", i, e.c_str(), a.c_str());
            break;
        }
    }

    // The start carries the round's facts as the adapter sampled them.
    if (!sent.empty()) {
        const Value &sentStart = sent[0];
        Expect(sentStart.Get("config").AsString() == config, "start config");
        for (const char *key : {"resetGeneration", "configGeneration", "deadline"}) {
            Expect(Show(sentStart.Get(key)) == Show(start.Get(key)), std::string("start ") + key);
        }
        const double sample = sentStart.Get("sample").AsNumber();
        Expect(sample >= 0 && sample < 1, "start sample");
    }

    Value finish;
    for (const Value &command : commandLists.back().elements()) {
        if (command.Get("type").AsString() == "finish") {
            finish = command;
        }
    }
    Expect(finish.IsObject(), "the round never finishes");
    const std::string &status = finish.Get("status").AsString();
    const bool downloaded = status == "downloaded";
    NSString *hash = downloaded ? @(finish.Get("hash").AsString().c_str()) : nil;
    const bool activated = downloaded && finish.Get("activated").Truthy();
    NSDictionary *expected = PushyHostResult(@(status.c_str()),
        @(finish.Get("reason").AsString().c_str()), hash, activated);
    Expect([pushyHostRoundResult isEqual:expected],
           "result " + Text(pushyHostRoundResult.description) + " instead of " +
           Text(expected.description));
    // Left for JS, it is the version a later crash hold activates.
    Expect(downloaded && !activated ? [pushyUnactivatedHash isEqualToString:hash]
                                    : pushyUnactivatedHash == nil, "unactivated hash");
    // However the round ends, the breadcrumb does not survive it.
    Expect([testDefaults objectForKey:keyNativeCheckIncomplete] == nil, "breadcrumb survived");
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc < 2) {
            std::fprintf(stderr, "usage: %s round-engine-vectors.json [round name]\n", argv[0]);
            return 2;
        }
        std::ifstream file(argv[1]);
        std::stringstream text;
        text << file.rdbuf();
        bool ok = false;
        const Value vectors = flowjson::Parse(text.str(), &ok);
        if (!ok) {
            std::fprintf(stderr, "[FAIL] cannot parse %s\n", argv[1]);
            return 1;
        }
        const Value &fixtures = vectors.Get("fixtures");
        int replayed = 0;
        for (const Value &round : vectors.Get("rounds").elements()) {
            roundName = round.Get("name").AsString();
            const Value steps = WithFixtures(round.Get("steps"), fixtures);
            if (!Replayable(roundName, steps) || (argc > 2 && roundName != argv[2])) {
                continue;
            }
            Replay(steps);
            ++replayed;
        }
        roundName = "round replay";
        Expect(replayed >= (argc > 2 ? 1 : 30),
               "only " + std::to_string(replayed) + " rounds replayed");
        if (!failures.empty()) {
            return 1;
        }
        std::printf("[PASS] round replay: %d rounds\n", replayed);
    }
    return 0;
}
