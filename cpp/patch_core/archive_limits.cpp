#include "archive_limits.h"

#include <dirent.h>
#include <sys/stat.h>

#include <limits>
#include <string>
#include <utility>
#include <vector>

#include "install_record.h"

namespace pushy {
namespace archive_limits {
namespace {

// expanded > compressed * kMaxCompressionRatio, past kRatioCheckMinBytes.
// A non-positive compressed size bounds nothing. Exact (no integer division
// rounding the ratio down) and overflow-free.
bool ExceedsRatio(long long expanded, long long compressed) {
  if (expanded <= kRatioCheckMinBytes) {
    return false;
  }
  if (compressed <= 0) {
    return true;
  }
  if (compressed > std::numeric_limits<long long>::max() / kMaxCompressionRatio) {
    return false;
  }
  return expanded > compressed * kMaxCompressionRatio;
}

// The entry for messages: its name, or its position when the host has none
// yet.
std::string Label(const std::string& name, long long index) {
  return name.empty() ? "#" + std::to_string(index) : name;
}

}  // namespace

bool IsReservedEntryName(const std::string& name) {
  const std::string prefix = install_record::kReservedPrefix;
  size_t start = 0;
  while (start <= name.size()) {
    size_t end = name.find_first_of("/\\", start);
    if (end == std::string::npos) {
      end = name.size();
    }
    if (name.compare(start, prefix.size(), prefix) == 0 &&
        end - start >= prefix.size()) {
      return true;
    }
    start = end + 1;
  }
  return false;
}

Status CheckEntryCount(long long entries) {
  if (entries > kMaxEntries) {
    return Status::Error("archive has too many entries (> " +
                         std::to_string(kMaxEntries) + ")");
  }
  return Status::Ok();
}

Status CheckUncompressedSize(long long archive_bytes, long long uncompressed_bytes) {
  if (uncompressed_bytes > kMaxTotalUncompressedBytes) {
    return Status::Error("archive expands beyond " +
                         std::to_string(kMaxTotalUncompressedBytes) + " bytes (" +
                         std::to_string(uncompressed_bytes) + ")");
  }
  if (ExceedsRatio(uncompressed_bytes, archive_bytes)) {
    return Status::Error("archive compression ratio exceeds " +
                         std::to_string(kMaxCompressionRatio) + ":1 (" +
                         std::to_string(uncompressed_bytes) + "/" +
                         std::to_string(archive_bytes) + ")");
  }
  return Status::Ok();
}

EntryAccumulator::EntryAccumulator(long long archive_bytes)
    : archive_bytes_(archive_bytes) {}

Status EntryAccumulator::Accept(long long uncompressed_size,
                                long long compressed_size,
                                bool is_symlink,
                                const std::string& name) {
  Status status = Add(uncompressed_size, is_symlink, name);
  if (status.ok && ExceedsRatio(uncompressed_size, compressed_size)) {
    return Status::Error("archive entry compression ratio too high: " +
                         Label(name, entries_ - 1));
  }
  return status;
}

Status EntryAccumulator::AcceptExtracted(long long size,
                                         bool is_symlink,
                                         const std::string& name) {
  return Add(size, is_symlink, name);
}

Status EntryAccumulator::Add(long long size,
                             bool is_symlink,
                             const std::string& name) {
  const long long index = entries_++;
  Status status = CheckEntryCount(entries_);
  if (!status.ok) {
    return status;
  }
  if (IsReservedEntryName(name)) {
    return Status::Error("archive contains reserved entry " + name);
  }
  if (is_symlink) {
    return Status::Error("archive entry is a symlink: " + Label(name, index));
  }
  if (size < 0) {
    return Status::Error("archive entry size unknown: " + Label(name, index));
  }
  if (size > kMaxEntryBytes) {
    return Status::Error("archive entry too large: " + Label(name, index) + " (" +
                         std::to_string(size) + " bytes)");
  }
  total_uncompressed_ += size;
  return CheckUncompressedSize(archive_bytes_, total_uncompressed_);
}

Status CheckExtractedDirectory(const std::string& dir, long long archive_bytes) {
  EntryAccumulator accumulator(archive_bytes);
  // Relative paths of the directories still to list; "" is `dir` itself.
  std::vector<std::string> pending(1);
  while (!pending.empty()) {
    const std::string relative = std::move(pending.back());
    pending.pop_back();
    const std::string path = relative.empty() ? dir : dir + "/" + relative;
    DIR* handle = opendir(path.c_str());
    if (handle == nullptr) {
      return Status::Error("cannot list extracted directory " + path);
    }
    Status status = Status::Ok();
    while (status.ok) {
      const dirent* item = readdir(handle);
      if (item == nullptr) {
        break;
      }
      const std::string name = item->d_name;
      if (name == "." || name == "..") {
        continue;
      }
      const std::string child = relative.empty() ? name : relative + "/" + name;
      struct stat st;
      if (lstat((dir + "/" + child).c_str(), &st) != 0) {
        status = Status::Error("cannot stat extracted entry " + child);
        break;
      }
      // Directories are walked but not counted: the zip may omit directory
      // entries, and iOS/Android count only what the archive declares.
      if (S_ISDIR(st.st_mode)) {
        if (IsReservedEntryName(child)) {
          status = Status::Error("archive contains reserved entry " + child);
        } else {
          pending.push_back(child);
        }
        continue;
      }
      status = accumulator.AcceptExtracted(static_cast<long long>(st.st_size),
                                           S_ISLNK(st.st_mode), child);
    }
    closedir(handle);
    if (!status.ok) {
      return status;
    }
  }
  return Status::Ok();
}

FreeSpaceProbe PlanUnknownLengthFreeSpaceProbe(long long known_total,
                                               long long written_before,
                                               long long chunk_bytes,
                                               long long reserved_until) {
  FreeSpaceProbe plan;
  plan.reserve = chunk_bytes > kUnknownLengthFreeSpaceProbeBytes
                     ? chunk_bytes
                     : kUnknownLengthFreeSpaceProbeBytes;
  plan.reserved_until = reserved_until;
  if (known_total > 0 || written_before + chunk_bytes <= reserved_until) {
    return plan;
  }
  plan.probe = true;
  plan.reserved_until = written_before + plan.reserve;
  return plan;
}

}  // namespace archive_limits
}  // namespace pushy
