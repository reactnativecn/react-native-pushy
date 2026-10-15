#include "round_engine.h"

#include <cmath>
#include <utility>

#include "../patch_core/obscured_text.h"
#include "native_config.h"
#include "native_round.h"
#include "update_flow_core.h"

namespace flowcore {

using flowjson::Value;

namespace {

// Stored encoded (see obscured_text.h): the result status of a round that
// found nothing to install, and the version-info flag of a version a crash
// hold installed (read by JS).
const std::string& StatusNone() {
  static const std::string value = pushy::text::Reveal("3418c1c1aa8a7c40");
  return value;
}
const std::string& InfoCrashHold() {
  static const std::string value =
      pushy::text::Reveal("3905f5c2a6b96d56212a19");
  return value;
}

// Phases: what the round waits for.
const char kAwaitEnv[] = "env";
const char kAwaitHttp[] = "http";
const char kAwaitInstalled[] = "installed";
const char kAwaitDownload[] = "download";
const char kAwaitCommit[] = "committed";
const char kDone[] = "done";

double Number(const Value& value) {
  const double number = value.AsNumber();
  return value.IsNumber() && std::isfinite(number) ? number : 0;
}

// A non-negative integral cursor; anything else reads as 0.
size_t Index(const Value& value) {
  const double number = Number(value);
  return number < 0 ? 0 : number >= 1e15 ? static_cast<size_t>(1e15)
                                         : static_cast<size_t>(number);
}

Value Command(const char* type) {
  Value command = Value::Object();
  command.Set("type", Value::String(type));
  return command;
}

bool IsIncremental(const std::string& strategy) {
  return strategy == "diff" || strategy == "pdiff";
}

// One step in progress: the state being built and the commands emitted.
class Step {
 public:
  Step(Value state, const Value& event) : state_(std::move(state)), event_(event) {
    now_ = Number(event.Get("now"));
    const std::string type = event.Get("type").AsString();
    if (type == "start" || !state_.IsObject()) {
      // A start begins a new round whatever came before; any other event
      // without a round finds no phase that expects it.
      state_ = Value::Object();
    }
    // Once a crash is held or the launch waits on the round, it stays so.
    for (const char* flag : {"crashHold", "forceActivate"}) {
      if (event.Get(flag).Truthy()) {
        state_.Set(flag, Value::Bool(true));
      }
    }
  }

  Value Run() {
    const std::string type = event_.Get("type").AsString();
    if (type == "start") {
      Start();
    } else if (Phase() == kDone) {
      // A finished round ignores late events.
      return Result();
    } else if (type != Phase()) {
      Finish("failed", "internal_error");
    } else if (type == kAwaitEnv) {
      OnEnv();
    } else if (type == kAwaitHttp) {
      OnHttp();
    } else if (type == kAwaitInstalled) {
      OnInstalled();
    } else if (type == kAwaitDownload) {
      OnDownload();
    } else {
      OnCommitted();
    }
    return Result();
  }

 private:
  std::string Phase() const { return state_.Get("phase").AsString(); }
  void Await(const char* phase) { state_.Set("phase", Value::String(phase)); }
  void Emit(Value command) { commands_.Push(std::move(command)); }

  Value Result() {
    Value result = Value::Object();
    result.Set("state", std::move(state_));
    result.Set("commands", std::move(commands_));
    return result;
  }

  void Finish(const std::string& status, const std::string& reason,
              const Value& hash = Value::Undefined(),
              const Value& activated = Value::Undefined()) {
    Value finish = Command("finish");
    finish.Set("status", Value::String(status));
    finish.Set("reason", Value::String(reason));
    finish.Set("hash", hash);
    finish.Set("activated", activated);
    Emit(std::move(finish));
    Await(kDone);
  }

  // What the remaining round budget allows for a bound of `limit` ms;
  // `limit` itself without a deadline.
  double Within(double limit) const {
    const double deadline = Number(state_.Get("deadline"));
    return deadline > 0 ? std::fmin(limit, deadline - now_) : limit;
  }

