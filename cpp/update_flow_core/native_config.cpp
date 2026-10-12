#include "native_config.h"

#include <unordered_set>
#include <utility>
#include <vector>

#include "../patch_core/obscured_text.h"

namespace flowcore {

using flowjson::Value;

namespace {

// Length of the ECMAScript whitespace/line terminator encoded at text[i], or
// 0 when there is none.
size_t WhitespaceAt(const std::string& text, size_t i) {
  const size_t left = text.size() - i;
  const auto byte = [&](size_t k) {
    return static_cast<unsigned char>(text[i + k]);
  };
  const unsigned char b0 = byte(0);
  if (b0 == ' ' || (b0 >= 0x09 && b0 <= 0x0d)) {
    return 1;
  }
  if (b0 == 0xc2 && left >= 2 && byte(1) == 0xa0) {
    return 2;  // U+00A0
  }
  if (left < 3) {
    return 0;
  }
  const unsigned char b1 = byte(1);
  const unsigned char b2 = byte(2);
  if (b0 == 0xe1 && b1 == 0x9a && b2 == 0x80) {
    return 3;  // U+1680
  }
  if (b0 == 0xe2 && b1 == 0x80 &&
      (b2 <= 0x8a || b2 == 0xa8 || b2 == 0xa9 || b2 == 0xaf) && b2 >= 0x80) {
    return 3;  // U+2000-U+200A, U+2028, U+2029, U+202F
  }
  if (b0 == 0xe2 && b1 == 0x81 && b2 == 0x9f) {
    return 3;  // U+205F
  }
  if (b0 == 0xe3 && b1 == 0x80 && b2 == 0x80) {
    return 3;  // U+3000
  }
  if (b0 == 0xef && b1 == 0xbb && b2 == 0xbf) {
    return 3;  // U+FEFF
  }
  return 0;
}

bool ContainsJsWhitespace(const std::string& text) {
  for (size_t i = 0; i < text.size(); i++) {
    if (WhitespaceAt(text, i) != 0) {
      return true;
    }
  }
  return false;
}

std::string StripTrailingSlashes(std::string text) {
  while (!text.empty() && text.back() == '/') {
    text.pop_back();
  }
  return text;
}

// Strings lose their trailing '/' first; then every entry (string or not)
// already present by value is dropped.
Value CanonicalUrlList(const Value& list) {
  if (!list.IsArray()) {
    return list;
  }
  Value result = Value::Array();
  std::unordered_set<std::string> strings;
  std::vector<const Value*> others;
  for (const Value& item : list.elements()) {
    if (item.IsString()) {
      std::string url = StripTrailingSlashes(item.AsString());
      if (strings.insert(url).second) {
        result.Push(Value::String(std::move(url)));
      }
      continue;
    }
    bool seen = false;
    for (const Value* other : others) {
      if (Value::DeepEquals(*other, item)) {
        seen = true;
        break;
      }
    }
    if (!seen) {
      others.push_back(&item);
      result.Push(item);
    }
  }
  return result;
}

Value ParseObject(const std::string& json) {
  bool ok = false;
  Value value = flowjson::Parse(json, &ok);
  return ok && value.IsObject() ? value : Value::Undefined();
}

const std::string& PolicyNextLaunch() {
  static const std::string value =
      pushy::text::Reveal("2912e0ffab8e6c70323b1dedd3");
  return value;
}

// Pushy's own service addresses, encoded by scripts/encode-native-text.ts.
std::vector<std::string> DefaultEndpoints() {
  return {
      pushy::text::Reveal(
          "3203e0c1bdd1270a372f18f8c2b6de7f4f2607f5b3d5b9817b592947e5cdefbc8a7e"),
      pushy::text::Reveal(
          "3203e0c1bdd1270a372f18f8c2b6de7f4f2607f5f0daac9c644a620ae88ca1ad93"),
  };
}

// One literal per address: src/__tests__/nativeTextEncoding.test.ts finds
// them by pattern.
std::vector<std::string> DefaultQueryUrls() {
  return {
      pushy::text::Reveal("3203e0c1bdd1270a253608fcd3fd9362476817f4f0d5a1996342631be3c2a3a9d779552507fdcde8928a6f512f5ce2ccbdc869404d2f1de79daa826d562c0913eec4fa9b7d4426"),
      pushy::text::Reveal("3203e0c1bdd1270a213b12b7dca09468462e12f3b0d5bd813d482446f4c6a1be8e79552507fdcda68cd06e5c3710e480a4867048483e55e0c2ab8d7d43030d1ce9c3b183214e2601f2f0d5b782601e2719e8ca"),
  };
}

Value StringArray(const std::vector<std::string>& values) {
  Value array = Value::Array();
  for (const std::string& value : values) {
    array.Push(Value::String(value));
  }
  return array;
}

bool IsHexDigit(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
         (c >= 'A' && c <= 'F');
}

bool IsDigit(char c) { return c >= '0' && c <= '9'; }

bool IsHostChar(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || IsDigit(c) ||
         c == '.' || c == '-';
}

// ^https?://(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(:[0-9]+)?([/?#]|$) — the
// scheme and authority check; anything else in the authority (userinfo,
// spaces, a missing host) fails it. Every quantifier is greedy and its
// continuation cannot start with a character it consumes, so a single
// left-to-right scan matches exactly what the backtracking regex does.
bool HasHttpAuthority(const std::string& url) {
  size_t i = 0;
  const std::string http = "http";
  if (url.compare(0, http.size(), http) != 0) {
    return false;
  }
  i = http.size();
  if (i < url.size() && url[i] == 's') {
    i++;
  }
  if (url.compare(i, 3, "://") != 0) {
    return false;
  }
  i += 3;
  const size_t host = i;
  if (i < url.size() && url[i] == '[') {
    i++;
    while (i < url.size() && (IsHexDigit(url[i]) || url[i] == ':')) {
      i++;
    }
    if (i == host + 1 || i >= url.size() || url[i] != ']') {
      return false;
    }
    i++;
  } else {
    while (i < url.size() && IsHostChar(url[i])) {
      i++;
    }
    if (i == host) {
      return false;
    }
  }
  if (i < url.size() && url[i] == ':') {
    const size_t port = ++i;
    while (i < url.size() && IsDigit(url[i])) {
      i++;
    }
    if (i == port) {
      return false;
    }
  }
  return i == url.size() || url[i] == '/' || url[i] == '?' || url[i] == '#';
}

// The normalizer's checks report the first problem in *error (without the
// prefix) and return false; no exceptions, the cores build without unwind
// tables on Android.
bool ConfigString(const Value& value, const std::string& name, bool allowEmpty,
                  std::string* out, std::string* error) {
  if (!value.IsString() ||
      (!allowEmpty && TrimJsWhitespace(value.AsString()).empty())) {
    *error = name + " must be a string" +
             (allowEmpty ? "" : " and must not be blank");
    return false;
  }
  *out = value.AsString();
  return true;
}

// `base` lists (endpoints) are request bases: non-empty, no query or
// fragment, trailing '/' dropped. Discovery lists keep their URLs whole.
bool ConfigUrls(const Value& values, const std::string& name, bool base,
                Value* out, std::string* error) {
  if (!values.IsArray() || (base && values.Size() == 0)) {
    *error = name + " must be " + (base ? "a non-empty" : "an") + " array";
    return false;
  }
  Value result = Value::Array();
  std::unordered_set<std::string> seen;
  for (const Value& item : values.elements()) {
    std::string url;
    if (!ConfigString(item, name, false, &url, error)) {
      return false;
    }
    url = TrimJsWhitespace(url);
    if (!HasHttpAuthority(url) || ContainsJsWhitespace(url) ||
        url.find('\\') != std::string::npos ||
        (base && url.find_first_of("?#") != std::string::npos)) {
      *error = name + " requires absolute HTTP(S) URLs without credentials" +
               (base ? ", queries or fragments" : "");
      return false;
    }
    if (base) {
      url = StripTrailingSlashes(std::move(url));
    }
    if (seen.insert(url).second) {
      result.Push(Value::String(std::move(url)));
    }
  }
  *out = std::move(result);
  return true;
}

bool Normalize(const std::string& optionsJson, Value* out,
               std::string* error) {
  const Value options = ParseObject(optionsJson);
  if (!options.IsObject()) {
    *error = "expected an object";
    return false;
  }
  static const char* const kKeys[] = {
      "appKey",   "endpoints",      "queryUrls", "afterDownload",
      "disabled", "packageVersion", "rnu",       "rn"};
  for (const auto& member : options.members()) {
    bool known = false;
    for (const char* key : kKeys) {
      known = known || member.first == key;
    }
    if (!known) {
      *error = "unknown option " + member.first;
      return false;
    }
  }
  const auto has = [&](const char* key) {
    return !options.Get(key).IsUndefined();
  };
  // A string option: absent takes `fallback`, present must pass ConfigString.
  const auto string = [&](const char* key, bool allowEmpty,
                          const std::string& fallback, Value* result) {
    std::string value = fallback;
    if (has(key) &&
        !ConfigString(options.Get(key), key, allowEmpty, &value, error)) {
      return false;
    }
    *result = Value::String(std::move(value));
    return true;
  };

  Value appKey, endpoints, queryUrls, rnu, rn, packageVersion;
  if (!has("appKey")) {
    *error = "appKey must be a string and must not be blank";
    return false;
  }
  if (!string("appKey", false, "", &appKey)) {
    return false;
  }
  const bool customEndpoints = has("endpoints");
  if (!ConfigUrls(customEndpoints ? options.Get("endpoints")
                                  : StringArray(DefaultEndpoints()),
                  "endpoints", true, &endpoints, error) ||
      !ConfigUrls(has("queryUrls")  ? options.Get("queryUrls")
                  : customEndpoints ? Value::Array()
                                    : StringArray(DefaultQueryUrls()),
                  "queryUrls", false, &queryUrls, error)) {
    return false;
  }
  Value afterDownload = Value::String("none");
  if (has("afterDownload")) {
    afterDownload = options.Get("afterDownload");
    if (!afterDownload.IsString() || (afterDownload.AsString() != "none" &&
                                      afterDownload.AsString() !=
                                          PolicyNextLaunch())) {
      *error = "afterDownload must be none or " + PolicyNextLaunch();
      return false;
    }
  }
  const Value& disabled = options.Get("disabled");
  if (!disabled.IsUndefined() && !disabled.IsBool()) {
    *error = "disabled must be a boolean";
    return false;
  }
  if (!string("rnu", true, "", &rnu) || !string("rn", true, "", &rn) ||
      (has("packageVersion") &&
       !string("packageVersion", false, "", &packageVersion))) {
    return false;
  }
  Value result = Value::Object();
  result.Set("appKey", std::move(appKey));
  result.Set("endpoints", std::move(endpoints));
  result.Set("queryUrls", std::move(queryUrls));
  result.Set("afterDownload", std::move(afterDownload));
  result.Set("disabled", Value::Bool(disabled.IsBool() && disabled.AsBool()));
  result.Set("rnu", std::move(rnu));
  result.Set("rn", std::move(rn));
  if (!packageVersion.IsUndefined()) {
    result.Set("packageVersion", std::move(packageVersion));
  }
  *out = std::move(result);
  return true;
}

}  // namespace

std::string TrimJsWhitespace(const std::string& text) {
  size_t begin = 0;
  while (begin < text.size()) {
    const size_t length = WhitespaceAt(text, begin);
    if (length == 0) {
      break;
    }
    begin += length;
  }
  size_t end = text.size();
  while (end > begin) {
    // A whitespace sequence is 1-3 bytes; try each length ending at `end`.
    size_t length = 0;
    for (size_t candidate = 1; candidate <= 3 && candidate <= end - begin;
         candidate++) {
      if (WhitespaceAt(text, end - candidate) == candidate) {
        length = candidate;
        break;
      }
    }
    if (length == 0) {
      break;
    }
    end -= length;
  }
  return text.substr(begin, end - begin);
}

Value CanonicalNativeConfig(const std::string& json) {
  Value config = ParseObject(json);
  if (!config.IsObject()) {
    return config;
  }
  const std::pair<const char*, Value> defaults[] = {
      {"disabled", Value::Bool(false)}, {"queryUrls", Value::Array()},
      {"rnu", Value::String("")},       {"rn", Value::String("")},
      {"afterDownload", Value::String("none")},
  };
  for (const auto& entry : defaults) {
    if (config.Get(entry.first).IsUndefined()) {
      config.Set(entry.first, entry.second);
    }
  }
  for (const char* key : {"endpoints", "queryUrls"}) {
    const Value& list = config.Get(key);
    if (list.IsArray()) {
      config.Set(key, CanonicalUrlList(list));
    }
  }
  return config;
}

bool ConfigsEquivalent(const std::string& a, const std::string& b) {
  const Value left = CanonicalNativeConfig(a);
  if (!left.IsObject()) {
    return false;
  }
  const Value right = CanonicalNativeConfig(b);
  return right.IsObject() && Value::DeepEquals(left, right);
}

RunnableConfig ParseRunnableConfig(const std::string& json) {
  RunnableConfig result;
  if (json.empty()) {
    result.status = "skipped";
    result.reason = "not_configured";
    return result;
  }
  Value config = ParseObject(json);
  if (!config.IsObject()) {
    result.status = "failed";
    result.reason = "invalid_config";
    return result;
  }
  if (config.Get("disabled").Truthy()) {
    result.status = "skipped";
    result.reason = "disabled";
    return result;
  }
  const Value& appKey = config.Get("appKey");
  std::string trimmed =
      appKey.IsString() ? TrimJsWhitespace(appKey.AsString()) : std::string();
  if (trimmed.empty()) {
    result.status = "failed";
    result.reason = "invalid_config";
    return result;
  }
  result.appKey = std::move(trimmed);
  result.config = std::move(config);
  return result;
}

std::string RunnableConfigJson(const std::string& json) {
  const RunnableConfig parsed = ParseRunnableConfig(json);
  Value result = Value::Object();
  if (parsed.runnable()) {
    result.Set("appKey", Value::String(parsed.appKey));
  } else {
    result.Set("status", Value::String(parsed.status));
    result.Set("reason", Value::String(parsed.reason));
  }
  return flowjson::Stringify(result);
}

bool NormalizeConfiguration(const std::string& optionsJson, std::string* out,
                            std::string* error) {
  Value result;
  std::string why;
  if (!Normalize(optionsJson, &result, &why)) {
    *error = "Invalid native configuration: " + why;
    return false;
  }
  *out = flowjson::Stringify(result);
  return true;
}

}  // namespace flowcore
