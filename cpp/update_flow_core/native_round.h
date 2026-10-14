#pragma once

#include <string>

#include "flow_json.h"

// The pure steps of the native cold-start round (NATIVE_CHECKUPDATE_DESIGN
// §10), one implementation for the Android, iOS and Harmony orchestrators:
// what to send, which endpoint to ask next, and everything a commit needs
// from the answer. HTTP, timeouts, locks, downloads and persistence stay
// native. JS has no counterpart (its client builds its own request through
// src/updateFlowCore.ts buildCheckRequestBody, which BuildRequestBody
// mirrors); tests/native-round-vectors.json pins this layer.
//
// `config` is the persisted config text (already through
// ParseRunnableConfig). `env` is what the platform knows about this launch,
// as a JSON object:
//   packageVersion     the binary's package version
//   currentVersion     the running version exactly as the platform's JS
//                      constant reports it (Android null, iOS absent,
//                      Harmony "" when none), so the request matches the one
//                      JS builds and JS can reuse the response cache
//   uuid               missing -> ""
//   rolledBackVersion  the launch-path rollback snapshot
//   buildTime          passed through
//   os                 "<platform> <Platform.Version>", as JS cInfo.os
//   bundleHash         omitted from the request when empty
// Keep the core internal to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

namespace flowcore {

// Total HTTP requests one query may issue: endpoint queries and remote list
// fetches alike. The JS check's endpoint fallback keeps the same budget for
// its endpoint queries (src/endpoint.ts MAX_ENDPOINT_REQUESTS,
// scripts/check-constant-parity.js).
constexpr int kMaxQueryRequests = 8;

// {"body": "<checkUpdate request text>", "query": <first NextQueryStep
// state>}. The body is BuildRequestBody over the config and env: a non-empty
// string config.packageVersion overrides env.packageVersion, cInfo.rnu/rn are
// the config's strings ("" otherwise), diffV is this core's
// kSupportedDiffVersion. randomSample ∈ [0, 1) picks the first endpoint
// (OrderEndpointCandidates). Undefined when the config is not runnable or
// env is not an object.
flowjson::Value PrepareRound(const std::string& configJson,
                             const flowjson::Value& env, double randomSample);

// One step of the sequential endpoint fallback (§5.1). Pass the previous
// state and the text the request it named returned (Undefined when it failed
// or none was made). The result is the next state, with
//   "url" (and "post"): issue that request — a POST of the round's body for
//       an endpoint query, a GET for a remote endpoint list — then call again;
//   "found": true: the text just passed in is the valid check response;
//   neither: no endpoint answered; the query is over.
// Policy: the configured endpoints in sampled order, then the first
// queryUrls list that fetches and parses as a JSON array, whose entries are
// queried in turn (one list is enough). Bases are stripped of trailing '/'
// and asked once each; entries that are not strings are skipped; a remote
// entry must be https when every configured endpoint is (IsHttpsOnly), so the
// network cannot downgrade the round. A response counts only when
// IsValidResponse accepts it. At most kMaxQueryRequests requests. Undefined
// for a state that is not an object.
flowjson::Value NextQueryStep(const flowjson::Value& state,
                              const flowjson::Value& responseText);

// Every configured endpoint is an https URL (ASCII case-insensitive); false
// for an empty or missing list.
bool IsHttpsOnly(const flowjson::Value& endpoints);

// HandleResponse for the round, plus what each commit needs:
//   {action: "none", reason, cache}
//   {action: "download", hash, attempts, activate, hashInfo, cache}
// attempts are planned for this device: no diff attempt without a running
// version (env.currentVersion falsy), no cleartext http:// URL when the
// config IsHttpsOnly; strategies left without a URL are dropped. hashInfo is
// the version info to persist next to the download (the JS side's
// setLocalHashInfo): the info's string name/description/metaInfo, plus
// forceBootRescue when the server's config.forceBoot is truthy (the same
// truthiness that activates it). cache is the response-cache text JS reuses
// ({ts, body, request, config}). afterDownload is the config's string
// (otherwise ""). Undefined when the config is not a JSON object or env is
// not an object.
flowjson::Value HandleRoundResponse(const std::string& responseText,
                                    const std::string& configJson,
                                    const flowjson::Value& env,
                                    const std::string& requestBody,
                                    double responseAtSeconds);

}  // namespace flowcore

#pragma GCC visibility pop
