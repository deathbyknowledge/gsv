#!/usr/bin/env bash
set -euo pipefail

POC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SOURCE_DIR=$($POC_DIR/scripts/prepare-emulator.sh)
BUILD_DIR="$SOURCE_DIR/build-gsv"
BUILD_JOBS=${GSV_HDZERO_BUILD_JOBS:-$(nproc)}

cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" \
  -DEMULATOR_BUILD=ON \
  -DHDZ_GOGGLE=OFF \
  -DHDZ_BOXPRO=OFF \
  -DHDZ_GOGGLE2=ON \
  -DCMAKE_C_STANDARD=11 \
  -DCMAKE_BUILD_TYPE=Debug
cmake --build "$BUILD_DIR" --parallel "$BUILD_JOBS"

printf '%s\n' "$BUILD_DIR/HDZGOGGLE"
