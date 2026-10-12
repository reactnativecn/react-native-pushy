#include <napi/native_api.h>

#include "flow_json.h"
#include "update_flow_core.h"
#include <js_native_api.h>
#include <js_native_api_types.h>

#include <cerrno>
#include <cstdint>
#include <string>
#include <unistd.h>
#include <utility>
#include <vector>

#include "archive_patch_core.h"
#include "digest.h"
#include "hbc_transform_wire.h"
#include "patch_core.h"
#include "state_core.h"
#include "state_ops.h"

namespace {

using pushy::state_ops::StateOperation;


void ThrowError(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

bool GetArgCount(
    napi_env env,
    napi_callback_info info,
    size_t* argc,
    napi_value* args) {
  return napi_get_cb_info(env, info, argc, args, nullptr, nullptr) == napi_ok;
}

bool GetValueType(
    napi_env env,
    napi_value value,
    napi_valuetype* out_type) {
  return napi_typeof(env, value, out_type) == napi_ok;
}

bool IsNullOrUndefined(napi_env env, napi_value value) {
  napi_valuetype type = napi_undefined;
  if (!GetValueType(env, value, &type)) {
    return true;
  }
  return type == napi_undefined || type == napi_null;
}

std::string GetString(napi_env env, napi_value value, bool* ok) {
  if (ok != nullptr) {
    *ok = false;
  }
  if (value == nullptr || IsNullOrUndefined(env, value)) {
    if (ok != nullptr) {
      *ok = true;
    }
    return std::string();
  }

  napi_valuetype type = napi_undefined;
  if (!GetValueType(env, value, &type) || type != napi_string) {
    ThrowError(env, "Expected string");
    return std::string();
  }

  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
    ThrowError(env, "Failed to read string");
    return std::string();
  }

  // length + 1 so NAPI's terminating '\0' lands inside owned storage instead
  // of the string's past-the-end terminator slot (formally UB to write).
  std::string result(length + 1, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(
          env, value, result.data(), length + 1, &written) != napi_ok) {
    ThrowError(env, "Failed to read string");
    return std::string();
  }
  result.resize(written);
  if (ok != nullptr) {
    *ok = true;
  }
  return result;
}

bool GetInt32(napi_env env, napi_value value, int32_t* out_value) {
  if (value == nullptr || out_value == nullptr) {
    ThrowError(env, "Expected number");
    return false;
  }
  napi_valuetype type = napi_undefined;
  if (!GetValueType(env, value, &type) || type != napi_number) {
    ThrowError(env, "Expected number");
    return false;
  }
  if (napi_get_value_int32(env, value, out_value) != napi_ok) {
    ThrowError(env, "Failed to read number");
    return false;
  }
  return true;
}

bool GetBoolean(napi_env env, napi_value value, bool* out_value) {
  if (out_value == nullptr) {
    ThrowError(env, "Expected boolean");
    return false;
  }
  if (value == nullptr || IsNullOrUndefined(env, value)) {
    *out_value = false;
    return true;
  }
  napi_valuetype type = napi_undefined;
  if (!GetValueType(env, value, &type) || type != napi_boolean) {
    ThrowError(env, "Expected boolean");
    return false;
  }
  bool result = false;
  if (napi_get_value_bool(env, value, &result) != napi_ok) {
    ThrowError(env, "Failed to read boolean");
    return false;
  }
  *out_value = result;
  return true;
}

bool HasNamedProperty(napi_env env, napi_value object, const char* name, bool* out_has) {
  if (out_has == nullptr) {
    ThrowError(env, "Internal error");
    return false;
  }
  bool has = false;
  if (napi_has_named_property(env, object, name, &has) != napi_ok) {
    ThrowError(env, std::string("Failed to read property ") + name);
    return false;
  }
  *out_has = has;
  return true;
}

bool GetNamedProperty(
    napi_env env,
    napi_value object,
    const char* name,
    napi_value* out_value) {
  if (out_value == nullptr) {
    ThrowError(env, "Internal error");
    return false;
  }
  if (napi_get_named_property(env, object, name, out_value) != napi_ok) {
    ThrowError(env, std::string("Failed to read property ") + name);
    return false;
  }
  return true;
}

bool GetOptionalStringProperty(
    napi_env env,
    napi_value object,
    const char* name,
    std::string* out_value) {
  bool has = false;
  if (!HasNamedProperty(env, object, name, &has)) {
    return false;
  }
  if (!has) {
    out_value->clear();
    return true;
  }

  napi_value property = nullptr;
  if (!GetNamedProperty(env, object, name, &property)) {
    return false;
  }

  bool ok = false;
  *out_value = GetString(env, property, &ok);
  return ok;
}

bool GetOptionalBoolProperty(
    napi_env env,
    napi_value object,
    const char* name,
    bool default_value,
    bool* out_value) {
  bool has = false;
  if (!HasNamedProperty(env, object, name, &has)) {
    return false;
  }
  if (!has) {
    *out_value = default_value;
    return true;
  }

  napi_value property = nullptr;
  if (!GetNamedProperty(env, object, name, &property)) {
    return false;
  }
  return GetBoolean(env, property, out_value);
}

bool GetStringArray(
    napi_env env,
    napi_value value,
    std::vector<std::string>* out_values) {
  out_values->clear();
  if (value == nullptr || IsNullOrUndefined(env, value)) {
    return true;
  }

  bool is_array = false;
  if (napi_is_array(env, value, &is_array) != napi_ok || !is_array) {
    ThrowError(env, "Expected string array");
    return false;
  }

  uint32_t length = 0;
  if (napi_get_array_length(env, value, &length) != napi_ok) {
    ThrowError(env, "Failed to read array length");
    return false;
  }

  out_values->reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item = nullptr;
    if (napi_get_element(env, value, index, &item) != napi_ok) {
      ThrowError(env, "Failed to read array item");
      return false;
    }
    bool ok = false;
    out_values->push_back(GetString(env, item, &ok));
    if (!ok) {
      return false;
    }
  }
  return true;
}

