cmake_minimum_required(VERSION 3.22)
project(gsv_litert LANGUAGES C CXX)

# LiteRT's CPU interpreter and XNNPACK are static dependencies of gsv-vision.
# Do not enable host-specific ISA flags: XNNPACK dispatches at runtime.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/archives")
foreach(config DEBUG RELEASE RELWITHDEBINFO MINSIZEREL)
  set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY_${config} "${CMAKE_BINARY_DIR}/archives")
endforeach()
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(TFLITE_ENABLE_INSTALL OFF CACHE BOOL "" FORCE)
set(TFLITE_ENABLE_GPU OFF CACHE BOOL "" FORCE)
set(TFLITE_ENABLE_METAL OFF CACHE BOOL "" FORCE)
set(TFLITE_ENABLE_NNAPI OFF CACHE BOOL "" FORCE)
set(TFLITE_ENABLE_EXTERNAL_DELEGATE OFF CACHE BOOL "" FORCE)
set(TFLITE_ENABLE_XNNPACK ON CACHE BOOL "" FORCE)
if(WIN32)
  # The pinned TensorFlow allocation implementation uses POSIX mmap. Our
  # checksum-pinned embedded models already use VerifyAndBuildFromBuffer.
  set(TFLITE_ENABLE_MMAP OFF CACHE BOOL "" FORCE)
endif()
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
# Keep LiteRT's exact revisions while avoiding GitLab clones, including the
# unused Eigen submodule in ml_dtypes. Both archives are checksum verified.
set(OVERRIDABLE_FETCH_CONTENT_eigen_URL
  https://storage.googleapis.com/mirror.tensorflow.org/gitlab.com/libeigen/eigen/-/archive/ea13a98decd497a8c5588fb5de71b57bcf10d864/eigen-ea13a98decd497a8c5588fb5de71b57bcf10d864.tar.gz
)
set(OVERRIDABLE_FETCH_CONTENT_eigen_URL_HASH
  SHA256=35c6126e246585d9cf6600b65471582c2701aae64b784a6fd19168a90cfc841e
)
set(OVERRIDABLE_FETCH_CONTENT_ml_dtypes_URL
  https://codeload.github.com/jax-ml/ml_dtypes/tar.gz/00d98cd92ade342fef589c0470379abb27baebe9
)
set(OVERRIDABLE_FETCH_CONTENT_ml_dtypes_URL_HASH
  SHA256=f6e5880666661351e6cd084ac4178ddc4dabcde7e9a73722981c0d1500cf5937
)
add_subdirectory("${litert_SOURCE_DIR}/tflite" "${CMAKE_BINARY_DIR}/tflite" EXCLUDE_FROM_ALL)

add_library(gsv_litert_bridge STATIC bridge.cc
  "${litert_SOURCE_DIR}/tflite/profiling/profile_buffer.cc"
  "${litert_SOURCE_DIR}/tflite/profiling/time.cc"
  "${litert_SOURCE_DIR}/tflite/profiling/memory_info.cc"
)
target_link_libraries(gsv_litert_bridge PRIVATE tensorflow-lite)
if(MSVC)
  target_compile_options(gsv_litert_bridge PRIVATE /W4 /EHsc)
else()
  target_compile_options(gsv_litert_bridge PRIVATE -Wall -Wextra)
endif()

# Rust needs the complete static archive, including the CPU kernel libraries.
# Building this target builds only its dependency closure into archives/.
install(CODE "
  set(ARCHIVE_DIR \"${CMAKE_ARCHIVE_OUTPUT_DIRECTORY}\")
  set(AR \"${CMAKE_AR}\")
  set(APPLE \"${APPLE}\")
  set(MSVC \"${MSVC}\")
  include(\"${CMAKE_CURRENT_SOURCE_DIR}/bundle.cmake\")
")
