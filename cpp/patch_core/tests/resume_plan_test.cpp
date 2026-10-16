// Replays tests/resume-plan-vectors.json through cpp/patch_core/resume_plan.h.
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

#include "../../update_flow_core/flow_json.h"
#include "../resume_plan.h"

namespace {

int failures = 0;

void Check(bool ok, const std::string& what) {
  if (!ok) {
    std::fprintf(stderr, "[FAIL] %s\n", what.c_str());
    ++failures;
  }
}

flowjson::Value ParseOrDie(const std::string& text, const std::string& what) {
  bool ok = false;
  flowjson::Value value = flowjson::Parse(text, &ok);
  Check(ok, what + ": output is not JSON: " + text);
  return value;
}

long long Int(const flowjson::Value& value) {
  return static_cast<long long>(value.AsNumber());
}

std::string Str(const flowjson::Value& value) {
  return value.IsString() ? value.AsString() : std::string();
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: resume_plan_test <resume-plan-vectors.json>\n");
    return 2;
  }
  std::ifstream in(argv[1]);
  std::stringstream buffer;
  buffer << in.rdbuf();
  bool ok = false;
  flowjson::ParseLimits limits;
  limits.max_input_bytes = 16 * 1024 * 1024;
  const flowjson::Value file = flowjson::Parse(buffer.str(), limits, &ok);
  if (!ok || !file.IsObject()) {
    std::fprintf(stderr, "cannot read %s\n", argv[1]);
    return 2;
  }
  const std::string url = file.Get("url").AsString();
  int cases = 0;

  for (const auto& c : file.Get("contentRange").elements()) {
    const long long got = pushy::resume::ParseContentRangeTotal(
        Str(c.Get("header")), Int(c.Get("start")));
    Check(got == Int(c.Get("expected")),
          "contentRange \"" + Str(c.Get("header")) + "\" -> " + std::to_string(got));
    ++cases;
  }
  for (const auto& c : file.Get("planRequest").elements()) {
    const std::string name = "planRequest " + Str(c.Get("name"));
    const std::string out = pushy::resume::PlanRequestJson(
        Str(c.Get("sidecar")), url, Int(c.Get("size")));
    Check(flowjson::Value::DeepEquals(ParseOrDie(out, name), c.Get("expected")),
          name + " -> " + out);
    ++cases;
  }
  for (const auto& c : file.Get("classifyResponse").elements()) {
    const std::string name = "classifyResponse " + Str(c.Get("name"));
    const std::string out = pushy::resume::ClassifyResponseJson(
        static_cast<int>(Int(c.Get("status"))), Int(c.Get("offset")),
        Str(c.Get("contentRange")), Str(c.Get("contentEncoding")),
        Int(c.Get("contentLength")), Str(c.Get("sidecar")), url,
        Int(c.Get("size")));
    Check(flowjson::Value::DeepEquals(ParseOrDie(out, name), c.Get("expected")),
          name + " -> " + out);
    ++cases;
  }
  for (const auto& c : file.Get("sidecar").elements()) {
    const std::string name = "sidecar " + Str(c.Get("name"));
    const std::string out = pushy::resume::SidecarJson(
        url, Str(c.Get("etag")), Str(c.Get("lastModified")),
        Str(c.Get("previous")), Int(c.Get("total")));
    Check(flowjson::Value::DeepEquals(ParseOrDie(out, name), c.Get("expected")),
          name + " -> " + out);
    // What a downloader writes it must read back as the same partial.
    const std::string plan = pushy::resume::PlanRequestJson(out, url, 1);
    Check(ParseOrDie(plan, name).Get("action").AsString() != "fresh" ||
              Int(c.Get("total")) == 1,
          name + ": written sidecar does not read back");
    ++cases;
  }

  if (failures > 0) {
    std::fprintf(stderr, "%d resume plan vector(s) failed\n", failures);
    return 1;
  }
  std::printf("%d resume plan vectors passed\n", cases);
  return 0;
}
