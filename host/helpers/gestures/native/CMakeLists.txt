cmake_minimum_required(VERSION 3.22)
project(gsv_litert LANGUAGES C CXX)

# LiteRT's CPU interpreter and XNNPACK are static dependencies of gsv-vision.
# Do not enable host-specific ISA flags: XNNPACK dispatches at runtime.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/archives")
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(TFLITE_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
set(TFLITE_ENABLE_GPU OFF CACHE BOOL "" FORCE)
set(TFLITE_ENABLE_METAL OFF CACHE BOOL "" FORCE)
set(TFLITE_ENABLE_NNAPI OFF CACHE BOOL "" FORCE)
set(TFLITE_ENABLE_EXTERNAL_DELEGATE OFF CACHE BOOL "" FORCE)
set(TFLITE_ENABLE_XNNPACK ON CACHE BOOL "" FORCE)
set(XNNPACK_ENABLE_KLEIDIAI OFF CACHE BOOL "" FORCE)
set(CPUINFO_LOG_LEVEL none CACHE STRING "" FORCE)
set(CMAKE_POLICY_VERSION_MINIMUM 3.5)
if(POLICY CMP0135)
  cmake_policy(SET CMP0135 NEW)
endif()
if(POLICY CMP0169)
  cmake_policy(SET CMP0169 OLD)
endif()
add_compile_definitions(TF_LITE_STRIP_ERROR_STRINGS)

include(FetchContent)
FetchContent_Declare(litert
  URL https://codeload.github.com/google-ai-edge/LiteRT/tar.gz/refs/tags/v2.2.0
  URL_HASH SHA256=6d2ce16738199adc5a3cdde76c3c6a6dac636d3b52a1d7790ea524fb0d59f7fc
)
# This is the TensorFlow revision required by LiteRT 2.2.0's CPU build.
FetchContent_Declare(tensorflow
  URL https://codeload.github.com/tensorflow/tensorflow/tar.gz/refs/tags/v2.21.0-rc0
  URL_HASH SHA256=91b2c2d12f0ebd78d84e5e1401269d0e6e36db5b74e19cc929e0f012b380af39
)
FetchContent_MakeAvailable(litert tensorflow)
set(TENSORFLOW_SOURCE_DIR "${tensorflow_SOURCE_DIR}" CACHE PATH "" FORCE)
add_subdirectory("${litert_SOURCE_DIR}/tflite" "${CMAKE_BINARY_DIR}/tflite" EXCLUDE_FROM_ALL)

add_library(gsv_litert_bridge STATIC bridge.cc
  "${litert_SOURCE_DIR}/tflite/profiling/profile_buffer.cc"
  "${litert_SOURCE_DIR}/tflite/profiling/time.cc"
  "${litert_SOURCE_DIR}/tflite/profiling/memory_info.cc"
)
target_link_libraries(gsv_litert_bridge PRIVATE tensorflow-lite)
target_compile_options(gsv_litert_bridge PRIVATE -Wall -Wextra)

# Rust needs the complete static archive, including the CPU kernel libraries.
# Building this target builds only its dependency closure into archives/.
install(CODE "
  set(ARCHIVE_DIR \"${CMAKE_ARCHIVE_OUTPUT_DIRECTORY}\")
  set(AR \"${CMAKE_AR}\")
  set(APPLE \"${APPLE}\")
  include(\"${CMAKE_CURRENT_SOURCE_DIR}/bundle.cmake\")
")
