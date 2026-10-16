#include <jni.h>

#include "jni_log.h"
#include "jni_natives.h"
#include "../patch_core/native_texts.h"

#include <string>
#include <vector>

#include "../patch_core/archive_patch_core.h"
#include "../patch_core/hbc_transform_wire.h"
#include "../patch_core/patch_core.h"
#include "jni_util.h"
#include "../patch_core/state_core.h"
#include "../patch_core/state_ops.h"

namespace {

using pushy::jni_util::GuardJni;
using pushy::jni_util::JArrayToVector;
using pushy::jni_util::JByteArrayToString;
using pushy::jni_util::JStringToString;
using pushy::jni_util::ThrowRuntimeException;
using pushy::jni_util::ToJString;
using pushy::state_ops::StateOperation;

constexpr const char* kStringSig = "Ljava/lang/String;";

// JNI result classes, resolved once in JNI_OnLoad (InitResultClassCache)
// instead of FindClass + a GetFieldID per field on every state operation.
// Written only before any native method can run, read-only afterwards.
struct StateResultIds {
  bool ready = false;
  jclass clazz = nullptr;
  jmethodID constructor = nullptr;
  jfieldID package_version = nullptr;
  jfieldID build_time = nullptr;
  jfieldID current_version = nullptr;
  jfieldID last_version = nullptr;
  jfieldID first_time = nullptr;
  jfieldID first_time_ok = nullptr;
  jfieldID rolled_back_version = nullptr;
  jfieldID changed = nullptr;
  jfieldID stale_version_to_delete = nullptr;
  jfieldID load_version = nullptr;
  jfieldID did_rollback = nullptr;
  jfieldID consumed_first_time = nullptr;
};

struct CopyGroupIds {
  bool ready = false;
  jclass clazz = nullptr;
  jclass string_class = nullptr;
  jmethodID constructor = nullptr;
  jfieldID from = nullptr;
  jfieldID to_paths = nullptr;
  jfieldID expected_crc = nullptr;
};

StateResultIds g_state;
CopyGroupIds g_copy_group;

// Resolves a class to a global ref. Logs and clears the pending exception on
// failure.
jclass FindGlobalClass(JNIEnv* env, const std::string& name) {
  jclass local = env->FindClass(name.c_str());
  if (local == nullptr) {
    env->ExceptionClear();
    PUSHY_JNI_LOGE("JNI result class %s not found", name.c_str());
    return nullptr;
  }
  auto* global = static_cast<jclass>(env->NewGlobalRef(local));
  env->DeleteLocalRef(local);
  return global;
}

// A missing field must never silently default: a lost firstTimeOk would read
// as false and roll back every launch. Logs the exact member.
bool LookupField(
    JNIEnv* env,
    jclass clazz,
    const std::string& class_name,
    const char* name,
    const char* signature,
    jfieldID* out) {
  *out = env->GetFieldID(clazz, name, signature);
  if (*out == nullptr) {
    env->ExceptionClear();
    PUSHY_JNI_LOGE("JNI field %s.%s (%s) not found", class_name.c_str(), name,
                   signature);
    return false;
  }
  return true;
}

bool LookupConstructor(
    JNIEnv* env, jclass clazz, const std::string& class_name, jmethodID* out) {
  *out = env->GetMethodID(clazz, "<init>", "()V");
  if (*out == nullptr) {
    env->ExceptionClear();
    PUSHY_JNI_LOGE("JNI no-arg constructor of %s not found", class_name.c_str());
    return false;
  }
  return true;
}

bool InitStateResultIds(JNIEnv* env) {
  const std::string& name = pushy::texts::StateResultClass();
  StateResultIds ids;
  ids.clazz = FindGlobalClass(env, name);
  if (ids.clazz == nullptr) {
    return false;
  }
  bool ok = LookupConstructor(env, ids.clazz, name, &ids.constructor);
  ok &= LookupField(env, ids.clazz, name, "packageVersion", kStringSig, &ids.package_version);
  ok &= LookupField(env, ids.clazz, name, "buildTime", kStringSig, &ids.build_time);
  ok &= LookupField(env, ids.clazz, name, "currentVersion", kStringSig, &ids.current_version);
  ok &= LookupField(env, ids.clazz, name, "lastVersion", kStringSig, &ids.last_version);
  ok &= LookupField(env, ids.clazz, name, "firstTime", "Z", &ids.first_time);
  ok &= LookupField(env, ids.clazz, name, "firstTimeOk", "Z", &ids.first_time_ok);
  ok &= LookupField(env, ids.clazz, name, "rolledBackVersion", kStringSig, &ids.rolled_back_version);
  ok &= LookupField(env, ids.clazz, name, "changed", "Z", &ids.changed);
  ok &= LookupField(env, ids.clazz, name, "staleVersionToDelete", kStringSig, &ids.stale_version_to_delete);
  ok &= LookupField(env, ids.clazz, name, "loadVersion", kStringSig, &ids.load_version);
  ok &= LookupField(env, ids.clazz, name, "didRollback", "Z", &ids.did_rollback);
  ok &= LookupField(env, ids.clazz, name, "consumedFirstTime", "Z", &ids.consumed_first_time);
  ids.ready = ok;
  g_state = ids;
  return ok;
}

bool InitCopyGroupIds(JNIEnv* env) {
  const std::string& name = pushy::texts::CopyGroupResultClass();
  CopyGroupIds ids;
  ids.clazz = FindGlobalClass(env, name);
  ids.string_class = FindGlobalClass(env, "java/lang/String");
  if (ids.clazz == nullptr || ids.string_class == nullptr) {
    return false;
  }
  bool ok = LookupConstructor(env, ids.clazz, name, &ids.constructor);
  ok &= LookupField(env, ids.clazz, name, "from", kStringSig, &ids.from);
  ok &= LookupField(env, ids.clazz, name, "toPaths", "[Ljava/lang/String;", &ids.to_paths);
  ok &= LookupField(env, ids.clazz, name, "expectedCrc", "J", &ids.expected_crc);
  ids.ready = ok;
  g_copy_group = ids;
  return ok;
}

// Throws (and returns false) when the class needed by a native is unusable;
// the reason was logged once at load time.
bool RequireReady(JNIEnv* env, bool ready, const char* what) {
  if (!ready) {
    ThrowRuntimeException(
        env, std::string("JNI result class unavailable: ") + what +
                 " (see the load-time log for the missing member)");
  }
  return ready;
}

void SetStringField(
    JNIEnv* env,
    jobject target,
    jfieldID field,
    const std::string& value) {
  if (value.empty()) {
    env->SetObjectField(target, field, nullptr);
    return;
  }

  jstring java_value = ToJString(env, value);
  env->SetObjectField(target, field, java_value);
  env->DeleteLocalRef(java_value);
}

void SetBooleanField(JNIEnv* env, jobject target, jfieldID field, bool value) {
  env->SetBooleanField(target, field, value ? JNI_TRUE : JNI_FALSE);
}

std::string GetStringField(JNIEnv* env, jobject target, jfieldID field) {
  auto* value = static_cast<jstring>(env->GetObjectField(target, field));
  std::string result = JStringToString(env, value);
  if (value != nullptr) {
    env->DeleteLocalRef(value);
  }
  return result;
}

bool GetBooleanField(JNIEnv* env, jobject target, jfieldID field) {
  return env->GetBooleanField(target, field) == JNI_TRUE;
}

// Caller has checked g_state.ready.
pushy::state::State ReadStateFromResult(JNIEnv* env, jobject state_result) {
  pushy::state::State state;
  if (state_result == nullptr) {
    return state;
  }
  state.package_version = GetStringField(env, state_result, g_state.package_version);
  state.build_time = GetStringField(env, state_result, g_state.build_time);
  state.current_version = GetStringField(env, state_result, g_state.current_version);
  state.last_version = GetStringField(env, state_result, g_state.last_version);
  state.first_time = GetBooleanField(env, state_result, g_state.first_time);
  state.first_time_ok = GetBooleanField(env, state_result, g_state.first_time_ok);
  state.rolled_back_version =
      GetStringField(env, state_result, g_state.rolled_back_version);
  return state;
}

// Caller has checked g_state.ready.
jobject NewStateCoreResult(
    JNIEnv* env,
    const pushy::state::State& state,
    bool changed = false,
    const std::string& stale_version_to_delete = std::string(),
    const std::string& load_version = std::string(),
    bool did_rollback = false,
    bool consumed_first_time = false) {
  jobject result = env->NewObject(g_state.clazz, g_state.constructor);
  if (result == nullptr) {
    return nullptr;
  }

  SetStringField(env, result, g_state.package_version, state.package_version);
  SetStringField(env, result, g_state.build_time, state.build_time);
  SetStringField(env, result, g_state.current_version, state.current_version);
  SetStringField(env, result, g_state.last_version, state.last_version);
  SetBooleanField(env, result, g_state.first_time, state.first_time);
  SetBooleanField(env, result, g_state.first_time_ok, state.first_time_ok);
  SetStringField(
      env, result, g_state.rolled_back_version, state.rolled_back_version);
  SetBooleanField(env, result, g_state.changed, changed);
  SetStringField(
      env, result, g_state.stale_version_to_delete, stale_version_to_delete);
  SetStringField(env, result, g_state.load_version, load_version);
  SetBooleanField(env, result, g_state.did_rollback, did_rollback);
  SetBooleanField(
      env, result, g_state.consumed_first_time, consumed_first_time);
  return result;
}

// Caller has checked g_copy_group.ready.
jobject NewCopyGroupResult(
    JNIEnv* env,
    const pushy::archive_patch::CopyGroup& group) {
  jobject result = env->NewObject(g_copy_group.clazz, g_copy_group.constructor);
  if (result == nullptr) {
    return nullptr;
  }

  SetStringField(env, result, g_copy_group.from, group.from);
  jobjectArray to_paths = env->NewObjectArray(
      static_cast<jsize>(group.to_paths.size()), g_copy_group.string_class,
      nullptr);
  if (to_paths != nullptr) {
    for (jsize index = 0; index < static_cast<jsize>(group.to_paths.size());
         ++index) {
      jstring value = ToJString(env, group.to_paths[index]);
      env->SetObjectArrayElement(to_paths, index, value);
      env->DeleteLocalRef(value);
    }
    env->SetObjectField(result, g_copy_group.to_paths, to_paths);
    env->DeleteLocalRef(to_paths);
  }
  env->SetLongField(
      result, g_copy_group.expected_crc,
      group.has_expected_crc ? static_cast<jlong>(group.expected_crc) : -1);

  return result;
}

}  // namespace

