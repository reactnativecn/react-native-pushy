#pragma once

#include <cstddef>
#include <string>

#include "archive_limits.h"
#include "patch_core.h"

// Keep the core internal to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

namespace pushy {
namespace delta {

// __diff.json, the manifest inside every patch archive, as the generators
// emit it (pushy-go internal/taskexecutor/bundle_diff.go and
// react-native-update-cli src/diff.ts):
//
//   {"copies":       {"<to>": "<from>" | "", ...},
//    "copiesCrc":    {"<to>": <crc32>, ...},          package diffs only
//    "deletes":      {"<path>": 1, ...},              ppk diffs only
//    "hbcTransform": {"<bundle patch entry>": {...}}} hdiffv2 track only
//
// The one parser of that file on Android, iOS and HarmonyOS. The rules are
// the most permissive form that is still safe; anything else fails the
// patch, and the JS strategy chain falls back to the full package:
//  - the text is a JSON object (at most archive_limits::kMaxManifestBytes,
//    at most kMaxManifestNodes values); unknown members are ignored, and a
//    member that is null counts as absent;
//  - copies: an object of target -> source strings. An empty (or null)
//    source means "same path as the target". Order follows the document;
//  - copiesCrc: an object keyed by copy *target* (not source). Each value is
//    an integer in [0, 2^32) or null; any other value is an error (a CRC the
//    client cannot honour must not silently skip the content check). Keys
//    naming no copy are ignored. Two copies of one source that declare
//    different CRCs are a self-contradictory manifest and an error;
//  - deletes: an object (its keys) or an array of strings;
//  - hbcTransform: an object; its member named after the bundle patch entry,
//    when present, must be an object and is handed on re-serialized
//    (PatchManifest::bundle_hbc_transform_meta). Non-object metadata is an
//    error, never ignored: applying a transform-domain patch without the
//    transform produces a corrupt bundle;
//  - every path passes ValidateManifest.
// Values of the wrong type (a numeric source, a non-string delete, copies as
// an array, ...) are errors on every platform.
struct PatchManifestOptions {
  // The archive entry whose hbcTransform metadata is extracted
  // (archive_patch::DefaultBundleDeltaEntryName() unless the platform names
  // its bundle differently, e.g. HarmonyOS).
  std::string bundle_patch_entry_name;
  // Stripped once from the start of every copy source that begins with it,
  // before the empty-source rule applies. HarmonyOS package diffs name the
  // origin entries by their HAP path ("resources/rawfile/assets/a.png"),
  // which the resource manager reads back as "assets/a.png".
  std::string copy_source_prefix;
};

// A package holds at most archive_limits::kMaxEntries entries, and the
// generators emit at most one copy source, one CRC and one delete per entry
// (plus a few hundred values of hbcTransform metadata). The cap bounds the
// parsed tree of a hostile 16 MB manifest to about ten MB of heap.
constexpr size_t kMaxManifestNodes =
    4 * static_cast<size_t>(archive_limits::kMaxEntries);

// Fails without touching *out.
Status ParsePatchManifest(
    const std::string& json_text,
    const PatchManifestOptions& options,
    PatchManifest* out);

}  // namespace delta
}  // namespace pushy

#pragma GCC visibility pop
