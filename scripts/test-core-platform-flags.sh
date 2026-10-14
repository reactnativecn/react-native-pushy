#!/bin/sh
# Compiles every shared core source (cpp/patch_core, cpp/update_flow_core)
# with each platform's release flags, warnings as errors, syntax only. The
# unit tests build the cores one way (host c++, C++17, RTTI, asserts on);
# the shipped binaries build them three other ways, so a construct only one
# platform rejects (RTTI under Android's -fno-rtti, C++20 changes under the
# iOS standard RN selects, code that only warns with NDEBUG) would otherwise
# first fail in that platform's build.
#
# Keep each set in step with its build:
#   android  android/jni/Application.mk  (APP_CPPFLAGS)
#   ios      react-native-update.podspec (Core compiler_flags; the C++
#            standard is React Native's, C++20 since RN 0.73)
#   harmony  harmony/pushy/src/main/cpp/CMakeLists.txt (release)
# Flag variables must split into compiler arguments.
# shellcheck disable=SC2086
set -eu

# Intentional one-command CDPATH assignment.
# shellcheck disable=SC1007
ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.tmp/core-platform-flags"
mkdir -p "$BUILD_DIR"

# CORE_WARNINGS (-Werror).
# shellcheck source-path=SCRIPTDIR source=lib/cpp-test-common.sh
. "$ROOT_DIR/scripts/lib/cpp-test-common.sh"

# Every shipped binary is built with clang; prefer it over the host c++.
CXX="${CXX:-}"
if [ -z "$CXX" ]; then
  if command -v clang++ >/dev/null 2>&1; then CXX=clang++; else CXX=c++; fi
fi

failed=0
check() {
  platform="$1"
  flags="$2"
  for source in "$ROOT_DIR"/cpp/patch_core/*.cpp "$ROOT_DIR"/cpp/update_flow_core/*.cpp; do
    if ! "$CXX" -fsyntax-only $CORE_WARNINGS $flags "$source"; then
      echo "[FAIL] $platform ($flags): ${source#"$ROOT_DIR"/}"
      failed=1
    fi
  done
  echo "[done] $platform: $flags"
}

check android "-std=c++17 -fexceptions -fno-rtti -DNDEBUG -fvisibility=hidden -fvisibility-inlines-hidden"
check ios "-std=c++20 -DNDEBUG -fvisibility=hidden -fvisibility-inlines-hidden"
check harmony "-std=c++17 -DNDEBUG -fvisibility=hidden -fvisibility-inlines-hidden"

if [ "$failed" != 0 ]; then
  exit 1
fi
echo "shared cores compile with every platform's release flags ($CXX)"
