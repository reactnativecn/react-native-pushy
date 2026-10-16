// Registers the Android native methods from JNI_OnLoad instead of exporting
// Java_<package>_<class>_<method> symbols: the shared library then exports only
// JNI_OnLoad, and the class names, method names and signatures used for
// registration are stored encoded (obscured_text.h,
// scripts/encode-native-text.ts). Regenerate the table when a native method
// is added or its Java signature changes.
#include <jni.h>

#include <string>
#include <vector>

#include "jni_log.h"
#include "jni_natives.h"
#include "../patch_core/obscured_text.h"

namespace {

struct NativeMethod {
  const char* name;
  const char* signature;
  void* function;
};

struct NativeClass {
  const char* name;
  std::vector<NativeMethod> methods;
};

const std::vector<NativeClass>& NativeClasses() {
  static const std::vector<NativeClass> classes = {
  // <generated:natives> (scripts/contract.ts; bun scripts/generate-contract.ts)
  {"3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c8ebc8e7e42342de4daa0",  // NativeCore
   {
       {"3d12e0e2bb9b784a302b19fdf2ba966b7c2216f2f7d4b6", "725edd",
        reinterpret_cast<void*>(&pushy::jni_natives::SupportedDiffVersion)},
   }},
  {"3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c95ad9e7640342de4c6b1878768",  // UpdateContext
   {
       {"290efad29d9f6951270815edde9199634b351dd7fbc9ab9c7d41", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655c7cbabcd8d79583507feccbe8e7244113617f1c7a3897a09361019fbc3b1de5d5f2911e7dcd3ab9341553e1febd0faf7b77b5b7d1de9c8a5976e7c4e3e02f481a687615753390ab9c6a0896b53214e2defd9a1974c433b03d1c5ceaf9b600a",
        reinterpret_cast<void*>(&pushy::jni_natives::SyncStateWithBinaryVersion)},
       {"2802fae2ba8a7c4001300efc", "723ed8d2a0c47a40233c08f7d7a7997b4f6809eefaceb49061003919e2c2b4b8d54440301aeeebaa909a4e5c2506fcd9f1ab6e40483a57f9d3a18b2675371214f4d0efab54020406ecb0cebc977044230bf3cdb7bbd4755a361ae0ccb5cc756d5e3600f481989c64565a1f16e4d682887952281545",
        reinterpret_cast<void*>(&pushy::jni_natives::RunStateCore)},
   }},
  {"3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c84b28d79583e0feffca49194",  // DownloadTask
   {
       {"3b07e4ddb7aa7a462a360afcf2b69c794b", "723ecffda48a7e446d331df7d1fca379582e0ae6a5e09ab9784e3a08a9cfa1b39d3867251ce2c6a2d9b376582012bfc1ab89630e6d2f0afcdca8d7454c22161cb5dbb59f69041b11f0f6d2becd5f5a2c1ce68badbf957f1a011bfec0a8843b51503602f081a7896b45100f0de4dabe8a317d6d3a32f8d6fa806a4d2a12edc1c9b381711e2304ecd0aeba8f36432314ecdea2cb42714b2132e0c0b9995446332816e38f",
        reinterpret_cast<void*>(&pushy::jni_natives::ApplyArchiveDelta)},
       {"391bf1d0a09e786a2e3b39f7c2a1996859", "723bfed0b88a274923311bb6e5a7826444205fdad2d1b98373002008e8c4ef8e8e655d3f09b0e189889e6a58791ff1c3adc857554c3216f289e6ba",
        reinterpret_cast<void*>(&pushy::jni_natives::CleanupOldEntries)},
   }},
  {"3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c86b19560762307efcfa0",  // FlowBridge
   {
       {"2a05f1c1af996d772d2a12fd", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655cf8189889e6a58791ff1c3adc857554c3216f289",
        reinterpret_cast<void*>(&pushy::jni_natives::FlowPrepareRound)},
       {"3412ecc59f9e6d573b0c08fcc6", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655a2e4af83897d163a12fecae5b4705357351fae",
        reinterpret_cast<void*>(&pushy::jni_natives::FlowNextQueryStep)},
       {"2903f1c19c847d4b26", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655a2e4af83897d163a12fecae5b4705357351fae",
        reinterpret_cast<void*>(&pushy::jni_natives::FlowStepRound)},
       {"3216fad5a28e5a40312f13f7c5b6", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655c7c2a4949e3355371df78299937648503c43d9d8ae9a68092f0113fd9887857c422602b9d595959c72462c45ebc5afb9d44b412006e2cefd",
        reinterpret_cast<void*>(&pushy::jni_natives::FlowHandleResponse)},
       {"3918fad7a78c7b60332a15efd7bf95635e", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655a2f2",
        reinterpret_cast<void*>(&pushy::jni_natives::FlowConfigsEquivalent)},
       {"2802fadfaf896440013012ffdfb4", "723bfed0b88a274923311bb6e5a7826444205fa8d2d1b98373002008e8c4ef8e8e655d3f09b0",
        reinterpret_cast<void*>(&pushy::jni_natives::FlowRunnableConfig)},
       {"3418e6dcaf87615f271c13f7d0ba9778582610e8f1d5", "723bfed0b88a274923311bb6e5a7826444205fa8d2d1b98373002008e8c4ef8e8e655d3f09b0",
        reinterpret_cast<void*>(&pushy::jni_natives::FlowNormalizeConfiguration)},
   }},
  {"3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c89b38963553d02d9cda68d8d78",  // InstallRecord
   {
       {"3304d7dea39b6440363a", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655c7c2a4949e3355371df78299937648503c43bce8",
        reinterpret_cast<void*>(&pushy::jni_natives::InstallRecordIsComplete)},
       {"391ff1d2a5aa6b512b291deddfbc9e", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655c7c2a4949e3355371df78299937648503c43cf9b83866850224f11fbd9b3de5d5f3a0cecf887",
        reinterpret_cast<void*>(&pushy::jni_natives::InstallRecordCheckActivation)},
       {"2912f5dd9d9f69422b311b", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655c7c2a4949e3355371df78299937648503c43d9d8ae9a68092f0113fd9887857c422602b9d3d6b880721f210be9c3ee8d8f6a5c3c08b7808a89616b5b7818f0c0acc756564d3517f188",
        reinterpret_cast<void*>(&pushy::jni_natives::InstallRecordSeal)},
       {"2a05fbdca19f6d76363e1bf0d8b4", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655a2e4af83897d163a12fecae5b4705357351fae",
        reinterpret_cast<void*>(&pushy::jni_natives::InstallRecordPromote)},
       {"3802fad5a28e5b4d236d49aff9b5", "723bfed0b88a274923311bb6e5a7826444205fa8d2d1b98373002008e8c4ef8e8e655d3f09b0",
        reinterpret_cast<void*>(&pushy::jni_natives::InstallRecordBundleSha256)},
   }},
  {"3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c81af997f5d270bc7c1a88b8b6f",  // ArchiveLimits
   {
       {"391ff1d2a5ae6651303619ea", "723dcffda48a7e446d331df7d1fca379582e0ae6a5e092ae580606",
        reinterpret_cast<void*>(&pushy::jni_natives::ArchiveCheckEntries)},
       {"2a1bf5df88996d40112f1dfad38382624822", "723ddefb84c2536f",
        reinterpret_cast<void*>(&pushy::jni_natives::ArchivePlanFreeSpaceProbe)},
   }},
  {"3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c92b8896259343ee7c9ab",  // ResumePlan
   {
       {"2a1bf5df9c8e7950272c08", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655c18189889e6a58791ff1c3adc857554c3216f289",
        reinterpret_cast<void*>(&pushy::jni_natives::ResumePlanRequest)},
       {"391bf5c2bd826e5c103a0fe9d9bd8368", "723edefda48a7e446d331df7d1fca379582e0ae6a5f7b294644e6305e7cda7f2a963463800ec938fae957d4f375cfccca4802b724a2911fbd5f4a06347350152f6d6ba9621783c17ebf1dbe2bc3a7c270bf1c5eeb29a76527d3cf8dbaf8d6726",
        reinterpret_cast<void*>(&pushy::jni_natives::ResumeClassifyResponse)},
       {"291ef0d4ad8a7a", "723bfed0b88a274923311bb6e5a7826444205fcdf4daae943d432d07e18c93a9887e5a3655c7c2a4949e3355371df78299937648503c43d9d8ae9a68092f0113fd9887857c422602b9d595959c72462c45ebc5afb9d44b412006e2cefd",
        reinterpret_cast<void*>(&pushy::jni_natives::ResumeSidecar)},
   }},
  // </generated:natives>
  };
  return classes;
}

// Registers each method on its own: a host's R8 build may drop an unused
// class or native method, which must not prevent the rest from binding. A
// failure is still logged (release builds too): otherwise the first call of
// the unbound method surfaces as an UnsatisfiedLinkError with no hint why.
void RegisterAll(JNIEnv* env) {
  for (const NativeClass& native_class : NativeClasses()) {
    const std::string class_name = pushy::text::Reveal(native_class.name);
    jclass clazz = env->FindClass(class_name.c_str());
    if (clazz == nullptr) {
      env->ExceptionClear();
      PUSHY_JNI_LOGE("JNI binding: class %s not found, %zu native methods unbound",
                     class_name.c_str(), native_class.methods.size());
      continue;
    }
    for (const NativeMethod& method : native_class.methods) {
      const std::string name = pushy::text::Reveal(method.name);
      const std::string signature = pushy::text::Reveal(method.signature);
      const JNINativeMethod entry = {
          const_cast<char*>(name.c_str()),
          const_cast<char*>(signature.c_str()),
          method.function,
      };
      if (env->RegisterNatives(clazz, &entry, 1) != JNI_OK) {
        env->ExceptionClear();
        PUSHY_JNI_LOGE("JNI binding: %s.%s%s could not be registered",
                       class_name.c_str(), name.c_str(), signature.c_str());
      }
    }
    env->DeleteLocalRef(clazz);
  }
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  JNIEnv* env = nullptr;
  if (vm->GetEnv(reinterpret_cast<void**>(&env), JNI_VERSION_1_6) != JNI_OK) {
    return JNI_ERR;
  }
  RegisterAll(env);
  // Result classes and their field IDs are resolved once here; a failure is
  // logged inside and makes the affected natives throw instead of guessing.
  pushy::jni_natives::InitResultClassCache(env);
  return JNI_VERSION_1_6;
}
