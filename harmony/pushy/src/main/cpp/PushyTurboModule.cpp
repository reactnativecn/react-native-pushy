#include "PushyTurboModule.h"

using namespace facebook;
using namespace rnoh;

// The JS-visible method table: (name, argument count, SYNC | ASYNC).
//
// This table is the only bridge RNOH gives JS into the ArkTS module: a method
// missing here is `undefined` on the JS side, and the JS feature-detects then
// treat the whole capability as "old native" and silently skip it — which is
// how the native cold-start check shipped dark on Harmony. Every spec method
// (src/NativePushy.ts) MUST be listed.
//
// Only the constants and the RN event plumbing are SYNC. Every
// Promise-returning spec method MUST be ASYNC: a sync registration converts
// the ArkTS Promise into an empty jsi object and its rejection becomes an
// unhandled ArkTS rejection, so JS would report e.g. setNeedUpdate as
// successful while nothing was switched. scripts/check-native-spec-parity.js
// enforces both rules against this table.
#define PUSHY_METHODS(X)                 \
  X(getConstants, 0, SYNC)               \
  X(addListener, 1, SYNC)                \
  X(removeListeners, 1, SYNC)            \
  X(setLocalHashInfo, 2, ASYNC)          \
  X(getLocalHashInfo, 1, ASYNC)          \
  X(setUuid, 1, ASYNC)                   \
  X(reloadUpdate, 1, ASYNC)              \
  X(restartApp, 0, ASYNC)                \
  X(setNeedUpdate, 1, ASYNC)             \
  X(markSuccess, 0, ASYNC)               \
  X(downloadPatchFromPpk, 1, ASYNC)      \
  X(downloadPatchFromPackage, 1, ASYNC)  \
  X(downloadFullUpdate, 1, ASYNC)        \
  X(downloadAndInstallApk, 1, ASYNC)     \
  X(syncNativeConfig, 1, ASYNC)          \
  X(getNativeCheckCache, 0, ASYNC)       \
  X(markJsCheckCompleted, 1, ASYNC)      \
  X(getBundleHash, 0, ASYNC)             \
  X(resetToPackagedBundle, 0, ASYNC)

// ArkTSTurboModule entry point per kind.
#define PUSHY_INVOKE_SYNC call
#define PUSHY_INVOKE_ASYNC callAsync

namespace {

#define PUSHY_HOST_FUNCTION(method_name, arg_count, kind)                \
  jsi::Value HostFunction_##method_name(                                 \
      jsi::Runtime &rt,                                                  \
      react::TurboModule &turboModule,                                   \
      const jsi::Value *args,                                            \
      size_t count) {                                                    \
    return jsi::Value(                                                   \
        static_cast<ArkTSTurboModule &>(turboModule)                     \
            .PUSHY_INVOKE_##kind(rt, #method_name, args, count));        \
  }

PUSHY_METHODS(PUSHY_HOST_FUNCTION)

#undef PUSHY_HOST_FUNCTION

} // namespace

PushyTurboModule::PushyTurboModule(
    const ArkTSTurboModule::Context ctx,
    const std::string name)
    : ArkTSTurboModule(ctx, name) {
#define PUSHY_REGISTER_METHOD(method_name, arg_count, kind) \
  methodMap_[#method_name] =                                \
      MethodMetadata{arg_count, HostFunction_##method_name};

  PUSHY_METHODS(PUSHY_REGISTER_METHOD)

#undef PUSHY_REGISTER_METHOD
}

#undef PUSHY_INVOKE_SYNC
#undef PUSHY_INVOKE_ASYNC
#undef PUSHY_METHODS
