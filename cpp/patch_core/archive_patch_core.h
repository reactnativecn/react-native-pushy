#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "patch_core.h"
#include "patch_manifest.h"

// Keep the core internal to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

namespace pushy {
namespace archive_patch {

enum class ArchivePatchType {
  // <generated:archive-patch-types> (scripts/contract.ts; bun scripts/generate-contract.ts)
  kFull = 1,
  kPatchFromPackage = 2,
  kPatchFromPpk = 3,
  // </generated:archive-patch-types>
};

enum class EntryAction {
  kSkip = 0,
  kExtract = 1,
};

// Every copy of one source. The manifest parser guarantees that copies of
// one source never declare different CRCs, so a group has at most one.
struct CopyGroup {
  std::string from;
  std::vector<std::string> to_paths;
  bool has_expected_crc = false;
  uint32_t expected_crc = 0;
};

struct ArchivePatchPlan {
  ArchivePatchType type = ArchivePatchType::kFull;
  delta::PatchManifest manifest;
  std::string merge_source_subdir;
  bool enable_merge = false;
};

EntryAction ClassifyEntry(
    ArchivePatchType type,
    const std::string& entry_name);

// Convert a platform-supplied integer to an ArchivePatchType. Returns false for
// unknown values so callers can fail loudly instead of silently treating an
// incremental patch as a full package (which would skip validation).
bool TryParseArchivePatchType(int value, ArchivePatchType* out);

// Name of the bundle delta entry inside a patch archive (index.bundlejs.patch),
// stored encoded (see obscured_text.h).
const std::string& DefaultBundleDeltaEntryName();

delta::Status BuildArchivePatchPlan(
    ArchivePatchType type,
    const delta::PatchManifest& manifest,
    const std::vector<std::string>& entry_names,
    ArchivePatchPlan* out_plan,
    const std::string& bundle_patch_entry_name = DefaultBundleDeltaEntryName());

delta::Status BuildCopyGroups(
    const delta::PatchManifest& manifest,
    std::vector<CopyGroup>* out_groups);

// What a staged patch archive declared: its entry names and the text of its
// __diff.json (empty when the archive has none).
struct ArchivePatchInput {
  ArchivePatchType type = ArchivePatchType::kFull;
  std::vector<std::string> entry_names;
  std::string manifest_json;
  std::string bundle_patch_entry_name = DefaultBundleDeltaEntryName();
  // See PatchManifestOptions::copy_source_prefix (HarmonyOS rawfiles).
  std::string copy_source_prefix;
};

// The patch types need the manifest and the bundle patch among the entries;
// the manifest is then parsed (ParsePatchManifest) and the merge planned.
// A full package plans nothing and ignores manifest_json.
delta::Status PlanArchivePatch(
    const ArchivePatchInput& input,
    ArchivePatchPlan* out_plan);

struct ArchivePatchRequest {
  ArchivePatchInput archive;
  std::string source_root;
  std::string target_root;
  std::string origin_bundle_path;
  std::string bundle_patch_path;
  std::string bundle_output_path;
  // The package's resources are not files under source_root (Android APK
  // entries, HarmonyOS rawfiles): only the bundle is rebuilt here, there is
  // nothing to merge, and the host performs the manifest's copies itself
  // from the groups handed back.
  bool host_copies_resources = false;
};

// PlanArchivePatch + ApplyPatchFromFileSource: the whole native half of a
// patch install, driven by the manifest text so the platforms never parse
// __diff.json themselves. With host_copies_resources, *out_host_copies (which
// must then be non-null) receives the grouped copies the host still owes;
// otherwise it is left empty. Full packages are rejected.
delta::Status ApplyArchivePatch(
    const ArchivePatchRequest& request,
    std::vector<CopyGroup>* out_host_copies,
    const delta::BundleRebuilder& bundle_patcher =
        delta::DefaultBundleRebuilder());

delta::Status BuildFileSourcePatchOptions(
    const ArchivePatchPlan& plan,
    const std::string& source_root,
    const std::string& target_root,
    const std::string& origin_bundle_path,
    const std::string& bundle_patch_path,
    const std::string& bundle_output_path,
    delta::FileSourcePatchOptions* out_options);

}  // namespace archive_patch
}  // namespace pushy

#pragma GCC visibility pop