  // A deadline `span` ms from now, capped by the round's.
  double DeadlineIn(double span) const {
    const double deadline = Number(state_.Get("deadline"));
    return deadline > 0 ? std::fmin(now_ + span, deadline) : now_ + span;
  }

  void Start() {
    const Value& config = event_.Get("config");
    state_.Set("config", config.IsString() ? config : Value::String(""));
    for (const char* key :
         {"resetGeneration", "configGeneration", "sample", "deadline"}) {
      state_.Set(key, Value::Number(Number(event_.Get(key))));
    }
    const RunnableConfig gate =
        ParseRunnableConfig(state_.Get("config").AsString());
    if (!gate.runnable()) {
      // Not a round: nothing ran, so nothing to mark.
      Finish(gate.status, gate.reason);
      return;
    }
    Emit(Command("markIncomplete"));
    Emit(Command("collectEnv"));
    Await(kAwaitEnv);
  }

  void OnEnv() {
    const Value& env = event_.Get("env");
    Value round = PrepareRound(state_.Get("config").AsString(), env,
                               Number(state_.Get("sample")));
    if (!round.IsObject()) {
      Finish("failed", "invalid_request");
      return;
    }
    state_.Set("env", env);
    state_.Set("body", round.Get("body"));
    state_.Set("query", round.Get("query"));
    Query(Value::Undefined());
  }

  // Asks the next endpoint, or settles the query on `text`.
  void Query(const Value& text) {
    Value query = NextQueryStep(state_.Get("query"), text);
    if (query.Get("found").Truthy()) {
      state_.Remove("query");
      Respond(text.AsString());
      return;
    }
    const Value& url = query.Get("url");
    const double timeout = Within(kQueryIdleTimeoutMs);
    if (!url.IsString() || timeout <= 0) {
      // No endpoint answered (or the budget is gone): nothing to commit.
      Finish("failed", "check_failed");
      return;
    }
    Value http = Command("http");
    http.Set("url", url);
    const bool post = query.Get("post").Truthy();
    http.Set("post", Value::Bool(post));
    if (post) {
      http.Set("body", state_.Get("body"));
    }
    http.Set("timeoutMs", Value::Number(timeout));
    http.Set("callTimeoutMs", Value::Number(Within(kQueryCallTimeoutMs)));
    Emit(std::move(http));
    state_.Set("query", std::move(query));
    Await(kAwaitHttp);
  }

  void OnHttp() {
    const Value& text = event_.Get("text");
    state_.Set("at", Value::Number(std::floor(Number(event_.Get("at")))));
    Query(text.IsString() ? text : Value::Undefined());
  }

  void Respond(const std::string& text) {
    Value decision = HandleRoundResponse(
        text, state_.Get("config").AsString(), state_.Get("env"),
        state_.Get("body").AsString(), Number(state_.Get("at")));
    state_.Remove("at");
    if (!decision.IsObject()) {
      Finish("failed", "invalid_response");
      return;
    }
    state_.Set("cache", decision.Get("cache"));
    if (decision.Get("action").AsString() != "download") {
      CommitCache(StatusNone(), decision.Get("reason").AsString());
      return;
    }
    const Value hash = decision.Get("hash");
    if (!hash.IsString() || !IsSafePathComponent(hash.AsString())) {
      Finish("failed", "invalid_response");
      return;
    }
    decision.Remove("action");
    decision.Remove("cache");
    state_.Set("decision", std::move(decision));
    Value check = Command("checkInstalled");
    check.Set("hash", hash);
    Emit(std::move(check));
    Await(kAwaitInstalled);
  }

  void OnInstalled() {
    if (event_.Get("installed").Truthy()) {
      CommitVersion();
      return;
    }
    Value cursor = Value::Object();
    cursor.Set("attempt", Value::Number(0));
    cursor.Set("url", Value::Number(0));
    cursor.Set("incremental", Value::Number(DeadlineIn(kDownloadPhaseMs)));
    cursor.Set("full", Value::Number(0));
    state_.Set("cursor", std::move(cursor));
    NextAttempt();
  }

