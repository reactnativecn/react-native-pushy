#include "native_round.h"

#include <cmath>
#include <utility>

#include "../patch_core/hbc_transform_wire.h"
#include "../patch_core/native_texts.h"
#include "native_config.h"
#include "update_flow_core.h"

namespace flowcore {

using flowjson::Value;

namespace {

// Stored encoded (native_texts.h).
using pushy::texts::InfoForceBoot;
using pushy::texts::QueryPath;

// The lists NextQueryStep walks, in order; the state's "list" names the
// current one ("" once the query is over).
const char kEndpoints[] = "endpoints";
const char kQueryUrls[] = "queryUrls";
const char kRemote[] = "remote";

bool HasPrefixIgnoringAsciiCase(const std::string& text, const char* prefix) {
  size_t i = 0;
  for (; prefix[i] != '\0'; i++) {
    if (i >= text.size()) {
      return false;
    }
    char c = text[i];
    if (c >= 'A' && c <= 'Z') {
      c = static_cast<char>(c - 'A' + 'a');
    }
    if (c != prefix[i]) {
      return false;
    }
  }
  return true;
}

bool IsHttpsUrl(const std::string& url) {
  return HasPrefixIgnoringAsciiCase(url, "https://");
}

bool IsCleartextUrl(const std::string& url) {
  return HasPrefixIgnoringAsciiCase(url, "http://");
}

std::string StripTrailingSlashes(std::string url) {
  while (!url.empty() && url.back() == '/') {
    url.pop_back();
  }
  return url;
}

Value StringOr(const Value& value, const char* fallback) {
  return value.IsString() ? value : Value::String(fallback);
}

// A non-negative integral state counter; anything else reads as 0. Capped
// well inside a 32-bit size_t (armeabi-v7a, x86): converting a double beyond
// the target's range is undefined.
size_t Counter(const Value& value) {
  const double number = value.AsNumber();
  if (!value.IsNumber() || !std::isfinite(number) || number < 0) {
    return 0;
  }
  return number >= 1e9 ? static_cast<size_t>(1e9)
                       : static_cast<size_t>(number);
}

// { packageVersion, currentVersion, uuid, rolledBackVersion } — what
// HandleResponse keys its decision on.
Value Identity(const Value& config, const Value& env) {
  const Value& configured = config.Get("packageVersion");
  Value identity = Value::Object();
  identity.Set("packageVersion",
               configured.IsString() && !configured.AsString().empty()
                   ? configured
                   : env.Get("packageVersion"));
  identity.Set("currentVersion", env.Get("currentVersion"));
  identity.Set("uuid", StringOr(env.Get("uuid"), ""));
  identity.Set("rolledBackVersion", env.Get("rolledBackVersion"));
  return identity;
}

std::string RequestBody(const Value& config, const Value& env) {
  const Value identity = Identity(config, env);
  Value cInfo = Value::Object();
  cInfo.Set("rnu", StringOr(config.Get("rnu"), ""));
  cInfo.Set("rn", StringOr(config.Get("rn"), ""));
  cInfo.Set("os", env.Get("os"));
  cInfo.Set("uuid", identity.Get("uuid"));
  Value input = Value::Object();
  input.Set("packageVersion", identity.Get("packageVersion"));
  input.Set("currentVersion", env.Get("currentVersion"));
  input.Set("buildTime", env.Get("buildTime"));
  input.Set("cInfo", std::move(cInfo));
  input.Set("supportedDiffVersion",
            Value::Number(pushy::hbc::kSupportedDiffVersion));
  input.Set("bundleHash", env.Get("bundleHash"));
  return flowjson::Stringify(BuildRequestBody(input));
}

bool Contains(const Value& list, const std::string& text) {
  for (const Value& entry : list.elements()) {
    if (entry.AsString() == text) {
      return true;
    }
  }
  return false;
}

Value PlanAttempts(const Value& attempts, bool hasOrigin, bool httpsOnly) {
  Value planned = Value::Array();
  for (const Value& attempt : attempts.elements()) {
    // diff patches the running version; with none running it cannot apply.
    if (attempt.Get("type").AsString() == "diff" && !hasOrigin) {
      continue;
    }
    Value urls = Value::Array();
    for (const Value& url : attempt.Get("urls").elements()) {
      if (url.IsString() && !url.AsString().empty() &&
          !(httpsOnly && IsCleartextUrl(url.AsString()))) {
        urls.Push(url);
      }
    }
    if (urls.Size() > 0) {
      Value kept = Value::Object();
      kept.Set("type", attempt.Get("type"));
      kept.Set("urls", std::move(urls));
      planned.Push(std::move(kept));
    }
  }
  return planned;
}

Value VersionInfo(const Value& info) {
  Value hashInfo = Value::Object();
  for (const char* key : {"name", "description", "metaInfo"}) {
    if (info.Get(key).IsString()) {
      hashInfo.Set(key, info.Get(key));
    }
  }
  // A forceBoot activation is the brick-rescue path: JS reports it once
  // this version survives to markSuccess. Only the server's directive counts
  // — a silent-strategy activation is ordinary delivery.
  if (info.Get("config").Get("forceBoot").Truthy()) {
    hashInfo.Set(InfoForceBoot(), Value::Bool(true));
  }
  return hashInfo;
}

}  // namespace

bool IsHttpsOnly(const Value& endpoints) {
  if (endpoints.elements().empty()) {
    return false;
  }
  for (const Value& endpoint : endpoints.elements()) {
    if (!endpoint.IsString() || !IsHttpsUrl(endpoint.AsString())) {
      return false;
    }
  }
  return true;
}

Value PrepareRound(const std::string& configJson, const Value& env,
                   double randomSample) {
  RunnableConfig gate = ParseRunnableConfig(configJson);
  if (!gate.runnable() || !env.IsObject()) {
    return Value::Undefined();
  }
  const Value& config = gate.config;
  const Value& queryUrls = config.Get(kQueryUrls);
  Value query = Value::Object();
  query.Set("appKey", Value::String(gate.appKey));
  query.Set("httpsOnly", Value::Bool(IsHttpsOnly(config.Get(kEndpoints))));
  query.Set(kEndpoints,
            OrderEndpointCandidates(config.Get(kEndpoints), randomSample));
  query.Set(kQueryUrls, queryUrls.IsArray() ? queryUrls : Value::Array());
  query.Set("list", Value::String(kEndpoints));
  query.Set("next", Value::Number(0));
  query.Set("tried", Value::Array());
  query.Set("spent", Value::Number(0));

  Value round = Value::Object();
  round.Set("body", Value::String(RequestBody(config, env)));
  round.Set("query", std::move(query));
  return round;
}

Value NextQueryStep(const Value& previous, const Value& responseText) {
  if (!previous.IsObject()) {
    return Value::Undefined();
  }
  Value state = previous;
  if (state.Get("url").IsString()) {
    const bool post = state.Get("post").Truthy();
    state.Remove("url");
    state.Remove("post");
    if (responseText.IsString()) {
      if (post && IsValidResponse(responseText.AsString())) {
        state.Set("found", Value::Bool(true));
      } else if (!post) {
        bool ok = false;
        Value remote = flowjson::Parse(responseText.AsString(), &ok);
        if (ok && remote.IsArray()) {
          state.Set("list", Value::String(kRemote));
          state.Set(kRemote, std::move(remote));
          state.Set("next", Value::Number(0));
        }
      }
    }
  }
  if (state.Get("found").Truthy()) {
    return state;
  }
  const bool httpsOnly = state.Get("httpsOnly").Truthy();
  for (;;) {
    const std::string list = state.Get("list").AsString();
    if (list != kEndpoints && list != kQueryUrls && list != kRemote) {
      state.Set("list", Value::String(""));
      return state;
    }
    const bool isListOfLists = list == kQueryUrls;
    const Value& entries = state.Get(list);
    size_t next = Counter(state.Get("next"));
    std::string target;
    while (target.empty() && next < entries.Size()) {
      const Value& entry = entries.At(next++);
      if (!entry.IsString()) {
        continue;
      }
      if (isListOfLists) {
        target = entry.AsString();
        continue;
      }
      std::string base = StripTrailingSlashes(entry.AsString());
      if (base.empty() || Contains(state.Get("tried"), base)) {
        continue;
      }
      // A remotely injected endpoint must not downgrade an https
      // configuration to plaintext.
      if (list == kRemote && httpsOnly && !IsHttpsUrl(base)) {
        continue;
      }
      target = std::move(base);
    }
    state.Set("next", Value::Number(static_cast<double>(next)));
    if (target.empty()) {
      // The configured endpoints are followed by the list discovery; a
      // fetched remote list (or running out of lists) ends the query.
      state.Set("list", Value::String(list == kEndpoints ? kQueryUrls : ""));
      state.Set("next", Value::Number(0));
      continue;
    }
    const size_t spent = Counter(state.Get("spent"));
    if (spent >= static_cast<size_t>(kMaxQueryRequests)) {
      state.Set("list", Value::String(""));
      return state;
    }
    state.Set("spent", Value::Number(static_cast<double>(spent + 1)));
    if (isListOfLists) {
      state.Set("url", Value::String(target));
      state.Set("post", Value::Bool(false));
    } else {
      Value tried = state.Get("tried").IsArray() ? state.Get("tried")
                                                 : Value::Array();
      tried.Push(Value::String(target));
      state.Set("tried", std::move(tried));
      state.Set("url", Value::String(target + QueryPath() +
                                     state.Get("appKey").AsString()));
      state.Set("post", Value::Bool(true));
    }
    return state;
  }
}

Value HandleRoundResponse(const std::string& responseText,
                          const std::string& configJson, const Value& env,
                          const std::string& requestBody,
                          double responseAtSeconds) {
  bool ok = false;
  const Value config = flowjson::Parse(configJson, &ok);
  if (!ok || !config.IsObject() || !env.IsObject()) {
    return Value::Undefined();
  }
  const Value& afterDownload = config.Get("afterDownload");
  const Value decision = HandleResponse(
      responseText, Identity(config, env), false,
      afterDownload.IsString() ? afterDownload.AsString() : std::string());

  Value round = Value::Object();
  round.Set("action", decision.Get("action"));
  if (decision.Get("action").AsString() == "download") {
    round.Set("hash", decision.Get("hash"));
    round.Set("attempts",
              PlanAttempts(decision.Get("attempts"),
                           env.Get("currentVersion").Truthy(),
                           IsHttpsOnly(config.Get(kEndpoints))));
    round.Set("activate", decision.Get("activate"));
    round.Set("hashInfo", VersionInfo(decision.Get("info")));
  } else {
    round.Set("reason", decision.Get("reason"));
  }
  // Scoped to the exact request and config that produced the response (§10.3);
  // freshness is anchored to the response's arrival.
  Value cache = Value::Object();
  cache.Set("ts", Value::Number(responseAtSeconds));
  cache.Set("body", Value::String(responseText));
  cache.Set("request", Value::String(requestBody));
  cache.Set("config", Value::String(configJson));
  round.Set("cache", Value::String(flowjson::Stringify(cache)));
  return round;
}

}  // namespace flowcore
