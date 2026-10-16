cmake_minimum_required(VERSION 3.13)
project(rnpushy LANGUAGES C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CMAKE_VERBOSE_MAKEFILE on)

# The shared native sources are compiled in place from the repository root
# (or the npm package root, which ships cpp/ and the android/jni submodules).
set(REPO_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../)
set(PATCH_CORE_DIR ${REPO_ROOT}/cpp/patch_core)
set(UPDATE_FLOW_CORE_DIR ${REPO_ROOT}/cpp/update_flow_core)
set(HPATCH_DIR ${REPO_ROOT}/cpp/hpatch)
set(HDIFFPATCH_DIR ${REPO_ROOT}/android/jni/HDiffPatch)
set(LZMA_DIR ${REPO_ROOT}/android/jni/lzma)

# Always compile from source. A prebuilt-import branch used to live here, but
# it had no symbol verification: a stale libs/<abi>/librnpushy.so missing a
# newly added export (e.g. getSupportedDiffVersion) would silently ship and
# crash getConstants at runtime.
#
# The platform-neutral cores are picked up by directory (non-recursive, so
# tests/ stays out; the Android JNI glue lives in cpp/android_jni), so a new
# core source needs no edit here. CONFIGURE_DEPENDS re-globs on every build.
file(GLOB CORE_SOURCES CONFIGURE_DEPENDS
     ${PATCH_CORE_DIR}/*.cpp
     ${UPDATE_FLOW_CORE_DIR}/*.cpp
     ${HPATCH_DIR}/*.c
)
set(HDP_SOURCES
     ${CMAKE_CURRENT_SOURCE_DIR}/pushy.cpp
     ${CORE_SOURCES}
     # <generated:vendored-sources> (scripts/contract.ts; bun scripts/generate-contract.ts)
     ${HDIFFPATCH_DIR}/libHDiffPatch/HPatch/patch.c
     ${HDIFFPATCH_DIR}/file_for_patch.c
     ${LZMA_DIR}/C/LzmaDec.c
     ${LZMA_DIR}/C/Lzma2Dec.c
     # </generated:vendored-sources>
)

add_library(rnpushy SHARED
    ${HDP_SOURCES}
)

# pushy.cpp includes the cores by name; the cores themselves (and hpatch's
# HDiffPatch/lzma includes) resolve file-relative.
target_include_directories(rnpushy PRIVATE
     ${CMAKE_CURRENT_SOURCE_DIR}
     ${PATCH_CORE_DIR}
     ${UPDATE_FLOW_CORE_DIR}
)

target_link_libraries(rnpushy PUBLIC
    libace_napi.z.so
)

if(TARGET rnoh)
    add_library(rnoh_pushy SHARED
        ${CMAKE_CURRENT_SOURCE_DIR}/PushyTurboModule.cpp
    )
    target_include_directories(rnoh_pushy PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
    target_link_libraries(rnoh_pushy PUBLIC rnoh)
endif()

# Optimize binary size for Release builds of the NAPI library. --gc-sections
# only drops anything when every function/data item sits in its own section,
# and the module registers itself through NAPI_MODULE's static constructor,
# so no symbol needs default visibility. Scoped to rnpushy: rnoh_pushy must
# keep exporting PushyTurboModule (JSI_EXPORT) for the host's PackageProvider.
if(NOT CMAKE_BUILD_TYPE STREQUAL "Debug")
    target_compile_options(rnpushy PRIVATE
        # NAPI_MODULE records __FILE__; keep the build path out of the binary.
        -fmacro-prefix-map=${CMAKE_CURRENT_SOURCE_DIR}/=
        -ffunction-sections
        -fdata-sections
        -fvisibility=hidden
        -fvisibility-inlines-hidden
    )
    # Strip debug symbols and garbage-collect the unused sections.
    target_link_options(rnpushy PRIVATE -Wl,--gc-sections -s)
endif()
