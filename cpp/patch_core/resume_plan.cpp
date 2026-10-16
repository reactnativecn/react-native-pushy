#include "resume_plan.h"

#include <cmath>

// Relative like every other cross-core include: use_frameworks! flattens the
// pod's headers.
#include "../update_flow_core/flow_json.h"

namespace pushy {
namespace resume {
namespace {

using flowjson::Value;

bool IsSpace(char c) { return c == ' ' || c == '\t'; }

std::string Trim(const std::string& text) {
  size_t begin = 0;
  size_t end = text.size();
  while (begin < end && IsSpace(text[begin])) {
    ++begin;
  }
  while (end > begin && IsSpace(text[end - 1])) {
    --end;
  }
  return text.substr(begin, end - begin);
}

// Digits only (no sign, no trailing text), within long long. -1 otherwise.
long long ParseDigits(const std::string& text) {
  if (text.empty() || text.size() > 18) {
    return -1;
  }
  long long value = 0;
  for (char c : text) {
    if (c < '0' || c > '9') {
      return -1;
    }
    value = value * 10 + (c - '0');
  }
  return value;
}

struct Sidecar {
  bool valid = false;
  std::string etag;
  std::string last_modified;
  long long total = 0;
};

// The sidecar for url, or invalid (absent, oversized, not a JSON object,
// another url): a partial without one is untrusted.
Sidecar ReadSidecar(const std::string& text, const std::string& url) {
  Sidecar sidecar;
  if (text.empty() || static_cast<long long>(text.size()) > kMaxSidecarBytes) {
    return sidecar;
  }
  bool ok = false;
  Value root = flowjson::Parse(text, &ok);
  if (!ok || !root.IsObject()) {
    return sidecar;
  }
  const Value& url_value = root.Get("url");
  if (!url_value.IsString() || url_value.AsString() != url) {
    return sidecar;
  }
  sidecar.valid = true;
  const Value& etag = root.Get("etag");
  if (etag.IsString()) {
    sidecar.etag = etag.AsString();
  }
  const Value& last_modified = root.Get("lastModified");
  if (last_modified.IsString()) {
    sidecar.last_modified = last_modified.AsString();
  }
  const Value& total = root.Get("total");
  if (total.IsNumber() && total.AsNumber() > 0 &&
      total.AsNumber() < 9007199254740992.0 &&
      std::floor(total.AsNumber()) == total.AsNumber()) {
    sidecar.total = static_cast<long long>(total.AsNumber());
  }
  return sidecar;
}

Value Number(long long n) { return Value::Number(static_cast<double>(n)); }

Value Action(const char* action) {
  Value result = Value::Object();
  result.Set("action", Value::String(action));
  return result;
}

std::string Complete(long long total) {
  Value result = Action("complete");
  result.Set("total", Number(total));
  return flowjson::Stringify(result);
}

bool IsEncoded(const std::string& content_encoding) {
  std::string encoding = Trim(content_encoding);
  if (encoding.empty()) {
    return false;
  }
  for (char& c : encoding) {
    if (c >= 'A' && c <= 'Z') {
      c = static_cast<char>(c - 'A' + 'a');
    }
  }
  return encoding != "identity";
}

}  // namespace

long long ParseContentRangeTotal(const std::string& header,
                                 long long expected_start) {
  const std::string unit = "bytes ";
  if (header.compare(0, unit.size(), unit) != 0) {
    return -1;
  }
  const std::string range = header.substr(unit.size());
  const size_t slash = range.find('/');
  const size_t dash = range.find('-');
  if (slash == std::string::npos || dash == std::string::npos || dash > slash) {
    return -1;
  }
  const long long start = ParseDigits(Trim(range.substr(0, dash)));
  const long long end = ParseDigits(Trim(range.substr(dash + 1, slash - dash - 1)));
  if (start < 0 || end < 0 || start != expected_start || end < start) {
    return -1;
  }
  const std::string total_part = Trim(range.substr(slash + 1));
  if (total_part == "*") {
    return 0;
  }
  const long long total = ParseDigits(total_part);
  return total > end ? total : -1;
}

std::string PlanRequestJson(const std::string& sidecar_text,
                            const std::string& url, long long partial_size) {
  const Sidecar sidecar = ReadSidecar(sidecar_text, url);
  if (sidecar.valid && partial_size > 0) {
    if (sidecar.total > 0 && partial_size == sidecar.total) {
      return Complete(sidecar.total);
    }
    if (sidecar.total <= 0 || partial_size < sidecar.total) {
      Value headers = Value::Object();
      headers.Set("Range", Value::String("bytes=" + std::to_string(partial_size) + "-"));
      headers.Set("Accept-Encoding", Value::String("identity"));
      const std::string& validator =
          sidecar.etag.empty() ? sidecar.last_modified : sidecar.etag;
      if (!validator.empty()) {
        headers.Set("If-Range", Value::String(validator));
      }
      Value result = Action("resume");
      result.Set("offset", Number(partial_size));
      result.Set("headers", headers);
      return flowjson::Stringify(result);
    }
  }
  return flowjson::Stringify(Action("fresh"));
}

std::string ClassifyResponseJson(int status, long long resume_offset,
                                 const std::string& content_range,
                                 const std::string& content_encoding,
                                 long long content_length,
                                 const std::string& sidecar_text,
                                 const std::string& url,
                                 long long partial_size) {
  if (status == 416) {
    const Sidecar sidecar = ReadSidecar(sidecar_text, url);
    if (sidecar.valid && sidecar.total > 0 && partial_size == sidecar.total) {
      return Complete(sidecar.total);
    }
    return flowjson::Stringify(Action("restart"));
  }
  if (status < 200 || status > 299) {
    return flowjson::Stringify(Action("httpError"));
  }
  const bool encoded = IsEncoded(content_encoding);
  const bool append = status == 206 && resume_offset > 0;
  long long total = 0;
  if (append) {
    // Encoded range bytes or a missing/mismatched Content-Range: the appended
    // bytes could not be trusted. Restarting (once) beats failing, which
    // would keep the partial and hit the same wall on every attempt.
    total = encoded ? -1 : ParseContentRangeTotal(content_range, resume_offset);
    if (total < 0) {
      return flowjson::Stringify(Action("restart"));
    }
  } else if (!encoded && content_length > 0) {
    total = content_length;
  }
  Value result = Action("write");
  result.Set("append", Value::Bool(append));
  result.Set("base", Number(append ? resume_offset : 0));
  result.Set("total", Number(total));
  result.Set("encoded", Value::Bool(encoded));
  result.Set("persistSidecar", Value::Bool(!encoded));
  return flowjson::Stringify(result);
}

std::string SidecarJson(const std::string& url, const std::string& etag,
                        const std::string& last_modified,
                        const std::string& previous_sidecar, long long total) {
  const Sidecar previous = ReadSidecar(previous_sidecar, url);
  const std::string& kept_etag = etag.empty() ? previous.etag : etag;
  const std::string& kept_last_modified =
      last_modified.empty() ? previous.last_modified : last_modified;
  Value meta = Value::Object();
  meta.Set("url", Value::String(url));
  if (!kept_etag.empty()) {
    meta.Set("etag", Value::String(kept_etag));
  }
  if (!kept_last_modified.empty()) {
    meta.Set("lastModified", Value::String(kept_last_modified));
  }
  if (total > 0) {
    meta.Set("total", Number(total));
  }
  return flowjson::Stringify(meta);
}

}  // namespace resume
}  // namespace pushy