bool GetOptionalStringArrayProperty(
    napi_env env,
    napi_value object,
    const char* name,
    std::vector<std::string>* out_values) {
  bool has = false;
  if (!HasNamedProperty(env, object, name, &has)) {
    return false;
  }
  if (!has) {
    out_values->clear();
    return true;
  }

  napi_value property = nullptr;
  if (!GetNamedProperty(env, object, name, &property)) {
    return false;
  }
  return GetStringArray(env, property, out_values);
}

bool GetObject(napi_env env, napi_value value) {
  if (value == nullptr || IsNullOrUndefined(env, value)) {
    return true;
  }
  napi_valuetype type = napi_undefined;
  if (!GetValueType(env, value, &type) || type != napi_object) {
    ThrowError(env, "Expected object");
    return false;
  }
  return true;
}

pushy::state::State ReadState(napi_env env, napi_value value, bool* ok) {
  if (ok != nullptr) {
    *ok = false;
  }
  pushy::state::State state;
  if (value == nullptr || IsNullOrUndefined(env, value)) {
    if (ok != nullptr) {
      *ok = true;
    }
    return state;
  }
  if (!GetObject(env, value)) {
    return state;
  }

  if (!GetOptionalStringProperty(env, value, "packageVersion", &state.package_version) ||
      !GetOptionalStringProperty(env, value, "buildTime", &state.build_time) ||
      !GetOptionalStringProperty(env, value, "currentVersion", &state.current_version) ||
      !GetOptionalStringProperty(env, value, "lastVersion", &state.last_version) ||
      !GetOptionalBoolProperty(env, value, "firstTime", false, &state.first_time) ||
      !GetOptionalBoolProperty(env, value, "firstTimeOk", true, &state.first_time_ok) ||
      !GetOptionalStringProperty(env, value, "rolledBackVersion", &state.rolled_back_version)) {
    return state;
  }

  if (ok != nullptr) {
    *ok = true;
  }
  return state;
}

napi_value NewBoolean(napi_env env, bool value) {
  napi_value result = nullptr;
  napi_get_boolean(env, value, &result);
  return result;
}

napi_value NewString(napi_env env, const std::string& value) {
  napi_value result = nullptr;
  if (napi_create_string_utf8(env, value.c_str(), value.size(), &result) !=
      napi_ok) {
    ThrowError(env, "Failed to create string");
    return nullptr;
  }
  return result;
}

void SetStringProperty(
    napi_env env,
    napi_value object,
    const char* name,
    const std::string& value) {
  if (value.empty()) {
    return;
  }
  napi_set_named_property(env, object, name, NewString(env, value));
}

void SetBoolProperty(
    napi_env env,
    napi_value object,
    const char* name,
    bool value) {
  napi_set_named_property(env, object, name, NewBoolean(env, value));
}

// Per-operation outputs reported next to the state; all default to "nothing".
struct StateResultExtras {
  bool changed = false;
  std::string stale_version_to_delete;
  std::string load_version;
  bool did_rollback = false;
  bool consumed_first_time = false;
};

napi_value NewStateResult(
    napi_env env,
    const pushy::state::State& state,
    const StateResultExtras& extras = StateResultExtras()) {
  napi_value result = nullptr;
  napi_create_object(env, &result);

  SetStringProperty(env, result, "packageVersion", state.package_version);
  SetStringProperty(env, result, "buildTime", state.build_time);
  SetStringProperty(env, result, "currentVersion", state.current_version);
  SetStringProperty(env, result, "lastVersion", state.last_version);
  SetBoolProperty(env, result, "firstTime", state.first_time);
  SetBoolProperty(env, result, "firstTimeOk", state.first_time_ok);
  SetStringProperty(env, result, "rolledBackVersion", state.rolled_back_version);
  SetBoolProperty(env, result, "changed", extras.changed);
  SetStringProperty(
      env, result, "staleVersionToDelete", extras.stale_version_to_delete);
  SetStringProperty(env, result, "loadVersion", extras.load_version);
  SetBoolProperty(env, result, "didRollback", extras.did_rollback);
  SetBoolProperty(env, result, "consumedFirstTime", extras.consumed_first_time);
  return result;
}

