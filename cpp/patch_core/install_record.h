#ifndef PUSHY_PATCH_CORE_INSTALL_RECORD_H_
#define PUSHY_PATCH_CORE_INSTALL_RECORD_H_

#include <cstdint>
#include <string>

#include "patch_core.h"

// The completion record every platform writes into a version directory once
// an install fully succeeded, and reads back before trusting that directory.
//
//   <root>/<hash>/.pushy-complete
//   {"schema":1,"versionHash":"<hash>","bundleSha256":"<hex>","artifactSha256":"<hex>"}
//
// - Written by the SDK only (archives may not ship a `.pushy-*` entry), as
//   the LAST step of a two-phase install: unpack/patch into
//   <root>/<hash>.staging, Seal() the record there, then Promote() renames
//   the staging directory to <root>/<hash>.
// - versionHash must equal the directory name; bundleSha256 is the digest of
//   the final bundle (index.bundlejs; bundle.harmony.js on Harmony) and is
//   re-verified at switchVersion time; artifactSha256 is the digest of the
//   downloaded archive (diagnostics / CDN corruption attribution, optional).
// - bundleSha256 is MANDATORY for schema 1. A writer whose bundle digest is
//   empty or fails must fail the install (staging dropped, no record); a
//   verifier must reject a non-empty record without one (record mismatch),
//   never activate the version unverified.
// - Legacy: an EMPTY (zero-byte) file is a completed install written by
//   SDK < 10.53 (no digests); it stays trusted for presence, nothing to
//   verify. Any other content must be a schema-1 record.
//
// This is the only implementation: Android (InstallRecord.java over JNI,
// cpp/android_jni/install_record_jni.cpp), iOS (RCTPushyInstallRecord.mm)
// and Harmony (InstallRecord.ts over NAPI, pushy.cpp) call it. The bundle
// file name is the caller's, since it differs per platform. The constants
// (and the staging suffix the hosts build their unpack directory from) are
// generated from scripts/contract.ts.

// Keep the core internal to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

