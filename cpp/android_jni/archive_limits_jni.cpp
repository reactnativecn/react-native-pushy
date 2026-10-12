// JNI glue of ArchiveLimits.java over the shared extraction accounting
// (cpp/patch_core/archive_limits.h).
#include <jni.h>

#include <string>
#include <vector>

#include "jni_natives.h"
#include "jni_util.h"
#include "../patch_core/archive_limits.h"

namespace {

using pushy::jni_util::GuardJni;
using pushy::jni_util::JArrayToVector;
using pushy::jni_util::ThrowRuntimeException;

void ThrowIOException(JNIEnv* env, const std::string& message) {
  jclass exception = env->FindClass("java/io/IOException");
  if (exception != nullptr) {
    env->ThrowNew(exception, message.c_str());
  }
}

}  // namespace

// One call per archive: the central directory's names and declared sizes
// through an EntryAccumulator. Returns the total uncompressed size, or throws
// an IOException with the first violation.
jlong pushy::jni_natives::ArchiveCheckEntries(
    JNIEnv* env, jclass, jlong archive_bytes, jobjectArray names,
    jlongArray sizes, jlongArray compressed_sizes) {
  return GuardJni(
      env, "Unexpected native exception while checking an archive", [&]() -> jlong {
    const jsize count = names == nullptr ? 0 : env->GetArrayLength(names);
    if (sizes == nullptr || compressed_sizes == nullptr ||
        env->GetArrayLength(sizes) != count ||
        env->GetArrayLength(compressed_sizes) != count) {
      ThrowRuntimeException(env, "archive entry arrays differ in length");
      return 0;
    }
    // Before any name is copied: a hostile central directory may list far
    // more entries than the cap.
    pushy::delta::Status status = pushy::archive_limits::CheckEntryCount(count);
    if (!status.ok) {
      ThrowIOException(env, status.message);
      return 0;
    }
    const std::vector<std::string> entry_names = JArrayToVector(env, names);
    std::vector<jlong> size_values(static_cast<size_t>(count));
    std::vector<jlong> compressed_values(static_cast<size_t>(count));
    if (count > 0) {
      env->GetLongArrayRegion(sizes, 0, count, size_values.data());
      env->GetLongArrayRegion(compressed_sizes, 0, count, compressed_values.data());
    }
    pushy::archive_limits::EntryAccumulator accumulator(archive_bytes);
    for (jsize i = 0; i < count; i++) {
      status = accumulator.Accept(size_values[i], compressed_values[i], false,
                                  entry_names[i]);
      if (!status.ok) {
        ThrowIOException(env, status.message);
        return 0;
      }
    }
    return accumulator.total_uncompressed();
  });
}

// {bytes to probe for (0: no probe), reservation end} before one chunk of a
// download is written.
jlongArray pushy::jni_natives::ArchivePlanFreeSpaceProbe(
    JNIEnv* env, jclass, jlong known_total, jlong written_before,
    jlong chunk_bytes, jlong reserved_until) {
  const pushy::archive_limits::FreeSpaceProbe plan =
      pushy::archive_limits::PlanUnknownLengthFreeSpaceProbe(
          known_total, written_before, chunk_bytes, reserved_until);
  jlongArray result = env->NewLongArray(2);
  if (result != nullptr) {
    const jlong values[2] = {plan.probe ? plan.reserve : 0, plan.reserved_until};
    env->SetLongArrayRegion(result, 0, 2, values);
  }
  return result;
}
