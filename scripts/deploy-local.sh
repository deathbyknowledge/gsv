#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE_DIR="${ROOT_DIR}/release/local"

if [[ ! -d "${BUNDLE_DIR}" ]]; then
  echo "Local bundle directory not found: ${BUNDLE_DIR}" >&2
  echo "Build bundles first: ./scripts/build-cloudflare-bundles.sh ./release/local" >&2
  exit 1
fi

if [[ $# -eq 0 ]]; then
  set -- -c gateway
fi

exec gsv deploy up --bundle-dir "${BUNDLE_DIR}" "$@"