napi_value NewArchivePatchPlanResult(
    napi_env env,
    const pushy::archive_patch::ArchivePatchPlan& plan) {
  napi_value result = nullptr;
  napi_create_object(env, &result);
  SetStringProperty(env, result, "mergeSourceSubdir", plan.merge_source_subdir);
  SetBoolProperty(env, result, "enableMerge", plan.enable_merge);
  return result;
}

napi_value NewCopyGroupArray(
    napi_env env,
    const std::vector<pushy::archive_patch::CopyGroup>& groups) {
  napi_value result = nullptr;
  napi_create_array_with_length(env, groups.size(), &result);
  for (size_t index = 0; index < groups.size(); ++index) {
    napi_value group = nullptr;
    napi_create_object(env, &group);
    SetStringProperty(env, group, "from", groups[index].from);

    napi_value to_paths = nullptr;
    napi_create_array_with_length(env, groups[index].to_paths.size(), &to_paths);
    for (size_t target_index = 0; target_index < groups[index].to_paths.size();
         ++target_index) {
      napi_set_element(
          env,
          to_paths,
          target_index,
          NewString(env, groups[index].to_paths[target_index]));
    }
    napi_set_named_property(env, group, "toPaths", to_paths);
    napi_set_element(env, result, index, group);
  }
  return result;
}

pushy::delta::PatchManifest BuildManifest(
    const std::vector<std::string>& copy_froms,
    const std::vector<std::string>& copy_tos,
    const std::vector<std::string>& deletes) {
  pushy::delta::PatchManifest manifest;
  for (size_t index = 0; index < copy_froms.size(); ++index) {
    manifest.copies.push_back(
        pushy::delta::CopyOperation{copy_froms[index], copy_tos[index]});
  }
  manifest.deletes = deletes;
  return manifest;
}

napi_value SyncStateWithBinaryVersion(napi_env env, napi_callback_info info) {
  napi_value args[3] = {nullptr, nullptr, nullptr};
  size_t argc = 3;
  if (!GetArgCount(env, info, &argc, args) || argc < 3) {
    ThrowError(env, "Wrong number of arguments");
    return nullptr;
  }

  bool ok = false;
  const std::string package_version = GetString(env, args[0], &ok);
  if (!ok) {
    return nullptr;
  }
  const std::string build_time = GetString(env, args[1], &ok);
  if (!ok) {
    return nullptr;
  }
  const pushy::state::State state = ReadState(env, args[2], &ok);
  if (!ok) {
    return nullptr;
  }

  const pushy::state::BinaryVersionSyncResult result =
      pushy::state::SyncBinaryVersion(state, package_version, build_time);
  StateResultExtras extras;
  extras.changed = result.changed;
  return NewStateResult(env, result.state, extras);
}

napi_value RunStateCore(napi_env env, napi_callback_info info) {
  napi_value args[5] = {nullptr, nullptr, nullptr, nullptr, nullptr};
  size_t argc = 5;
  if (!GetArgCount(env, info, &argc, args) || argc < 2) {
    ThrowError(env, "Wrong number of arguments");
    return nullptr;
  }

  int32_t operation = 0;
  if (!GetInt32(env, args[0], &operation)) {
    return nullptr;
  }

  bool ok = false;
  const pushy::state::State state = ReadState(env, args[1], &ok);
  if (!ok) {
    return nullptr;
  }

  std::string string_arg;
  if (argc >= 3) {
    string_arg = GetString(env, args[2], &ok);
    if (!ok) {
      return nullptr;
    }
  }

  bool flag_a = false;
  bool flag_b = false;
  if (argc >= 4 && !GetBoolean(env, args[3], &flag_a)) {
    return nullptr;
  }
  if (argc >= 5 && !GetBoolean(env, args[4], &flag_b)) {
    return nullptr;
  }

  switch (static_cast<StateOperation>(operation)) {
    case StateOperation::kSwitchVersion:
      return NewStateResult(env, pushy::state::SwitchVersion(state, string_arg));
    case StateOperation::kMarkSuccess: {
      const pushy::state::MarkSuccessResult result = pushy::state::MarkSuccess(state);
      StateResultExtras extras;
      extras.stale_version_to_delete = result.stale_version_to_delete;
      return NewStateResult(env, result.state, extras);
    }
    case StateOperation::kRollback: {
      const pushy::state::State next = pushy::state::Rollback(state);
      StateResultExtras extras;
      extras.load_version = next.current_version;
      extras.did_rollback = true;
      return NewStateResult(env, next, extras);
    }
    case StateOperation::kClearFirstTime:
      return NewStateResult(env, pushy::state::ClearFirstTime(state));
    case StateOperation::kClearRollbackMark:
      return NewStateResult(env, pushy::state::ClearRollbackMark(state));
    case StateOperation::kResolveLaunch: {
      const pushy::state::LaunchDecision decision =
          pushy::state::ResolveLaunchState(state, flag_a, flag_b);
      StateResultExtras extras;
      extras.load_version = decision.load_version;
      extras.did_rollback = decision.did_rollback;
      extras.consumed_first_time = decision.consumed_first_time;
      return NewStateResult(env, decision.state, extras);
    }
  }

  ThrowError(env, "Unknown state operation");
  return nullptr;
}

