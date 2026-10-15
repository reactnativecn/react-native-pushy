#ifndef PUSHY_ANDROID_JNI_NATIVES_H_
#define PUSHY_ANDROID_JNI_NATIVES_H_

#include <jni.h>

// Android native methods. They are registered by name from JNI_OnLoad
// (jni_registration.cpp) instead of being exported as Java_* symbols, so the
// shared library's dynamic symbol table carries no class or method names.
namespace pushy {
namespace jni_natives {

// Called once from JNI_OnLoad: caches the JNI result classes (global refs),
// their constructors and field IDs. Returns false (after logging what is
// missing) when any lookup failed; the natives that need the missing class
// then throw a RuntimeException instead of defaulting fields.
bool InitResultClassCache(JNIEnv* env);

jint SupportedDiffVersion(JNIEnv*, jclass);
jobject SyncStateWithBinaryVersion(JNIEnv* env, jclass, jstring package_version, jstring build_time, jobject state_result);
jobject RunStateCore(JNIEnv* env, jclass, jint operation, jobject state_result, jstring string_arg, jboolean flag_a, jboolean flag_b);
jobjectArray ApplyArchiveDelta(JNIEnv* env, jclass, jint patch_type, jobjectArray entry_names, jbyteArray manifest_json, jstring source_root, jstring target_root, jstring origin_bundle_path, jstring bundle_patch_path, jstring bundle_output_path, jboolean host_copies_resources);
void CleanupOldEntries(JNIEnv* env, jclass, jstring root_dir, jobjectArray keep_names, jint max_age_days, jstring trash_dir);
jstring FlowPrepareRound(JNIEnv* env, jclass, jstring configJson, jstring envJson, jdouble randomSample);
jstring FlowNextQueryStep(JNIEnv* env, jclass, jstring stateJson, jstring responseText);
jstring FlowStepRound(JNIEnv* env, jclass, jstring stateJson, jstring eventJson);
jstring FlowHandleResponse(JNIEnv* env, jclass, jstring responseText, jstring configJson, jstring envJson, jstring requestBody, jlong responseAtSeconds);
jboolean FlowConfigsEquivalent(JNIEnv* env, jclass, jstring a, jstring b);
jstring FlowRunnableConfig(JNIEnv* env, jclass, jstring configJson);
jstring FlowNormalizeConfiguration(JNIEnv* env, jclass, jstring optionsJson);
jboolean InstallRecordIsComplete(JNIEnv* env, jclass, jstring version_dir, jstring version_hash, jstring bundle_file_name);
jstring InstallRecordCheckActivation(JNIEnv* env, jclass, jstring version_dir, jstring version_hash, jstring bundle_file_name, jboolean grandfathered);
jstring InstallRecordSeal(JNIEnv* env, jclass, jstring staging_dir, jstring version_hash, jstring bundle_file_name, jstring artifact_sha256, jstring known_bundle_sha256);
jstring InstallRecordPromote(JNIEnv* env, jclass, jstring staging_dir, jstring version_dir);
jstring InstallRecordBundleSha256(JNIEnv* env, jclass, jstring version_dir);
jlong ArchiveCheckEntries(JNIEnv* env, jclass, jlong archive_bytes, jobjectArray names, jlongArray sizes, jlongArray compressed_sizes);
jlongArray ArchivePlanFreeSpaceProbe(JNIEnv* env, jclass, jlong known_total, jlong written_before, jlong chunk_bytes, jlong reserved_until);

}  // namespace jni_natives
}  // namespace pushy

#endif  // PUSHY_ANDROID_JNI_NATIVES_H_