  // Strategies in the planned order (diff, pdiff, full), each over its
  // mirrors, starting at the cursor.
  void NextAttempt() {
    Value cursor = state_.Get("cursor");
    const Value& attempts = state_.Get("decision").Get("attempts");
    size_t attempt = Index(cursor.Get("attempt"));
    size_t url = Index(cursor.Get("url"));
    for (; attempt < attempts.Size(); attempt++, url = 0) {
      const Value& planned = attempts.At(attempt);
      const std::string strategy = planned.Get("type").AsString();
      const bool full = !IsIncremental(strategy);
      if (full && Number(cursor.Get("full")) == 0) {
        cursor.Set("full", Value::Number(DeadlineIn(kDownloadPhaseMs)));
      }
      const double deadline =
          Number(cursor.Get(full ? "full" : "incremental"));
      const Value& urls = planned.Get("urls");
      if (url >= urls.Size()) {
        continue;
      }
      // Never start an attempt whose phase budget is gone: it would outlive
      // the round. The full phase is the last one.
      if (deadline - now_ <= 0) {
        if (full) {
          break;
        }
        continue;
      }
      Value download = Command("download");
      download.Set("strategy", Value::String(full ? "full" : strategy));
      download.Set("url", urls.At(url));
      download.Set("hash", state_.Get("decision").Get("hash"));
      if (strategy == "diff") {
        download.Set("originHash", state_.Get("env").Get("currentVersion"));
      }
      download.Set("deadline", Value::Number(deadline));
      Emit(std::move(download));
      cursor.Set("attempt", Value::Number(static_cast<double>(attempt)));
      cursor.Set("url", Value::Number(static_cast<double>(url)));
      state_.Set("cursor", std::move(cursor));
      Await(kAwaitDownload);
      return;
    }
    state_.Remove("cursor");
    // The native attempt is over, so JS may reuse the response and retry
    // through its own strategy chain.
    CommitCache("failed", "download_failed");
  }

  void OnDownload() {
    if (event_.Get("ok").Truthy()) {
      state_.Remove("cursor");
      CommitVersion();
      return;
    }
    Value cursor = state_.Get("cursor");
    const size_t attempt = Index(cursor.Get("attempt"));
    const std::string strategy = state_.Get("decision")
                                     .Get("attempts")
                                     .At(attempt)
                                     .Get("type")
                                     .AsString();
    const bool nextStrategy =
        event_.Get("timedOut").Truthy() ||
        // The bytes arrived but could not be applied: every mirror serves
        // the same artifact, so only the next strategy can help.
        !IsMirrorRetryableCode(event_.Get("code").AsString());
    if (event_.Get("timedOut").Truthy() && !IsIncremental(strategy)) {
      // The full phase timed out: no budget is left for anything.
      cursor.Set("attempt", Value::Number(1e15));
    } else if (nextStrategy) {
      cursor.Set("attempt", Value::Number(static_cast<double>(attempt + 1)));
      cursor.Set("url", Value::Number(0));
    } else {
      cursor.Set("url", Value::Number(Number(cursor.Get("url")) + 1));
    }
    state_.Set("cursor", std::move(cursor));
    NextAttempt();
  }

  // Only the response cache: nothing to install or activate.
  void CommitCache(const std::string& status, const std::string& reason) {
    Value result = Value::Object();
    result.Set("status", Value::String(status));
    result.Set("reason", Value::String(reason));
    Commit("", "", false, std::move(result));
  }

  // The version info, the activation and the response cache in one commit.
  void CommitVersion() {
    const Value& decision = state_.Get("decision");
    const bool crashHold = state_.Get("crashHold").Truthy();
    Value hashInfo = decision.Get("hashInfo");
    if (crashHold) {
      hashInfo.Set(InfoCrashHold(), Value::Bool(true));
    }
    // Silent strategies or a server-marked forceBoot version activate for
    // the next launch; otherwise activation stays with JS — unless JS is
    // dead (a crash hold) or the launch itself waits on this round.
    const bool activate = decision.Get("activate").Truthy() || crashHold ||
                          state_.Get("forceActivate").Truthy();
    const std::string hash = decision.Get("hash").AsString();
    Value result = Value::Object();
    result.Set("status", Value::String("downloaded"));
    result.Set("reason", Value::String(""));
    result.Set("hash", Value::String(hash));
    result.Set("activated", Value::Bool(activate));
    Commit(hash, flowjson::Stringify(hashInfo), activate, std::move(result));
  }