bool pushy::jni_natives::InitResultClassCache(JNIEnv* env) {
  // Every class is attempted so the log names all missing members at once.
  bool ok = InitStateResultIds(env);
  ok &= InitCopyGroupIds(env);
  return ok;
}

// 客户端可消费的 diff 轨道版本(能力上报,而非 SDK 版本映射);JS 层经
// getConstants 暴露,随 checkUpdate 以 diffV 上报,服务端据此下发 v2 轨道。
jint pushy::jni_natives::SupportedDiffVersion(
    JNIEnv*,
    jclass) {
  return static_cast<jint>(pushy::hbc::kSupportedDiffVersion);
}

jobject pushy::jni_natives::SyncStateWithBinaryVersion(
    JNIEnv* env,
    jclass,
    jstring package_version,
    jstring build_time,
    jobject state_result) {
  return GuardJni(
      env, "Unexpected native exception in syncStateWithBinaryVersion",
      [&]() -> jobject {
        if (!RequireReady(env, g_state.ready, "state result")) {
          return nullptr;
        }
        pushy::state::State state = ReadStateFromResult(env, state_result);
        pushy::state::BinaryVersionSyncResult result =
            pushy::state::SyncBinaryVersion(
                state,
                JStringToString(env, package_version),
                JStringToString(env, build_time));
        return NewStateCoreResult(env, result.state, result.changed);
      });
}

