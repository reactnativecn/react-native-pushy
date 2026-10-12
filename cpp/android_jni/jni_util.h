#pragma once

#include <jni.h>

#include <cstdint>
#include <exception>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#include "../patch_core/patch_core.h"

// Small JNI helpers shared by every Android glue translation unit
// (patch_core_android.cpp, update_core_android.cpp and
// update_flow_jni.cpp). Header-only with inline linkage so
// each can include it without a separate compilation unit.

namespace pushy {
namespace jni_util {

inline std::string JStringToString(JNIEnv* env, jstring value) {
  if (value == nullptr) {
    return std::string();
  }

  const char* chars = env->GetStringUTFChars(value, nullptr);
  if (chars == nullptr) {
    return std::string();
  }

  std::string result(chars);
  env->ReleaseStringUTFChars(value, chars);
  return result;
}

// Standard UTF-8 -> Java string. NewStringUTF expects JNI's *modified* UTF-8
// and corrupts supplementary code points (4-byte sequences, e.g. emoji), so
// decode explicitly and pass UTF-16 code units to NewString. Encoded
// surrogate code points are accepted too: strings that originated in Java may
// have entered through modified UTF-8 (JStringToString). Invalid bytes become
// U+FFFD. Returns nullptr when the result would not fit a jsize.
inline jstring ToJString(JNIEnv* env, const std::string& value) {
  std::vector<jchar> utf16;
  utf16.reserve(value.size());
  size_t i = 0;
  while (i < value.size()) {
    const unsigned char first = static_cast<unsigned char>(value[i]);
    uint32_t codePoint = 0xfffd;
    size_t width = 1;
    if (first < 0x80) {
      codePoint = first;
    } else if (first >= 0xc2 && first <= 0xdf && i + 1 < value.size()) {
      const unsigned char b1 = static_cast<unsigned char>(value[i + 1]);
      if ((b1 & 0xc0) == 0x80) {
        codePoint = ((first & 0x1f) << 6) | (b1 & 0x3f);
        width = 2;
      }
    } else if (first == 0xc0 && i + 1 < value.size() &&
               static_cast<unsigned char>(value[i + 1]) == 0x80) {
      codePoint = 0;  // modified UTF-8 encoding of U+0000
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef && i + 2 < value.size()) {
      const unsigned char b1 = static_cast<unsigned char>(value[i + 1]);
      const unsigned char b2 = static_cast<unsigned char>(value[i + 2]);
      if ((b1 & 0xc0) == 0x80 && (b2 & 0xc0) == 0x80 &&
          !(first == 0xe0 && b1 < 0xa0)) {
        codePoint = ((first & 0x0f) << 12) | ((b1 & 0x3f) << 6) |
                    (b2 & 0x3f);
        width = 3;
      }
    } else if (first >= 0xf0 && first <= 0xf4 && i + 3 < value.size()) {
      const unsigned char b1 = static_cast<unsigned char>(value[i + 1]);
      const unsigned char b2 = static_cast<unsigned char>(value[i + 2]);
      const unsigned char b3 = static_cast<unsigned char>(value[i + 3]);
      if ((b1 & 0xc0) == 0x80 && (b2 & 0xc0) == 0x80 &&
          (b3 & 0xc0) == 0x80 && !(first == 0xf0 && b1 < 0x90) &&
          !(first == 0xf4 && b1 > 0x8f)) {
        codePoint = ((first & 0x07) << 18) | ((b1 & 0x3f) << 12) |
                    ((b2 & 0x3f) << 6) | (b3 & 0x3f);
        width = 4;
      }
    }
    i += width;
    if (codePoint <= 0xffff) {
      utf16.push_back(static_cast<jchar>(codePoint));
    } else {
      codePoint -= 0x10000;
      utf16.push_back(static_cast<jchar>(0xd800 + (codePoint >> 10)));
      utf16.push_back(static_cast<jchar>(0xdc00 + (codePoint & 0x3ff)));
    }
  }
  if (utf16.size() > static_cast<size_t>(std::numeric_limits<jsize>::max())) {
    return nullptr;
  }
  return env->NewString(utf16.empty() ? nullptr : utf16.data(),
                        static_cast<jsize>(utf16.size()));
}

inline std::vector<std::string> JArrayToVector(
    JNIEnv* env,
    jobjectArray values) {
  std::vector<std::string> result;
  if (values == nullptr) {
    return result;
  }

  const jsize size = env->GetArrayLength(values);
  result.reserve(static_cast<size_t>(size));
  for (jsize index = 0; index < size; ++index) {
    auto* item = static_cast<jstring>(env->GetObjectArrayElement(values, index));
    result.push_back(JStringToString(env, item));
    env->DeleteLocalRef(item);
  }
  return result;
}

inline void ThrowRuntimeException(JNIEnv* env, const char* message) {
  jclass exception = env->FindClass("java/lang/RuntimeException");
  if (exception != nullptr) {
    env->ThrowNew(exception, message);
  }
}

inline void ThrowRuntimeException(JNIEnv* env, const std::string& message) {
  ThrowRuntimeException(env, message.c_str());
}

// Reads the parallel copy_froms/copy_tos arrays (+ deletes, may be null) into
// a PatchManifest via delta::BuildPatchManifest. On failure (length mismatch)
// a RuntimeException is pending and false is returned.
inline bool ReadPatchManifest(
    JNIEnv* env,
    jobjectArray copy_froms,
    jobjectArray copy_tos,
    jobjectArray deletes,
    delta::PatchManifest* out) {
  const delta::Status status = delta::BuildPatchManifest(
      JArrayToVector(env, copy_froms), JArrayToVector(env, copy_tos),
      JArrayToVector(env, deletes), out);
  if (!status.ok) {
    ThrowRuntimeException(env, status.message);
  }
  return status.ok;
}

// Runs a native method body so no C++ exception (bad_alloc/length_error from
// input-proportional STL allocations) ever unwinds through the JNI boundary:
// it becomes a Java RuntimeException like every other failure of the entry
// point, carrying `fallback_message` when the exception has no message of its
// own. Returns a value-initialized Result (nullptr / void) in that case.
template <typename Body>
auto GuardJni(JNIEnv* env, const char* fallback_message, Body&& body)
    -> decltype(body()) {
  using Result = decltype(body());
  try {
    return std::forward<Body>(body)();
  } catch (const std::exception& error) {
    ThrowRuntimeException(env, error.what());
  } catch (...) {
    ThrowRuntimeException(env, fallback_message);
  }
  return Result();
}

}  // namespace jni_util
}  // namespace pushy
