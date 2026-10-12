# shellcheck shell=sh
# Shared settings for the cpp/ core test scripts (test-patch-core.sh,
# test-update-flow-core.sh). POSIX sh; sourced, not executed. Expects
# BUILD_DIR to be set by the caller.

# The cpp/ cores must build warning-free (-Werror).
# shellcheck disable=SC2034  # used by the sourcing script
CORE_WARNINGS="-Wall -Wextra -Werror"

# Opt-in AddressSanitizer + UndefinedBehaviorSanitizer build: the cores
# process untrusted (downloaded) data, so running the tests under sanitizers
# catches memory/UB regressions. Enable with SANITIZE=1.
#   cpp_test_sanitize_flags "<what is being built>"
# sets SANITIZE_FLAGS (empty unless SANITIZE=1).
cpp_test_sanitize_flags() {
  SANITIZE_FLAGS=""
  if [ "${SANITIZE:-0}" = "1" ]; then
    SANITIZE_FLAGS="-fsanitize=address,undefined -fno-omit-frame-pointer -g"
    echo "Building $1 with AddressSanitizer + UBSan"
  fi
}

# Opt-in libFuzzer runs (FUZZ=1; FUZZ_SECONDS bounds each run, default 20)
# need clang with the libFuzzer runtime (libclang_rt.fuzzer). Apple clang
# ships without it, so Homebrew LLVM is tried too; FUZZ_CXX picks a compiler
# explicitly. Without a usable one the run is skipped, not failed.
#   if cpp_test_fuzz_compiler; then "$FUZZ_CXX" ...; fi
# returns 0 and sets FUZZ_CXX when FUZZ=1 and a compiler links a fuzzer.
cpp_test_fuzz_compiler() {
  [ "${FUZZ:-0}" = "1" ] || return 1
  fuzz_probe="$BUILD_DIR/fuzz_probe.cpp"
  printf '#include <cstddef>\n#include <cstdint>\nextern "C" int LLVMFuzzerTestOneInput(const uint8_t*, size_t) { return 0; }\n' > "$fuzz_probe"
  found_clang=0
  for candidate in ${FUZZ_CXX:-} clang++ /opt/homebrew/opt/llvm/bin/clang++ /usr/local/opt/llvm/bin/clang++; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    found_clang=1
    if "$candidate" -fsanitize=fuzzer,address,undefined "$fuzz_probe" -o "$BUILD_DIR/fuzz_probe" >/dev/null 2>&1; then
      FUZZ_CXX="$candidate"
      return 0
    fi
  done
  if [ "$found_clang" = "0" ]; then
    echo "FUZZ=1: clang++ not found, skipping the libFuzzer run"
  else
    echo "FUZZ=1: clang++ has no libFuzzer runtime (libclang_rt.fuzzer), skipping the libFuzzer run"
  fi
  return 1
}
