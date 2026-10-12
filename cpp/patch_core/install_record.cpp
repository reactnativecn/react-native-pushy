#include "install_record.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <utility>

#include "digest.h"
// Relative like every other cross-core include (see patch_manifest.cpp):
// use_frameworks! flattens the pod's headers.
#include "../update_flow_core/flow_json.h"

namespace pushy {
namespace install_record {
namespace {

// Written next to the record, then renamed over it. Its `.pushy-` prefix is
// reserved like the record's own name, so no archive can ship one.
constexpr const char* kTempSuffix = ".tmp";
// A record has five members; the cap only bounds a hostile file's tree.
constexpr size_t kMaxRecordNodes = 1024;

std::string JoinPath(const std::string& dir, const std::string& name) {
  return dir + "/" + name;
}

std::string RecordPath(const std::string& dir) {
  return JoinPath(dir, kFileName);
}

std::string ErrnoText() {
  return std::strerror(errno);
}

bool IsRegularFile(const std::string& path) {
  struct stat info;
  return stat(path.c_str(), &info) == 0 && S_ISREG(info.st_mode);
}

// The record file's text and what it is. kPresent only when it parses as a
// JSON object; *text is filled for kPresent alone.
Record::State ReadRecordText(const std::string& dir, std::string* text) {
  const std::string path = RecordPath(dir);
  struct stat info;
  if (stat(path.c_str(), &info) != 0) {
    return errno == ENOENT || errno == ENOTDIR ? Record::State::kAbsent
                                               : Record::State::kInvalid;
  }
  if (!S_ISREG(info.st_mode)) {
    return Record::State::kInvalid;
  }
  if (info.st_size == 0) {
    return Record::State::kLegacy;
  }
  if (info.st_size > kMaxRecordBytes) {
    return Record::State::kInvalid;
  }
  // O_NONBLOCK: a FIFO swapped in after the stat must not hang the caller.
  const int fd = open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0) {
    return Record::State::kInvalid;
  }
  std::string content;
  char buffer[4096];
  bool failed = false;
  for (;;) {
    const ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      failed = true;
      break;
    }
    if (count == 0) {
      break;
    }
    content.append(buffer, static_cast<size_t>(count));
    if (static_cast<long long>(content.size()) > kMaxRecordBytes) {
      failed = true;
      break;
    }
  }
  close(fd);
  if (failed) {
    return Record::State::kInvalid;
  }
  // Truncated to zero between the stat and the read: still the legacy shape.
  const Record record = Parse(content);
  if (record.state == Record::State::kPresent) {
    *text = std::move(content);
  }
  return record.state;
}

std::string StringMember(const flowjson::Value& object, const char* key) {
  const flowjson::Value& value = object.Get(key);
  return value.IsString() ? value.AsString() : std::string();
}

bool EqualsIgnoringAsciiCase(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) {
    return false;
  }
  for (size_t i = 0; i < a.size(); i++) {
    char x = a[i];
    char y = b[i];
    if (x >= 'A' && x <= 'Z') {
      x = static_cast<char>(x - 'A' + 'a');
    }
    if (y >= 'A' && y <= 'Z') {
      y = static_cast<char>(y - 'A' + 'a');
    }
    if (x != y) {
      return false;
    }
  }
  return true;
}

bool WriteAll(int fd, const std::string& data) {
  size_t written = 0;
  while (written < data.size()) {
    const ssize_t count = write(fd, data.data() + written, data.size() - written);
    if (count < 0) {
      if (errno == EINTR) {
        continue;
      }
      return false;
    }
    written += static_cast<size_t>(count);
  }
  return true;
}

// Makes a directory's entries durable (a rename or a new file only is once
// the directory itself is synced). Best-effort by design: some file systems
// refuse to open or fsync a directory, which must not fail an install whose
// files are already synced.
void SyncDirectory(const std::string& dir) {
  const int fd = open(dir.c_str(), O_RDONLY | O_CLOEXEC | O_DIRECTORY);
  if (fd < 0) {
    return;
  }
  while (fsync(fd) != 0 && errno == EINTR) {
  }
  close(fd);
}

std::string ParentDirectory(const std::string& path) {
  const size_t slash = path.find_last_of('/');
  if (slash == std::string::npos) {
    return ".";
  }
  return slash == 0 ? "/" : path.substr(0, slash);
}

Status Rejected(const std::string& version_hash, const char* reason) {
  return Status::Error("Bundle version " + version_hash + " " + reason);
}

Status RecordMismatch(const std::string& version_hash) {
  return Rejected(version_hash, "completion record mismatch.");
}

}  // namespace

