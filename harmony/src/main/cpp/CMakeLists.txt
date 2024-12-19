cmake_minimum_required(VERSION 3.13)
project(rnupdate)

set(HDP_SOURCES
    hpatch.c
    HDiffPatch/libHDiffPatch/HPatch/patch.c
    HDiffPatch/file_for_patch.c
    lzma/C/LzmaDec.c
    lzma/C/Lzma2Dec.c
)
set(CMAKE_VERBOSE_MAKEFILE on)

file(GLOB rnoh_pushy_SRC CONFIGURE_DEPENDS *.cpp)
add_library(rnoh_pushy SHARED ${rnoh_pushy_SRC})
target_include_directories(rnoh_pushy PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(rnoh_pushy PUBLIC rnoh)

add_library(rnupdate SHARED
    pushy.cpp
    ${HDP_SOURCES}
)

add_library(hdiffpatch SHARED
    hpatch.h
    hpatch.c
)

target_include_directories(rnupdate PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/HDiffPatch
    ${CMAKE_CURRENT_SOURCE_DIR}/lzma/C
)

target_link_libraries(rnupdate PUBLIC
    libace_napi.z.so
)

