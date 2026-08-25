#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INPUT="${1:-/home/hank/Videos/2026-07-15_14-43-25.mkv}"
MODE="${MODE:-preview}"

case "$MODE" in
  preview)
    OUTPUT="${2:-/home/hank/Videos/gsv-1000-device-demo-rough-v1-preview.mp4}"
    VIDEO_ARGS=(-s 1280x720 -r 30 -c:v libx264 -preset veryfast -crf 23)
    ;;
  final)
    OUTPUT="${2:-/home/hank/Videos/gsv-1000-device-demo-rough-v1.mp4}"
    VIDEO_ARGS=(-r 60 -c:v libx264 -preset medium -crf 18)
    ;;
  *)
    echo "Unknown MODE: $MODE (expected preview or final)" >&2
    exit 2
    ;;
esac

cd "$SCRIPT_DIR"
ffmpeg -hide_banner -y \
  -i "$INPUT" \
  -/filter_complex filter-complex.txt \
  -map "[vout]" \
  -an \
  "${VIDEO_ARGS[@]}" \
  -pix_fmt yuv420p \
  -movflags +faststart \
  "$OUTPUT"

printf '%s\n' "$OUTPUT"
