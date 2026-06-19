#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-${ROOT_DIR}/release/local}"
ZIP_PATH="${OUT_DIR}/gsv-browser-extension.zip"

export COPYFILE_DISABLE=1
export COPY_EXTENDED_ATTRIBUTES_DISABLE=1

(
  cd "${ROOT_DIR}"
  npm run gsv:build
  npm run extension:check
  npm run extension:build
)

mkdir -p "${OUT_DIR}"
rm -f "${ZIP_PATH}"

(
  cd "${ROOT_DIR}/extension/dist"
  node "${ROOT_DIR}/scripts/zip-directory.mjs" . "${ZIP_PATH}"
)

echo "Browser extension package ready: ${ZIP_PATH}"