napi_value BuildArchivePatchPlan(napi_env env, napi_callback_info info) {
  napi_value args[6] = {nullptr, nullptr, nullptr, nullptr, nullptr, nullptr};
  size_t argc = 6;
  if (!GetArgCount(env, info, &argc, args) || argc < 5) {
    ThrowError(env, "Wrong number of arguments");
    return nullptr;
  }

  int32_t patch_type = 0;
  if (!GetInt32(env, args[0], &patch_type)) {
    return nullptr;
  }

  std::vector<std::string> entry_names;
  std::vector<std::string> copy_froms;
  std::vector<std::string> copy_tos;
  std::vector<std::string> deletes;
  if (!GetStringArray(env, args[1], &entry_names) ||
      !GetStringArray(env, args[2], &copy_froms) ||
      !GetStringArray(env, args[3], &copy_tos) ||
      !GetStringArray(env, args[4], &deletes)) {
    return nullptr;
  }
  if (copy_froms.size() != copy_tos.size()) {
    ThrowError(env, "copyFroms and copyTos length mismatch");
    return nullptr;
  }

  std::string bundle_patch_entry_name =
      pushy::archive_patch::DefaultBundleDeltaEntryName();
  if (argc >= 6) {
    bool ok = false;
    const std::string candidate = GetString(env, args[5], &ok);
    if (!ok) {
      return nullptr;
    }
    if (!candidate.empty()) {
      bundle_patch_entry_name = candidate;
    }
  }

  const pushy::delta::PatchManifest manifest =
      BuildManifest(copy_froms, copy_tos, deletes);
  pushy::archive_patch::ArchivePatchType archive_type;
  if (!pushy::archive_patch::TryParseArchivePatchType(patch_type, &archive_type)) {
    ThrowError(env, "Unknown archive delta type");
    return nullptr;
  }
  pushy::archive_patch::ArchivePatchPlan plan;
  const pushy::delta::Status status = pushy::archive_patch::BuildArchivePatchPlan(
      archive_type,
      manifest,
      entry_names,
      &plan,
      bundle_patch_entry_name);
  if (!status.ok) {
    ThrowError(env, status.message);
    return nullptr;
  }

  return NewArchivePatchPlanResult(env, plan);
}

napi_value BuildCopyGroups(napi_env env, napi_callback_info info) {
  napi_value args[2] = {nullptr, nullptr};
  size_t argc = 2;
  if (!GetArgCount(env, info, &argc, args) || argc < 2) {
    ThrowError(env, "Wrong number of arguments");
    return nullptr;
  }

  std::vector<std::string> copy_froms;
  std::vector<std::string> copy_tos;
  if (!GetStringArray(env, args[0], &copy_froms) ||
      !GetStringArray(env, args[1], &copy_tos)) {
    return nullptr;
  }
  if (copy_froms.size() != copy_tos.size()) {
    ThrowError(env, "copyFroms and copyTos length mismatch");
    return nullptr;
  }

  const pushy::delta::PatchManifest manifest =
      BuildManifest(copy_froms, copy_tos, std::vector<std::string>());
  std::vector<pushy::archive_patch::CopyGroup> groups;
  const pushy::delta::Status status =
      pushy::archive_patch::BuildCopyGroups(manifest, &groups);
  if (!status.ok) {
    ThrowError(env, status.message);
    return nullptr;
  }

  return NewCopyGroupArray(env, groups);
}

// ---------------------------------------------------------------------------
// Async work plumbing for the heavy patch operations.
//
// applyDeltaFromSource and cleanupOldEntries run hdiff / recursive file IO
// that can take hundreds of ms to seconds. The Pushy TurboModule executes on
// the UI thread, so running these synchronously froze the UI. These are now
// wrapped in napi_create_async_work: arguments are parsed on the JS thread, the
// heavy work runs on a libuv worker thread, and the returned Promise is settled
// back on the JS thread.
// ---------------------------------------------------------------------------

// Reject an already-created deferred with an Error(message).
void RejectDeferredWithMessage(
    napi_env env,
    napi_deferred deferred,
    const char* message) {
  napi_value error = nullptr;
  napi_value message_value = nullptr;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &message_value);
  napi_create_error(env, nullptr, message_value, &error);
  napi_reject_deferred(env, deferred, error);
}

void ResolveDeferredWithUndefined(napi_env env, napi_deferred deferred) {
  napi_value undefined_value = nullptr;
  napi_get_undefined(env, &undefined_value);
  napi_resolve_deferred(env, deferred, undefined_value);
}

// Resolves with undefined, or rejects with the status message.
void SettleWithStatus(
    napi_env env,
    napi_deferred deferred,
    const pushy::delta::Status& status) {
  if (status.ok) {
    ResolveDeferredWithUndefined(env, deferred);
  } else {
    RejectDeferredWithMessage(env, deferred, status.message.c_str());
  }
}

