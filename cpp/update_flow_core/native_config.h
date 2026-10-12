#pragma once

#include <string>

#include "flow_json.h"

// The persisted native check config: its validation when a host configures
// it, the gate that decides whether it can run a round, and the equivalence
// that decides whether a new one is a change. One implementation for the
// Android, iOS and Harmony orchestrators (each used to carry its own copy);
// JSON strings in and out so the bindings stay thin.
//
// The JS client keeps its own TS copy of the equivalence
// (src/updateFlowCore.ts nativeConfigsEquivalent — it must also run on web and
// on natives that predate this file); both replay
// tests/config-equivalence-vectors.json. The gate and the normalizer have no
// JS counterpart; tests/native-config-vectors.json pins them.
// Keep the core internal to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

namespace flowcore {

// ECMAScript String.prototype.trim: strips WhiteSpace and LineTerminator
// code points (TAB, LF, VT, FF, CR, SPACE, NBSP, U+1680, U+2000-U+200A,
// U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF) from both ends of a UTF-8
// string. Other control characters are kept.
std::string TrimJsWhitespace(const std::string& text);

// Contract C1. Canonical form of a persisted config: the parsed object with
// absent keys defaulted ({disabled:false, queryUrls:[], rnu:"", rn:"",
// afterDownload:"none"}) and each `endpoints`/`queryUrls` array's strings
// stripped of every trailing '/', then deduplicated keeping the first
// occurrence. Present values are never coerced (0 is not false, null is not
// a default). Undefined when the text is not a JSON object.
flowjson::Value CanonicalNativeConfig(const std::string& json);

// Two configs are equivalent iff both are JSON objects whose canonical forms
// are DeepEquals (key order ignored). Anything else is never equivalent, not
// even to itself — callers pass "" for an absent config.
bool ConfigsEquivalent(const std::string& a, const std::string& b);

// The gate every entry point (round start, crash-hold install, the host's
// prepareBundle, the round itself) applies to the persisted config, so they
// agree on what is runnable:
//   ""                                   -> skipped / not_configured
//   not a JSON object                    -> failed  / invalid_config
//   `disabled` truthy (JS truthiness)    -> skipped / disabled
//   `appKey` not a string, or blank      -> failed  / invalid_config
//     after TrimJsWhitespace
//   otherwise runnable, with the trimmed appKey and the parsed config.
struct RunnableConfig {
  std::string status;  // empty when runnable, else "skipped" / "failed"
  std::string reason;
  std::string appKey;
  flowjson::Value config;

  bool runnable() const { return status.empty(); }
};
RunnableConfig ParseRunnableConfig(const std::string& json);

// Binding form of ParseRunnableConfig: {"appKey": "<trimmed>"} when runnable,
// otherwise {"status": "...", "reason": "..."}. The binding re-parses the
// config itself when it needs more fields.
std::string RunnableConfigJson(const std::string& json);

// Validates the options a host passes to configure() (a JSON object) and
// returns the config to persist:
//   {appKey, endpoints, queryUrls, afterDownload, disabled, rnu, rn,
//    packageVersion?}
// Only those keys are accepted. appKey/packageVersion are non-blank strings
// (kept as given), rnu/rn strings. endpoints default to Pushy's own and must
// be a non-empty array of absolute http(s) URLs without credentials, queries
// or fragments; each is trimmed, stripped of trailing '/' and deduplicated.
// queryUrls default to Pushy's discovery URLs, or to [] once endpoints are
// custom; each is trimmed and deduplicated (queries allowed). afterDownload
// is "none" (default) or the next-launch policy; disabled a boolean. A
// present null is invalid, never a default. On failure returns false and
// sets *error to "Invalid native configuration: <why>".
bool NormalizeConfiguration(const std::string& optionsJson, std::string* out,
                            std::string* error);

}  // namespace flowcore

#pragma GCC visibility pop
