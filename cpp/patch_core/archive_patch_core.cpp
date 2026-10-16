#include "archive_patch_core.h"

#include <unordered_map>
#include <utility>

#include "native_texts.h"

namespace pushy {
namespace archive_patch {
namespace {

constexpr const char* kManifestEntryName = "__diff.json";
bool HasEntry(const std::vector<std::string>& entry_names, const std::string& name) {
  for (const std::string& entry_name : entry_names) {
    if (entry_name == name) {
      return true;
    }
  }
  return false;
}

}  // namespace

const std::string& DefaultBundleDeltaEntryName() {
  return texts::BundleDeltaEntry();
}

EntryAction ClassifyEntry(
    ArchivePatchType type,
    const std::string& entry_name) {
  if (type == ArchivePatchType::kFull) {
    return EntryAction::kExtract;
  }
  return entry_name == kManifestEntryName ? EntryAction::kSkip : EntryAction::kExtract;
}

bool TryParseArchivePatchType(int value, ArchivePatchType* out) {
  switch (value) {
    case 1:
      *out = ArchivePatchType::kFull;
      return true;
    case 2:
      *out = ArchivePatchType::kPatchFromPackage;
      return true;
    case 3:
      *out = ArchivePatchType::kPatchFromPpk;
      return true;
    default:
      return false;
  }
}

delta::Status BuildArchivePatchPlan(
    ArchivePatchType type,
    const delta::PatchManifest& manifest,
    const std::vector<std::string>& entry_names,
    ArchivePatchPlan* out_plan,
    const std::string& bundle_patch_entry_name) {
  if (out_plan == nullptr) {
    return delta::Status::Error("Archive plan output is required");
  }

  delta::Status manifest_status = delta::ValidateManifest(manifest);
  if (!manifest_status.ok) {
    return manifest_status;
  }

  out_plan->type = type;
  out_plan->manifest = manifest;
  out_plan->merge_source_subdir.clear();
  out_plan->enable_merge = false;

  switch (type) {
    case ArchivePatchType::kFull:
      return delta::Status::Ok();
    case ArchivePatchType::kPatchFromPackage:
    case ArchivePatchType::kPatchFromPpk:
      if (!HasEntry(entry_names, kManifestEntryName)) {
        return delta::Status::Error("diff.json not found");
      }
      if (!HasEntry(entry_names, bundle_patch_entry_name)) {
        return delta::Status::Error("bundle delta not found");
      }
      out_plan->merge_source_subdir =
          type == ArchivePatchType::kPatchFromPackage ? "assets" : "";
      out_plan->enable_merge = true;
      return delta::Status::Ok();
  }

  return delta::Status::Error("Unknown archive delta type");
}

delta::Status BuildCopyGroups(
    const delta::PatchManifest& manifest,
    std::vector<CopyGroup>* out_groups) {
  if (out_groups == nullptr) {
    return delta::Status::Error("Copy groups output is required");
  }

  delta::Status manifest_status = delta::ValidateManifest(manifest);
  if (!manifest_status.ok) {
    return manifest_status;
  }

  // Groups in order of first appearance; the index keeps this linear in the
  // number of copies (a package diff copies thousands of resources).
  std::vector<CopyGroup> groups;
  std::unordered_map<std::string, size_t> group_by_source;
  for (const delta::CopyOperation& copy : manifest.copies) {
    const auto inserted = group_by_source.emplace(copy.from, groups.size());
    if (inserted.second) {
      CopyGroup group;
      group.from = copy.from;
      groups.push_back(std::move(group));
    }
    CopyGroup& group = groups[inserted.first->second];
    group.to_paths.push_back(copy.to);
    if (copy.has_expected_crc) {
      group.has_expected_crc = true;
      group.expected_crc = copy.expected_crc;
    }
  }
  *out_groups = std::move(groups);

  return delta::Status::Ok();
}

delta::Status PlanArchivePatch(
    const ArchivePatchInput& input,
    ArchivePatchPlan* out_plan) {
  if (out_plan == nullptr) {
    return delta::Status::Error("Archive plan output is required");
  }
  if (input.type == ArchivePatchType::kFull) {
    return BuildArchivePatchPlan(
        input.type, delta::PatchManifest(), input.entry_names, out_plan,
        input.bundle_patch_entry_name);
  }
  // Missing entries first: an archive without __diff.json has no text to
  // parse, and the entry error is the one worth reporting.
  if (!HasEntry(input.entry_names, kManifestEntryName)) {
    return delta::Status::Error("diff.json not found");
  }
  if (!HasEntry(input.entry_names, input.bundle_patch_entry_name)) {
    return delta::Status::Error("bundle delta not found");
  }
  delta::PatchManifestOptions options;
  options.bundle_patch_entry_name = input.bundle_patch_entry_name;
  options.copy_source_prefix = input.copy_source_prefix;
  delta::PatchManifest manifest;
  delta::Status status =
      delta::ParsePatchManifest(input.manifest_json, options, &manifest);
  if (!status.ok) {
    return status;
  }
  return BuildArchivePatchPlan(
      input.type, manifest, input.entry_names, out_plan,
      input.bundle_patch_entry_name);
}

delta::Status ApplyArchivePatch(
    const ArchivePatchRequest& request,
    std::vector<CopyGroup>* out_host_copies,
    const delta::BundleRebuilder& bundle_patcher) {
  if (request.archive.type == ArchivePatchType::kFull) {
    return delta::Status::Error("A full package has no delta to apply");
  }
  if (request.host_copies_resources && out_host_copies == nullptr) {
    return delta::Status::Error("Host copy groups output is required");
  }
  if (out_host_copies != nullptr) {
    out_host_copies->clear();
  }
  ArchivePatchPlan plan;
  delta::Status status = PlanArchivePatch(request.archive, &plan);
  if (!status.ok) {
    return status;
  }
  delta::FileSourcePatchOptions options;
  status = BuildFileSourcePatchOptions(
      plan, request.source_root, request.target_root,
      request.origin_bundle_path, request.bundle_patch_path,
      request.bundle_output_path, &options);
  if (!status.ok) {
    return status;
  }
  std::vector<CopyGroup> host_copies;
  if (request.host_copies_resources) {
    status = BuildCopyGroups(plan.manifest, &host_copies);
    if (!status.ok) {
      return status;
    }
    options.manifest.copies.clear();
    options.manifest.deletes.clear();
    options.enable_merge = false;
  }
  status = delta::ApplyPatchFromFileSource(options, bundle_patcher);
  if (!status.ok) {
    return status;
  }
  if (out_host_copies != nullptr) {
    *out_host_copies = std::move(host_copies);
  }
  return delta::Status::Ok();
}

delta::Status BuildFileSourcePatchOptions(
    const ArchivePatchPlan& plan,
    const std::string& source_root,
    const std::string& target_root,
    const std::string& origin_bundle_path,
    const std::string& bundle_patch_path,
    const std::string& bundle_output_path,
    delta::FileSourcePatchOptions* out_options) {
  if (out_options == nullptr) {
    return delta::Status::Error("Delta options output is required");
  }

  out_options->manifest = plan.manifest;
  out_options->source_root = source_root;
  out_options->target_root = target_root;
  out_options->origin_bundle_path = origin_bundle_path;
  out_options->bundle_patch_path = bundle_patch_path;
  out_options->bundle_output_path = bundle_output_path;
  out_options->merge_source_subdir = plan.merge_source_subdir;
  out_options->enable_merge = plan.enable_merge;
  return delta::Status::Ok();
}

}  // namespace archive_patch
}  // namespace pushy