  void Commit(const std::string& hash, const std::string& hashInfo,
              bool activate, Value result) {
    Value commit = Command("commit");
    commit.Set("hash", Value::String(hash));
    commit.Set("hashInfo", Value::String(hashInfo));
    commit.Set("activate", Value::Bool(activate));
    commit.Set("cache", state_.Get("cache"));
    commit.Set("resetGeneration", state_.Get("resetGeneration"));
    commit.Set("configGeneration", state_.Get("configGeneration"));
    Emit(std::move(commit));
    state_.Set("result", std::move(result));
    Await(kAwaitCommit);
  }

  void OnCommitted() {
    const Value result = state_.Get("result");
    if (event_.Get("error").Truthy()) {
      Finish("failed", "commit_failed");
    } else if (!event_.Get("ok").Truthy()) {
      Finish("cancelled", "reset");
    } else if (result.Get("hash").IsString()) {
      const Value& activated = event_.Get("activated");
      Finish(result.Get("status").AsString(), result.Get("reason").AsString(),
             result.Get("hash"),
             activated.IsBool() ? activated : result.Get("activated"));
    } else {
      Finish(result.Get("status").AsString(), result.Get("reason").AsString());
    }
  }

  Value state_;
  const Value& event_;
  double now_ = 0;
  Value commands_ = Value::Array();
};

}  // namespace

bool IsSafePathComponent(const std::string& name) {
  return !name.empty() && name != "." && name != ".." &&
         name.find_first_of(std::string("/\\\0", 3)) == std::string::npos;
}

Value StepRound(const Value& state, const Value& event) {
  return Step(state, event).Run();
}

std::string StepRoundJson(const std::string& stateJson,
                          const std::string& eventJson) {
  // The state carries server text (the response cache, the planned URLs) and
  // the event a whole response body, so the byte cap is the platform's
  // response cap's business; the node cap still bounds the heap.
  flowjson::ParseLimits limits;
  limits.max_input_bytes = 256 * 1024 * 1024;
  limits.max_nodes = 4 * flowjson::kMaxNodes;
  bool stateOk = true;
  bool eventOk = false;
  const Value state =
      stateJson.empty() ? Value::Undefined()
                        : flowjson::Parse(stateJson, limits, &stateOk);
  const Value event = flowjson::Parse(eventJson, limits, &eventOk);
  if (!stateOk || !eventOk || !event.IsObject()) {
    Value finish = Value::Object();
    finish.Set("type", Value::String("finish"));
    finish.Set("status", Value::String("failed"));
    finish.Set("reason", Value::String("internal_error"));
    Value commands = Value::Array();
    commands.Push(std::move(finish));
    Value done = Value::Object();
    done.Set("phase", Value::String(kDone));
    Value result = Value::Object();
    result.Set("state", std::move(done));
    result.Set("commands", std::move(commands));
    return flowjson::Stringify(result);
  }
  return flowjson::Stringify(StepRound(state, event));
}

std::string HostCancellation(const std::string& hostConfig,
                             const std::string& roundConfig,
                             const std::string& storedConfig,
                             double roundConfigGeneration,
                             double configGeneration,
                             double roundResetGeneration,
                             double resetGeneration) {
  if (roundConfigGeneration != configGeneration ||
      !ConfigsEquivalent(hostConfig, roundConfig) ||
      !ConfigsEquivalent(hostConfig, storedConfig)) {
    return "config_changed";
  }
  if (roundResetGeneration != resetGeneration) {
    return "reset";
  }
  return "";
}

}  // namespace flowcore
