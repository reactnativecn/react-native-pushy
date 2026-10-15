// libFuzzer harness for the JSON parser and the decision pipeline built on it
// — both consume raw server bytes. Build and run with
//   FUZZ=1 ./scripts/test-update-flow-core.sh
// (clang -fsanitize=fuzzer,address,undefined). Any crash, sanitizer report or
// abort() below is a finding.
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <string>

#include "../flow_json.h"
#include "../native_config.h"
#include "../native_round.h"
#include "../round_engine.h"
#include "../update_flow_core.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  const std::string text(reinterpret_cast<const char*>(data), size);

  bool ok = false;
  const flowjson::Value parsed = flowjson::Parse(text, &ok);
  if (ok) {
    // Whatever parses must stringify to something that parses again: the
    // canonical serialization is what every vector comparison relies on.
    // Stringify can legitimately emit more bytes than it consumed (raw
    // control bytes become \u00xx, "1e308" prints through %.17g), so a
    // serialization that crosses the parser's input cap is not a finding —
    // only a rejection of text within the cap is.
    const std::string again = flowjson::Stringify(parsed);
    if (again.size() <= flowjson::kMaxInputBytes) {
      bool ok_again = false;
      flowjson::Parse(again, &ok_again);
      if (!ok_again) {
        std::abort();
      }
    }
  }

  flowjson::Value identity = flowjson::Value::Object();
  identity.Set("packageVersion", flowjson::Value::String("2.3.4"));
  identity.Set("currentVersion", flowjson::Value::String("cur"));
  identity.Set("uuid", flowjson::Value::String("test1"));
  identity.Set("rolledBackVersion", flowjson::Value::String("bad"));
  flowjson::Stringify(
      flowcore::HandleResponse(text, identity, false, "none"));
  flowcore::IsValidResponse(text);

  // The round: the text as the persisted config, as a response and as a
  // remote endpoint list. Every query walk must end within its request cap.
  flowjson::Value env = flowjson::Value::Object();
  env.Set("packageVersion", flowjson::Value::String("2.3.4"));
  env.Set("currentVersion", flowjson::Value::String("cur"));
  env.Set("os", flowjson::Value::String("fuzz 1"));
  const flowjson::Value round = flowcore::PrepareRound(text, env, 0.5);
  flowjson::Value state = round.Get("query");
  for (int step = 0; state.IsObject(); step++) {
    if (step > 2 * flowcore::kMaxQueryRequests + 2) {
      std::abort();
    }
    state = flowcore::NextQueryStep(state, flowjson::Value::String(text));
    if (state.Get("found").Truthy() || !state.Get("url").IsString()) {
      break;
    }
  }
  flowjson::Stringify(flowcore::HandleRoundResponse(
      text, "{\"appKey\":\"k\",\"endpoints\":[\"https://a\"]}", env, "{}", 1));
  flowjson::Stringify(
      flowcore::HandleRoundResponse("{\"upToDate\":true}", text, env, text, 1));

  // The round driver: the text as the response every endpoint returns, then
  // as the binding's event and state. Every round must finish: one step per
  // request, planned mirror (bounded by the response's node cap) and commit.
  flowjson::Value engine;
  flowjson::Value event = flowjson::Value::Object();
  event.Set("type", flowjson::Value::String("start"));
  event.Set("config", flowjson::Value::String(
                          "{\"appKey\":\"k\",\"endpoints\":[\"https://a\"]}"));
  for (int step = 0;; step++) {
    if (step > 4 * static_cast<int>(flowjson::kMaxNodes)) {
      std::abort();
    }
    const flowjson::Value result = flowcore::StepRound(engine, event);
    engine = result.Get("state");
    if (engine.Get("phase").AsString() == "done") {
      break;
    }
    const std::string type = result.Get("commands")
                                 .At(result.Get("commands").Size() - 1)
                                 .Get("type")
                                 .AsString();
    event = flowjson::Value::Object();
    if (type == "collectEnv") {
      event.Set("type", flowjson::Value::String("env"));
      event.Set("env", env);
    } else if (type == "http") {
      event.Set("type", flowjson::Value::String("http"));
      event.Set("text", flowjson::Value::String(text));
    } else if (type == "checkInstalled") {
      event.Set("type", flowjson::Value::String("installed"));
    } else if (type == "download") {
      event.Set("type", flowjson::Value::String("download"));
      event.Set("code", flowjson::Value::String("DOWNLOAD_FAILED"));
    } else {
      event.Set("type", flowjson::Value::String("committed"));
      event.Set("ok", flowjson::Value::Bool(true));
    }
  }
  flowcore::StepRoundJson(text, "{\"type\":\"committed\",\"ok\":true}");
  flowcore::StepRoundJson("", text);

  // The persisted-config layer reads host/JS-written text: equivalence must
  // be reflexive for every object, and a normalized config must be runnable
  // (or disabled) and stable under its own normalization.
  flowcore::RunnableConfigJson(text);
  if (flowcore::CanonicalNativeConfig(text).IsObject() &&
      !flowcore::ConfigsEquivalent(text, text)) {
    std::abort();
  }
  std::string normalized;
  std::string error;
  if (flowcore::NormalizeConfiguration(text, &normalized, &error)) {
    const flowcore::RunnableConfig gate =
        flowcore::ParseRunnableConfig(normalized);
    std::string again;
    if (!(gate.runnable() || gate.reason == "disabled") ||
        !flowcore::NormalizeConfiguration(normalized, &again, &error) ||
        again != normalized) {
      std::abort();
    }
  }
  return 0;
}