Record Parse(const std::string& text) {
  Record record;
  if (text.empty()) {
    record.state = Record::State::kLegacy;
    return record;
  }
  record.state = Record::State::kInvalid;
  if (static_cast<long long>(text.size()) > kMaxRecordBytes) {
    return record;
  }
  flowjson::ParseLimits limits;
  limits.max_input_bytes = static_cast<size_t>(kMaxRecordBytes);
  limits.max_nodes = kMaxRecordNodes;
  bool ok = false;
  const flowjson::Value object = flowjson::Parse(text, limits, &ok);
  if (!ok || !object.IsObject()) {
    return record;
  }
  record.state = Record::State::kPresent;
  const flowjson::Value& schema = object.Get("schema");
  record.current_schema =
      schema.IsNumber() && schema.AsNumber() == static_cast<double>(kSchema);
  record.version_hash = StringMember(object, "versionHash");
  record.bundle_sha256 = StringMember(object, "bundleSha256");
  record.artifact_sha256 = StringMember(object, "artifactSha256");
  return record;
}

bool Names(const Record& record, const std::string& version_hash) {
  return record.state == Record::State::kPresent && record.current_schema &&
         !version_hash.empty() && record.version_hash == version_hash;
}

Record Read(const std::string& version_dir) {
  std::string text;
  const Record::State state = ReadRecordText(version_dir, &text);
  if (state == Record::State::kPresent) {
    return Parse(text);
  }
  Record record;
  record.state = state;
  return record;
}

bool HasRecordFile(const std::string& version_dir) {
  struct stat info;
  return stat(RecordPath(version_dir).c_str(), &info) == 0;
}

Status Build(const std::string& version_hash,
             const std::string& bundle_sha256,
             const std::string& artifact_sha256,
             std::string* out) {
  if (bundle_sha256.empty()) {
    return Rejected(version_hash, "has no bundle digest.");
  }
  flowjson::Value record = flowjson::Value::Object();
  record.Set("schema", flowjson::Value::Number(kSchema));
  record.Set("versionHash", flowjson::Value::String(version_hash));
  record.Set("bundleSha256", flowjson::Value::String(bundle_sha256));
  if (!artifact_sha256.empty()) {
    record.Set("artifactSha256", flowjson::Value::String(artifact_sha256));
  }
  *out = flowjson::Stringify(record);
  return Status::Ok();
}

Status Write(const std::string& dir, const std::string& record_json) {
  const std::string path = RecordPath(dir);
  const std::string temp = path + kTempSuffix;
  const int fd = open(temp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0666);
  if (fd < 0) {
    return Status::Error("cannot create completion record " + temp + ": " +
                         ErrnoText());
  }
  bool ok = WriteAll(fd, record_json);
  while (ok && fsync(fd) != 0) {
    if (errno != EINTR) {
      ok = false;
    }
  }
  std::string error = ok ? std::string() : ErrnoText();
  if (close(fd) != 0 && ok) {
    ok = false;
    error = ErrnoText();
  }
  if (!ok) {
    unlink(temp.c_str());
    return Status::Error("cannot write completion record " + temp + ": " + error);
  }
  if (rename(temp.c_str(), path.c_str()) != 0) {
    error = ErrnoText();
    unlink(temp.c_str());
    return Status::Error("cannot place completion record " + path + ": " + error);
  }
  SyncDirectory(dir);
  return Status::Ok();
}

SealResult Seal(const std::string& staging_dir,
                const std::string& version_hash,
                const std::string& bundle_file_name,
                const std::string& artifact_sha256,
                const std::string& known_bundle_sha256) {
  SealResult result;
  const std::string bundle = JoinPath(staging_dir, bundle_file_name);
  if (!IsRegularFile(bundle)) {
    result.status = Status::Error("bundle missing after install: " + bundle);
    return result;
  }
  const std::string bundle_sha256 = known_bundle_sha256.empty()
      ? digest::Sha256File(bundle)
      : known_bundle_sha256;
  std::string record;
  result.status = Build(version_hash, bundle_sha256, artifact_sha256, &record);
  if (!result.status.ok) {
    return result;
  }
  result.status = Write(staging_dir, record);
  result.file_failure = !result.status.ok;
  return result;
}

Status Promote(const std::string& staging_dir, const std::string& version_dir) {
  if (rename(staging_dir.c_str(), version_dir.c_str()) != 0) {
    return Status::Error("cannot move " + staging_dir + " to " + version_dir +
                         ": " + ErrnoText());
  }
  SyncDirectory(ParentDirectory(version_dir));
  return Status::Ok();
}

