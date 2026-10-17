// Replays tests/stored-items-vectors.json through cpp/patch_core/
// stored_items.h: the plan, the stores once it is applied, and the
// re-entry property every host relies on (a process killed after any prefix
// of the plan finishes the same migration on its next launch).
#include <algorithm>
#include <cstdio>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "../../update_flow_core/flow_json.h"
#include "../stored_items.h"

namespace {

using pushy::stored::Entries;
using pushy::stored::MigrationPlan;
using Store = std::map<std::string, std::string>;

int failures = 0;

void Check(bool ok, const std::string& what) {
  if (!ok) {
    std::fprintf(stderr, "[FAIL] %s\n", what.c_str());
    ++failures;
  }
}

int Layout(const flowjson::Value& value) {
  if (value.IsNumber()) {
    return static_cast<int>(value.AsNumber());
  }
  if (value.AsString() == "android") {
    return pushy::stored::kLegacyAndroid;
  }
  if (value.AsString() == "ios") {
    return pushy::stored::kLegacyIos;
  }
  return pushy::stored::kLegacyHarmony;
}

// A legacy value as the hosts pass it (see the vectors' doc).
std::string Text(const flowjson::Value& value) {
  if (value.IsString()) {
    return value.AsString();
  }
  if (value.IsBool()) {
    return value.AsBool() ? "1" : "0";
  }
  if (value.IsNumber()) {
    return flowjson::Stringify(value);
  }
  return "";
}

Store ToStore(const flowjson::Value& object) {
  Store store;
  for (const auto& member : object.members()) {
    store[member.first] = Text(member.second);
  }
  return store;
}

Entries ToEntries(const Store& store) {
  return Entries(store.begin(), store.end());
}

std::string Describe(const Store& store) {
  flowjson::Value object = flowjson::Value::Object();
  for (const auto& entry : store) {
    object.Set(entry.first, flowjson::Value::String(entry.second));
  }
  return flowjson::Stringify(object);
}

flowjson::Value PlanJson(const MigrationPlan& plan) {
  flowjson::Value puts = flowjson::Value::Array();
  for (const auto& put : plan.puts) {
    flowjson::Value pair = flowjson::Value::Array();
    pair.Push(flowjson::Value::String(put.first));
    pair.Push(flowjson::Value::String(put.second));
    puts.Push(pair);
  }
  flowjson::Value removes = flowjson::Value::Array();
  for (const auto& key : plan.removes) {
    removes.Push(flowjson::Value::String(key));
  }
  flowjson::Value out = flowjson::Value::Object();
  out.Set("schemaVersion", flowjson::Value::Number(plan.schema_version));
  out.Set("migrated", flowjson::Value::Bool(plan.migrated));
  out.Set("puts", puts);
  out.Set("removes", removes);
  return out;
}

// Applies the first `puts` puts and the first `removes` removes.
void Apply(const MigrationPlan& plan, size_t puts, size_t removes, Store* legacy,
           Store* current) {
  for (size_t i = 0; i < puts && i < plan.puts.size(); ++i) {
    (*current)[plan.puts[i].first] = plan.puts[i].second;
  }
  for (size_t i = 0; i < removes && i < plan.removes.size(); ++i) {
    legacy->erase(plan.removes[i]);
  }
}

// Runs the migration to completion from (legacy, current), the way a host
// does across launches.
void Finish(int layout, Store* legacy, Store* current) {
  const MigrationPlan plan =
      pushy::stored::MigrateStoredItems(layout, ToEntries(*legacy), ToEntries(*current));
  Apply(plan, plan.puts.size(), plan.removes.size(), legacy, current);
}

std::vector<std::string> Flat(const Store& store) {
  std::vector<std::string> flat;
  for (const auto& entry : store) {
    flat.push_back(entry.first);
    flat.push_back(entry.second);
  }
  return flat;
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: stored_items_test <stored-items-vectors.json>\n");
    return 2;
  }
  std::ifstream in(argv[1]);
  std::stringstream buffer;
  buffer << in.rdbuf();
  bool ok = false;
  const flowjson::Value file = flowjson::Parse(buffer.str(), &ok);
  if (!ok || !file.IsObject()) {
    std::fprintf(stderr, "cannot read %s\n", argv[1]);
    return 2;
  }

  Check(pushy::stored::ParseSchemaVersion("1") == 1, "schema \"1\"");
  Check(pushy::stored::ParseSchemaVersion("12") == 12, "schema \"12\"");
  for (const char* bad : {"", "0", "01", "-1", "1.0", " 1", "x", "1234567890"}) {
    Check(pushy::stored::ParseSchemaVersion(bad) == 0,
          std::string("schema \"") + bad + "\" is not a schema");
  }

  int cases = 0;
  for (const auto& c : file.Get("cases").elements()) {
    const std::string name = c.Get("name").AsString();
    const int layout = Layout(c.Get("layout"));
    const Store legacy = ToStore(c.Get("legacy"));
    const Store current = ToStore(c.Get("current"));
    const MigrationPlan plan =
        pushy::stored::MigrateStoredItems(layout, ToEntries(legacy), ToEntries(current));
    const std::string json =
        pushy::stored::MigrateStoredItemsJson(layout, Flat(legacy), Flat(current));
    ++cases;

    if (c.Get("plan").kind() == flowjson::Value::Kind::Null) {
      Check(!plan.valid, name + ": expected no plan");
      Check(json == "null", name + ": binding returns " + json);
      continue;
    }
    Check(plan.valid, name + ": expected a plan");
    const std::string got = flowjson::Stringify(PlanJson(plan));
    Check(flowjson::Value::DeepEquals(PlanJson(plan), c.Get("plan")),
          name + ": plan " + got);
    bool parsed = false;
    Check(flowjson::Value::DeepEquals(flowjson::Parse(json, &parsed), c.Get("plan")) &&
              parsed,
          name + ": binding " + json);
    if (!plan.puts.empty()) {
      Check(plan.puts.back().first == pushy::stored::kSchemaVersionKey,
            name + ": the schema is the last put");
    }

    Store after_legacy = legacy;
    Store after_current = current;
    Apply(plan, plan.puts.size(), plan.removes.size(), &after_legacy, &after_current);
    const Store want_legacy = ToStore(c.Get("after").Get("legacy"));
    const Store want_current = ToStore(c.Get("after").Get("current"));
    Check(after_legacy == want_legacy, name + ": legacy after " + Describe(after_legacy));
    Check(after_current == want_current,
          name + ": current after " + Describe(after_current));

    // Done means done: planning again changes nothing.
    const MigrationPlan again = pushy::stored::MigrateStoredItems(
        layout, ToEntries(after_legacy), ToEntries(after_current));
    Check(again.puts.empty() && again.removes.empty() && !again.migrated,
          name + ": planning again after the plan is not a no-op");

    // Killed after any prefix of the plan (puts in order, then removes):
    // the next launch reaches the same stores.
    const size_t steps = plan.puts.size() + plan.removes.size();
    for (size_t step = 0; step < steps; ++step) {
      Store l = legacy;
      Store s = current;
      const size_t puts = std::min(step, plan.puts.size());
      Apply(plan, puts, step - puts, &l, &s);
      Finish(layout, &l, &s);
      Check(l == want_legacy && s == want_current,
            name + ": killed after step " + std::to_string(step) + " ends at " +
                Describe(l) + " / " + Describe(s));
    }
  }

  if (failures > 0) {
    std::fprintf(stderr, "%d stored items check(s) failed\n", failures);
    return 1;
  }
  std::printf("%d stored items vectors passed\n", cases);
  return 0;
}
