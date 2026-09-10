cmake_minimum_required(VERSION 3.18)
project(kb_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
add_compile_options(-O3 -DNDEBUG)

if(NOMINSIZE)
  add_compile_definitions(NOMINSIZE)
endif()

find_package(Python REQUIRED COMPONENTS Interpreter Development.Module)
find_package(nanobind CONFIG REQUIRED)

include(FetchContent)
FetchContent_Declare(
  rapidfuzz
  GIT_REPOSITORY https://github.com/rapidfuzz/rapidfuzz-cpp.git
  GIT_TAG        v3.3.2
  GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(rapidfuzz)

nanobind_add_module(
  kb_native
  NOMINSIZE
  src/kb_native/module.cpp
  src/kb_native/suffix_array.cpp
  src/kb_native/trigrams.cpp
  src/kb_native/aho_corasick.cpp
  src/kb_native/distance.cpp
  src/kb_native/bm25.cpp
  src/kb_native/vectors.cpp
)

target_include_directories(kb_native PRIVATE src/kb_native ${rapidfuzz_SOURCE_DIR})
target_link_libraries(kb_native PRIVATE rapidfuzz::rapidfuzz)

install(TARGETS kb_native LIBRARY DESTINATION . COMPONENT python)
