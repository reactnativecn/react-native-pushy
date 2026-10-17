#include "stored_items.h"

#include <algorithm>

#include "../update_flow_core/flow_json.h"
#include "obscured_text.h"

namespace pushy {
namespace stored {
namespace {

struct Carried {
  std::string to;
  std::string from;
  // A flag: any legacy value means set, stored as "1".
  bool marker;
};

struct LegacyLayout {
  int id;
  std::vector<Carried> carried;
  std::vector<std::string> dropped;
  std::vector<std::string> dropped_prefixes;
};

// Built on first use: the keys with update wording are encoded (see
// scripts/encode-native-text.ts) and revealed at run time.
const std::vector<LegacyLayout>& LegacyLayouts() {
  static const std::vector<LegacyLayout>* layouts = new std::vector<LegacyLayout>{
      // <generated:legacy-layouts> (scripts/contract.ts; bun scripts/generate-contract.ts)
      // Android: SharedPreferences Texts.PREFERENCES_NAME, and its "_check"
      // file for the response cache; native booleans.
      {kLegacyAndroid,
       // Carried: {key, legacy key, marker}.
       {
           {"uuid", "uuid", false},
           {"nativeConfig", "nativeConfig", false},
           {"nativeCheckIncomplete", "nativeCheckIncomplete", true},
           {"bundleHashCache", "bundleHashCache", false},
           {"packageVersion", "packageVersion", false},
           {"buildTime", "buildTime", false},
       },
       // Dropped.
       {
           "currentVersion",
           "lastVersion",
           "firstTime",
           "firstTimeOk",
           "rolledBackVersion",
           "firstLoadMarked",
           "nativeCheckResp",
           "rolledBack",
           "shouldRollback",
           "blockUntil",
           "blockReason",
       },
       {"hash_"}},
      // iOS: standardUserDefaults, shared with the host app: only these keys
      // are ours (the unprefixed packageVersion/buildTime that SDKs before
      // 10.5x wrote are left alone, they may be the host's).
      {kLegacyIos,
       // Carried: {key, legacy key, marker}.
       {
           {"uuid", "REACTNATIVECN_PUSHY_UUID", false},
           {"nativeConfig", "REACTNATIVECN_PUSHY_NATIVE_CONFIG_KEY", false},
           {"nativeCheckIncomplete", "REACTNATIVECN_PUSHY_NATIVE_CHECK_INCOMPLETE_KEY", true},
           {"bundleHashCache", "REACTNATIVECN_PUSHY_BUNDLEHASH_KEY", false},
           {"packageVersion", "REACTNATIVECN_PUSHY_PACKAGEVERSION", false},
           {"buildTime", "REACTNATIVECN_PUSHY_BUILDTIME", false},
       },
       // Dropped.
       {
           "REACTNATIVECN_PUSHY_INFO_KEY",
           "REACTNATIVECN_PUSHY_FIRSTLOADMARKED_KEY",
           "REACTNATIVECN_PUSHY_ROLLEDBACKMARKED_KEY",
           text::Reveal("0832d5f29aa549710b0939daf88ca058790f3dded7e888b451640d2ec3f69099bb43711523cafa8ea7bb4372132a"),
           "REACTNATIVECN_PUSHY_NATIVE_CHECK_RESP_KEY",
           text::Reveal("0832d5f29aa549710b0939daf88ca058790f3ddedcf797b6597a1c2dc7f785"),
           "REACTNATIVECN_PUSHY_BUNDLEHASH_IDENTITY",
           "REACTNATIVECN_PUSHY_BUNDLEHASH_VALUE",
       },
       {"REACTNATIVECN_PUSHY_HASH_"}},
      // Harmony: preferences Texts.PREFERENCES_NAME; booleans native or "true".
      {kLegacyHarmony,
       // Carried: {key, legacy key, marker}.
       {
           {"uuid", "uuid", false},
           {"nativeConfig", "nativeConfig", false},
           {"nativeCheckIncomplete", "nativeCheckIncomplete", true},
           {"bundleHashCache", "bundleHashCache", false},
           {"packageVersion", "packageVersion", false},
           {"buildTime", "buildTime", false},
       },
       // Dropped.
       {
           "currentVersion",
           "lastVersion",
           "firstTime",
           "firstTimeOk",
           "rolledBackVersion",
           "firstLoadMarked",
           "nativeCheckResp",
           "rolledBack",
           "shouldRollback",
           "blockUntil",
           "blockReason",
       },
       {"hash_"}},
      // </generated:legacy-layouts>
  };
  return *layouts;
}

const LegacyLayout* FindLayout(int id) {
  for (const LegacyLayout& layout : LegacyLayouts()) {
    if (layout.id == id) {
      return &layout;
    }
  }
  return nullptr;
}

bool Owns(const LegacyLayout& layout, const std::string& key) {
  for (const Carried& item : layout.carried) {
    if (item.from == key) {
      return true;
    }
  }
  if (std::find(layout.dropped.begin(), layout.dropped.end(), key) !=
      layout.dropped.end()) {
    return true;
  }
  for (const std::string& prefix : layout.dropped_prefixes) {
    if (key.compare(0, prefix.size(), prefix) == 0) {
      return true;
    }
  }
  return false;
}

// The value of `key`, or "" when absent.
const std::string& Lookup(const Entries& entries, const std::string& key) {
  static const std::string* const empty = new std::string();
  for (const auto& entry : entries) {
    if (entry.first == key) {
      return entry.second;
    }
  }
  return *empty;
}

Entries Pairs(const std::vector<std::string>& flat) {
  Entries entries;
  for (size_t i = 0; i + 1 < flat.size(); i += 2) {
    entries.emplace_back(flat[i], flat[i + 1]);
  }
  return entries;
}

}  // namespace

int ParseSchemaVersion(const std::string& value) {
  // Nine digits at most: no overflow, and no schema will ever get there.
  if (value.empty() || value.size() > 9 || value[0] == '0') {
    return 0;
  }
  int version = 0;
  for (char c : value) {
    if (c < '0' || c > '9') {
      return 0;
    }
    version = version * 10 + (c - '0');
  }
  return version;
}

MigrationPlan MigrateStoredItems(int legacy_layout, const Entries& legacy,
                                 const Entries& current) {
  MigrationPlan plan;
  const LegacyLayout* layout = FindLayout(legacy_layout);
  if (layout == nullptr) {
    plan.valid = false;
    return plan;
  }
  const int stored = ParseSchemaVersion(Lookup(current, kSchemaVersionKey));
  if (stored > kSchemaVersion) {
    // A later SDK owns the store (the user went back to an older binary):
    // read what this one knows, write nothing, delete nothing.
    plan.schema_version = stored;
    return plan;
  }

  // Every legacy key goes, whether this run migrates or an earlier one did:
  // a migration killed before its removes, or an older binary the user went
  // back to in between, leaves keys that must never be read again.
  for (const auto& entry : legacy) {
    if (Owns(*layout, entry.first)) {
      plan.removes.push_back(entry.first);
    }
  }
  std::sort(plan.removes.begin(), plan.removes.end());
  plan.removes.erase(std::unique(plan.removes.begin(), plan.removes.end()),
                     plan.removes.end());

  plan.schema_version = kSchemaVersion;
  if (stored == kSchemaVersion) {
    return plan;
  }

  plan.migrated = true;
  for (const Carried& item : layout->carried) {
    const std::string& value = Lookup(legacy, item.from);
    // The store wins: a value it holds without a schema was written by this
    // SDK after an earlier migration attempt that did not reach its schema
    // write (or is that attempt's own copy).
    if (value.empty() || !Lookup(current, item.to).empty()) {
      continue;
    }
    plan.puts.emplace_back(item.to, item.marker ? std::string("1") : value);
  }
  plan.puts.emplace_back(kSchemaVersionKey, std::to_string(kSchemaVersion));
  return plan;
}

std::string MigrateStoredItemsJson(int legacy_layout,
                                   const std::vector<std::string>& legacy,
                                   const std::vector<std::string>& current) {
  const MigrationPlan plan =
      MigrateStoredItems(legacy_layout, Pairs(legacy), Pairs(current));
  if (!plan.valid) {
    return "null";
  }
  flowjson::Value puts = flowjson::Value::Array();
  for (const auto& put : plan.puts) {
    flowjson::Value pair = flowjson::Value::Array();
    pair.Push(flowjson::Value::String(put.first));
    pair.Push(flowjson::Value::String(put.second));
    puts.Push(pair);
  }
  flowjson::Value removes = flowjson::Value::Array();
  for (const std::string& key : plan.removes) {
    removes.Push(flowjson::Value::String(key));
  }
  flowjson::Value out = flowjson::Value::Object();
  out.Set("schemaVersion", flowjson::Value::Number(plan.schema_version));
  out.Set("migrated", flowjson::Value::Bool(plan.migrated));
  out.Set("puts", puts);
  out.Set("removes", removes);
  return flowjson::Stringify(out);
}

}  // namespace stored
}  // namespace pushy
