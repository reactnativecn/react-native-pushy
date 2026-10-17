// JNI surface of the persisted-layout migration (cpp/patch_core/
// stored_items.h) for StoreMigration.java. Flat key/value arrays in, JSON
// text out; a null return means the core threw (memory ran out) and the
// caller falls back to carrying the uuid alone — a C++ exception must never
// unwind through the JNI boundary.
#include <jni.h>

#include "jni_natives.h"

#include <string>
#include <vector>

#include "jni_util.h"
#include "../patch_core/stored_items.h"

using pushy::jni_util::JArrayToVector;
using pushy::jni_util::ToJString;

jstring pushy::jni_natives::StoredItemsMigrate(JNIEnv* env, jclass, jint legacy_layout,
                                               jobjectArray legacy, jobjectArray current) {
  try {
    return ToJString(env, pushy::stored::MigrateStoredItemsJson(
                              static_cast<int>(legacy_layout), JArrayToVector(env, legacy),
                              JArrayToVector(env, current)));
  } catch (...) {
    return nullptr;
  }
}
