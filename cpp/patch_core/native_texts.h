#ifndef PUSHY_PATCH_CORE_NATIVE_TEXTS_H_
#define PUSHY_PATCH_CORE_NATIVE_TEXTS_H_

#include <string>
#include <vector>

#include "obscured_text.h"

// The plain text shipped native code needs but must not carry in its string
// tables (update wording, service addresses), stored encoded and decoded on
// first use. Shared by the C++ cores and iOS; Android and Harmony get their
// copies in Texts.java / Texts.ts. All generated from scripts/contract.ts.
// Keep the core internal to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

namespace pushy {
namespace texts {

// <generated:texts> (scripts/contract.ts; bun scripts/generate-contract.ts)
// The round status / decision reason when nothing is to be installed.
inline const std::string& StatusNone() {
  static const std::string value = text::Reveal("3418c1c1aa8a7c40");
  return value;
}
// Version-info flag of a version a crash hold installed (read by JS).
inline const std::string& InfoCrashHold() {
  static const std::string value = text::Reveal("3905f5c2a6b96d56212a19");
  return value;
}
// Version-info flag of a version the server forceBoot-activated.
inline const std::string& InfoForceBoot() {
  static const std::string value = text::Reveal("3c18e6d2aba9674a360d19ead5a695");
  return value;
}
inline const std::string& QueryPath() {
  static const std::string value = text::Reveal("7514fcd4ad805d55263e08fc99");
  return value;
}
// The afterDownload policy that activates for the next launch.
inline const std::string& PolicyNextLaunch() {
  static const std::string value = text::Reveal("2912e0ffab8e6c70323b1dedd3");
  return value;
}
inline const std::string& FieldAvailable() {
  static const std::string value = text::Reveal("2f07f0d0ba8e");
  return value;
}
// The bundle patch entry inside a patch archive.
inline const std::string& BundleDeltaEntry() {
  static const std::string value = text::Reveal("3319f0d4b6c56a502c3b10fcdca0de7d4b3307e9");
  return value;
}
inline const std::string& OptionUrlKey() {
  static const std::string value = text::Reveal("2f07f0d0ba8e5d572e");
  return value;
}
inline const std::string& PpkDeltaSuffix() {
  static const std::string value = text::Reveal("7407e4dae09b69512137");
  return value;
}
// Archive suffix of a patch against the installed package.
inline const std::string& PackageDeltaSuffix() {
  static const std::string value = text::Reveal("741ee4d0e09b69512137");
  return value;
}
inline const std::string& LogTag() {
  static const std::string value = text::Reveal("2812f5d2bac6664436360afc9ba680694b3301");
  return value;
}
inline const std::string& StateResultClass() {
  static const std::string value = text::Reveal("3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c93a99b63511201f9cd97878c695522");
  return value;
}
inline const std::string& CopyGroupResultClass() {
  static const std::string value = text::Reveal("3919bbc3ab8a6b512c3e08f0c0b6df60452311edfbc8f780624b2d1de38c83b28a6e732301fed897878c695522");
  return value;
}
// Pushy's own service addresses, configure()'s defaults.
inline std::vector<std::string> DefaultEndpoints() {
  return {
      text::Reveal("3203e0c1bdd1270a372f18f8c2b6de7f4f2607f5b3d5b9817b592947e5cdefbc8a7e"),
      text::Reveal("3203e0c1bdd1270a372f18f8c2b6de7f4f2607f5f0daac9c644a620ae88ca1ad93"),
  };
}
inline std::vector<std::string> DefaultQueryUrls() {
  return {
      text::Reveal("3203e0c1bdd1270a253608fcd3fd9362476817f4f0d5a1996342631be3c2a3a9d779552507fdcde8928a6f512f5ce2ccbdc869404d2f1de79daa826d562c0913eec4fa9b7d4426"),
      text::Reveal("3203e0c1bdd1270a213b12b7dca09468462e12f3b0d5bd813d482446f4c6a1be8e79552507fdcda68cd06e5c3710e480a4867048483e55e0c2ab8d7d43030d1ce9c3b183214e2601f2f0d5b782601e2719e8ca"),
  };
}
// </generated:texts>

}  // namespace texts
}  // namespace pushy

#pragma GCC visibility pop

#endif  // PUSHY_PATCH_CORE_NATIVE_TEXTS_H_