bool IsComplete(const std::string& version_dir,
                const std::string& version_hash,
                const std::string& bundle_file_name) {
  if (!IsRegularFile(JoinPath(version_dir, bundle_file_name))) {
    return false;
  }
  const Record record = Read(version_dir);
  return record.state == Record::State::kLegacy || Names(record, version_hash);
}

std::string RecordedBundleSha256(const std::string& version_dir) {
  return Read(version_dir).bundle_sha256;
}

bool FileStamp::operator==(const FileStamp& other) const {
  return regular == other.regular && device == other.device &&
         inode == other.inode && size == other.size &&
         modified_sec == other.modified_sec &&
         modified_nsec == other.modified_nsec &&
         changed_sec == other.changed_sec && changed_nsec == other.changed_nsec;
}

FileStamp StampFile(const std::string& path) {
  FileStamp stamp;
  struct stat info;
  if (stat(path.c_str(), &info) != 0 || !S_ISREG(info.st_mode)) {
    return stamp;
  }
  stamp.regular = true;
  stamp.device = static_cast<uint64_t>(info.st_dev);
  stamp.inode = static_cast<uint64_t>(info.st_ino);
  stamp.size = static_cast<int64_t>(info.st_size);
#if defined(__APPLE__)
  stamp.modified_sec = info.st_mtimespec.tv_sec;
  stamp.modified_nsec = info.st_mtimespec.tv_nsec;
  stamp.changed_sec = info.st_ctimespec.tv_sec;
  stamp.changed_nsec = info.st_ctimespec.tv_nsec;
#else
  stamp.modified_sec = info.st_mtim.tv_sec;
  stamp.modified_nsec = info.st_mtim.tv_nsec;
  stamp.changed_sec = info.st_ctim.tv_sec;
  stamp.changed_nsec = info.st_ctim.tv_nsec;
#endif
  return stamp;
}

Status CheckActivation(const std::string& version_dir,
                       const std::string& version_hash,
                       const std::string& bundle_file_name,
                       bool grandfathered,
                       Activation* out) {
  const std::string bundle = JoinPath(version_dir, bundle_file_name);
  const FileStamp before = StampFile(bundle);
  if (!before.regular) {
    return Rejected(version_hash, "not found.");
  }
  std::string text;
  const Record::State state = ReadRecordText(version_dir, &text);
  // Versions activated before records existed are grandfathered through
  // current/last state, but only while their directory has NO record file:
  // a present record is verified like any other.
  if (grandfathered && state == Record::State::kAbsent) {
    out->basis = Activation::Basis::kGrandfathered;
    out->record_text.clear();
    out->bundle = before;
    return Status::Ok();
  }
  // Any other directory without a record may be a crash-left partial
  // install or something else put there.
  if (state == Record::State::kAbsent) {
    return Rejected(version_hash, "is incomplete.");
  }
  if (state == Record::State::kInvalid) {
    return Rejected(version_hash, "has no valid completion record.");
  }
  if (state == Record::State::kLegacy) {
    out->basis = Activation::Basis::kLegacyMarker;
    out->record_text.clear();
    out->bundle = before;
    return Status::Ok();
  }
  const Record record = Parse(text);
  if (!Names(record, version_hash)) {
    return RecordMismatch(version_hash);
  }
  // Mandatory for schema 1: a record without it is never trusted.
  if (record.bundle_sha256.empty()) {
    return RecordMismatch(version_hash);
  }
  const std::string actual = digest::Sha256File(bundle);
  if (actual.empty()) {
    return Rejected(version_hash, "bundle could not be read.");
  }
  if (StampFile(bundle) != before) {
    return Rejected(version_hash, "changed while being verified.");
  }
  if (!EqualsIgnoringAsciiCase(record.bundle_sha256, actual)) {
    return Rejected(version_hash, "bundle digest mismatch.");
  }
  out->basis = Activation::Basis::kDigest;
  out->record_text = text;
  out->bundle = before;
  return Status::Ok();
}

bool Unchanged(const std::string& version_dir,
               const std::string& bundle_file_name,
               bool grandfathered,
               const Activation& passed) {
  const FileStamp bundle = StampFile(JoinPath(version_dir, bundle_file_name));
  if (!bundle.regular) {
    return false;
  }
  std::string text;
  const Record::State state = ReadRecordText(version_dir, &text);
  switch (passed.basis) {
    case Activation::Basis::kGrandfathered:
      return state == Record::State::kAbsent && grandfathered;
    case Activation::Basis::kLegacyMarker:
      return state == Record::State::kLegacy && bundle == passed.bundle;
    case Activation::Basis::kDigest:
      return state == Record::State::kPresent && text == passed.record_text &&
             bundle == passed.bundle;
  }
  return false;
}

}  // namespace install_record
}  // namespace pushy
