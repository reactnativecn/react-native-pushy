// JNI glue of InstallRecord.java over the shared completion record core
// (cpp/patch_core/install_record.h). The jstring-returning natives return
// null on success and the reason otherwise; Java turns a reason into an
// IOException.
#include <jni.h>

#include <string>

#include "jni_natives.h"
#include "jni_util.h"
#include "../patch_core/install_record.h"

namespace {

using pushy::jni_util::GuardJni;
using pushy::jni_util::JStringToString;
using pushy::jni_util::ToJString;

jstring ReasonOrNull(JNIEnv* env, const pushy::delta::Status& status) {
  return status.ok ? nullptr : ToJString(env, status.message);
}

}  // namespace

jboolean pushy::jni_natives::InstallRecordIsComplete(
    JNIEnv* env, jclass, jstring version_dir, jstring version_hash,
    jstring bundle_file_name) {
  return GuardJni(
      env, "Unexpected native exception while reading a completion record", [&] {
    return pushy::install_record::IsComplete(
               JStringToString(env, version_dir),
               JStringToString(env, version_hash),
               JStringToString(env, bundle_file_name))
               ? JNI_TRUE
               : JNI_FALSE;
  });
}

// Hashes the whole bundle: called from worker threads only.
jstring pushy::jni_natives::InstallRecordCheckActivation(
    JNIEnv* env, jclass, jstring version_dir, jstring version_hash,
    jstring bundle_file_name, jboolean grandfathered) {
  return GuardJni(
      env, "Unexpected native exception while verifying a version", [&] {
    pushy::install_record::Activation activation;
    return ReasonOrNull(
        env, pushy::install_record::CheckActivation(
                 JStringToString(env, version_dir),
                 JStringToString(env, version_hash),
                 JStringToString(env, bundle_file_name),
                 grandfathered == JNI_TRUE, &activation));
  });
}

jstring pushy::jni_natives::InstallRecordSeal(
    JNIEnv* env, jclass, jstring staging_dir, jstring version_hash,
    jstring bundle_file_name, jstring artifact_sha256,
    jstring known_bundle_sha256) {
  return GuardJni(
      env, "Unexpected native exception while writing a completion record", [&] {
    return ReasonOrNull(
        env, pushy::install_record::Seal(
                 JStringToString(env, staging_dir),
                 JStringToString(env, version_hash),
                 JStringToString(env, bundle_file_name),
                 JStringToString(env, artifact_sha256),
                 JStringToString(env, known_bundle_sha256))
                 .status);
  });
}

jstring pushy::jni_natives::InstallRecordPromote(
    JNIEnv* env, jclass, jstring staging_dir, jstring version_dir) {
  return GuardJni(
      env, "Unexpected native exception while moving a staged version", [&] {
    return ReasonOrNull(
        env, pushy::install_record::Promote(JStringToString(env, staging_dir),
                                            JStringToString(env, version_dir)));
  });
}

jstring pushy::jni_natives::InstallRecordBundleSha256(
    JNIEnv* env, jclass, jstring version_dir) {
  return GuardJni(
      env, "Unexpected native exception while reading a completion record", [&] {
    return ToJString(env, pushy::install_record::RecordedBundleSha256(
                              JStringToString(env, version_dir)));
  });
}
