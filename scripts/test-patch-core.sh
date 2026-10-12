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

COMMON_INCLUDES="
  -I$ROOT_DIR/cpp/patch_core
  -I$ROOT_DIR/android/jni
  -I$ROOT_DIR/android/jni/HDiffPatch
  -I$ROOT_DIR/android/jni/HDiffPatch/libHDiffPatch/HPatch
  -I$ROOT_DIR/android/jni/lzma/C
"

# The vendored HDiffPatch / lzma C sources are compiled with -Wall -Wextra
# only (no -Werror).
cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/cpp/hpatch/hpatch.c" -o "$BUILD_DIR/hpatch.o"
cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/HDiffPatch/libHDiffPatch/HPatch/patch.c" -o "$BUILD_DIR/patch.o"
cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/HDiffPatch/file_for_patch.c" -o "$BUILD_DIR/file_for_patch.o"
cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/lzma/C/LzmaDec.c" -o "$BUILD_DIR/LzmaDec.o"
cc -Wall -Wextra $SANITIZE_FLAGS $COMMON_INCLUDES -c "$ROOT_DIR/android/jni/lzma/C/Lzma2Dec.c" -o "$BUILD_DIR/Lzma2Dec.o"

c++ \
  -std=c++17 \
  $CORE_WARNINGS \
  $SANITIZE_FLAGS \
  $COMMON_INCLUDES \
  "$ROOT_DIR/cpp/patch_core/tests/patch_core_test.cpp" \
  "$ROOT_DIR/cpp/patch_core/archive_patch_core.cpp" \
  "$ROOT_DIR/cpp/patch_core/digest.cpp" \
  "$ROOT_DIR/cpp/patch_core/patch_core.cpp" \
  "$ROOT_DIR/cpp/patch_core/state_core.cpp" \
  "$ROOT_DIR/cpp/patch_core/hbc_transform.cpp" \
  "$ROOT_DIR/cpp/patch_core/hbc_transform_wire.cpp" \
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

# Opt-in libFuzzer run of the hbcTransform wire parser (untrusted __diff.json
# metadata): FUZZ=1 bun run test:patch-core.
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
fi
