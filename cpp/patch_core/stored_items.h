#pragma once

#include <string>
#include <utility>
#include <vector>

// The persisted layout every platform shares (scripts/contract.ts
// storeSchema, stateFields, storedItems) and the one-time move out of the
// layouts SDKs up to 10.61 wrote (legacyLayouts). The hosts keep the IO:
// they snapshot both stores as strings, write the plan's puts, and only once
// those are durable delete the plan's removes from the legacy store.
// tests/stored-items-vectors.json pins this layer and the hosts' adapters.
//
// What is carried over is what a binary upgrade keeps (the uuid, the native
// config, the round breadcrumb, the bundle hash cache) plus the binary
// identity the upgrade is detected from. The new layout only ships in a new
// binary, whose first launch resets every other state field anyway
// (state::SyncBinaryVersion), so the installed version, its info and the
// launch markers are dropped instead of translated.
//
// Keep the core internal to whichever binary links it (see podspec Core).
#pragma GCC visibility push(hidden)

namespace pushy {
namespace stored {

// <generated:schema> (scripts/contract.ts; bun scripts/generate-contract.ts)
constexpr int kSchemaVersion = 1;
constexpr const char* kSchemaVersionKey = "schemaVersion";
// The legacy layouts, by the id the hosts pass.
constexpr int kLegacyAndroid = 1;
constexpr int kLegacyIos = 2;
constexpr int kLegacyHarmony = 3;
// </generated:schema>

// Key/value pairs in store order (the hosts' snapshots are unordered maps;
// keys are unique). A value the host cannot read as text (an iOS dictionary)
// is passed as "": it is still a key to delete, never a value to carry.
using Entries = std::vector<std::pair<std::string, std::string>>;

struct MigrationPlan {
  // False only for an unknown legacy layout id: the host then migrates
  // nothing (see the hosts' uuid-only fallback).
  bool valid = true;
  // The schema the store holds once the plan is applied: kSchemaVersion, or
  // a newer one a later SDK wrote, which this SDK leaves alone.
  int schema_version = 0;
  // The plan carries the one-time migration (the store had no schema).
  bool migrated = false;
  // Into the state store, in order; schemaVersion is always the last, so a
  // host whose writes are not atomic (iOS) never marks a partial migration
  // as done. A key the store already holds is never overwritten.
  Entries puts;
  // From the legacy store, sorted: only keys the legacy layout owns (iOS
  // shares its legacy store with the host app).
  std::vector<std::string> removes;
};

// The store's own schemaVersion value as a number; 0 when absent or not a
// plain positive decimal.
int ParseSchemaVersion(const std::string& value);

// Idempotent: re-running it after any prefix of its plan was applied yields
// the rest of that plan. legacy: the legacy store; current: the state store.
MigrationPlan MigrateStoredItems(int legacy_layout, const Entries& legacy,
                                 const Entries& current);

// For the bindings: flat [key, value, key, value, ...] arrays in (an odd
// trailing key is ignored), JSON out:
//   {"schemaVersion":1,"migrated":true,"puts":[["uuid","..."],...],
//    "removes":["..."]}
// or "null" for an unknown layout.
std::string MigrateStoredItemsJson(int legacy_layout,
                                   const std::vector<std::string>& legacy,
                                   const std::vector<std::string>& current);

}  // namespace stored
}  // namespace pushy

#pragma GCC visibility pop
