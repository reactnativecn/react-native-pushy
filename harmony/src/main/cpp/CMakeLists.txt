cmake_minimum_required(VERSION 3.13)
set(CMAKE_VERBOSE_MAKEFILE on)

file(GLOB rnoh_pushy_SRC CONFIGURE_DEPENDS *.cpp)
add_library(rnoh_pushy SHARED ${rnoh_pushy_SRC})
target_include_directories(rnoh_pushy PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(rnoh_pushy PUBLIC rnoh)