jobject pushy::jni_natives::RunStateCore(
    JNIEnv* env,
    jclass,
    jint operation,
    jobject state_result,
    jstring string_arg,
    jboolean flag_a,
    jboolean flag_b) {
  return GuardJni(
      env, "Unexpected native exception in runStateCore", [&]() -> jobject {
        if (!RequireReady(env, g_state.ready, "state result")) {
          return nullptr;
        }
        const pushy::state::State state = ReadStateFromResult(env, state_result);
        switch (static_cast<StateOperation>(operation)) {
          case StateOperation::kSwitchVersion:
            return NewStateCoreResult(
                env,
                pushy::state::SwitchVersion(
                    state, JStringToString(env, string_arg)));
          case StateOperation::kMarkSuccess: {
            const pushy::state::MarkSuccessResult result =
                pushy::state::MarkSuccess(state);
            return NewStateCoreResult(
                env, result.state, false, result.stale_version_to_delete);
          }
          case StateOperation::kRollback: {
            const pushy::state::State next = pushy::state::Rollback(state);
            return NewStateCoreResult(
                env, next, false, std::string(), next.current_version, true);
          }
          case StateOperation::kClearFirstTime:
            return NewStateCoreResult(env, pushy::state::ClearFirstTime(state));
          case StateOperation::kClearRollbackMark:
            return NewStateCoreResult(
                env, pushy::state::ClearRollbackMark(state));
          case StateOperation::kResolveLaunch: {
            const pushy::state::LaunchDecision decision =
                pushy::state::ResolveLaunchState(
                    state, flag_a == JNI_TRUE, flag_b == JNI_TRUE);
            return NewStateCoreResult(
                env,
                decision.state,
                false,
                std::string(),
                decision.load_version,
                decision.did_rollback,
                decision.consumed_first_time);
          }
        }

        ThrowRuntimeException(env, "Unknown state operation");
        return nullptr;
      });
}

