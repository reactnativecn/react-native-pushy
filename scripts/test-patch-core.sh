#!/bin/sh
# Flag variables ($SANITIZE_FLAGS, $CORE_WARNINGS, ...) must split into
# compiler arguments.
# shellcheck disable=SC2086
set -eu

# Intentional one-command CDPATH assignment.
# shellcheck disable=SC1007
ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.tmp/patch-core-tests"

mkdir -p "$BUILD_DIR"

# SANITIZE=1 / FUZZ=1 conventions and CORE_WARNINGS.
# shellcheck source-path=SCRIPTDIR source=lib/cpp-test-common.sh
. "$ROOT_DIR/scripts/lib/cpp-test-common.sh"
cpp_test_sanitize_flags "patch core tests"

# The cores and hpatch include everything file-relative; only the test itself
# includes HDiffPatch's patch.h by name.
COMMON_INCLUDES="
  -I$ROOT_DIR/android/jni/HDiffPatch/libHDiffPatch/HPatch
"

# hpatch.c and the vendored HDiffPatch / lzma C sources are compiled with
# -Wall -Wextra only (no -Werror).
cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/cpp/hpatch/hpatch.c" -o "$BUILD_DIR/hpatch.o"
cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/HDiffPatch/libHDiffPatch/HPatch/patch.c" -o "$BUILD_DIR/patch.o"
cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/HDiffPatch/file_for_patch.c" -o "$BUILD_DIR/file_for_patch.o"
cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/lzma/C/LzmaDec.c" -o "$BUILD_DIR/LzmaDec.o"
cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/lzma/C/Lzma2Dec.c" -o "$BUILD_DIR/Lzma2Dec.o"

# Every patch core source, picked up by directory like the platform builds
# (tests/ is a subdirectory and stays out), plus the flow core's JSON parser
# the manifest parser reads __diff.json with (every platform links both).
c++ \
  -std=c++17 \
  $CORE_WARNINGS \
  $SANITIZE_FLAGS \
  $COMMON_INCLUDES \
  "$ROOT_DIR/cpp/patch_core/tests/patch_core_test.cpp" \
  "$ROOT_DIR"/cpp/patch_core/*.cpp \
  "$ROOT_DIR/cpp/update_flow_core/flow_json.cpp" \
  "$BUILD_DIR/hpatch.o" \
  "$BUILD_DIR/patch.o" \
  "$BUILD_DIR/file_for_patch.o" \
  "$BUILD_DIR/LzmaDec.o" \
  "$BUILD_DIR/Lzma2Dec.o" \
  -o "$BUILD_DIR/patch_core_test"

c++ \
  -std=c++17 \
  $CORE_WARNINGS \
  $SANITIZE_FLAGS \
  "$ROOT_DIR/cpp/patch_core/tests/hbc_transform_test.cpp" \
  "$ROOT_DIR/cpp/patch_core/hbc_transform.cpp" \
  "$ROOT_DIR/cpp/patch_core/hbc_transform_wire.cpp" \
  -o "$BUILD_DIR/hbc_transform_test"

"$BUILD_DIR/patch_core_test" "$ROOT_DIR/cpp/patch_core/tests/fixtures"
"$BUILD_DIR/hbc_transform_test" "$ROOT_DIR/cpp/patch_core/tests/fixtures"

# Opt-in libFuzzer runs of the hbcTransform wire parser (untrusted __diff.json
# metadata) and of the whole __diff.json parser: FUZZ=1 bun run test:patch-core.
if cpp_test_fuzz_compiler; then
  echo "Fuzzing hbcTransform wire parser for ${FUZZ_SECONDS:-20}s ($FUZZ_CXX)"
  "$FUZZ_CXX" \
    -std=c++17 \
    $CORE_WARNINGS \
    -g -O1 -fno-omit-frame-pointer \
    -fsanitize=fuzzer,address,undefined \
    "$ROOT_DIR/cpp/patch_core/tests/fuzz_hbc_transform_wire.cpp" \
    "$ROOT_DIR/cpp/patch_core/hbc_transform.cpp" \
    "$ROOT_DIR/cpp/patch_core/hbc_transform_wire.cpp" \
    -o "$BUILD_DIR/fuzz_hbc_transform_wire"
  CORPUS_DIR="$BUILD_DIR/fuzz-corpus-hbc-transform-wire"
  mkdir -p "$CORPUS_DIR"
  cp "$ROOT_DIR/cpp/patch_core/tests/fixtures/v96.meta.json" "$CORPUS_DIR/seed-v96-meta.json"
  "$BUILD_DIR/fuzz_hbc_transform_wire" \
    -max_total_time="${FUZZ_SECONDS:-20}" \
    -max_len=8192 \
    -print_final_stats=1 \
    "$CORPUS_DIR"

  # The __diff.json parser (patch_manifest.h) links the whole core, so the
  # hpatch/HDiffPatch/lzma objects built above (uninstrumented) come along.
  echo "Fuzzing __diff.json manifest parser for ${FUZZ_SECONDS:-20}s ($FUZZ_CXX)"
  "$FUZZ_CXX" \
    -std=c++17 \
    $CORE_WARNINGS \
    -g -O1 -fno-omit-frame-pointer \
    -fsanitize=fuzzer,address,undefined \
    "$ROOT_DIR/cpp/patch_core/tests/fuzz_patch_manifest.cpp" \
    "$ROOT_DIR"/cpp/patch_core/*.cpp \
    "$ROOT_DIR/cpp/update_flow_core/flow_json.cpp" \
    "$BUILD_DIR/hpatch.o" \
    "$BUILD_DIR/patch.o" \
    "$BUILD_DIR/file_for_patch.o" \
    "$BUILD_DIR/LzmaDec.o" \
    "$BUILD_DIR/Lzma2Dec.o" \
    -o "$BUILD_DIR/fuzz_patch_manifest"
  CORPUS_DIR="$BUILD_DIR/fuzz-corpus-patch-manifest"
  mkdir -p "$CORPUS_DIR"
  # Seeds: option byte + manifest text (server ppk and package shapes, the
  # HarmonyOS form, and a transform-domain manifest).
  printf '\000{"copies":{"assets/b.png":"assets/a.png"},"deletes":{"assets/old.png":1,"assets/gone/":1}}' > "$CORPUS_DIR/seed-ppk.json"
  printf '\000{"copies":{"assets/a.png":"","assets/b.png":"assets/a.png"},"copiesCrc":{"assets/a.png":3421780262,"assets/b.png":3421780262}}' > "$CORPUS_DIR/seed-package.json"
  printf '\003{"copies":{"assets/i.png":"resources/rawfile/assets/i.png"},"deletes":["x"],"hbcTransform":{"bundle.harmony.js.patch":{"v":1}}}' > "$CORPUS_DIR/seed-harmony.json"
  { printf '\000{"hbcTransform":{"index.bundlejs.patch":'; cat "$ROOT_DIR/cpp/patch_core/tests/fixtures/v96.meta.json"; printf '}}'; } > "$CORPUS_DIR/seed-hbc.json"
  "$BUILD_DIR/fuzz_patch_manifest" \
    -max_total_time="${FUZZ_SECONDS:-20}" \
    -max_len=8192 \
    -print_final_stats=1 \
    "$CORPUS_DIR"
fi
