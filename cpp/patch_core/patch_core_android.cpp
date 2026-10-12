#include <jni.h>

#include "jni_natives.h"

#include <string>
#include <vector>

#include "jni_util.h"
#include "patch_core.h"

namespace {

using pushy::jni_util::GuardJni;
using pushy::jni_util::JArrayToVector;
using pushy::jni_util::JStringToString;
using pushy::jni_util::ReadPatchManifest;
using pushy::jni_util::ThrowRuntimeException;

}  // namespace

void pushy::jni_natives::ApplyDeltaFromSource(
    JNIEnv* env,
    jclass,
    jstring source_root,
    jstring target_root,
    jstring origin_bundle_path,
    jstring bundle_patch_path,
    jstring bundle_output_path,
    jstring merge_source_subdir,
    jboolean enable_merge,
    jobjectArray copy_froms,
    jobjectArray copy_tos,
    jobjectArray deletes,
    jstring hbc_transform_meta) {
  GuardJni(env, "Unexpected native exception while applying delta", [&] {
    pushy::delta::FileSourcePatchOptions options;
    if (!ReadPatchManifest(env, copy_froms, copy_tos, deletes, &options.manifest)) {
      return;
    }
    options.source_root = JStringToString(env, source_root);
    options.target_root = JStringToString(env, target_root);
    options.origin_bundle_path = JStringToString(env, origin_bundle_path);
    options.bundle_patch_path = JStringToString(env, bundle_patch_path);
    options.bundle_output_path = JStringToString(env, bundle_output_path);
    options.merge_source_subdir = JStringToString(env, merge_source_subdir);
    options.enable_merge = enable_merge == JNI_TRUE;
    options.bundle_hbc_transform_meta = JStringToString(env, hbc_transform_meta);

    const pushy::delta::Status status =
        pushy::delta::ApplyPatchFromFileSource(options);
    if (!status.ok) {
      ThrowRuntimeException(env, status.message);
    }
  });
}

void pushy::jni_natives::CleanupOldEntries(
    JNIEnv* env,
    jclass,
    jstring root_dir,
    jobjectArray keep_names,
    jint max_age_days,
    jstring trash_dir) {
  GuardJni(env, "Unexpected native exception in cleanupOldEntries", [&] {
    const std::string root = JStringToString(env, root_dir);
    const std::vector<std::string> keep = JArrayToVector(env, keep_names);
    const std::string trash = JStringToString(env, trash_dir);
    // A trash directory turns the delete into renames (cheap enough to run
    // under the caller's version-files lock); the caller purges it later.
    const pushy::delta::Status status = trash.empty()
        ? pushy::delta::CleanupOldEntries(
              root, keep, static_cast<int>(max_age_days))
        : pushy::delta::MoveOldEntriesToTrash(
              root, keep, static_cast<int>(max_age_days), trash);
    if (!status.ok) {
      ThrowRuntimeException(env, status.message);
    }
  });
}
