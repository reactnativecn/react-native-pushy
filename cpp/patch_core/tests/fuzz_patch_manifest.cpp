// libFuzzer harness for the __diff.json parser (patch_manifest.h): the whole
// manifest is untrusted archive content. Build and run with
//   FUZZ=1 ./scripts/test-patch-core.sh
// (clang -fsanitize=fuzzer,address,undefined). Any crash, sanitizer report or
// abort is a finding. The first input byte picks the options so both the
// plain and the HarmonyOS (rawfile prefix) forms are covered.
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <unordered_map>
#include <vector>

#include "../archive_patch_core.h"
#include "../hbc_transform_wire.h"
#include "../patch_manifest.h"

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
  if (size == 0) {
    return 0;
  }
  pushy::delta::PatchManifestOptions options;
  options.bundle_patch_entry_name =
      (data[0] & 1) ? "bundle.harmony.js.patch" : "index.bundlejs.patch";
  if (data[0] & 2) {
    options.copy_source_prefix = "resources/rawfile/";
  }
  const std::string json(reinterpret_cast<const char*>(data + 1), size - 1);

  pushy::delta::PatchManifest manifest;
  if (!pushy::delta::ParsePatchManifest(json, options, &manifest).ok) {
    return 0;
  }
  // Whatever parses is safe to apply and self-consistent.
  if (!pushy::delta::ValidateManifest(manifest).ok) {
    std::abort();
  }
  std::unordered_map<std::string, uint32_t> crc_by_source;
  for (const pushy::delta::CopyOperation& copy : manifest.copies) {
    if (!copy.has_expected_crc) {
      continue;
    }
    const auto inserted = crc_by_source.emplace(copy.from, copy.expected_crc);
    if (!inserted.second && inserted.first->second != copy.expected_crc) {
      std::abort();
    }
  }
  std::vector<pushy::archive_patch::CopyGroup> groups;
  if (!pushy::archive_patch::BuildCopyGroups(manifest, &groups).ok) {
    std::abort();
  }
  // The re-serialized metadata goes on to the strict wire parser.
  if (!manifest.bundle_hbc_transform_meta.empty()) {
    pushy::hbc::HbcTransformMeta meta;
    pushy::hbc::ParseHbcTransformMeta(manifest.bundle_hbc_transform_meta, &meta);
  }
  return 0;
}