template <typename W>
struct AsyncCall {
  napi_async_work work = nullptr;
  napi_deferred deferred = nullptr;
  W data;
  void (*execute)(W&) = nullptr;
  void (*settle)(napi_env, napi_deferred, const W&) = nullptr;
};

// Runs execute(data) on a libuv worker thread and returns a Promise that
// settle(env, deferred, data) settles back on the JS thread. Every path
// settles the promise exactly once and frees the call: a creation or queue
// failure rejects immediately, and work that was cancelled or aborted before
// it ran is rejected instead of settled from meaningless results.
template <typename W>
napi_value QueueWork(
    napi_env env,
    const char* name,
    W data,
    void (*execute)(W&),
    void (*settle)(napi_env, napi_deferred, const W&)) {
  auto* call = new AsyncCall<W>();
  call->data = std::move(data);
  call->execute = execute;
  call->settle = settle;

  napi_value promise = nullptr;
  if (napi_create_promise(env, &call->deferred, &promise) != napi_ok) {
    delete call;
    ThrowError(env, "Unable to create promise");
    return nullptr;
  }

  napi_value resource_name = nullptr;
  napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &resource_name);
  if (napi_create_async_work(
          env,
          nullptr,
          resource_name,
          [](napi_env, void* raw) {
            auto* c = static_cast<AsyncCall<W>*>(raw);
            c->execute(c->data);
          },
          [](napi_env cb_env, napi_status status, void* raw) {
            auto* c = static_cast<AsyncCall<W>*>(raw);
            if (status != napi_ok) {
              RejectDeferredWithMessage(cb_env, c->deferred, "async work aborted");
            } else {
              c->settle(cb_env, c->deferred, c->data);
            }
            napi_delete_async_work(cb_env, c->work);
            delete c;
          },
          call,
          &call->work) != napi_ok) {
    // Work was never created: settle the promise and free the call so it
    // neither leaks nor hangs pending forever.
    RejectDeferredWithMessage(env, call->deferred, "Unable to create async work");
    delete call;
    return promise;
  }
  if (napi_queue_async_work(env, call->work) != napi_ok) {
    // Queueing failed: the complete callback will never run, so clean up here.
    napi_delete_async_work(env, call->work);
    RejectDeferredWithMessage(env, call->deferred, "Unable to queue async work");
    delete call;
    return promise;
  }
  return promise;
}

struct ApplyPatchWork {
  pushy::delta::FileSourcePatchOptions options;
  pushy::delta::Status status{false, ""};
};

struct CleanupWork {
  std::string root_dir;
  // Every version that may still be in use: persisted current/last AND the
  // version this process booted from (two switches without a restart must not
  // evict the running bundle while its on-demand assets are still served).
  std::vector<std::string> keep_names;
  int32_t max_age_days = 0;
  pushy::delta::Status status{false, ""};
};

// Streaming file digest on a worker thread. A full package or bundle is tens
// of MB; hashing it synchronously on the UI thread (where the TurboModule
// runs) froze the app for hundreds of ms per archive/bundle/activation.
struct Sha256FileWork {
  std::string path;
  std::string hex;
};

// Digest of a byte range of an fd the caller keeps open (rawfile
// descriptors: the embedded bundle lives at [offset, offset + length) inside
// the HAP). The fd is never closed here; JS closes it after the promise
// settles.
struct Sha256RangeWork {
  int fd = -1;
  int64_t offset = 0;
  int64_t length = 0;
  std::string hex;
  std::string error;
};

// pread loop (positioned: never moves a file offset the caller may share).
// A short read before `length` bytes is an error, not EOF.
void HashFdRange(Sha256RangeWork& w) {
  pushy::digest::Sha256 hasher;
  std::vector<uint8_t> buffer(256 * 1024);
  int64_t position = w.offset;
  int64_t remaining = w.length;
  while (remaining > 0) {
    const size_t want = static_cast<size_t>(
        remaining < static_cast<int64_t>(buffer.size())
            ? remaining
            : static_cast<int64_t>(buffer.size()));
    const ssize_t read = pread(w.fd, buffer.data(), want, static_cast<off_t>(position));
    if (read < 0) {
      if (errno == EINTR) {
        continue;
      }
      w.error = "sha256HexRawFdAsync: read failed (errno " +
                 std::to_string(errno) + ")";
      return;
    }
    if (read == 0) {
      w.error = "sha256HexRawFdAsync: unexpected end of file";
      return;
    }
    hasher.Update(buffer.data(), static_cast<size_t>(read));
    position += read;
    remaining -= read;
  }
  w.hex = hasher.HexDigest();
}

bool GetNonNegativeInt64(
    napi_env env,
    napi_value value,
    const char* name,
    int64_t* out_value) {
  napi_valuetype type = napi_undefined;
  if (value == nullptr || !GetValueType(env, value, &type) ||
      type != napi_number ||
      napi_get_value_int64(env, value, out_value) != napi_ok ||
      *out_value < 0) {
    ThrowError(env, std::string("sha256HexRawFdAsync: ") + name +
                        " must be a non-negative number");
    return false;
  }
  return true;
}

