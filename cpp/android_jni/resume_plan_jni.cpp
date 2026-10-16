// JNI surface of the resumable-download decisions (cpp/patch_core/
// resume_plan.h) for DownloadTask.java, through ResumePlan.java. Strings in,
// JSON text out; a null return means the core threw (memory ran out) and the
// caller fails the download, keeping the partial and its sidecar — a C++
// exception must never unwind through the JNI boundary.
#include <jni.h>

#include "jni_natives.h"

#include <string>

#include "jni_util.h"
#include "../patch_core/resume_plan.h"

using pushy::jni_util::JStringToString;
using pushy::jni_util::ToJString;

jstring pushy::jni_natives::ResumePlanRequest(JNIEnv* env, jclass, jstring sidecar,
                                              jstring url, jlong partial_size) {
  try {
    return ToJString(env, pushy::resume::PlanRequestJson(
                              JStringToString(env, sidecar), JStringToString(env, url),
                              static_cast<long long>(partial_size)));
  } catch (...) {
    return nullptr;
  }
}

jstring pushy::jni_natives::ResumeClassifyResponse(
    JNIEnv* env, jclass, jint status, jlong resume_offset, jstring content_range,
    jstring content_encoding, jlong content_length, jstring sidecar, jstring url,
    jlong partial_size) {
  try {
    return ToJString(
        env, pushy::resume::ClassifyResponseJson(
                 static_cast<int>(status), static_cast<long long>(resume_offset),
                 JStringToString(env, content_range),
                 JStringToString(env, content_encoding),
                 static_cast<long long>(content_length), JStringToString(env, sidecar),
                 JStringToString(env, url), static_cast<long long>(partial_size)));
  } catch (...) {
    return nullptr;
  }
}

jstring pushy::jni_natives::ResumeSidecar(JNIEnv* env, jclass, jstring url, jstring etag,
                                          jstring last_modified, jstring previous_sidecar,
                                          jlong total) {
  try {
    return ToJString(env, pushy::resume::SidecarJson(
                              JStringToString(env, url), JStringToString(env, etag),
                              JStringToString(env, last_modified),
                              JStringToString(env, previous_sidecar),
                              static_cast<long long>(total)));
  } catch (...) {
    return nullptr;
  }
}
