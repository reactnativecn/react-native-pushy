#!/bin/sh
# Flag variables ($SANITIZE_FLAGS, $CORE_WARNINGS) must split into compiler
# arguments.
# shellcheck disable=SC2086
set -eu

# Intentional one-command CDPATH assignment.
# shellcheck disable=SC1007
ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.tmp/update-flow-core-tests"

mkdir -p "$BUILD_DIR"

# SANITIZE=1 / FUZZ=1 conventions and CORE_WARNINGS.
# shellcheck source-path=SCRIPTDIR source=lib/cpp-test-common.sh
. "$ROOT_DIR/scripts/lib/cpp-test-common.sh"
cpp_test_sanitize_flags "update flow core tests"

c++ \
  -std=c++17 \
  $CORE_WARNINGS \
  $SANITIZE_FLAGS \
  "$ROOT_DIR"/cpp/update_flow_core/*.cpp \
  "$ROOT_DIR/cpp/update_flow_core/tests/update_flow_core_test.cpp" \
  -o "$BUILD_DIR/update_flow_core_test"

"$BUILD_DIR/update_flow_core_test" \
  "$ROOT_DIR/cpp/update_flow_core/tests/flow_vectors.json" \
  "$ROOT_DIR/cpp/update_flow_core/tests/config-equivalence-vectors.json" \
  "$ROOT_DIR/cpp/update_flow_core/tests/native-config-vectors.json"

# Opt-in libFuzzer run of the JSON parser + decision pipeline (raw server
# bytes): FUZZ=1 bun run test:flow-core.
if cpp_test_fuzz_compiler; then
  echo "Fuzzing flow JSON parser + decision pipeline for ${FUZZ_SECONDS:-20}s ($FUZZ_CXX)"
  "$FUZZ_CXX" \
    -std=c++17 \
    $CORE_WARNINGS \
    -g -O1 -fno-omit-frame-pointer \
    -fsanitize=fuzzer,address,undefined \
    "$ROOT_DIR"/cpp/update_flow_core/*.cpp \
    "$ROOT_DIR/cpp/update_flow_core/tests/fuzz_flow_json.cpp" \
    -o "$BUILD_DIR/fuzz_flow_json"
  CORPUS_DIR="$BUILD_DIR/fuzz-corpus-flow-json"
  mkdir -p "$CORPUS_DIR"
  printf '{"update":true,"hash":"h2","full":"h2.ppk","diff":"d.hdiff","paths":["cdn.x.com","https://m.x.com/"],"name":"v2","config":{"forceBoot":true}}' > "$CORPUS_DIR/seed-download.json"
  printf '{"update":true,"hash":"root","expVersion":{"hash":"gray","full":"g.ppk","config":{"rollout":{"2.3.4":63}}},"paths":["cdn"]}' > "$CORPUS_DIR/seed-rollout.json"
  printf '{"upToDate":true,"s":"\\ud83d\\ude00 \\u00e9 \\n","n":[1,-0.5,1e2,null,false]}' > "$CORPUS_DIR/seed-scalars.json"
  printf '{"appKey":" k ","endpoints":["https://a.example/","https://a.example"],"disabled":false,"rn":""}' > "$CORPUS_DIR/seed-config.json"
  "$BUILD_DIR/fuzz_flow_json" \
    -max_total_time="${FUZZ_SECONDS:-20}" \
    -max_len=4096 \
    -print_final_stats=1 \
    "$CORPUS_DIR"
fi