jobjectArray pushy::jni_natives::ApplyArchiveDelta(
    JNIEnv* env,
    jclass,
    jint patch_type,
    jobjectArray entry_names,
    jbyteArray manifest_json,
    jstring source_root,
    jstring target_root,
    jstring origin_bundle_path,
    jstring bundle_patch_path,
    jstring bundle_output_path,
    jboolean host_copies_resources) {
  return GuardJni(
      env, "Unexpected native exception while applying archive delta",
      [&]() -> jobjectArray {
        if (!RequireReady(env, g_copy_group.ready, "copy group result")) {
          return nullptr;
        }
        pushy::archive_patch::ArchivePatchRequest request;
        // Unknown values never fall back to kFull (which would skip the
        // manifest and entry checks).
        if (!pushy::archive_patch::TryParseArchivePatchType(
                static_cast<int>(patch_type), &request.archive.type)) {
          ThrowRuntimeException(env, "Unknown archive delta type");
          return nullptr;
        }
        request.archive.entry_names = JArrayToVector(env, entry_names);
        // The manifest's own UTF-8 bytes: a jstring would come through as
        // modified UTF-8 and mangle supplementary characters in paths.
        request.archive.manifest_json = JByteArrayToString(env, manifest_json);
        request.source_root = JStringToString(env, source_root);
        request.target_root = JStringToString(env, target_root);
        request.origin_bundle_path = JStringToString(env, origin_bundle_path);
        request.bundle_patch_path = JStringToString(env, bundle_patch_path);
        request.bundle_output_path = JStringToString(env, bundle_output_path);
        request.host_copies_resources = host_copies_resources == JNI_TRUE;

        std::vector<pushy::archive_patch::CopyGroup> groups;
        const pushy::delta::Status status =
            pushy::archive_patch::ApplyArchivePatch(request, &groups);
        if (!status.ok) {
          ThrowRuntimeException(env, status.message);
          return nullptr;
        }

        jobjectArray result = env->NewObjectArray(
            static_cast<jsize>(groups.size()), g_copy_group.clazz, nullptr);
        if (result == nullptr) {
          return nullptr;
        }
        for (jsize index = 0; index < static_cast<jsize>(groups.size());
             ++index) {
          jobject group = NewCopyGroupResult(env, groups[index]);
          env->SetObjectArrayElement(result, index, group);
          env->DeleteLocalRef(group);
        }
        return result;
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
