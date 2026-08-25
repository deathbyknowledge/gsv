#!/usr/bin/env bash
set -euo pipefail

VIDEO="${1:-/home/hank/Videos/gsv-instagram-browser-demo-report-v2-preview.mp4}"
MUSIC="${2:-/home/hank/Downloads/The Son of Flynn.mp3}"
OUTPUT="${3:-/home/hank/Videos/gsv-instagram-browser-demo-son-of-flynn-v2-preview.mp4}"

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
  start = 80.0;
  if (duration < start) {
    start = duration - 3.0;
    if (start < 0) start = 0;
  }
  printf "%.6f", start;
}
')"

fade_out_duration="$(awk -v duration="$duration" -v start="$fade_out_start" 'BEGIN {
  fade_duration = duration - start;
  if (fade_duration < 0) fade_duration = 0;
  printf "%.6f", fade_duration;
}
')"

# The recording itself is intentionally silent. Keep the track's natural
# dynamics, add only click protection at the opening, and complement its
# existing outro with a gentle fade to digital silence at the final frame.
ffmpeg -hide_banner -y \
  -i "$VIDEO" \
  -i "$MUSIC" \
  -map 0:v:0 \
  -map 1:a:0 \
  -c:v copy \
  -af "aresample=48000,atrim=duration=${duration},asetpts=PTS-STARTPTS,volume=0.5dB,afade=t=in:st=0:d=0.15:curve=qsin,afade=t=out:st=${fade_out_start}:d=${fade_out_duration}:curve=qsin" \
  -c:a aac \
  -b:a 320k \
  -ar 48000 \
  -disposition:a:0 default \
  -movflags +faststart \
  -shortest \
  "$OUTPUT"

printf '%s\n' "$OUTPUT"
