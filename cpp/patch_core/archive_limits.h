#ifndef PUSHY_PATCH_CORE_ARCHIVE_LIMITS_H_
#define PUSHY_PATCH_CORE_ARCHIVE_LIMITS_H_

#include <string>

#include "patch_core.h"

// Single source of truth for the resource caps applied to an update package
// before and while it is unpacked, and for the accounting that enforces them.
// A corrupt or hostile archive must be able to cost at most a bounded amount
// of disk, memory and time — never a full disk or a zip bomb. The caps are
// generous for real packages (a large full bundle with assets is tens of MB)
// and exist purely as damage bounds.
//
// Every platform runs the rules below (archive_limits.cpp):
//   - Android: SafeZipFile.inspect hands the central directory to
//     CheckArchiveEntries, and DownloadTask plans its free-space probes, over
//     JNI (cpp/android_jni/archive_limits_jni.cpp);
//   - iOS: RCTPushyInstaller.mm feeds an EntryAccumulator from the unzip
//     delegate, RCTPushyDownloader.mm plans its probes;
//   - Harmony: zlib only reports the whole archive's expansion, so
//     DownloadTask.ts checks it with CheckUncompressedSize before unpacking
//     and CheckExtractedDirectory after, over NAPI (pushy.cpp).
// The constants a host still compares against itself (download caps, the
// manifest cap, the free-space margin, the streamed-bytes backstop) are
// mirrored in android/.../ArchiveLimits.java and
// harmony/pushy/src/main/ets/ArchiveLimits.ts;
// scripts/check-constant-parity.js (part of `bun lint`) asserts they match.

// Keep the core internal to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

namespace pushy {
namespace archive_limits {

using delta::Status;

// Downloaded archive (Content-Length up front, streamed bytes as backstop).
constexpr long long kMaxArchiveBytes = 512LL * 1024 * 1024;
// Sum of every entry's uncompressed size.
constexpr long long kMaxTotalUncompressedBytes = 2048LL * 1024 * 1024;
// A single entry's uncompressed size.
constexpr long long kMaxEntryBytes = 512LL * 1024 * 1024;
// Number of entries in one archive.
constexpr long long kMaxEntries = 20000;
// Uncompressed/compressed ratio, of each entry and of the archive as a whole,
// checked only above kRatioCheckMinBytes of expansion (tiny highly
// compressible files are legitimate).
constexpr long long kMaxCompressionRatio = 100;
constexpr long long kRatioCheckMinBytes = 1LL * 1024 * 1024;
// __diff.json is parsed fully in memory.
constexpr long long kMaxManifestBytes = 16LL * 1024 * 1024;
// Free disk required beyond the bytes about to be written.
constexpr long long kFreeDiskMarginBytes = 64LL * 1024 * 1024;
// A download whose length is unknown up front (chunked / encoded body) can
// only reserve the margin when the response arrives; the disk is re-probed
// before any write that would run past the bytes reserved so far, each
// probe reserving at least this many bytes ahead (a single larger chunk
// reserves its own size), so no write can ever eat into the margin.
constexpr long long kUnknownLengthFreeSpaceProbeBytes = 8LL * 1024 * 1024;

// Whether any component of an archive path ('/' or '\\' separated) starts
// with install_record::kReservedPrefix. Those names belong to the SDK (the
// completion record): a package unpacking its own record next to a bundle
// would be trusted as a finished install even if the steps after it fail.
bool IsReservedEntryName(const std::string& name);

// The entry count of a whole archive (iOS knows it before the first entry).
Status CheckEntryCount(long long entries);

// The whole archive: its total expansion and its overall ratio. An archive of
// unknown (non-positive) size has no ratio to trust and fails it once the
// expansion is past kRatioCheckMinBytes.
Status CheckUncompressedSize(long long archive_bytes, long long uncompressed_bytes);

// Per-entry accounting while an archive is walked, before (Android, iOS) or
// right after (Harmony) its bytes land. Each Accept checks, in order: the
// entry count, a reserved name, a symlink, the entry's own size (negative =
// unknown is refused), the running total and whole-archive ratio
// (CheckUncompressedSize), and the entry's ratio. The first failure is the
// verdict; the caller stops there.
class EntryAccumulator {
 public:
  // archive_bytes: the archive file's size, for the whole-archive ratio.
  explicit EntryAccumulator(long long archive_bytes);

  // An entry as the central directory declares it. `name` is the path inside
  // the archive; a host that only learns it once the entry is on disk (iOS)
  // passes "" and checks the name then with IsReservedEntryName. A
  // non-positive compressed size with an expansion past kRatioCheckMinBytes
  // is an unbounded ratio.
  Status Accept(long long uncompressed_size,
                long long compressed_size,
                bool is_symlink,
                const std::string& name);

  // An entry already on disk whose compressed size the host never saw
  // (Harmony): everything but the entry's own ratio; the whole archive's
  // ratio still applies.
  Status AcceptExtracted(long long size, bool is_symlink, const std::string& name);

  long long entries() const { return entries_; }
  long long total_uncompressed() const { return total_uncompressed_; }

 private:
  Status Add(long long size, bool is_symlink, const std::string& name);

  long long archive_bytes_;
  long long entries_ = 0;
  long long total_uncompressed_ = 0;
};

// Walks a freshly unpacked directory (iteratively, symlinks not followed)
// through an EntryAccumulator: every file and directory below `dir` is one
// entry named by its path relative to `dir`, a directory weighing 0 bytes.
Status CheckExtractedDirectory(const std::string& dir, long long archive_bytes);

// Before each chunk of a download is written. `known_total` > 0 means the
// response announced its length (checked once when it arrived: no probe);
// written_before counts this response's body bytes before the chunk.
struct FreeSpaceProbe {
  // Probe the disk for `reserve` bytes (plus kFreeDiskMarginBytes) first.
  bool probe = false;
  long long reserve = 0;
  // The reservation after this chunk, relative to the start of the body.
  long long reserved_until = 0;
};
FreeSpaceProbe PlanUnknownLengthFreeSpaceProbe(long long known_total,
                                               long long written_before,
                                               long long chunk_bytes,
                                               long long reserved_until);

}  // namespace archive_limits
}  // namespace pushy

#pragma GCC visibility pop

#endif  // PUSHY_PATCH_CORE_ARCHIVE_LIMITS_H_
