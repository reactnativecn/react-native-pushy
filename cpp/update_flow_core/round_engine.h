#pragma once

#include <string>

#include "flow_json.h"

// The driver of one native cold-start round (NATIVE_CHECKUPDATE_DESIGN §12):
// the loop the Android, iOS and Harmony orchestrators used to write by hand
// around the pure steps of native_round.h — the config gate, the breadcrumb,
// the endpoint query, the response decision, the already-installed check, the
// two download budgets, the commit and the result it maps to.
//
// Sans-IO: StepRound takes the previous state and what just happened, and
// returns the next state plus what to do. It never does IO, never reads a
// clock, never locks; the time arrives in each event. The platform adapter
// runs the commands (HTTP, downloads, persistence, the commit's lock and its
// generation re-check, the activation digest gate) and feeds the outcome back
// as the next event. The state is plain JSON, so the JNI and NAPI bindings
// pass it through as text and keep no handle.
//
// tests/round-engine-vectors.json pins every trace.
// Keep the core internal to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

namespace flowcore {

// Each download phase's window: the incremental strategies (diff, pdiff)
// share one, the first full attempt opens its own, so incremental failures
// cannot starve the last-resort full download. A round deadline caps both.
constexpr double kDownloadPhaseMs = 600 * 1000;
// Per request of the endpoint query: the idle (connect/read) timeout and the
// whole-call bound. A round deadline caps both.
constexpr double kQueryIdleTimeoutMs = 10 * 1000;
constexpr double kQueryCallTimeoutMs = 15 * 1000;

// One step of the round. `state` is the previous result's "state" (anything
// for a "start" event); the result is {"state": ..., "commands": [...]}.
//
// Events ({"type": ..., ...}; every event carries "now", the platform's
// monotonic clock in milliseconds, and may carry the sticky flags
// "crashHold" — a crash is being held, JS is dead — and "forceActivate" —
// the launch waits on this round, as the tvOS purge restore):
//   start      config (the persisted config text, "" when absent),
//              resetGeneration, configGeneration (sampled before the config
//              was read), sample (∈ [0, 1), picks the first endpoint),
//              deadline (monotonic ms; 0 for none)
//   env        env: the launch as native_round.h describes it
//   http       text: the response body (absent when the request failed),
//              at: wall-clock seconds the response arrived
//   installed  installed: a complete install of the hash is already on disk
//   download   ok; code: the failure's error code; timedOut: the attempt
//              outlived its deadline
//   committed  ok: the commit landed; when false, reason names the
//              generation that moved since the round started ("reset", the
//              default, or "config_changed"); activated: what it really
//              activated (absent = as asked); error: the commit itself failed
//              (the activation gate rejected the version, a write threw)
//
// Commands:
//   markIncomplete  persist the interrupted-round breadcrumb (§11.4). The
//                   adapter clears it once the round is over, however it
//                   ends
//   collectEnv      reply with an env event
//   http            url, post, body (when post), timeoutMs, callTimeoutMs
//   checkInstalled  hash
//   download        strategy ("diff", "pdiff" or "full"), url, hash,
//                   originHash (diff only), deadline (monotonic ms)
//   commit          hash and hashInfo (the version info as JSON text; both ""
//                   when only the response cache is committed), activate,
//                   cache, resetGeneration, configGeneration — one atomic
//                   commit that first re-checks both generations
//   finish          status, reason, and for "downloaded" hash and activated.
//                   The round is over; later events are ignored. A
//                   downloaded but not activated version is the one a later
//                   crash hold may activate.
//
// An event the current phase does not expect (or of no known type) finishes
// the round as failed/internal_error.
flowjson::Value StepRound(const flowjson::Value& state,
                          const flowjson::Value& event);

// StepRound over JSON text, for the bindings. A state or event that does not
// parse finishes the round as failed/internal_error.
std::string StepRoundJson(const std::string& stateJson,
                          const std::string& eventJson);

// Whether a host that waited on a round may take its result, checked after
// the wait: "" when it may, otherwise the cancellation reason. The config
// the host saw, the one the round ran with and the one stored now must be
// equivalent (ConfigsEquivalent) and the config generation unchanged
// ("config_changed"); then the reset generation unchanged ("reset").
std::string HostCancellation(const std::string& hostConfig,
                             const std::string& roundConfig,
                             const std::string& storedConfig,
                             double roundConfigGeneration,
                             double configGeneration,
                             double roundResetGeneration,
                             double resetGeneration);

// A server-provided hash may name a directory: non-empty, not "." or "..",
// no '/', '\\' or NUL.
bool IsSafePathComponent(const std::string& name);

}  // namespace flowcore

#pragma GCC visibility pop
