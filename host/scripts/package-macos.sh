#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: host/scripts/package-macos.sh [--debug|--release] [--skip-build] [--output DIR]

Build and assemble an unsigned GSV.app for the current Mac architecture.

Options:
  --debug       Package optimized development-profile binaries (default).
  --release     Package release-profile binaries.
  --skip-build  Reuse existing binaries.
  --output DIR  Write GSV.app and its ZIP to DIR.
  -h, --help    Show this help.
EOF
}

die() {
  printf 'package-macos: %s\n' "$1" >&2
  exit 1
}

profile="debug"
skip_build=0
output_override=""
while (($# > 0)); do
  case "$1" in
    --debug)
      profile="debug"
      ;;
    --release)
      profile="release"
      ;;
    --skip-build)
      skip_build=1
      ;;
    --output)
      (($# >= 2)) || die "--output requires a directory"
      output_override="$2"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
  shift
done

[[ "$(uname -s)" == "Darwin" ]] || die "run this script on macOS"
for command in awk cargo ditto file iconutil install plutil sed sips; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
host_root="$(cd "$script_dir/.." && pwd)"
repository_root="$(cd "$host_root/.." && pwd)"
target_root="$host_root/target"
architecture="$(uname -m)"
output_dir="${output_override:-$target_root/package/macos/$architecture/$profile}"
binary_dir="$target_root/$profile"
plist_template="$host_root/packaging/macos/Info.plist"
icon_source="$repository_root/web/public/brand/gsv-mark-white.svg"
version="$(awk -F '"' '/^version = "/ { print $2; exit }' "$host_root/Cargo.toml")"
[[ -n "$version" ]] || die "could not read the workspace version"

if ((skip_build == 0)); then
  cargo_args=(
    --locked
    --manifest-path "$host_root/Cargo.toml"
    --package gsv
    --package machine
    --package desktop
    --package gestures
    --package transcriber
  )
  if [[ "$profile" == "release" ]]; then
    cargo_args+=(--release)
  fi
  cargo build "${cargo_args[@]}"
fi

binaries=(gsv-desktop gsv gsvd gsv-vision gsv-transcribe)
for binary in "${binaries[@]}"; do
  path="$binary_dir/$binary"
  [[ -x "$path" ]] || die "missing executable $path"
  file "$path" | grep -q 'Mach-O' || die "$path is not a macOS executable"
done
[[ -f "$plist_template" ]] || die "missing Info.plist template"
[[ -f "$icon_source" ]] || die "missing application icon"

mkdir -p "$output_dir"
stage="$(mktemp -d "$output_dir/.gsv-macos-package.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
app="$stage/GSV.app"
macos_dir="$app/Contents/MacOS"
resources_dir="$app/Contents/Resources"
mkdir -p "$macos_dir" "$resources_dir"

sed "s/__GSV_VERSION__/$version/g" "$plist_template" > "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"
for binary in "${binaries[@]}"; do
  install -m 0755 "$binary_dir/$binary" "$macos_dir/$binary"
done
install -m 0644 "$repository_root/LICENSE" "$resources_dir/LICENSE"
install -m 0644 "$host_root/helpers/transcriber/THIRD_PARTY.md" \
  "$macos_dir/THIRD_PARTY.md"
gesture_license_dir="$resources_dir/licenses/gesture-models"
mkdir -p "$gesture_license_dir"
install -m 0644 "$host_root/helpers/gestures/models/LICENSE.apache-2.0" \
  "$gesture_license_dir/LICENSE.apache-2.0"
install -m 0644 "$host_root/helpers/gestures/models/PROVENANCE.md" \
  "$gesture_license_dir/PROVENANCE.md"

icon_artwork="$stage/GSV-app-icon-1024.png"
"$binary_dir/gsv-desktop" --render-macos-icon "$icon_artwork"
[[ -f "$icon_artwork" ]] || die "application icon renderer produced no output"
iconset="$stage/GSV.iconset"
mkdir -p "$iconset"
render_icon() {
  local canvas_size="$1"
  local output="$2"
  sips -z "$canvas_size" "$canvas_size" "$icon_artwork" \
    --out "$output" >/dev/null
}
for size in 16 32 128 256 512; do
  render_icon "$size" "$iconset/icon_${size}x${size}.png"
  double_size=$((size * 2))
  render_icon "$double_size" "$iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$iconset" -o "$resources_dir/GSV.icns"

plutil -lint "$app/Contents/Info.plist" >/dev/null
[[ -x "$macos_dir/gsv-desktop" ]] || die "bundle validation failed"
[[ -f "$resources_dir/GSV.icns" ]] || die "bundle icon generation failed"
[[ -f "$gesture_license_dir/LICENSE.apache-2.0" ]] \
  || die "bundle gesture-model license staging failed"

app_path="$output_dir/GSV.app"
zip_path="$output_dir/GSV-$version-$architecture-$profile.zip"
[[ "$(basename "$app_path")" == "GSV.app" ]] || die "unsafe app output path"
rm -rf "$app_path"
rm -f "$zip_path"
ditto "$app" "$app_path"
ditto -c -k --sequesterRsrc --keepParent "$app_path" "$zip_path"

trap - EXIT
rm -rf "$stage"
printf 'Unsigned development app: %s\n' "$app_path"
printf 'Shareable development ZIP: %s\n' "$zip_path"
printf 'Public distribution still requires signing and notarization.\n'
