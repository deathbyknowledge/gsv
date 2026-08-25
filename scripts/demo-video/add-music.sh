#!/usr/bin/env bash
set -euo pipefail

VIDEO="${1:-/home/hank/Videos/gsv-1000-device-demo-rough-v1.mp4}"
MUSIC="${2:-/home/hank/Downloads/Karl Casey - The Heist.flac}"
OUTPUT="${3:-/home/hank/Videos/gsv-1000-device-demo-the-heist-v1.mp4}"

for command in ffmpeg ffprobe awk; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "error: $command is required" >&2
    exit 1
  }
done

[[ -f "$VIDEO" ]] || {
  echo "error: video not found: $VIDEO" >&2
  exit 1
}
[[ -f "$MUSIC" ]] || {
  echo "error: music not found: $MUSIC" >&2
  exit 1
}

duration="$(
  ffprobe -v error \
    -select_streams v:0 \
    -show_entries stream=duration \
    -of default=noprint_wrappers=1:nokey=1 \
    "$VIDEO"
)"
[[ "$duration" =~ ^[0-9]+([.][0-9]+)?$ ]] || {
  echo "error: could not determine video duration" >&2
  exit 1
}

fade_out_start="$(awk -v duration="$duration" 'BEGIN {
  start = duration - 3.0;
  if (start < 0) start = 0;
  printf "%.3f", start;
}')"

# The source master has no useful production audio. Keep the music dynamic,
# lower its measured -13 LUFS master by 2 dB, and use gentle edge fades.
ffmpeg -hide_banner -y \
  -i "$VIDEO" \
  -i "$MUSIC" \
  -map 0:v:0 \
  -map 1:a:0 \
  -c:v copy \
  -af "aresample=48000,volume=-2dB,afade=t=in:st=0:d=1,afade=t=out:st=${fade_out_start}:d=3,atrim=end=${duration}" \
  -c:a aac \
  -b:a 320k \
  -ar 48000 \
  -disposition:a:0 default \
  -metadata:s:a:0 title="The Heist" \
  -metadata:s:a:0 artist="Karl Casey @ White Bat Audio" \
  -metadata comment='Music: "The Heist" by Karl Casey @ White Bat Audio' \
  -movflags +faststart \
  -shortest \
  "$OUTPUT"

printf '%s\n' "$OUTPUT"