napi_value ApplyPatchFromFileSource(napi_env env, napi_callback_info info) {
  napi_value args[1] = {nullptr};
  size_t argc = 1;
  if (!GetArgCount(env, info, &argc, args) || argc < 1) {
    ThrowError(env, "Wrong number of arguments");
    return nullptr;
  }
  if (!GetObject(env, args[0])) {
    return nullptr;
  }

  std::vector<std::string> copy_froms;
  std::vector<std::string> copy_tos;
  std::vector<std::string> deletes;
  std::string source_root;
  std::string target_root;
  std::string origin_bundle_path;
  std::string bundle_patch_path;
  std::string bundle_output_path;
  std::string merge_source_subdir;
  std::string bundle_hbc_transform_meta;
  bool enable_merge = true;

  if (!GetOptionalStringArrayProperty(env, args[0], "copyFroms", &copy_froms) ||
      !GetOptionalStringArrayProperty(env, args[0], "copyTos", &copy_tos) ||
      !GetOptionalStringArrayProperty(env, args[0], "deletes", &deletes) ||
      !GetOptionalStringProperty(env, args[0], "sourceRoot", &source_root) ||
      !GetOptionalStringProperty(env, args[0], "targetRoot", &target_root) ||
      !GetOptionalStringProperty(env, args[0], "originBundlePath", &origin_bundle_path) ||
      !GetOptionalStringProperty(env, args[0], "bundleDeltaPath", &bundle_patch_path) ||
      !GetOptionalStringProperty(env, args[0], "bundleOutputPath", &bundle_output_path) ||
      !GetOptionalStringProperty(env, args[0], "mergeSourceSubdir", &merge_source_subdir) ||
      !GetOptionalStringProperty(
          env, args[0], "bundleHbcTransformMeta", &bundle_hbc_transform_meta) ||
      !GetOptionalBoolProperty(env, args[0], "enableMerge", true, &enable_merge)) {
    return nullptr;
  }
  if (copy_froms.size() != copy_tos.size()) {
    ThrowError(env, "copyFroms and copyTos length mismatch");
    return nullptr;
  }

  ApplyPatchWork work;
  work.options.manifest = BuildManifest(copy_froms, copy_tos, deletes);
  work.options.source_root = source_root;
  work.options.target_root = target_root;
  work.options.origin_bundle_path = origin_bundle_path;
  work.options.bundle_patch_path = bundle_patch_path;
  work.options.bundle_output_path = bundle_output_path;
  work.options.merge_source_subdir = merge_source_subdir;
  work.options.bundle_hbc_transform_meta = bundle_hbc_transform_meta;
  work.options.enable_merge = enable_merge;

  return QueueWork<ApplyPatchWork>(
      env,
      "applyDeltaFromSource",
      std::move(work),
      [](ApplyPatchWork& w) {
        w.status = pushy::delta::ApplyPatchFromFileSource(w.options);
      },
      [](napi_env cb_env, napi_deferred deferred, const ApplyPatchWork& w) {
        SettleWithStatus(cb_env, deferred, w.status);
      });
}

// cleanupOldEntries(rootDir, keepNames: string[], maxAgeDays)
napi_value CleanupOldEntries(napi_env env, napi_callback_info info) {
  napi_value args[3] = {nullptr, nullptr, nullptr};
  size_t argc = 3;
  if (!GetArgCount(env, info, &argc, args) || argc < 3) {
    ThrowError(env, "Wrong number of arguments");
    return nullptr;
  }

  bool ok = false;
  const std::string root_dir = GetString(env, args[0], &ok);
  if (!ok) {
    return nullptr;
  }
  std::vector<std::string> keep_names;
  if (!GetStringArray(env, args[1], &keep_names)) {
    return nullptr;
  }
  int32_t max_age_days = 0;
  if (!GetInt32(env, args[2], &max_age_days)) {
    return nullptr;
  }

  CleanupWork work;
  work.root_dir = root_dir;
  work.keep_names = std::move(keep_names);
  work.max_age_days = max_age_days;

  return QueueWork<CleanupWork>(
      env,
      "cleanupOldEntries",
      std::move(work),
      [](CleanupWork& w) {
        w.status = pushy::delta::CleanupOldEntries(
            w.root_dir, w.keep_names, w.max_age_days);
      },
      [](napi_env cb_env, napi_deferred deferred, const CleanupWork& w) {
        SettleWithStatus(cb_env, deferred, w.status);
      });
}

