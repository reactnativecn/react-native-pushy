#include "patch_manifest.h"

#include <cmath>
#include <cstdint>
#include <unordered_map>
#include <utility>

// Relative like every other cross-core include (see patch_core.cpp's hpatch.h
// include): use_frameworks! flattens the pod's headers.
#include "../update_flow_core/flow_json.h"

namespace pushy {
namespace delta {
namespace {

constexpr const char* kErrorPrefix = "delta manifest: ";

Status ManifestError(const std::string& message) {
  return Status::Error(kErrorPrefix + message);
}

// null counts as absent everywhere (JSON writers emit it for empty maps).
bool IsAbsent(const flowjson::Value& value) {
  return value.IsUndefined() ||
         value.kind() == flowjson::Value::Kind::Null;
}

// An integer in [0, 2^32): the only CRC value a client can compare.
bool ReadCrc32(const flowjson::Value& value, uint32_t* out) {
  if (!value.IsNumber()) {
    return false;
  }
  const double number = value.AsNumber();
  if (!std::isfinite(number) || number < 0 || number > 4294967295.0 ||
      std::floor(number) != number) {
    return false;
  }
  *out = static_cast<uint32_t>(number);
  return true;
}

Status ParseCopies(
    const flowjson::Value& copies,
    const flowjson::Value& copies_crc,
    const PatchManifestOptions& options,
    PatchManifest* manifest) {
  if (IsAbsent(copies)) {
    return Status::Ok();
  }
  if (!copies.IsObject()) {
    return ManifestError("copies is not an object");
  }
  if (!IsAbsent(copies_crc) && !copies_crc.IsObject()) {
    return ManifestError("copiesCrc is not an object");
  }
  // Target -> declared CRC value; one pass, not a member scan per copy.
  std::unordered_map<std::string, const flowjson::Value*> crc_by_target;
  if (copies_crc.IsObject()) {
    crc_by_target.reserve(copies_crc.members().size());
    for (const auto& member : copies_crc.members()) {
      crc_by_target.emplace(member.first, &member.second);
    }
  }
  const std::string& prefix = options.copy_source_prefix;
  // Source -> the CRC some copy of it declared, to catch contradictions.
  std::unordered_map<std::string, uint32_t> crc_by_source;
  manifest->copies.reserve(copies.members().size());
  for (const auto& member : copies.members()) {
    const std::string& to = member.first;
    const flowjson::Value& from_value = member.second;
    std::string from;
    if (from_value.IsString()) {
      from = from_value.AsString();
    } else if (!IsAbsent(from_value)) {
      return ManifestError("copies entry is not a string: " + to);
    }
    if (!prefix.empty() && from.compare(0, prefix.size(), prefix) == 0) {
      from.erase(0, prefix.size());
    }
    if (from.empty()) {
      from = to;
    }

    CopyOperation copy;
    copy.from = std::move(from);
    copy.to = to;
    const auto declared = crc_by_target.find(to);
    if (declared != crc_by_target.end()) {
      const flowjson::Value& crc = *declared->second;
      if (!IsAbsent(crc)) {
        if (!ReadCrc32(crc, &copy.expected_crc)) {
          return ManifestError("copiesCrc entry is not a CRC32: " + to);
        }
        copy.has_expected_crc = true;
        const auto inserted =
            crc_by_source.emplace(copy.from, copy.expected_crc);
        if (!inserted.second &&
            inserted.first->second != copy.expected_crc) {
          return ManifestError("conflicting copiesCrc for source " + copy.from);
        }
      }
    }
    manifest->copies.push_back(std::move(copy));
  }
  return Status::Ok();
}

Status ParseDeletes(const flowjson::Value& deletes, PatchManifest* manifest) {
  if (IsAbsent(deletes)) {
    return Status::Ok();
  }
  if (deletes.IsObject()) {
    manifest->deletes.reserve(deletes.members().size());
    for (const auto& member : deletes.members()) {
      manifest->deletes.push_back(member.first);
    }
    return Status::Ok();
  }
  if (deletes.IsArray()) {
    manifest->deletes.reserve(deletes.Size());
    for (const flowjson::Value& path : deletes.elements()) {
      if (!path.IsString()) {
        return ManifestError("deletes entry is not a string");
      }
      manifest->deletes.push_back(path.AsString());
    }
    return Status::Ok();
  }
  return ManifestError("deletes is not an object or array");
}

Status ParseHbcTransform(
    const flowjson::Value& hbc_transform,
    const PatchManifestOptions& options,
    PatchManifest* manifest) {
  if (IsAbsent(hbc_transform)) {
    return Status::Ok();
  }
  if (!hbc_transform.IsObject()) {
    return ManifestError("hbcTransform is not an object");
  }
  const flowjson::Value& meta =
      hbc_transform.Get(options.bundle_patch_entry_name);
  if (IsAbsent(meta)) {
    return Status::Ok();
  }
  if (!meta.IsObject()) {
    return ManifestError(
        "hbcTransform entry is not an object: " +
        options.bundle_patch_entry_name);
  }
  manifest->bundle_hbc_transform_meta = flowjson::Stringify(meta);
  return Status::Ok();
}

}  // namespace

Status ParsePatchManifest(
    const std::string& json_text,
    const PatchManifestOptions& options,
    PatchManifest* out) {
  if (out == nullptr) {
    return Status::Error("Manifest output is required");
  }
  flowjson::ParseLimits limits;
  limits.max_input_bytes =
      static_cast<size_t>(archive_limits::kMaxManifestBytes);
  limits.max_nodes = kMaxManifestNodes;
  bool ok = false;
  const flowjson::Value root = flowjson::Parse(json_text, limits, &ok);
  if (!ok) {
    return ManifestError("invalid JSON or over the size limits");
  }
  if (!root.IsObject()) {
    return ManifestError("not a JSON object");
  }

  PatchManifest manifest;
  Status status =
      ParseCopies(root.Get("copies"), root.Get("copiesCrc"), options, &manifest);
  if (!status) {
    return status;
  }
  status = ParseDeletes(root.Get("deletes"), &manifest);
  if (!status) {
    return status;
  }
  status = ParseHbcTransform(root.Get("hbcTransform"), options, &manifest);
  if (!status) {
    return status;
  }
  status = ValidateManifest(manifest);
  if (!status) {
    return status;
  }
  *out = std::move(manifest);
  return Status::Ok();
}

}  // namespace delta
}  // namespace pushy
