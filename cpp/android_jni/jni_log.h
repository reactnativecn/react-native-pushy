#ifndef PUSHY_ANDROID_JNI_LOG_H_
#define PUSHY_ANDROID_JNI_LOG_H_

#include <android/log.h>

#include "../patch_core/native_texts.h"

// Keep the core internal to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

namespace pushy {
namespace jni_log {

// Same logcat tag as the Java layer (Texts.LOG_TAG), stored encoded.
inline const char* Tag() {
  static const char* const tag = texts::LogTag().c_str();
  return tag;
}

}  // namespace jni_log
}  // namespace pushy

#pragma GCC visibility pop

// Error-level logcat line under the SDK's tag. For JNI binding failures that
// would otherwise be swallowed: they must be visible in release builds.
#define PUSHY_JNI_LOGE(...) \
  __android_log_print(ANDROID_LOG_ERROR, ::pushy::jni_log::Tag(), __VA_ARGS__)

#endif  // PUSHY_ANDROID_JNI_LOG_H_