// sha256HexFileAsync(path) -> Promise<hex>. Rejects when the file cannot be
// read (Sha256File returns an empty digest in that case).
napi_value Sha256HexFileAsync(napi_env env, napi_callback_info info) {
  napi_value args[1] = {nullptr};
  size_t argc = 1;
  if (!GetArgCount(env, info, &argc, args) || argc < 1) {
    ThrowError(env, "sha256HexFileAsync: missing path argument");
    return nullptr;
  }
  bool ok = false;
  std::string path = GetString(env, args[0], &ok);
  if (!ok) {
    return nullptr;
  }
  if (path.empty()) {
    ThrowError(env, "sha256HexFileAsync: path must be a non-empty string");
    return nullptr;
  }

  Sha256FileWork work;
  work.path = std::move(path);

  return QueueWork<Sha256FileWork>(
      env,
      "sha256HexFileAsync",
      std::move(work),
      [](Sha256FileWork& w) { w.hex = pushy::digest::Sha256File(w.path); },
      [](napi_env cb_env, napi_deferred deferred, const Sha256FileWork& w) {
        if (w.hex.empty()) {
          RejectDeferredWithMessage(
              cb_env, deferred, "sha256HexFileAsync: cannot read file");
        } else {
          napi_resolve_deferred(cb_env, deferred, NewString(cb_env, w.hex));
        }
      });
}

// sha256HexRawFdAsync(fd, offset, length) -> Promise<hex>, hashed on a libuv
// worker thread. Used for the embedded bundle (resourceManager.getRawFd): the
// UI thread neither reads the multi-MB bundle into memory nor hashes it.
// Rejects on any read failure or short read.
napi_value Sha256HexRawFdAsync(napi_env env, napi_callback_info info) {
  napi_value args[3] = {nullptr, nullptr, nullptr};
  size_t argc = 3;
  if (!GetArgCount(env, info, &argc, args) || argc < 3) {
    ThrowError(env, "sha256HexRawFdAsync: expected (fd, offset, length)");
    return nullptr;
  }
  int32_t fd = -1;
  if (!GetInt32(env, args[0], &fd)) {
    return nullptr;
  }
  if (fd < 0) {
    ThrowError(env, "sha256HexRawFdAsync: fd must be non-negative");
    return nullptr;
  }
  int64_t offset = 0;
  int64_t length = 0;
  if (!GetNonNegativeInt64(env, args[1], "offset", &offset) ||
      !GetNonNegativeInt64(env, args[2], "length", &length)) {
    return nullptr;
  }

  Sha256RangeWork work;
  work.fd = fd;
  work.offset = offset;
  work.length = length;

  return QueueWork<Sha256RangeWork>(
      env,
      "sha256HexRawFdAsync",
      std::move(work),
      HashFdRange,
      [](napi_env cb_env, napi_deferred deferred, const Sha256RangeWork& w) {
        if (!w.error.empty() || w.hex.empty()) {
          RejectDeferredWithMessage(
              cb_env,
              deferred,
              w.error.empty() ? "sha256HexRawFdAsync: no digest"
                              : w.error.c_str());
        } else {
          napi_resolve_deferred(cb_env, deferred, NewString(cb_env, w.hex));
        }
      });
}

bool ExportFunction(
    napi_env env,
    napi_value exports,
    const char* name,
    napi_callback callback) {
  napi_value fn = nullptr;
  if (napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &fn) !=
      napi_ok) {
    ThrowError(env, std::string("Unable to create function ") + name);
    return false;
  }

  if (napi_set_named_property(env, exports, name, fn) != napi_ok) {
    ThrowError(env, std::string("Unable to export function ") + name);
    return false;
  }
  return true;
}

}  // namespace


// CRC32(zip/zlib 多项式)。同步:输入是已在内存的 rawfile 资源字节,用于
// pdiff 拷贝前与 __diff.json copiesCrc 比对(不符则整次 patch 失败落 full)。
static napi_value Crc32(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  if (!GetArgCount(env, info, &argc, args) || argc < 1) {
    ThrowError(env, "crc32: missing data argument");
    return nullptr;
  }

  void* data = nullptr;
  size_t length = 0;
  bool is_typedarray = false;
  napi_is_typedarray(env, args[0], &is_typedarray);
  if (is_typedarray) {
    napi_typedarray_type type;
    napi_value arraybuffer = nullptr;
    size_t offset = 0;
    if (napi_get_typedarray_info(
            env, args[0], &type, &length, &data, &arraybuffer, &offset) !=
        napi_ok) {
      ThrowError(env, "crc32: cannot read typed array");
      return nullptr;
    }
  } else {
    bool is_arraybuffer = false;
    napi_is_arraybuffer(env, args[0], &is_arraybuffer);
    if (!is_arraybuffer ||
        napi_get_arraybuffer_info(env, args[0], &data, &length) != napi_ok) {
      ThrowError(env, "crc32: expected Uint8Array or ArrayBuffer");
      return nullptr;
    }
  }

  pushy::digest::Crc32 crc;
  if (length > 0) {
    crc.Update(static_cast<const uint8_t*>(data), length);
  }

  napi_value result = nullptr;
  // CRC32 fits a double exactly (32-bit unsigned), matching the JSON number
  // representation in the manifest.
  napi_create_double(env, static_cast<double>(crc.Value()), &result);
  return result;
}

// 原生 patch 内核可消费的 diff 轨道版本(2 = hdiffv2 轨道)
static napi_value GetSupportedDiffVersion(napi_env env, napi_callback_info) {
  napi_value result = nullptr;
  napi_create_uint32(
      env,
      static_cast<uint32_t>(pushy::hbc::kSupportedDiffVersion),
      &result);
  return result;
}

