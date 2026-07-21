#!/usr/bin/env bash
set -euo pipefail

POC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK_DIR=${GSV_HDZERO_WORK_DIR:-"$POC_DIR/.work"}
SOURCE_DIR="$WORK_DIR/hdzero-goggle"
UPSTREAM_URL=https://github.com/hd-zero/hdzero-goggle.git
UPSTREAM_COMMIT=6fe76d4510c45092b616ff967c2b0942bd44a4b2

mkdir -p "$WORK_DIR"

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  git clone --filter=blob:none --no-checkout "$UPSTREAM_URL" "$SOURCE_DIR"
  git -C "$SOURCE_DIR" fetch --depth 1 origin "$UPSTREAM_COMMIT"
  git -C "$SOURCE_DIR" switch --detach "$UPSTREAM_COMMIT"
fi

ACTUAL_COMMIT=$(git -C "$SOURCE_DIR" rev-parse HEAD)
if [[ "$ACTUAL_COMMIT" != "$UPSTREAM_COMMIT" ]]; then
  echo "HDZero worktree is at $ACTUAL_COMMIT; expected $UPSTREAM_COMMIT" >&2
  echo "Use a fresh GSV_HDZERO_WORK_DIR or restore the generated worktree." >&2
  exit 1
fi

mkdir -p "$SOURCE_DIR/src/core" "$SOURCE_DIR/src/ui" "$SOURCE_DIR/src/util"
cp "$POC_DIR/overlay/src/core/gsv_ipc.c" "$SOURCE_DIR/src/core/gsv_ipc.c"
cp "$POC_DIR/overlay/src/core/gsv_ipc.h" "$SOURCE_DIR/src/core/gsv_ipc.h"
cp "$POC_DIR/overlay/src/ui/page_gsv.c" "$SOURCE_DIR/src/ui/page_gsv.c"
cp "$POC_DIR/overlay/src/ui/page_gsv.h" "$SOURCE_DIR/src/ui/page_gsv.h"
cp "$POC_DIR/overlay/src/util/system.c" "$SOURCE_DIR/src/util/system.c"

if git -C "$SOURCE_DIR" apply --unidiff-zero --check "$POC_DIR/patches/upstream.patch" 2>/dev/null; then
  git -C "$SOURCE_DIR" apply --unidiff-zero "$POC_DIR/patches/upstream.patch"
elif ! git -C "$SOURCE_DIR" apply --unidiff-zero --reverse --check "$POC_DIR/patches/upstream.patch" 2>/dev/null; then
  echo "The GSV integration patch no longer applies cleanly to the pinned HDZero source." >&2
  exit 1
fi

printf '%s\n' "$SOURCE_DIR"
