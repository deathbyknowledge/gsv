#!/usr/bin/env bash
# Node 24 (what CI uses) and RAM-backed temp, per the integration test guidance.
set -euo pipefail
cd "$(dirname "$0")/../.."
TMPDIR=$(mktemp -d /dev/shm/gsv-onboarding-XXXXXX)
export TMPDIR
trap 'rm -rf "$TMPDIR"' EXIT
exec_args=(mise exec node@24 -- npx tsx bench/onboarding/run.ts "$@")
"${exec_args[@]}"
