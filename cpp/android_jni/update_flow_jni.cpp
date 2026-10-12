// JNI surface of the update-flow decision layer for the Android orchestrator
// (SyncCoordinator.java). Pure string-in/string-out: every payload is
// JSON, matching the decision layer's own boundary. A null return means
// "input did not parse" and the caller skips the check round; a C++ exception
// (bad_alloc/length_error from an oversized body) maps onto that same path —
// it must never unwind through the JNI boundary.
#include <jni.h>

#include "jni_natives.h"

#include <string>

#include "jni_util.h"
#include "../update_flow_core/flow_json.h"
#include "../update_flow_core/native_config.h"
#include "../update_flow_core/native_round.h"

using pushy::jni_util::ToJString;

namespace {

// Parses a JSON object argument; Undefined (-> null result) otherwise.
flowjson::Value ParseObject(JNIEnv* env, jstring json) {
  bool ok = false;
  flowjson::Value value =
      flowjson::Parse(pushy::jni_util::JStringToString(env, json), &ok);
  return ok && value.IsObject() ? value : flowjson::Value::Undefined();
}

// Stringify, or null for an Undefined result (input the core rejected).
jstring ToJsonOrNull(JNIEnv* env, const flowjson::Value& value) {
  return value.IsUndefined() ? nullptr
                             : ToJString(env, flowjson::Stringify(value));
}

}  // namespace

// Native round (update_flow_core/native_round.h).
jstring pushy::jni_natives::FlowPrepareRound(JNIEnv* env, jclass,
                                             jstring configJson,
                                             jstring envJson,
                                             jdouble randomSample) {
  try {
    return ToJsonOrNull(
        env, flowcore::PrepareRound(
                 pushy::jni_util::JStringToString(env, configJson),
                 ParseObject(env, envJson), randomSample));
  } catch (...) {
    return nullptr;
  }
}

// A null responseText is a failed request (or none made yet).
jstring pushy::jni_natives::FlowNextQueryStep(JNIEnv* env, jclass,
                                              jstring stateJson,
                                              jstring responseText) {
  try {
    return ToJsonOrNull(
        env, flowcore::NextQueryStep(
                 ParseObject(env, stateJson),
                 responseText == nullptr
                     ? flowjson::Value::Undefined()
                     : flowjson::Value::String(pushy::jni_util::JStringToString(
                           env, responseText))));
  } catch (...) {
    return nullptr;
  }
}

jstring pushy::jni_natives::FlowHandleResponse(
    JNIEnv* env, jclass, jstring responseText, jstring configJson,
    jstring envJson, jstring requestBody, jlong responseAtSeconds) {
  try {
    return ToJsonOrNull(
        env, flowcore::HandleRoundResponse(
                 pushy::jni_util::JStringToString(env, responseText),
                 pushy::jni_util::JStringToString(env, configJson),
                 ParseObject(env, envJson),
                 pushy::jni_util::JStringToString(env, requestBody),
                 static_cast<double>(responseAtSeconds)));
  } catch (...) {
    return nullptr;
  }
}

// Persisted-config layer (update_flow_core/native_config.h). A null Java
// string is an absent config: never equivalent, not_configured at the gate.
jboolean pushy::jni_natives::FlowConfigsEquivalent(
    JNIEnv* env, jclass, jstring a, jstring b) {
  if (a == nullptr || b == nullptr) {
    return JNI_FALSE;
  }
  try {
    return flowcore::ConfigsEquivalent(pushy::jni_util::JStringToString(env, a),
                                       pushy::jni_util::JStringToString(env, b))
               ? JNI_TRUE
               : JNI_FALSE;
  } catch (...) {
    return JNI_FALSE;
  }
}

jstring pushy::jni_natives::FlowRunnableConfig(JNIEnv* env, jclass,
                                               jstring configJson) {
  try {
    return ToJString(env, flowcore::RunnableConfigJson(
                              pushy::jni_util::JStringToString(env, configJson)));
  } catch (...) {
    return nullptr;
  }
}

// Throws IllegalArgumentException("Invalid native configuration: ...") for
// options the host must fix; null only when memory ran out.
jstring pushy::jni_natives::FlowNormalizeConfiguration(JNIEnv* env, jclass,
                                                       jstring optionsJson) {
  try {
    std::string config;
    std::string error;
    if (!flowcore::NormalizeConfiguration(
            pushy::jni_util::JStringToString(env, optionsJson), &config,
            &error)) {
      jclass exception = env->FindClass("java/lang/IllegalArgumentException");
      if (exception != nullptr) {
        env->ThrowNew(exception, error.c_str());
      }
      return nullptr;
    }
    return ToJString(env, config);
  } catch (...) {
    return nullptr;
  }
}
