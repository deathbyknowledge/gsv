file(GLOB archives "${ARCHIVE_DIR}/*.a")
if(NOT EXISTS "${ARCHIVE_DIR}/libgsv_litert_bridge.a" OR
   NOT EXISTS "${ARCHIVE_DIR}/libtensorflow-lite.a" OR
   NOT EXISTS "${ARCHIVE_DIR}/libXNNPACK.a")
  message(FATAL_ERROR "The gesture CPU runtime archives are incomplete")
endif()
file(MAKE_DIRECTORY "${CMAKE_INSTALL_PREFIX}/lib")
set(output "${CMAKE_INSTALL_PREFIX}/lib/libgsv_litert.a")
if(APPLE)
  execute_process(COMMAND /usr/bin/libtool -static -o "${output}" ${archives}
    COMMAND_ERROR_IS_FATAL ANY)
else()
  # Relative filenames keep MRI scripts independent of spaces in build paths.
  set(script "CREATE ../libgsv_litert.a\n")
  foreach(archive IN LISTS archives)
    get_filename_component(name "${archive}" NAME)
    string(APPEND script "ADDLIB ${name}\n")
  endforeach()
  string(APPEND script "SAVE\nEND\n")
  file(WRITE "${ARCHIVE_DIR}/bundle.mri" "${script}")
  execute_process(COMMAND "${AR}" -M
    WORKING_DIRECTORY "${ARCHIVE_DIR}"
    INPUT_FILE "${ARCHIVE_DIR}/bundle.mri"
    COMMAND_ERROR_IS_FATAL ANY)
  file(COPY_FILE "${ARCHIVE_DIR}/../libgsv_litert.a" "${output}" ONLY_IF_DIFFERENT)
endif()