namespace pushy {
namespace install_record {

using delta::Status;

// <generated:constants> (scripts/contract.ts; bun scripts/generate-contract.ts)
constexpr int kSchema = 1;
constexpr const char* kFileName = ".pushy-complete";
// Every name starting with this prefix, at any depth of a version directory,
// belongs to the SDK (the record, its temp file): no archive may ship one
// (archive_limits::IsReservedEntryName).
constexpr const char* kReservedPrefix = ".pushy-";
constexpr const char* kStagingSuffix = ".staging";
// A record is a few hundred bytes; anything larger is not one.
constexpr long long kMaxRecordBytes = 64 * 1024;
// </generated:constants>

// A record file's contents.
struct Record {
  enum class State {
    kAbsent,   // no such entry
    kInvalid,  // not a readable regular file of at most kMaxRecordBytes, or
               // not a JSON object
    kLegacy,   // the zero-byte marker of SDK < 10.53
    kPresent,  // a JSON object
  };
  State state = State::kAbsent;
  // kPresent only. A member that is missing or of another JSON type reads
  // as false / empty: records are written by this code alone, so nothing is
  // coerced.
  bool current_schema = false;  // "schema" is the number kSchema
  std::string version_hash;
  std::string bundle_sha256;
  std::string artifact_sha256;
};

// The text of a record file: "" is kLegacy, a JSON object kPresent,
// anything else (or more than kMaxRecordBytes) kInvalid.
Record Parse(const std::string& text);

// Whether a kPresent record is a schema-1 record naming this version.
bool Names(const Record& record, const std::string& version_hash);

// <version_dir>/.pushy-complete, parsed.
Record Read(const std::string& version_dir);

// Whether <version_dir>/.pushy-complete exists at all (of any type). Only a
// directory WITHOUT one may be grandfathered through current/last state.
bool HasRecordFile(const std::string& version_dir);

// The schema-1 record text. Fails when bundle_sha256 is empty: a version
// whose bundle could not be hashed must never be recorded as installed.
// artifact_sha256 is optional and omitted when empty.
Status Build(const std::string& version_hash,
             const std::string& bundle_sha256,
             const std::string& artifact_sha256,
             std::string* out);

// Writes record_json as <dir>/.pushy-complete atomically and durably: a
// temporary sibling is written and fsynced, renamed over the record, and the
// directory is fsynced (best-effort: a file system that refuses a directory
// fsync does not fail the install).
Status Write(const std::string& dir, const std::string& record_json);

struct SealResult {
  Status status = Status::Ok();
  // The record could not be written (a file-system failure), as opposed to
  // an install that produced no hashable bundle.
  bool file_failure = false;
};

// The second phase's first half: hashes <staging_dir>/<bundle_file_name>
// (unless the caller already knows its digest, e.g. from extracting it),
// builds the record and writes it into the staging directory.
SealResult Seal(const std::string& staging_dir,
                const std::string& version_hash,
                const std::string& bundle_file_name,
                const std::string& artifact_sha256,
                const std::string& known_bundle_sha256);

// The second phase's second half: renames the sealed staging directory to
// version_dir (which the caller has removed if it existed) and fsyncs the
// parent directory (best-effort, as in Write).
Status Promote(const std::string& staging_dir, const std::string& version_dir);

// Launch / dedup presence check, no digest work: the bundle is a regular
// file and the record is the legacy marker or names this version (a
// digest-less schema-1 record is still "installed"; only activation refuses
// it).
bool IsComplete(const std::string& version_dir,
                const std::string& version_hash,
                const std::string& bundle_file_name);

// bundleSha256 of the version's record (crash attribution); "" when the
// record is absent, legacy, unreadable or has none.
std::string RecordedBundleSha256(const std::string& version_dir);

// Identity of a file's bytes on disk without reading them: a rewrite or an
// atomic replacement (new inode) changes it.
struct FileStamp {
  bool regular = false;
  uint64_t device = 0;
  uint64_t inode = 0;
  int64_t size = 0;
  int64_t modified_sec = 0;
  int64_t modified_nsec = 0;
  int64_t changed_sec = 0;
  int64_t changed_nsec = 0;

  bool operator==(const FileStamp& other) const;
  bool operator!=(const FileStamp& other) const { return !(*this == other); }
};

FileStamp StampFile(const std::string& path);

// What CheckActivation let through, for Unchanged.
struct Activation {
  enum class Basis {
    kGrandfathered,  // no record file; the version is the current or last one
    kLegacyMarker,   // the zero-byte marker: nothing to verify
    kDigest,         // the record's bundleSha256 matched the bundle's bytes
  };
  Basis basis = Basis::kDigest;
  std::string record_text;  // the verified record's exact text
  FileStamp bundle;         // the bundle as it was hashed
};

// The switchVersion gate (slow: re-hashes the bundle; never call it on a UI
// thread or under a lock the UI thread takes). Passes when the bundle is a
// regular file and either
//  - the directory has no record file and `grandfathered` (the version is
//    the persisted current or last one: activated before records existed),
//  - the record is the legacy marker, or
//  - the record is a schema-1 record naming this version whose bundleSha256
//    matches the bundle, which did not change while it was hashed.
// Otherwise fails with the reason ("Bundle version <hash> ..."), every
// platform's SWITCH_VERSION_FAILED message. *out is set only on success.
Status CheckActivation(const std::string& version_dir,
                       const std::string& version_hash,
                       const std::string& bundle_file_name,
                       bool grandfathered,
                       Activation* out);

// Cheap re-check (no hashing; e.g. under the state lock right before the
// switch is committed) that the directory still passes on the same basis:
// same grandfathering, same record text, same bundle file.
bool Unchanged(const std::string& version_dir,
               const std::string& bundle_file_name,
               bool grandfathered,
               const Activation& passed);

}  // namespace install_record
}  // namespace pushy

#pragma GCC visibility pop

#endif  // PUSHY_PATCH_CORE_INSTALL_RECORD_H_