// ---- update-flow decision layer (NATIVE_CHECKUPDATE_DESIGN §10) ----
// String-in/string-out JSON, matching the decision layer's own boundary.
// Returning undefined (nullptr without a pending exception) means "input did
// not parse"; the ArkTS orchestrator skips the check round.

static napi_value FlowBuildRequestBody(napi_env env,
                                            napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  if (!GetArgCount(env, info, &argc, args) || argc < 1) {
    ThrowError(env, "buildRequestBody: missing input argument");
    return nullptr;
  }
  bool ok = false;
  std::string input_json = GetString(env, args[0], &ok);
  if (!ok) {
    return nullptr;
  }
  bool parsed = false;
  flowjson::Value input = flowjson::Parse(input_json, &parsed);
  if (!parsed || !input.IsObject()) {
    return nullptr;
  }
  return NewString(
      env, flowjson::Stringify(flowcore::BuildRequestBody(input)));
}

static napi_value FlowOrderEndpointCandidates(napi_env env,
                                              napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2] = {nullptr, nullptr};
  if (!GetArgCount(env, info, &argc, args) || argc < 2) {
    ThrowError(env, "orderEndpointCandidates: missing arguments");
    return nullptr;
  }
  bool ok = false;
  std::string endpoints_json = GetString(env, args[0], &ok);
  if (!ok) {
    return nullptr;
  }
  double sample = 0;
  if (napi_get_value_double(env, args[1], &sample) != napi_ok) {
    ThrowError(env, "orderEndpointCandidates: expected number sample");
    return nullptr;
  }
  bool parsed = false;
  flowjson::Value endpoints = flowjson::Parse(endpoints_json, &parsed);
  if (!parsed || !endpoints.IsArray()) {
    return nullptr;
  }
  return NewString(env,
                        flowjson::Stringify(flowcore::OrderEndpointCandidates(
                            endpoints, sample)));
}

static napi_value FlowIsValidResponse(napi_env env,
                                           napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1] = {nullptr};
  if (!GetArgCount(env, info, &argc, args) || argc < 1) {
    ThrowError(env, "isValidResponse: missing arguments");
    return nullptr;
  }
  bool ok = false;
  std::string response_text = GetString(env, args[0], &ok);
  if (!ok) {
    // Exception pending (non-string argument): propagate it as a throw
    // instead of a boolean that the caller would treat as a verdict.
    return nullptr;
  }
  napi_value result = nullptr;
  napi_get_boolean(env, flowcore::IsValidResponse(response_text),
                   &result);
  return result;
}

static napi_value FlowHandleResponse(napi_env env,
                                          napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3] = {nullptr, nullptr, nullptr};
  if (!GetArgCount(env, info, &argc, args) || argc < 3) {
    ThrowError(env, "handleResponse: missing arguments");
    return nullptr;
  }
  bool ok = false;
  std::string response_text = GetString(env, args[0], &ok);
  if (!ok) {
    return nullptr;
  }
  std::string identity_json = GetString(env, args[1], &ok);
  if (!ok) {
    return nullptr;
  }
  std::string after_download = GetString(env, args[2], &ok);
  if (!ok) {
    return nullptr;
  }
  bool parsed = false;
  flowjson::Value identity = flowjson::Parse(identity_json, &parsed);
  if (!parsed || !identity.IsObject()) {
    return nullptr;
  }
  return NewString(env,
                        flowjson::Stringify(flowcore::HandleResponse(
                            response_text, identity, false, after_download)));
}

napi_value Init(napi_env env, napi_value exports) {
  if (!ExportFunction(env, exports, "syncStateWithBinaryVersion", SyncStateWithBinaryVersion) ||
      !ExportFunction(env, exports, "runStateCore", RunStateCore) ||
      !ExportFunction(env, exports, "buildArchivePlan", BuildArchivePatchPlan) ||
      !ExportFunction(env, exports, "buildCopyGroups", BuildCopyGroups) ||
      !ExportFunction(env, exports, "applyDeltaFromSource", ApplyPatchFromFileSource) ||
      !ExportFunction(env, exports, "cleanupOldEntries", CleanupOldEntries) ||
      !ExportFunction(env, exports, "sha256HexFileAsync", Sha256HexFileAsync) ||
      !ExportFunction(env, exports, "sha256HexRawFdAsync", Sha256HexRawFdAsync) ||
      !ExportFunction(env, exports, "crc32", Crc32) ||
      !ExportFunction(env, exports, "getSupportedDiffVersion", GetSupportedDiffVersion) ||
      !ExportFunction(env, exports, "buildRequestBody", FlowBuildRequestBody) ||
      !ExportFunction(env, exports, "orderEndpointCandidates", FlowOrderEndpointCandidates) ||
      !ExportFunction(env, exports, "isValidResponse", FlowIsValidResponse) ||
      !ExportFunction(env, exports, "handleResponse", FlowHandleResponse)) {
    return nullptr;
  }
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
