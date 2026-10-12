// JNI surface of the update-flow decision layer for the Android orchestrator
// (SyncCoordinator.java). Pure string-in/string-out: every payload is
// JSON, matching the decision layer's own boundary. A null return means
// "input did not parse" and the caller skips the check round; a C++ exception
// (bad_alloc/length_error from an oversized body) maps onto that same path —
// it must never unwind through the JNI boundary.
#include <jni.h>

#include "jni_natives.h"

#include <string>

#include "../patch_core/jni_util.h"
#include "flow_json.h"
#include "update_flow_core.h"

using pushy::jni_util::ToJString;

jstring pushy::jni_natives::FlowBuildRequestBody(
    JNIEnv* env, jclass, jstring inputJson) {
  try {
    bool ok = false;
    flowjson::Value input = flowjson::Parse(
        pushy::jni_util::JStringToString(env, inputJson), &ok);
    if (!ok || !input.IsObject()) {
      return nullptr;
    }
    return ToJString(
        env, flowjson::Stringify(flowcore::BuildRequestBody(input)));
  } catch (...) {
    return nullptr;
  }
}

jstring pushy::jni_natives::FlowOrderEndpointCandidates(
    JNIEnv* env, jclass, jstring endpointsJson, jdouble randomSample) {
  try {
    bool ok = false;
    flowjson::Value endpoints = flowjson::Parse(
        pushy::jni_util::JStringToString(env, endpointsJson), &ok);
    if (!ok || !endpoints.IsArray()) {
      return nullptr;
    }
    return ToJString(env, flowjson::Stringify(flowcore::OrderEndpointCandidates(
                              endpoints, randomSample)));
  } catch (...) {
    return nullptr;
  }
}

jboolean pushy::jni_natives::FlowIsValidResponse(
    JNIEnv* env, jclass, jstring responseText) {
  if (responseText == nullptr) {
    return JNI_FALSE;
  }
  try {
    return flowcore::IsValidResponse(
               pushy::jni_util::JStringToString(env, responseText))
               ? JNI_TRUE
               : JNI_FALSE;
  } catch (...) {
    return JNI_FALSE;
  }
}

jstring pushy::jni_natives::FlowHandleResponse(
    JNIEnv* env, jclass, jstring responseText, jstring identityJson,
    jstring afterDownload) {
  try {
    bool ok = false;
    flowjson::Value identity = flowjson::Parse(
        pushy::jni_util::JStringToString(env, identityJson), &ok);
    if (!ok || !identity.IsObject()) {
      return nullptr;
    }
    return ToJString(env, flowjson::Stringify(flowcore::HandleResponse(
                              pushy::jni_util::JStringToString(env, responseText),
                              identity, false,
                              pushy::jni_util::JStringToString(env, afterDownload))));
  } catch (...) {
    return nullptr;
  }
}
