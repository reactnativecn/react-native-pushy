#ifndef PUSHY_PATCH_CORE_JNI_LOG_H_
#define PUSHY_PATCH_CORE_JNI_LOG_H_

#include <android/log.h>

#include "obscured_text.h"

// Keep the core internal to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

namespace pushy {
namespace jni_log {

// Same logcat tag as the Java layer (Texts.LOG_TAG), stored encoded.
inline const char* Tag() {
  static const char* const tag =
      text::RevealStatic("2812f5d2bac6664436360afc9ba680694b3301");
  return tag;
}

}  // namespace jni_log
}  // namespace pushy

#pragma GCC visibility pop

// Error-level logcat line under the SDK's tag. For JNI binding failures that
// would otherwise be swallowed: they must be visible in release builds.
#define PUSHY_JNI_LOGE(...) \
  __android_log_print(ANDROID_LOG_ERROR, ::pushy::jni_log::Tag(), __VA_ARGS__)

#endif  // PUSHY_PATCH_CORE_JNI_LOG_H_
